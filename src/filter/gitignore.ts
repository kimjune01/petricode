// ── .gitignore filtering ─────────────────────────────────────────
// Parses .gitignore and provides an isIgnored(path) predicate.
// Hardcodes .git, node_modules, .env, .env.* as always-excluded.

import { readFile } from "fs/promises";
import { join } from "path";

/** Directories/files always excluded regardless of .gitignore content. */
const ALWAYS_EXCLUDED = [".git", "node_modules", ".env"];

/** Check if a segment matches a .env pattern (.env, .env.local, etc.) */
function isEnvFile(segment: string): boolean {
  return segment === ".env" || segment.startsWith(".env.");
}

/**
 * Parse a .gitignore file into an array of patterns.
 * Returns empty array if the file doesn't exist.
 */
export async function parseGitignore(projectDir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(projectDir, ".gitignore"), "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Convert gitignore patterns to a predicate function.
 * Handles simple patterns: directory names, globs with *, negation (!).
 *
 * @param patterns - parsed gitignore lines
 * @returns predicate: (relativePath) => true if ignored
 */
export function buildIgnorePredicate(
  patterns: string[],
): (relativePath: string) => boolean {
  // Per gitignore semantics, patterns are evaluated in source order and the
  // LAST matching pattern decides — a later negation overrides an earlier
  // ignore, and a later ignore re-overrides that negation. Splitting into
  // positive/negative arrays loses this ordering.
  const compiled = patterns.map((pat) => {
    const negate = pat.startsWith("!");
    return { negate, re: patternToRegex(negate ? pat.slice(1) : pat) };
  });

  return (relativePath: string): boolean => {
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
    let ignored = false;
    for (const { negate, re } of compiled) {
      const isAnchored = re.source.startsWith("^") && !re.source.startsWith("(^|/");
      if (re.test(relativePath) || (!isAnchored && segments.some((seg) => re.test(seg)))) {
        ignored = !negate;
      }
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

  // Escape regex special chars except * and ?
  let regex = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");

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
    .replace(/⟨SLASHGLOBSTAR⟩/g, "(/.*)?/")
    .replace(/⟨LEADGLOBSTAR⟩/g, "(.*/)?")
    .replace(/⟨GLOBSTAR⟩/g, ".*");

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
): Promise<(relativePath: string) => boolean> {
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
