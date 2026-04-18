// ── Triage classifier trace ──────────────────────────────────────
// Append-only JSONL log of every classifier verdict, for later audit
// ("why did it auto-run that?"). Hot-path constraint: must not stall
// the event loop on append. Rotation is rename-based — when the file
// exceeds the cap, rename it to `<file>.1` (overwriting any prior .1)
// and start fresh. O(1) regardless of file size.

import { rename, stat, open } from "fs/promises";
import { constants as fsConstants } from "fs";

export interface TraceLine {
  ts: string;
  tool: string;
  args_hash: string;
  args_preview: string;
  verdict: string;
  rationale: string;
  model: string;
  latency_ms: number;
}

export interface TriageTraceWriter {
  append(line: TraceLine): Promise<void>;
  /**
   * Resolve once every previously-queued append has settled. Headless
   * mode awaits this before `process.exit` — without it, in-flight
   * trace writes get killed by the exit and lose their audit entries.
   */
  flush(): Promise<void>;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function createFileTraceWriter(opts: {
  path: string;
  maxBytes?: number;
}): TriageTraceWriter {
  const path = opts.path;
  const cap = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // Per-process write queue. Earlier rev had a TOCTOU race: two
  // concurrent appends both saw size > cap, A renamed and started
  // writing a fresh file, then B's stale "rotate" rename overwrote A's
  // freshly-rotated .1 with B's tiny new file → 5MB of audit log gone.
  // A simple chained-promise queue serializes the rotate+append
  // critical section without forcing callers to await on each other
  // outside the writer.
  let queue: Promise<void> = Promise.resolve();
  // Latch flipped by flush() so post-flush appends short-circuit.
  // Without this, classify() promises that resolve AFTER flush() drains
  // the queue can sneak a write in just as `process.exit` lands —
  // partial appendFile call → corrupted JSONL line, unparseable forever.
  let closed = false;

  return {
    async append(line: TraceLine): Promise<void> {
      if (closed) return;
      const serialized = JSON.stringify(line) + "\n";
      const work = queue.then(async () => {

        // Rotate BEFORE append so we never grow past 2× cap. Inside the
        // serialized critical section, rename + open execute atomically
        // relative to other queued appends in this process.
        try {
          const st = await stat(path);
          if (st.size + serialized.length > cap) {
            await rename(path, `${path}.1`).catch(() => {
              // Concurrent rotation by another process is rare (we own
              // the project dir) and harmless — open below creates a
              // fresh file.
            });
          }
        } catch {
          // File doesn't exist yet — first open will create it.
        }

        // Open with O_NOFOLLOW so the OS itself refuses to traverse a
        // symlink at the target. Earlier `lstat`+`appendFile` had a
        // TOCTOU window — between the lstat and the open, an attacker
        // (a malicious tool emitted by the agent itself, even) could
        // swap the file for a symlink to ~/.bashrc and the appendFile
        // would happily follow it. O_NOFOLLOW closes the race at the
        // syscall layer.
        let fh;
        try {
          fh = await open(
            path,
            fsConstants.O_WRONLY
              | fsConstants.O_APPEND
              | fsConstants.O_CREAT
              | fsConstants.O_NOFOLLOW,
            0o600,
          );
        } catch (err) {
          // ELOOP fires when the target IS a symlink and O_NOFOLLOW is
          // set. Skip THIS append but don't latch — a transient symlink
          // trick (rogue tool creates+removes the link in one batch)
          // shouldn't permanently blind the audit log for the rest of
          // the session. Future appends retry the open. Operators see a
          // warning per attempt, which is the right signal: persistent
          // symlinks at the trace path are themselves suspicious.
          if (
            err instanceof Error
            && (err as NodeJS.ErrnoException).code === "ELOOP"
          ) {
            console.warn(
              `petricode: refusing to write triage trace — ${path} is a symlink`,
            );
            return;
          }
          throw err;
        }
        try {
          await fh.appendFile(serialized, "utf-8");
        } finally {
          await fh.close().catch(() => undefined);
        }
      });
      // Re-assign the queue tail to this work promise so subsequent
      // appends chain after it. Swallow rejection on the queue tail so
      // one failed write doesn't poison every future append.
      queue = work.catch(() => undefined);
      return work;
    },
    flush(): Promise<void> {
      // Set the latch BEFORE awaiting so any concurrent classify() that
      // resolves while we're draining short-circuits in append() instead
      // of slipping a fresh write past us. Once flush() returns, the
      // writer is permanently closed — callers pair it with process exit.
      closed = true;
      return queue;
    },
  };
}
