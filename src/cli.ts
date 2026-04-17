// Ink is loaded lazily — headless mode (`-p`) skips the import entirely
// so non-TTY scripts don't pay for the React/Ink boot or hit raw-mode
// errors when stdin isn't a terminal.
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ── Crash log ────────────────────────────────────────────────────
const logDir = join(process.cwd(), ".petricode");
const crashLog = join(logDir, "crash.log");

function writeCrash(err: unknown): void {
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const msg = err instanceof Error
      ? `${err.message}\n${err.stack}`
      : String(err);
    appendFileSync(crashLog, `\n--- ${ts} ---\n${msg}\n`);
  } catch {
    // Last resort — don't crash the crash handler
  }
}

// Bracketed paste mode is enabled by Composer's mount effect. On a normal
// React unmount the cleanup effect disables it, but uncaught exceptions
// and signals skip cleanup — leaving the user's terminal echoing literal
// ESC[200~/ESC[201~ around any paste in subsequent shell sessions.
//
// Registered lazily by registerBracketedPasteCleanup() right before the
// TUI mounts. Headless callers never invoke it, so `petricode -p` doesn't
// emit the disable sequence onto stdout when piped to a TTY.
function disableBracketedPaste(): void {
  try {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l");
  } catch {
    // Stdout may already be closed.
  }
}
function registerBracketedPasteCleanup(): void {
  process.on("exit", disableBracketedPaste);
  process.on("SIGINT", () => { disableBracketedPaste(); process.exit(130); });
  process.on("SIGTERM", () => { disableBracketedPaste(); process.exit(143); });
}

