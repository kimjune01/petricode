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
      // Refuse non-regular files: open() on a FIFO or character device
      // blocks until the other end speaks, hanging the agent indefinitely.
      if (!stats.isFile()) {
        throw new Error(`not a regular file: ${path}`);
      }
      // Mirror fileRefs.ts: always read up to MAX_READ_BYTES into a
      // Buffer, sniff the first 4096 bytes for NUL, and refuse on
      // binary content. Without this, the model could `file_read` a
      // 200KB PNG / sqlite db / compiled binary and the raw bytes
      // decoded as UTF-8 became a string of replacement chars and
      // garbage that displaced useful context. Always allocating
      // MAX_READ_BYTES (rather than capping by stats.size) also
      // handles virtual files (/proc/*, /sys/*) that report size 0
      // but yield real content.
      const fh = await open(resolved, "r");
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES);
        const { bytesRead } = await fh.read(buf, 0, MAX_READ_BYTES, 0);
        const head = buf.slice(0, Math.min(bytesRead, 4096));
        if (head.indexOf(0) !== -1) {
          throw new Error(`binary file (NUL bytes detected): ${path}`);
        }
        // Whether the file actually exceeded the cap depends on what
        // we read; stats.size lies for virtual files (/proc, /sys
        // report 0 but yield content) so we can't trust it as the
        // sole signal. But when stats.size IS reliable (positive and
        // ≤ cap), it's the only way to distinguish "exact-multiple
        // of MAX_READ_BYTES read in full" from "first MAX_READ_BYTES
        // of a larger file": fh.read fills the buffer to the brim in
        // both cases, so bytesRead alone can't tell them apart.
        const truncated =
          bytesRead >= MAX_READ_BYTES &&
          !(stats.size > 0 && stats.size <= MAX_READ_BYTES);
        // Mirror fileRefs.ts: TextDecoder with stream:true holds back
        // an incomplete trailing UTF-8 sequence instead of decoding it
        // to U+FFFD. Without this, truncating a CJK / emoji / accented
        // file at MAX_READ_BYTES could bisect a multi-byte char and
        // garble the last visible glyph just before the truncation
        // marker. Pass stream:true only when truncated; for full reads
        // any trailing incomplete bytes ARE a real decode error and
        // should surface as U+FFFD (matches fileRefs.ts behavior).
        const decoder = new TextDecoder("utf-8");
        const body = decoder.decode(
          buf.slice(0, bytesRead),
          { stream: truncated },
        );
        if (!truncated) return body;
        // For virtual files (/proc, /sys) stats.size is 0 even though
        // the read returned content; "≥<cap>" is the honest description.
        // Pre-fix the interpolation used `||` with `+`, which produces
        // "≥262144" with no space and no "bytes" unit on size-0 files.
        const sizeDesc =
          stats.size > 0 ? `${stats.size} bytes` : `≥${MAX_READ_BYTES} bytes`;
        return `${body}\n[truncated — file is ${sizeDesc}, showing first ${MAX_READ_BYTES} bytes]`;
      } finally {
        await fh.close();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`file_read: ${msg}`);
    }
  },
};
