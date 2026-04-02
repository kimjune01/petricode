import { readFile as fsReadFile } from "fs/promises";
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

  async execute(args) {
    const path = args.path as string;
    if (!path) throw new Error("file_read: missing required argument 'path'");
    try {
      return await fsReadFile(path, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`file_read: ${msg}`);
    }
  },
};
