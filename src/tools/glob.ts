import { Glob as BunGlob } from "bun";
import type { Tool } from "./tool.js";

export const GlobTool: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern. Returns matched paths.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern (e.g. '**/*.ts')" },
      path: {
        type: "string",
        description: "Base directory to search from (default: cwd)",
      },
    },
    required: ["pattern"],
  },

  async execute(args) {
    const pattern = args.pattern as string;
    if (!pattern) throw new Error("glob: missing required argument 'pattern'");
    const cwd = (args.path as string) ?? ".";

    const glob = new BunGlob(pattern);
    const results: string[] = [];
    for await (const path of glob.scan({ cwd, dot: false })) {
      results.push(path);
    }
    results.sort();
    return results.join("\n") || "(no matches)";
  },
};
