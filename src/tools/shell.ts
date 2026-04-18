import { spawn } from "child_process";
import type { Tool } from "./tool.js";

const DEFAULT_TIMEOUT = 30_000;
// Cap output to protect the agent from `cat /dev/urandom`, `yes`, and
// other unbounded producers that would OOM the Node heap before the
// timeout fires. 1 MB matches grep.ts; downstream maskToolOutput
// replaces anything larger with a placeholder anyway.
const MAX_OUTPUT_BYTES = 1_048_576;

export const ShellTool: Tool = {
  name: "shell",
  description: "Execute a shell command and return stdout+stderr.",
  input_schema: {
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 30000)",
      },
    },
    required: ["command"],
  },

  async execute(args, opts) {
    const command = args.command as string;
    if (!command) throw new Error("shell: missing required argument 'command'");
    const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;
    const signal = opts?.signal;
    const cwd = opts?.cwd ?? process.cwd();

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    return new Promise<string>((resolve, reject) => {
      const proc = spawn("sh", ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd,
      });
      // Force UTF-8 chunk decoding: without setEncoding, raw Buffer
      // chunks emitted by Node may split a multi-byte char across two
      // 'data' events, and Buffer.toString() on each half emits U+FFFD
      // replacement chars. setEncoding aligns chunk boundaries to whole
      // code points using the stream's internal StringDecoder.
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");

      // Single shared buffer: append both streams in arrival order so the
      // model sees output and error lines interleaved as they happened.
      // Splitting into stdout/stderr and concatenating at the end (`stdout
      // + stderr`) puts every error after every regular line, which made
      // build/test failures look unrelated to the command they came from.
      let output = "";
      let outputBytes = 0;
      let truncated = false;

      const collect = (chunk: string) => {
        if (truncated) return;
        // Byte length: utf8 strings can be 1–4 bytes per code point and
        // we're protecting against output-size OOM, not character-count.
        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          proc.kill("SIGTERM");
          return;
        }
        output += chunk;
      };
      proc.stdout.on("data", collect);
      proc.stderr.on("data", collect);

      // Single cleanup so timeout / abort / close / error all fully detach.
      // Without this the abort listener leaks past timeout fires.
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        cleanup();
        reject(new Error(`shell: command timed out after ${timeout}ms`));
      }, timeout);

      const onAbort = () => {
        proc.kill("SIGTERM");
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      proc.on("close", (code, signalName) => {
        cleanup();
        let trimmed = output.trimEnd();
        if (truncated) {
          trimmed += `\n[output truncated — exceeded ${MAX_OUTPUT_BYTES} bytes]`;
        }
        // Signal-terminated processes report code=null. Render the signal
        // name instead of "[exit null]" so a SIGSEGV / our own SIGTERM
        // (truncation) / SIGKILL (timeout) is legible to the model.
        if (code !== null && code !== 0) {
          resolve(`[exit ${code}]\n${trimmed}`);
        } else if (code === null && signalName) {
          resolve(`[killed by ${signalName}]\n${trimmed}`);
        } else {
          resolve(trimmed);
        }
      });

      proc.on("error", (err) => {
        cleanup();
        reject(new Error(`shell: ${err.message}`));
      });
    });
  },
};
