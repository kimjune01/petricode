// ── Path validation for file tool arguments ─────────────────────
// Validates paths before tool execution to prevent directory traversal,
// symlink escapes, and absolute path breakouts.
//
// Design: fail-closed. Non-string paths, unresolvable paths, and anything
// outside the project boundary are rejected.

import { realpathSync } from "fs";
import { normalize, isAbsolute, resolve, sep, dirname } from "path";

/** Tools whose path argument targets a specific file. */
const FILE_TOOLS = new Set(["file_read", "file_write", "edit"]);

/** Tools whose path argument is a search base directory. */
const SEARCH_TOOLS = new Set(["glob", "grep"]);

/** All argument keys that may contain file paths. */
const PATH_KEYS = ["path", "file_path", "file", "filename"] as const;

export interface PathValidationError {
  field: string;
  message: string;
}

/**
 * Validate tool call arguments for path safety.
 * Returns null if valid, or an error description if invalid.
 *
 * Fail-closed: if the path argument exists but is not a string, validation
 * rejects it rather than silently passing.
 */
export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  projectDir: string,
): PathValidationError | null {
  const validate = FILE_TOOLS.has(toolName)
    ? validateFilePath
    : SEARCH_TOOLS.has(toolName)
      ? validateSearchPath
      : null;

  if (!validate) return null;

  // Validate ALL path argument keys — an LLM could send multiple aliases
  // and we must not let a valid one mask an invalid one.
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      return { field: key, message: `${key} must be a string` };
    }
    const err = validate(value, projectDir);
    if (err) return err;
  }

  return null;
}

/**
 * Validate a file path (for read/write/edit tools).
 *
 * Strategy:
 *   1. Lexical: reject null bytes, '..' segments
 *   2. Boundary: resolve to absolute and confirm it's within projectDir
 *   3. Symlink: for existing files, use realpathSync to resolve symlinks
 *      and re-check containment
 */
function validateFilePath(
  path: string,
  projectDir: string,
): PathValidationError | null {
  // Block null bytes (can truncate paths in C-backed syscalls)
  if (path.includes("\0")) {
    return { field: "path", message: `Path contains null byte: "${path}"` };
  }

  // Normalize, handling both / and \ separators
  const normalized = normalize(path);

  // Block directory traversal (lexical check on normalized path)
  if (containsTraversal(normalized)) {
    return {
      field: "path",
      message: `Path contains directory traversal (..): "${path}"`,
    };
  }

  // Resolve to absolute path for boundary check
  const resolvedProject = resolve(projectDir);
  const resolvedPath = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(projectDir, normalized);

  // Must be within project directory
  if (
    !resolvedPath.startsWith(resolvedProject + sep) &&
    resolvedPath !== resolvedProject
  ) {
    return {
      field: "path",
      message: `Path must be within the project directory: "${path}"`,
    };
  }

  // Symlink check: if the file already exists, resolve the real path
  // and verify it's still within the project boundary.
  // For file_write targeting a new file, realpathSync will throw — that's fine,
  // the lexical check above is sufficient for new files.
  // Symlink check: resolve the real path and verify containment.
  // For new files, walk up to the nearest existing parent directory
  // to catch directory symlinks pointing outside the project.
  try {
    const realTarget = realpathSync(resolvedPath);
    const realProject = realpathSync(resolvedProject);
    if (
      !realTarget.startsWith(realProject + sep) &&
      realTarget !== realProject
    ) {
      return {
        field: "path",
        message: `Path resolves via symlink outside the project directory: "${path}"`,
      };
    }
  } catch {
    // File doesn't exist — walk up to the nearest existing ancestor
    // and verify IT is within the project boundary (catches dir symlinks).
    let ancestor = dirname(resolvedPath);
    while (ancestor !== dirname(ancestor)) {
      try {
        const realAncestor = realpathSync(ancestor);
        const realProject = realpathSync(resolvedProject);
        if (
          !realAncestor.startsWith(realProject + sep) &&
          realAncestor !== realProject
        ) {
          return {
            field: "path",
            message: `Path resolves via symlink outside the project directory: "${path}"`,
          };
        }
        break; // found an existing ancestor inside the project — OK
      } catch {
        ancestor = dirname(ancestor);
      }
    }
  }

  return null;
}

/**
 * Validate a search path (for glob/grep tools).
 * Same containment rules, no file-extension requirement.
 */
function validateSearchPath(
  path: string,
  projectDir: string,
): PathValidationError | null {
  if (path.includes("\0")) {
    return { field: "path", message: `Search path contains null byte` };
  }

  const normalized = normalize(path);

  if (containsTraversal(normalized)) {
    return {
      field: "path",
      message: `Search path contains directory traversal (..): "${path}"`,
    };
  }

  const resolvedProject = resolve(projectDir);
  const resolvedPath = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(projectDir, normalized);

  if (
    !resolvedPath.startsWith(resolvedProject + sep) &&
    resolvedPath !== resolvedProject
  ) {
    return {
      field: "path",
      message: `Search path must be within the project directory: "${path}"`,
    };
  }

  // Symlink check for existing directories
  try {
    const realTarget = realpathSync(resolvedPath);
    const realProject = realpathSync(resolvedProject);
    if (
      !realTarget.startsWith(realProject + sep) &&
      realTarget !== realProject
    ) {
      return {
        field: "path",
        message: `Search path resolves via symlink outside the project: "${path}"`,
      };
    }
  } catch {
    // Directory doesn't exist — lexical check suffices
  }

  return null;
}

/**
 * Check if a normalized path contains '..' traversal.
 * Uses the platform separator so it works on both Unix and Windows.
 */
function containsTraversal(normalized: string): boolean {
  // After normalize(), segments are split by the platform separator
  const segments = normalized.split(sep);
  return segments.some((seg) => seg === "..");
}
