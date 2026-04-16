import { readFile } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { validateFilePath } from "../filter/pathValidation.js";

const FILE_REF_PATTERN = /@([^\s]+)/g;

/**
 * Expand @path references in input text by inlining file contents.
 *
 * Paths must resolve inside `projectDir` — anything outside (e.g. @/etc/passwd,
 * @~/.ssh/id_rsa) is silently left as-is. Read failures are also silent so a
 * stray @-mention in pasted text doesn't reveal whether a file exists.
 */
export async function expandFileRefs(input: string, projectDir: string): Promise<string> {
  const matches = [...input.matchAll(FILE_REF_PATTERN)];
  if (matches.length === 0) return input;

  // Build replacement map in one pass to avoid global replace on evolving output
  const replacements = new Map<string, string>();
  for (const match of matches) {
    const fullMatch = match[0]!;
    if (replacements.has(fullMatch)) continue;
    const rawPath = match[1]!;
    const filePath = rawPath.replace(/[.,;:!?]+$/, "");
    if (validateFilePath(filePath, projectDir)) continue;
    // validateFilePath confirms projectDir-relative resolution stays inside
    // projectDir, but readFile resolves relative paths against process.cwd().
    // If petricode was launched from outside projectDir, that mismatch would
    // splice the wrong file's contents under a misleading <file path="..."> tag.
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
    try {
      const contents = await readFile(absPath, "utf-8");
      replacements.set(fullMatch, `\n<file path="${filePath}">\n${contents}\n</file>`);
    } catch {
      // Do nothing, leave as-is
    }
  }

  // Single-pass replacement using the pattern
  return input.replace(FILE_REF_PATTERN, (fullMatch) => {
    return replacements.get(fullMatch) ?? fullMatch;
  });
}
