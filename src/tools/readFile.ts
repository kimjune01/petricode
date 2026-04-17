import { stat, open } from "fs/promises";
import { isAbsolute, resolve } from "path";
import type { Tool } from "./tool.js";

// Cap reads so a model issuing `file_read` on /var/log/system.log or a
// 50 MB build artifact can't OOM the agent. Above this, we return a
// truncated head with a [truncated …] suffix so the model gets actionable
// content instead of a downstream `[masked]` opaque blob.
const MAX_READ_BYTES = 262_144; // 256 KB

export const ReadFileTool: Tool = {
  name: "file_read",
  description:
    "Read the contents of a file at the given path. Files above 256KB are truncated.",
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
      const stats = await stat(resolved);
      if (stats.size <= MAX_READ_BYTES) {
        const fh = await open(resolved, "r");
        try {
          return await fh.readFile("utf-8");
        } finally {
          await fh.close();
        }
      }
      const fh = await open(resolved, "r");
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES);
        const { bytesRead } = await fh.read(buf, 0, MAX_READ_BYTES, 0);
        const head = buf.slice(0, bytesRead).toString("utf-8");
        return `${head}\n[truncated — file is ${stats.size} bytes, showing first ${MAX_READ_BYTES}]`;
      } finally {
        await fh.close();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`file_read: ${msg}`);
    }
  },
};
