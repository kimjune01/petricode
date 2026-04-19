// ── Dangerous-shell predicate ────────────────────────────────────
// Pattern-matches shell command strings against a list of operations
// that can't be undone by `git checkout` or a normal filesystem
// rollback. Used by `--permissive` mode to gate the un-undoable while
// auto-allowing everything reversible.
//
// False positives are fine — they fall through to the normal y/n
// confirmation prompt. False negatives are the failure mode that
// matters: a destructive command auto-running because the regex didn't
// match is exactly what permissive mode promises NOT to do. When in
// doubt, broaden the pattern.

export interface DangerVerdict {
  dangerous: boolean;
  /** Short human-readable reason, surfaced in the confirmation prompt. */
  reason?: string;
}

interface Pattern {
  // Anchored to word boundaries internally so `firmly` ≠ `rm`. Patterns
  // intentionally don't try to parse shell — they look for the
  // dangerous *invocation*, anywhere in the string. Subshells, pipes,
  // command substitution → if the dangerous call is in there at all,
  // we want to catch it.
  re: RegExp;
  reason: string;
}

const PATTERNS: Pattern[] = [
  // `rm -r`, `rm -rf`, `rm -fr`, `rm -Rf`, `rm --recursive`, `rm --force`
  // Recursive deletes — even of "safe" paths — bypass git for un-tracked
  // work and have no kernel-level undo. We gate any recursive rm, not
  // just `-rf`, because `rm -r build/` will still smoke local untracked
  // edits inside `build/`.
  {
    re: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*|--(?:recursive|force))\b/,
    reason: "rm with -r/-f deletes files irretrievably (un-tracked work bypasses git)",
  },
  // `git push --force`, `-f`, `--force-with-lease`. Lease is safer than
  // bare --force but still rewrites remote history — collaborators with
  // local clones get clobbered, CI pipelines built on the old SHA
  // become orphaned. Gate all three.
  {
    re: /\bgit\s+push\s+(?:[^;&|\n]*\s)?(?:--force(?:-with-lease)?|-f)\b/,
    reason: "git push --force rewrites remote history (clobbers others' work)",
  },
  // `git reset --hard` discards uncommitted changes — anything not
  // staged or committed is gone, no reflog rescue.
  {
    re: /\bgit\s+reset\s+(?:[^;&|\n]*\s)?--hard\b/,
    reason: "git reset --hard discards uncommitted changes",
  },
  // `git clean -f` deletes un-tracked files (opposite of rm: not in git
  // at all, no recovery). `-fd` and `-fdx` are the common destructive
  // forms.
  {
    re: /\bgit\s+clean\s+(?:[^;&|\n]*\s)?-[a-zA-Z]*f/,
    reason: "git clean -f deletes un-tracked files (no git recovery)",
  },
  // `git branch -D` (capital) force-deletes branches even if unmerged;
  // `-d` lowercase only deletes if merged, so it's safe.
  {
    re: /\bgit\s+branch\s+(?:[^;&|\n]*\s)?-[a-zA-Z]*D\b/,
    reason: "git branch -D force-deletes unmerged branches",
  },
  // `dd if=… of=…` is block-level write. Wrong `of=` clobbers a disk;
  // there's no userland undo. The flag-based form (`if=`/`of=`) is the
  // only meaningful invocation, so anchor on those.
  {
    re: /\bdd\s+(?:[^;&|\n]*\s)?(?:if|of)=/,
    reason: "dd writes raw blocks (can corrupt disks irrecoverably)",
  },
  // `mkfs`, `mkfs.ext4`, `mkfs.xfs`, etc. — filesystem creation
  // destroys whatever's on the target partition.
  {
    re: /\bmkfs(?:\.[a-zA-Z0-9]+)?\b/,
    reason: "mkfs erases the target partition",
  },
  // `sudo` is privilege escalation — blast radius is the whole machine,
  // not just the project. The model shouldn't auto-elevate even in
  // permissive mode; the user's password (or NOPASSWD config) is the
  // ceremony that should gate it.
  {
    re: /\bsudo\b/,
    reason: "sudo escalates privileges (blast radius is system-wide)",
  },
];

export function isDangerousShell(cmd: string): DangerVerdict {
  if (!cmd) return { dangerous: false };
  for (const { re, reason } of PATTERNS) {
    if (re.test(cmd)) return { dangerous: true, reason };
  }
  return { dangerous: false };
}
