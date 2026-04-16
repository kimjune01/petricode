import { Glob as BunGlob } from "bun";
import { join, isAbsolute, relative } from "path";
import type { Tool } from "./tool.js";
import { loadIgnorePredicate } from "../filter/gitignore.js";

export const GlobTool: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern. Returns matched paths.",
  input_schema: {
    properties: {
      pattern: { type: "string", description: "Glob pattern (e.g. '**/*.ts')" },
      path: {
        type: "string",
        description: "Base directory to search from (default: cwd)",
      },
    },
    required: ["pattern"],
  },

  async execute(args, opts) {
    const pattern = args.pattern as string;
    if (!pattern) throw new Error("glob: missing required argument 'pattern'");
    const projectRoot = opts?.cwd ?? process.cwd();
    const cwd = (args.path as string) ?? projectRoot;

    // Load .gitignore from project root, not from the search subdirectory.
    const isIgnored = await loadIgnorePredicate(projectRoot);

    // Compute the search dir's offset from project root so we can
    // reconstruct root-relative paths for the ignore predicate.
    const cwdPrefix = isAbsolute(cwd) ? relative(projectRoot, cwd) : cwd;

    const glob = new BunGlob(pattern);
    const results: string[] = [];
    for await (const path of glob.scan({ cwd, dot: false })) {
      // Reconstruct root-relative path for ignore matching.
      const rootRelative = cwdPrefix === "." || cwdPrefix === ""
        ? path
        : join(cwdPrefix, path);
      if (!isIgnored(rootRelative)) {
        results.push(path);
      }
    }
    results.sort();
    return results.join("\n") || "(no matches)";
  },
};