process.on("uncaughtException", (err) => {
  writeCrash(err);
  disableBracketedPaste();
  console.error(`\nCrash logged to ${crashLog}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  writeCrash(reason);
  disableBracketedPaste();
  console.error(`\nCrash logged to ${crashLog}`);
  process.exit(1);
});

const args = process.argv.slice(2);

// ── Argv parsing ─────────────────────────────────────────────────
// Walk argv positionally instead of indexOf-scanning the whole array.
// indexOf doesn't know that the token after `-p` belongs to -p, so
// `petricode -p "--list"` was treating --list as a top-level flag and
// `petricode --resume -p hi` was treating "-p" as the session ID.
//
// `--` is honored as the end-of-flags sentinel: everything after is
// treated as positional and won't trigger -h, --version, --list, etc.
type ParsedArgs = {
  help: boolean;
  version: boolean;
  list: boolean;
  resume?: string;
  prompt?: string;
  format: "text" | "json";
  // Tracks whether --format was explicitly set, so we can report
  // "--format requires -p" when the user passes --format but no
  // prompt — without that, --format silently launched the TUI.
  formatExplicit: boolean;
  errors: string[];
};

function parseArgs(input: string[]): ParsedArgs {
  const out: ParsedArgs = {
    help: false,
    version: false,
    list: false,
    format: "text",
    formatExplicit: false,
    errors: [],
  };
  let i = 0;
  let positional = false;
  while (i < input.length) {
    const arg = input[i]!;
    if (positional) {
      i++;
      continue;
    }
    if (arg === "--") { positional = true; i++; continue; }
    if (arg === "--help" || arg === "-h") { out.help = true; i++; continue; }
    if (arg === "--version") { out.version = true; i++; continue; }
    if (arg === "--list") { out.list = true; i++; continue; }
    if (arg === "--resume") {
      const next = input[i + 1];
      if (!next || next.startsWith("-")) {
        out.errors.push("--resume requires a session ID. Use --list to see sessions.");
        i++;
      } else {
        out.resume = next;
        i += 2;
      }
      continue;
    }
    if (arg === "-p" || arg === "--prompt") {
      const next = input[i + 1];
      // Trust the user: a prompt is allowed to start with `-` (e.g.
      // "- write tests for X"). The earlier rejection of leading-dash
      // values prevented `petricode -p "-f or whatever"` entirely with
      // no escape hatch. Only reject the truly missing case here.
      if (next === undefined) {
        out.errors.push("-p/--prompt requires a prompt string. Example: petricode -p \"fix the failing test\"");
        i++;
      } else {
        // Last-wins per clig.dev: a later -p overrides an earlier one.
        out.prompt = next;
        i += 2;
      }
      continue;
    }
    if (arg === "--format") {
      const next = input[i + 1];
      if (next === "text" || next === "json") {
        out.format = next;
        out.formatExplicit = true;
        i += 2;
      } else {
        out.errors.push("--format expects 'text' or 'json'.");
        i++;
      }
      continue;
    }
    out.errors.push(`Unknown flag: ${arg}`);
    i++;
  }
  return out;
}

const parsed = parseArgs(args);

// Cross-flag validation that's awkward to express inside the per-token
// loop: --format only does anything in headless mode, so flagging it
// without -p surfaces the user's mistake instead of silently dropping
// the flag and launching the TUI.
if (parsed.formatExplicit && parsed.prompt === undefined) {
  parsed.errors.push("--format requires -p/--prompt (it only affects headless output).");
}

if (parsed.help) {
  console.log(`petricode

Usage:
  petricode [options]
  petricode -p "<prompt>"          Run one turn headless, print result, exit
  petricode --prompt "<prompt>"    Same as -p

Options:
  --help, -h            Show this help message
  --version             Show version
  --resume <session-id> Resume a previous session
  --list                List recent sessions
  -p, --prompt <text>   Headless: run one turn against <text>, write result
                        to stdout, exit. No TUI. Tools auto-allow.
  --format <text|json>  With -p: output format. Default: text.
  --                    Treat the rest of the arguments as positional.

Examples:
  petricode -p "summarize README.md"
  petricode -p "fix the failing test" --format json
  petricode --resume abc123

Exit codes:
  0   success
  1   runtime error (bootstrap failure, model rejection)
  2   misuse (bad or missing flag value)
  130 SIGINT (Ctrl+C)
  141 SIGPIPE (downstream consumer closed the pipe)

Run without arguments to open the TUI.`);
  process.exit(0);
}

if (parsed.version) {
  console.log("petricode 0.1.0");
  process.exit(0);
}

// argv errors are reported AFTER --help/--version so users can still
// reach those without first satisfying flag validation. Anything else
// (bad --resume, unknown flag, malformed -p) bails with exit 2.
if (parsed.errors.length > 0) {
  for (const e of parsed.errors) console.error(e);
  process.exit(2);
}

if (parsed.list) {
  // List sessions requires async — handled here before TUI
  const { createSqliteRemember } = await import("./remember/sqlite.js");
  const { listSessions } = await import("./session/resume.js");
  const { join } = await import("path");
  const dataDir = join(process.cwd(), ".petricode", "data");
  const remember = createSqliteRemember({ dataDir });
  const sessions = await listSessions(remember, 20);
  if (sessions.length === 0) {
    console.log("No sessions found.");
  } else {
    console.log("Recent sessions:");
    for (const s of sessions) {
      const created = new Date(
        (s.metadata.created_at as number) ?? 0,
      ).toLocaleString();
      console.log(`  ${s.id}  ${created}`);
    }
  }
  process.exit(0);
}

const resumeSessionId = parsed.resume;

// Headless mode — `-p` / `--prompt`. Routed BEFORE the TUI bootstrap so
// the Ink import and raw-mode setup never run for non-interactive callers.
if (parsed.prompt !== undefined) {
  const prompt = parsed.prompt;
  const format = parsed.format;

  const { runHeadless, writeAndDrain } = await import("./headless.js");
  const result = await runHeadless({
    prompt,
    projectDir: process.cwd(),
    resumeSessionId,
    format,
  });
  // Drain via the shared helper so the truncation behavior is covered by
  // test/headless.test.ts's fixture, not just inlined here.
  //
  // EPIPE is the normal signal that a downstream consumer closed early
  // (`petricode -p ... | head -n1`). Don't surface it as a crash — log
  // nothing and exit 141 (128 + SIGPIPE), matching how core utilities
  // like `cat` and `seq` report a broken pipe.
  try {
    if (result.stdout) await writeAndDrain(process.stdout, result.stdout);
    if (result.stderr) await writeAndDrain(process.stderr, result.stderr);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EPIPE") {
      process.exit(141);
    }
    throw err;
  }
  process.exit(result.exitCode);
}

// Past this point we're running the TUI — register the bracketed-paste
// cleanup hooks so a crash or signal doesn't leave the user's terminal
// in bracketed-paste mode. Headless mode never gets here, so its stdout
// stays clean.
registerBracketedPasteCleanup();

// Bootstrap the pipeline
const { bootstrap } = await import("./session/bootstrap.js");
const { pipeline, sessionId, resumed, mode } = await bootstrap({
  projectDir: process.cwd(),
  resumeSessionId,
  // onConfirm wired by App.tsx after mount
});

if (resumed) {
  console.log(`Resumed session ${sessionId}`);
}

// Workaround for Bun stdin bug with Ink's useInput
process.stdin.resume();

// Lazy imports — see header comment for why Ink isn't at the top.
const { render } = await import("ink");
const React = await import("react");
const { default: App } = await import("./app/App.js");

const { waitUntilExit } = render(
  React.createElement(App, { pipeline, resumeSessionId, mode }),
);
await waitUntilExit();
