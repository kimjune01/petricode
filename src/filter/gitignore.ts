// ── .gitignore filtering ─────────────────────────────────────────
// Parses .gitignore and provides an isIgnored(path) predicate.
// Hardcodes .git, node_modules, .env, .env.* as always-excluded.

import { readFile, readdir } from "fs/promises";
import { join } from "path";

/** Directories/files always excluded regardless of .gitignore content. */
const ALWAYS_EXCLUDED = [".git", "node_modules", ".env"];

/** Check if a segment matches a .env pattern (.env, .env.local, etc.) */
function isEnvFile(segment: string): boolean {
  return segment === ".env" || segment.startsWith(".env.");
}

/**
 * Walk projectDir collecting every .gitignore (root and nested) into a
 * single ordered pattern list. Patterns from nested .gitignore files are
 * rewritten with their directory prefix so the existing flat-list
 * predicate matches them only inside the subtree they were authored in,
 * matching git's "scoped to the .gitignore's directory" semantics.
 *
 * Traversal is parent-before-child so the predicate's "last match wins"
 * behaviour gives nested files precedence over root, as git does. We
 * skip ALWAYS_EXCLUDED dirs to avoid descending into node_modules/.git
 * on big trees, and don't follow symlinks to avoid loops.
 *
 * Returns empty array if no .gitignore files are found anywhere.
 */
export async function parseGitignore(projectDir: string): Promise<string[]> {
  const patterns: string[] = [];
  await collectGitignores(projectDir, "", patterns);
  return patterns;
}

async function collectGitignores(
  rootDir: string,
  relDir: string,
  out: string[],
): Promise<void> {
  const fullDir = relDir ? join(rootDir, relDir) : rootDir;

  try {
    const raw = await readFile(join(fullDir, ".gitignore"), "utf-8");
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      out.push(rewritePatternForSubdir(line, relDir));
    }
  } catch {
    // No .gitignore in this directory — fine, just don't contribute.
  }

  let entries;
  try {
    entries = await readdir(fullDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isAlwaysExcluded(entry.name)) continue;
    const sub = relDir ? `${relDir}/${entry.name}` : entry.name;
    await collectGitignores(rootDir, sub, out);
  }
}

// Rewrite a pattern from <rootDir>/<relDir>/.gitignore so it can be
// evaluated against root-relative paths by buildIgnorePredicate. Per
// gitignore semantics, a pattern in a subdir's .gitignore is scoped to
// that subtree: `foo` matches at any depth under relDir, `/foo` matches
// only relDir/foo, an internal slash anchors as well, a trailing slash
// stays directory-only, and `!keep.txt` un-ignores within the subtree.
// (Block-comment form would close early on the literal `**/` example.)
function rewritePatternForSubdir(pattern: string, relDir: string): string {
  if (!relDir) return pattern;
  const negate = pattern.startsWith("!");
  let body = negate ? pattern.slice(1) : pattern;
  const dirOnly = body.endsWith("/");
  if (dirOnly) body = body.slice(0, -1);

  let anchoredHere = body.startsWith("/");
  if (anchoredHere) body = body.slice(1);
  // Internal `/` also anchors per gitignore semantics — `a/b` in
  // `sub/.gitignore` matches `sub/a/b`, not `sub/x/a/b`.
  if (!anchoredHere && body.includes("/")) anchoredHere = true;

  const prefix = `/${relDir}/`;
  let rewritten = anchoredHere ? `${prefix}${body}` : `${prefix}**/${body}`;
  if (dirOnly) rewritten += "/";
  return (negate ? "!" : "") + rewritten;
}

/**
 * Convert gitignore patterns to a predicate function.
 * Handles simple patterns: directory names, globs with *, negation (!).
 *
 * @param patterns - parsed gitignore lines
 * @returns predicate: (relativePath, isDirectory?) => true if ignored.
 *   `isDirectory` is consulted for trailing-slash patterns (`foo/`),
 *   which per gitignore semantics MUST only match directories.
 *   - true  → directory-only patterns may match
 *   - false → directory-only patterns are skipped
 *   - undefined → directory-only patterns may match (conservative default
 *     for callers that don't know; preserves prior behavior)
 */
export function buildIgnorePredicate(
  patterns: string[],
): (relativePath: string, isDirectory?: boolean) => boolean {
  // Per gitignore semantics, patterns are evaluated in source order and the
  // LAST matching pattern decides — a later negation overrides an earlier
  // ignore, and a later ignore re-overrides that negation. Splitting into
  // positive/negative arrays loses this ordering.
  const compiled = patterns.map((pat) => {
    const negate = pat.startsWith("!");
    const body = negate ? pat.slice(1) : pat;
    const dirOnly = body.endsWith("/");
    return { negate, dirOnly, re: patternToRegex(body) };
  });

  return (relativePath: string, isDirectory?: boolean): boolean => {
    const segments = relativePath.split("/");

    // Always-excluded: check every path segment
    for (const seg of segments) {
      if (ALWAYS_EXCLUDED.includes(seg) || isEnvFile(seg)) {
        return true;
      }
    }

    // Walk patterns in source order. Anchored patterns (^...) only match the
    // full path; unanchored patterns ((^|/)...) also match individual segments
    // so bare names like "dist" match at any depth.
    //
    // Dir-only handling (`dist/`): the pattern must NOT match a regular file
    // whose leaf segment happens to be named `dist`, but it MUST still ignore
    // children of an ignored directory (e.g. `dist/index.js`). Strategy:
    // when caller asserts the path is a file, skip dir-only matches that
    // land on the leaf segment, but allow matches in the middle of the path
    // (those are "inside an ignored dir").
    const lastSegIdx = segments.length - 1;
    let ignored = false;
    for (const { negate, dirOnly, re } of compiled) {
      const isAnchored = re.source.startsWith("^") && !re.source.startsWith("(^|/");
      const skipLeaf = dirOnly && isDirectory === false;
      let matched = false;

      const fullMatch = re.exec(relativePath);
      if (fullMatch) {
        const endsAtLeaf =
          fullMatch.index + fullMatch[0].length === relativePath.length;
        if (!(skipLeaf && endsAtLeaf)) matched = true;
      }

      if (!matched && !isAnchored) {
        for (let i = 0; i < segments.length; i++) {
          if (!re.test(segments[i] as string)) continue;
          if (skipLeaf && i === lastSegIdx) continue;
          matched = true;
          break;
        }
      }

      if (matched) ignored = !negate;
    }
    return ignored;
  };
}

