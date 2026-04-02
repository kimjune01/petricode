import { readFile, writeFile } from "fs/promises";
import type { Tool } from "./tool.js";

export const EditTool: Tool = {
  name: "edit",
  description:
    "Replace an exact string in a file. The old_string must appear exactly once unless replace_all is true. " +
    "Fails if old_string is not found or is ambiguous (multiple matches without replace_all).",
  input_schema: {
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
      old_string: { type: "string", description: "Exact text to find" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences (default false)",
      },
    },
    required: ["path", "old_string", "new_string"],
  },

  async execute(args) {
    const path = args.path as string;
    const oldStr = args.old_string as string;
    const newStr = args.new_string as string;
    const replaceAll = (args.replace_all as boolean) ?? false;

    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT")) {
        throw new Error(`edit: file not found: ${path}`);
      }
      throw new Error(`edit: cannot read ${path}: ${msg}`);
    }

    if (!oldStr) {
      throw new Error("edit: old_string must not be empty");
    }

    if (oldStr === newStr) {
      throw new Error("edit: old_string and new_string are identical");
    }

    const occurrences = content.split(oldStr).length - 1;

    if (occurrences === 0) {
      throw new Error(
        `edit: old_string not found in ${path}`,
      );
    }

    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `edit: old_string found ${occurrences} times in ${path}. ` +
          `Set replace_all to true, or provide more context to make the match unique.`,
      );
    }

    const updated = replaceAll
      ? content.replaceAll(oldStr, newStr)
      : content.replace(oldStr, newStr);

    await writeFile(path, updated, "utf-8");

    const count = replaceAll ? occurrences : 1;
    return `Replaced ${count} occurrence${count > 1 ? "s" : ""} in ${path}`;
  },
};
