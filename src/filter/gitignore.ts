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
  // Split into positive and negative patterns
  const positive: RegExp[] = [];
  const negative: RegExp[] = [];

  for (const pat of patterns) {
    if (pat.startsWith("!")) {
      negative.push(patternToRegex(pat.slice(1)));
    } else {
      positive.push(patternToRegex(pat));
    }
  }

  return (relativePath: string): boolean => {
    const segments = relativePath.split("/");

    // Always-excluded: check every path segment
    for (const seg of segments) {
      if (ALWAYS_EXCLUDED.includes(seg) || isEnvFile(seg)) {
        return true;
      }
    }

    // Check gitignore patterns against the full relative path
    // and against each path segment (for directory patterns)
    let ignored = false;

    for (const re of positive) {
      if (re.test(relativePath) || segments.some((seg) => re.test(seg))) {
        ignored = true;
        break;
      }
    }

    if (ignored) {
      // Check negation patterns
      for (const re of negative) {
        if (re.test(relativePath) || segments.some((seg) => re.test(seg))) {
          return false;
        }
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

  // Convert glob patterns to regex
  regex = regex
    .replace(/\*\*/g, "⟨GLOBSTAR⟩")
    .replace(/\*/g, "[^/]*")
    .replace(/⟨GLOBSTAR⟩/g, ".*")
    .replace(/\?/g, "[^/]");

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
