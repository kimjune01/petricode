import { writeFile as fsWriteFile, mkdir, stat } from "fs/promises";
import { dirname, isAbsolute, resolve } from "path";
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

  async execute(args, opts) {
    const path = args.path as string;
    const content = args.content as string;
    if (!path) throw new Error("file_write: missing required argument 'path'");
    if (content === undefined || content === null)
      throw new Error("file_write: missing required argument 'content'");
    // Same hazard as file_read: relative paths must resolve against projectDir
    // so the validated path and the IO target agree.
    const cwd = opts?.cwd ?? process.cwd();
    const resolved = isAbsolute(path) ? path : resolve(cwd, path);
    try {
      // If the target already exists and isn't a regular file, refuse:
      // writing to a FIFO blocks until a reader appears, hanging the agent.
      try {
        const existing = await stat(resolved);
        if (!existing.isFile()) {
          throw new Error(`file_write: not a regular file: ${path}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("ENOENT")) throw err;
      }
      await mkdir(dirname(resolved), { recursive: true });
      await fsWriteFile(resolved, content, "utf-8");
      return `Wrote ${content.length} bytes to ${path}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`file_write: ${msg}`);
    }
  },
};
