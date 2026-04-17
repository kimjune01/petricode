import { open, stat } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { validateFilePath } from "../filter/pathValidation.js";

const FILE_REF_PATTERN = /@([^\s]+)/g;
// Mirrors ReadFileTool's MAX_READ_BYTES so an `@huge.log` mention can't
// dump unbounded bytes into the prompt — the per-tool cap meant nothing
// when fileRefs.ts inlined files via raw readFile().
const MAX_READ_BYTES = 262_144; // 256 KB

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
    const trailingMatch = rawPath.match(/[.,;:!?]+$/);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const filePath = trailing ? rawPath.slice(0, -trailing.length) : rawPath;
    if (validateFilePath(filePath, projectDir)) continue;
    // validateFilePath confirms projectDir-relative resolution stays inside
    // projectDir, but readFile resolves relative paths against process.cwd().
    // If petricode was launched from outside projectDir, that mismatch would
    // splice the wrong file's contents under a misleading <file path="..."> tag.
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
    try {
      const stats = await stat(absPath);
      const fh = await open(absPath, "r");
      let contents: string;
      try {
        if (stats.size <= MAX_READ_BYTES) {
          contents = await fh.readFile("utf-8");
        } else {
          const buf = Buffer.alloc(MAX_READ_BYTES);
          const { bytesRead } = await fh.read(buf, 0, MAX_READ_BYTES, 0);
          contents = `${buf.slice(0, bytesRead).toString("utf-8")}\n[truncated — file is ${stats.size} bytes, showing first ${MAX_READ_BYTES}]`;
        }
      } finally {
        await fh.close();
      }
      // Reattach the trailing punctuation we stripped from the path —
      // otherwise `What about @README.md, @LICENSE?` would lose the
      // comma and the question mark from the user's prose.
      replacements.set(
        fullMatch,
        `\n<file path="${filePath}">\n${contents}\n</file>${trailing}`,
      );
    } catch {
      // Do nothing, leave as-is
    }
  }

  // Single-pass replacement using the pattern
  return input.replace(FILE_REF_PATTERN, (fullMatch) => {
    return replacements.get(fullMatch) ?? fullMatch;
  });
}