/**
 * Convert a gitignore glob pattern to a regex.
 * Supports: *, **, ?, leading /, trailing /
 */
function patternToRegex(pattern: string): RegExp {
  let p = pattern;

  // Remove trailing slash (directory indicator — we match by segment anyway)
  if (p.endsWith("/")) p = p.slice(0, -1);

  // Per gitignore spec: pattern is anchored if it starts with / OR
  // contains a slash anywhere (e.g. "src/*.js", "test/data").
  const anchored = p.startsWith("/") || p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);

  // Mask gitignore escape sequences (`\*`, `\?`, `\!`) before regex
  // escaping so they survive both the metachar pass and the glob
  // substitutions, then restore them as literal-character matches.
  // Without masking, `\*` collapses to a literal-backslash + glob `*`,
  // matching `\Aname` instead of `*name` for a pattern like `file\*name`.
  //
  // Markers use angle-bracket sentinels rather than control characters
  // (U+0001…U+0003): a literal control char in the input pattern would
  // otherwise be unmasked into a regex wildcard.
  const ESC_STAR = "⟨ESCSTAR⟩";
  const ESC_QMARK = "⟨ESCQMARK⟩";
  const ESC_BANG = "⟨ESCBANG⟩";
  const ESC_HASH = "⟨ESCHASH⟩";
  let regex = p
    .replace(/\\\*/g, ESC_STAR)
    .replace(/\\\?/g, ESC_QMARK)
    .replace(/\\!/g, ESC_BANG)
    .replace(/\\#/g, ESC_HASH);

  // Escape regex special chars except * and ?
  regex = regex.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  // Convert glob patterns to regex.
  // Order matters: handle multi-char sequences before single-char ones.
  //   /**/  → zero or more directories (matches a/b and a/x/b)
  //   **/   → leading globstar (matches root or any prefix)
  //   **    → match anything including /
  //   *     → match anything except /
  //   ?     → match single char except /
  //
  // The `?` glob substitution runs FIRST: globstar expansions emit literal
  // regex `?` quantifiers (`(/.*)?/`, `(.*/)?`), and a later `?` → `[^/]`
  // pass would mangle them.
  regex = regex
    .replace(/\?/g, "[^/]")
    .replace(/\/\*\*\//g, "⟨SLASHGLOBSTAR⟩")
    .replace(/\*\*\//g, "⟨LEADGLOBSTAR⟩")
    .replace(/\*\*/g, "⟨GLOBSTAR⟩")
    .replace(/\*/g, "[^/]*")
    // Non-greedy expansions so the predicate's "match ends at leaf?" check
    // (used by dir-only patterns) sees the shortest valid match. Without
    // `?` quantifiers, `a/**/` against `a/foo/file.txt` greedily grabs
    // `foo/file.txt`, end-of-match lands at the leaf, and the dirOnly
    // skip incorrectly drops the file.
    .replace(/⟨SLASHGLOBSTAR⟩/g, "(/.*?)?/")
    .replace(/⟨LEADGLOBSTAR⟩/g, "(.*?/)?")
    .replace(/⟨GLOBSTAR⟩/g, ".*?")
    // Restore masked gitignore escapes as literal-character regex matches.
    .replaceAll(ESC_STAR, "\\*")
    .replaceAll(ESC_QMARK, "\\?")
    .replaceAll(ESC_BANG, "!")
    .replaceAll(ESC_HASH, "#");

  if (anchored) {
    return new RegExp(`^${regex}(/|$)`);
  }
  // Unanchored patterns match anywhere
  return new RegExp(`(^|/)${regex}(/|$)`);
}

/**
 * Convenience: load .gitignore from a project dir and return a predicate.
 */
export async function loadIgnorePredicate(
  projectDir: string,
): Promise<(relativePath: string, isDirectory?: boolean) => boolean> {
  const patterns = await parseGitignore(projectDir);
  return buildIgnorePredicate(patterns);
}

/**
 * Check if a single directory entry name should be skipped.
 * Quick check for the always-excluded list — useful in directory walkers
 * before constructing full relative paths.
 */
export function isAlwaysExcluded(name: string): boolean {
  return ALWAYS_EXCLUDED.includes(name) || isEnvFile(name);
}
