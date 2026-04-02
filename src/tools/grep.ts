import { spawn } from "child_process";
import type { Tool } from "./tool.js";

export const GrepTool: Tool = {
  name: "grep",
  description: "Search for a regex pattern in files. Returns matching lines.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: {
        type: "string",
        description: "Directory or file to search in (default: cwd)",
      },
      glob: {
        type: "string",
        description: "File glob filter (e.g. '*.ts')",
      },
    },
    required: ["pattern"],
  },

  async execute(args) {
    const pattern = args.pattern as string;
    if (!pattern) throw new Error("grep: missing required argument 'pattern'");
    const searchPath = (args.path as string) ?? ".";
    const glob = args.glob as string | undefined;

    return new Promise<string>((resolve, reject) => {
      const grepArgs = ["-rn", ...(glob ? ["--include", glob] : []), "--", pattern, searchPath];
      const proc = spawn("grep", grepArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      proc.stdout.on("data", (d: Buffer) => (output += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (output += d.toString()));

      proc.on("close", (code) => {
        // grep exits 1 when no matches found — not an error
        if (code !== null && code > 1) {
          resolve(`[exit ${code}]\n${output.trimEnd()}`);
        } else {
          resolve(output.trimEnd() || "(no matches)");
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`grep: ${err.message}`));
      });
    });
  },
};
