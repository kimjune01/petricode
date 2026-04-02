import { spawn } from "child_process";
import type { Tool } from "./tool.js";

const DEFAULT_TIMEOUT = 30_000;

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

  async execute(args) {
    const command = args.command as string;
    if (!command) throw new Error("shell: missing required argument 'command'");
    const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;

    return new Promise<string>((resolve, reject) => {
      const proc = spawn("sh", ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`shell: command timed out after ${timeout}ms`));
      }, timeout);

      proc.on("close", (code) => {
        clearTimeout(timer);
        const output = (stdout + stderr).trimEnd();
        if (code !== 0) {
          resolve(`[exit ${code}]\n${output}`);
        } else {
          resolve(output);
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`shell: ${err.message}`));
      });
    });
  },
};
