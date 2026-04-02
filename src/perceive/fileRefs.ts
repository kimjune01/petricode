import { readFile } from "fs/promises";

const FILE_REF_PATTERN = /@(\/[^\s]+)/g;

/**
 * Expand @path references in input text by inlining file contents.
 */
export async function expandFileRefs(input: string): Promise<string> {
  const matches = [...input.matchAll(FILE_REF_PATTERN)];
  if (matches.length === 0) return input;

  let result = input;
  for (const match of matches) {
    const fullMatch = match[0]!;
    const filePath = match[1]!;
    try {
      const contents = await readFile(filePath, "utf-8");
      result = result.replace(
        fullMatch,
        `\n<file path="${filePath}">\n${contents}\n</file>`
      );
    } catch {
      result = result.replace(fullMatch, `[file not found: ${filePath}]`);
    }
  }

  return result;
}
