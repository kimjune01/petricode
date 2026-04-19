# Bug Hunt Round 47

Three confirmed new bugs. Most of the agent's initial findings were false positives
(verified against source): ch.length cursor advance is intentional for surrogate pairs,
grep truncation discards are expected, resume.ts content field IS preserved, the
resumeSessionId prop in App is dead code (not a logic bug), and the contextSummary
setState-on-unmount is a no-op in React 18.

> Reviewer: `claude --model sonnet` (gemini Vertex SDK still broken,
> codex still 401-unauthed).

## Triage outcome

- **#1 (abort path missing grace SIGKILL)** — FIXED in `src/tools/shell.ts:101` and `src/tools/grep.ts:221`. Round 46's grace-SIGKILL pattern was added to the truncation path but onAbort was never updated; SIGTERM-immune children survived Ctrl+C indefinitely. onAbort now schedules the same 2s grace SIGKILL and skips cleanup() so the timer outlives the reject. close handler still cleans up once the proc actually exits.
- **#2 (auto-trigger fires on version strings / IPs)** — FIXED in `src/skiller/filter.ts:77`. Tightened the path-token filter from `t.includes(".")` to require either `/` or an identifier+single-dot+alpha-extension shape. `v1.2.3`, `192.168.1.1`, `2.0.1-rc` no longer qualify; bare filenames like `foo.ts` still do.
- **#3 (UTF-8 truncation boundary U+FFFD)** — FIXED in `src/tools/readFile.ts:55`. Replaced `Buffer.toString("utf-8")` with `TextDecoder.decode({ stream: truncated })` mirroring fileRefs.ts. Incomplete trailing multi-byte sequences are held back instead of decoding to U+FFFD.

---

## Bug 1 — HIGH: Abort path missing grace SIGKILL in shell.ts and grep.ts

**Files:**
- `src/tools/shell.ts:101–105`
- `src/tools/grep.ts:221–225`

**Description:**
Both tools have three paths that kill the child process: timeout, truncation, and
abort (Ctrl+C / AbortSignal). The truncation path was fixed with a 2-second grace
SIGKILL in a prior round. The abort path was not updated — it sends SIGTERM then
immediately cleans up listeners and rejects the promise, with no SIGKILL fallback.

```typescript
// shell.ts — abort handler
const onAbort = () => {
  proc.kill("SIGTERM");   // ← SIGTERM only
  cleanup();              // removes all listeners, cancels timeout
  reject(new DOMException("Aborted", "AbortError"));
  // ← no killGraceTimer for SIGTERM-immune children
};
```

Compare to the truncation path which has:
```typescript
killGraceTimer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
```

**Impact:** If the user hits Ctrl+C on a SIGTERM-immune shell command (e.g.
`trap '' TERM && sleep 3600`, or any process that catches and swallows SIGTERM),
the child process keeps running indefinitely. Over repeated sessions this leaks
processes that hold file locks and consume CPU/memory, invisible to the user.

**Suggested fix:** Add the same grace SIGKILL pattern to `onAbort` in both tools:
```typescript
const onAbort = () => {
  proc.kill("SIGTERM");
  const abortKill = setTimeout(() => proc.kill("SIGKILL"), 2_000);
  cleanup();
  clearTimeout(abortKill); // only if proc already exited in 'close'
  reject(new DOMException("Aborted", "AbortError"));
};
```
The cleanest implementation mirrors the truncation path: store the grace timer in
`killGraceTimer` and let `cleanup()` cancel it if the process exits normally within
the 2-second window.

**Severity:** high

---

## Bug 2 — MED: Auto-trigger path token extraction matches version strings and domain names

**File:** `src/skiller/filter.ts:77`

**Description:**
`matchesGlob` extracts "path-like" tokens from user input by splitting on whitespace
and keeping any token containing `/` or `.`:

```typescript
const tokens = input.split(/\s+/).filter((t) => t.includes("/") || t.includes("."));
```

The dot check is too broad. Version strings (`v1.2.3`, `2.0.1-rc`), domain names
(`example.com`, `api.service.internal`), file extensions used standalone (`.ts`),
and IP addresses (`192.168.1.1`) all pass the filter and are fed to the glob regex.

A skill with `paths: "*.2"` would activate on user input "upgrade to v1.2.3". A
skill with `paths: "*.com"` would activate on "fetch from example.com". Users
writing innocent sentences trigger unrelated skill injections silently — there is
no indication that an auto-trigger fired.

**Impact:** Unexpected skill bodies are injected into the system prompt, potentially
changing model behavior (or exposing debug instructions) when the user's message
happens to contain a version string or URL matching a skill's path glob.

**Suggested fix:** Require tokens to contain at least one `/` to qualify as
path-like (a lone dot is not enough):
```typescript
const tokens = input.split(/\s+/).filter((t) => t.includes("/"));
```
Or, if basename globs like `*.ts` must still work, require the token to look like
a filesystem path (start with `.`, `/`, `~`, or a letter followed by `/`):
```typescript
const tokens = input.split(/\s+/).filter(
  (t) => t.includes("/") || /^\.[a-zA-Z]/.test(t)
);
```

**Severity:** med

---

## Bug 3 — LOW: readFile.ts Buffer.toString() emits U+FFFD at truncation boundary

**File:** `src/tools/readFile.ts:55`

**Description:**
When a file exceeds the 256 KB cap, the tool reads exactly `MAX_READ_BYTES` into
a Buffer and calls `.toString("utf-8")` on the full slice:

```typescript
const body = buf.slice(0, bytesRead).toString("utf-8");
```

If the byte at position `MAX_READ_BYTES − 1` falls in the middle of a multi-byte
UTF-8 sequence (2–4 bytes for CJK, emoji, accented chars), `Buffer.toString` emits
a U+FFFD replacement character for the incomplete sequence instead of silently
dropping it. The model receives garbled output at the end of the readable block.

`fileRefs.ts` avoids this by using a `TextDecoder` with stream mode, which holds
back incomplete trailing sequences. `readFile.ts` does not.

The condition for the bug: file larger than 256 KB, truncated read, and a multi-byte
char whose first byte lands at or before position 262144 and whose continuation
bytes would be at or past position 262144. Uncommon in ASCII-heavy codebases but
realistic for CJK source files, markdown with emoji, or minified JS.

**Suggested fix:** Use `TextDecoder` instead of `Buffer.toString`:
```typescript
const decoder = new TextDecoder("utf-8");
const body = decoder.decode(buf.slice(0, bytesRead));
```
`TextDecoder` without `stream: true` still replaces incomplete trailing sequences
with U+FFFD, but that's consistent with fileRefs.ts and at least avoids the silent
contract break. For a clean truncation with no replacement chars, use
`{ fatal: false }` and strip the trailing incomplete sequence manually, or use
`stream: true` across chunks.

**Severity:** low
