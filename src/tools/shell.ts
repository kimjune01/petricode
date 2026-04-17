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

      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let truncated = false;

      const collect = (d: Buffer, sink: "out" | "err") => {
        if (truncated) return;
        outputBytes += d.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          proc.kill("SIGTERM");
          return;
        }
        if (sink === "out") stdout += d.toString();
        else stderr += d.toString();
      };
      proc.stdout.on("data", (d: Buffer) => collect(d, "out"));
      proc.stderr.on("data", (d: Buffer) => collect(d, "err"));

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

      proc.on("close", (code) => {
        cleanup();
        let output = (stdout + stderr).trimEnd();
        if (truncated) {
          output += `\n[output truncated — exceeded ${MAX_OUTPUT_BYTES} bytes]`;
        }
        if (code !== 0) {
          resolve(`[exit ${code}]\n${output}`);
        } else {
          resolve(output);
        }
      });

      proc.on("error", (err) => {
        cleanup();
        reject(new Error(`shell: ${err.message}`));
      });
    });
  },
};
