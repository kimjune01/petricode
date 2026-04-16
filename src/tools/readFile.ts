import { readFile as fsReadFile } from "fs/promises";
import { isAbsolute, resolve } from "path";
import type { Tool } from "./tool.js";

export const ReadFileTool: Tool = {
  name: "file_read",
  description: "Read the contents of a file at the given path.",
  input_schema: {
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
    },
    required: ["path"],
  },

  async execute(args, opts) {
    const path = args.path as string;
    if (!path) throw new Error("file_read: missing required argument 'path'");
    // Relative paths must resolve against projectDir, not process.cwd().
    // Otherwise validateFilePath green-lights "src/foo.ts" against projectDir
    // while readFile opens <process.cwd()>/src/foo.ts — wrong file, possibly
    // outside the validated tree.
    const cwd = opts?.cwd ?? process.cwd();
    const resolved = isAbsolute(path) ? path : resolve(cwd, path);
    try {
      return await fsReadFile(resolved, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`file_read: ${msg}`);
    }
  },
};
