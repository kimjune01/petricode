import { readFile } from "fs/promises";

const FILE_REF_PATTERN = /@([^\s]+)/g;

/**
 * Expand @path references in input text by inlining file contents.
 */
export async function expandFileRefs(input: string): Promise<string> {
  const matches = [...input.matchAll(FILE_REF_PATTERN)];
  if (matches.length === 0) return input;

  // Build replacement map in one pass to avoid global replace on evolving output
  const replacements = new Map<string, string>();
  for (const match of matches) {
    const fullMatch = match[0]!;
    if (replacements.has(fullMatch)) continue;
    const rawPath = match[1]!;
    const filePath = rawPath.replace(/[.,;:!?]+$/, "");
    try {
      const contents = await readFile(filePath, "utf-8");
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
