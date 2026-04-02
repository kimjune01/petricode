import { writeFile as fsWriteFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { Tool } from "./tool.js";

export const WriteFileTool: Tool = {
  name: "file_write",
  description: "Write content to a file, creating parent directories if needed.",
  input_schema: {
    properties: {
      path: { type: "string", description: "Absolute path to write" },
      content: { type: "string", description: "File content" },
    },
    required: ["path", "content"],
  },

  async execute(args) {
    const path = args.path as string;
    const content = args.content as string;
    if (!path) throw new Error("file_write: missing required argument 'path'");
    if (content === undefined || content === null)
      throw new Error("file_write: missing required argument 'content'");
    try {
      await mkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, content, "utf-8");
      return `Wrote ${content.length} bytes to ${path}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`file_write: ${msg}`);
    }
  },
};
