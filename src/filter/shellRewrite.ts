// ── Soft-delete rewriter ─────────────────────────────────────────
// When the dangerous-shell guard catches an `rm -rf path`, we offer a
// reversible alternative: `mkdir -p <trash> && mv path <trash>/`. The
// user picks the soft form in the confirmation prompt and the rewriter
// hands the new command back to the executor.
//
// Strict scope: single-positional recursive rm only. Multi-target
// invocations, globs, command substitution, or anything that touches
// the shell metacharacters get null — we don't try to rewrite shell we
// can't fully parse, because a wrong rewrite is worse than the gate.

export interface ShellRewrite {
  /** The shell command to run instead. Safe to pass straight to bash. */
  rewrittenCmd: string;
  /** Short human label rendered in the confirmation prompt. */
  label: string;
  /** Where the moved files will land — surfaced so the user knows where to undo. */
  trashDir: string;
}

export interface RewriteOptions {
  sessionId: string;
  /** Override the timestamp for deterministic tests. */
  nowIso?: string;
  /** Override `/tmp` for tests / Windows (`%TEMP%`). */
  tmpRoot?: string;
}

/**
 * If `cmd` is a single-target recursive rm we know how to soft-delete,
 * return a `mkdir -p <trash> && mv …` rewrite. Otherwise null — the
 * caller falls back to the normal allow/deny prompt.
 */
export function rewriteRmToMv(cmd: string, opts: RewriteOptions): ShellRewrite | null {
  if (!cmd) return null;
  // Bail on anything that introduces a second command or shell
  // expansion. We're rewriting a single rm call, not a pipeline. Globs
  // (`*`, `?`) get bailed too — the model said `rm -rf build/*`, we
  // don't know how to enumerate the matches without running shell.
  if (/[|;&<>`$()*?\n]/.test(cmd)) return null;

  const tokens = tokenize(cmd);
  if (tokens === null || tokens.length < 2) return null;
  if (tokens[0] !== "rm") return null;

  let recursive = false;
  const positionals: string[] = [];
  // After `--`, everything is a positional even if it starts with `-`.
  // Some users / models write `rm -rf -- foo` defensively.
  let endOfFlags = false;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (endOfFlags) {
      positionals.push(t);
      continue;
    }
    if (t === "--") {
      endOfFlags = true;
      continue;
    }
    if (t.startsWith("--")) {
      if (t === "--recursive" || t === "-r" || t === "-R") {
        recursive = true;
        continue;
      }
      if (t === "--force") continue;
      // Unknown long flag — refuse to rewrite. Better to leave the gate
      // up than to silently strip a flag whose semantics we don't model.
      return null;
    }
    if (t.startsWith("-") && t.length > 1) {
      const flagChars = t.slice(1);
      // Any combination of r/R/f/F is fine; anything else (e.g. `-i`,
      // `-v`, `-d`) means we don't fully model this invocation. Bail.
      if (/[^rRfF]/.test(flagChars)) return null;
      if (/[rR]/.test(flagChars)) recursive = true;
      continue;
    }
    positionals.push(t);
  }

  // Not recursive → not a rewrite candidate. Plain `rm file.txt` isn't
  // dangerous enough to gate, and the predicate wouldn't have caught it.
  if (!recursive) return null;
  // Multi-target rm: refuse. A partial mv (one succeeds, one fails)
  // leaves the workspace in a worse state than the original `rm` would
  // have. If the user really wants to nuke multiple paths, the rm-anyway
  // option is still available.
  if (positionals.length !== 1) return null;

  const target = positionals[0]!;
  // Refuse to mv catastrophic targets. `/`, `.`, `..` and `~` are the
  // ones that would cause the most damage if rewritten — moving `/`
  // anywhere is nonsense and `.` would relocate the project. The user
  // can still pick "allow" if they really mean it.
  if (
    target === "/"
    || target === "."
    || target === ".."
    || target === "~"
    || target === ""
  ) return null;

  const tmpRoot = opts.tmpRoot ?? "/tmp";
  // Path-safe timestamp (no colons — bad on Windows, awkward in URLs).
  const ts = (opts.nowIso ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const trashDir = `${tmpRoot}/petricode-trash/${opts.sessionId}/${ts}`;

  const quotedTarget = shellQuote(target);
  const quotedTrash = shellQuote(trashDir);
  // mkdir -p is idempotent and creates parents — survives both first-run
  // and "the user made the same trash dir manually" cases. Trailing `/`
  // on the destination ensures `mv foo/ trash/` puts the directory
  // INSIDE trash (as `trash/foo`), not renames it to `trash`.
  const rewrittenCmd = `mkdir -p ${quotedTrash} && mv ${quotedTarget} ${quotedTrash}/`;
  const label = `move "${target}" → ${trashDir}/`;
  return { rewrittenCmd, label, trashDir };
}

/**
 * Lightweight tokenizer that handles bare words and single/double quoted
 * strings. Returns null if the input has unbalanced quotes — better to
 * bail than to mangle the args.
 */
function tokenize(cmd: string): string[] | null {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(cmd)) !== null) {
    consumed = m.index + m[0].length;
    const bare = m[3];
    // A bare-word capture starting with `"` or `'` means the
    // quoted-string branches failed to find a closing quote and the
    // alternation fell through to `\S+`. Treat as malformed — better
    // to refuse than to mv the literal opening quote into trash.
    if (bare !== undefined && (bare.startsWith(`"`) || bare.startsWith(`'`))) {
      return null;
    }
    tokens.push(m[1] ?? m[2] ?? m[3]!);
  }
  // If there's leftover non-whitespace, the regex bailed on something
  // (almost always an unterminated quote). Refuse — partial parses are
  // exactly the kind of "looked safe, wasn't" that the rewriter exists
  // to prevent.
  if (cmd.slice(consumed).trim().length > 0) return null;
  return tokens;
}

/**
 * POSIX-safe shell quoting. Wraps the value in single quotes and escapes
 * any embedded single quote via the standard `'\''` dance. Always quotes
 * even bare identifiers so `bash -c` reads the command identically
 * regardless of the target's contents.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
