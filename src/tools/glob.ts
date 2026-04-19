import { Glob as BunGlob } from "bun";
import { join, isAbsolute, relative, resolve } from "path";
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
    // The model-supplied path is relative to projectRoot, NOT process.cwd().
    // BunGlob.scan({cwd}) would otherwise resolve "src" against process.cwd(),
    // bypassing the projectRoot validation done in toolSubpipe.
    const rawPath = args.path as string | undefined;
    const cwd = rawPath
      ? (isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath))
      : projectRoot;

    // Load .gitignore from project root, not from the search subdirectory.
    const isIgnored = await loadIgnorePredicate(projectRoot);

    // Compute the search dir's offset from project root so we can
    // reconstruct root-relative paths for the ignore predicate.
    const cwdPrefix = isAbsolute(cwd) ? relative(projectRoot, cwd) : cwd;

    const glob = new BunGlob(pattern);
    const results: string[] = [];
    // dot: true so `**/*.yml` traverses .github/, .circleci/, etc.
    // Pre-fix `dot: false` silently dropped every hidden directory
    // even when it wasn't gitignored — the model running glob to
    // discover CI config got an empty result and concluded the
    // project had none. Gitignore filtering still excludes
    // .git/, .petricode/, and any user-ignored hidden dir below.
    for await (const path of glob.scan({ cwd, dot: true })) {
      // Reconstruct root-relative path for ignore matching. BunGlob.scan
      // yields files only by default, so dir-only patterns must not match.
      const rootRelative = cwdPrefix === "." || cwdPrefix === ""
        ? path
        : join(cwdPrefix, path);
      if (!isIgnored(rootRelative, false)) {
        results.push(path);
      }
    }
    results.sort();
    return results.join("\n") || "(no matches)";
  },
};
