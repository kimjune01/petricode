// ── Argv parsing ─────────────────────────────────────────────────
// Pure: a positional walker that consumes argv into a typed result
// (no I/O, no exits). Lives in its own module so tests can import
// and exercise it without spawning the CLI subprocess. The CLI
// (cli.ts) calls this and then translates the result into prints
// and process.exit calls.
//
// Why positional, not indexOf-scanning: indexOf doesn't know that
// the token after `-p` belongs to -p, so `petricode -p "--list"`
// used to treat --list as a top-level flag, and `--resume -p hi`
// used to treat "-p" as the session ID.
//
// `--` is honored as the end-of-flags sentinel: everything after
// is treated as positional and won't trigger -h, --version, --list.

export type ParsedArgs = {
  help: boolean;
  version: boolean;
  list: boolean;
  resume?: string;
  prompt?: string;
  format: "text" | "json";
  // Tracks whether --format was explicitly set, so cross-flag
  // validation can report "--format requires -p" when the user
  // passes --format but no prompt.
  formatExplicit: boolean;
  errors: string[];
};

export function parseArgs(input: string[]): ParsedArgs {
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
      // "- write tests for X"). Round-19 rejected leading-dash values
      // entirely, which gave dash-prefixed prompts no escape hatch.
      // Only reject the truly missing case here.
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

  // Cross-flag validation that's awkward to express inside the
  // per-token loop. --format only does anything in headless mode,
  // so flagging it without -p surfaces the user's mistake instead
  // of silently dropping the flag and launching the TUI.
  if (out.formatExplicit && out.prompt === undefined) {
    out.errors.push("--format requires -p/--prompt (it only affects headless output).");
  }

  return out;
}
