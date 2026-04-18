import { spawn } from "child_process";
import { isAbsolute, relative, normalize } from "path";
import type { Tool } from "./tool.js";
import { loadIgnorePredicate } from "../filter/gitignore.js";

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_BYTES = 1_048_576;

export const GrepTool: Tool = {
  name: "grep",
  description: "Search for a regex pattern in files. Returns matching lines.",
  input_schema: {
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
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 30000)",
      },
    },
    required: ["pattern"],
  },

  async execute(args, opts) {
    const pattern = args.pattern as string;
    if (!pattern) throw new Error("grep: missing required argument 'pattern'");
    const projectRoot = opts?.cwd ?? process.cwd();
    const searchPath = (args.path as string) ?? ".";
    const glob = args.glob as string | undefined;
    const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;
    const signal = opts?.signal;

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // Honor the project's .gitignore so the model isn't drowned in build-
    // artifact hits when it greps for a function name. The shell-level
    // --exclude-dir/--exclude flags only cover .git/node_modules/.env*;
    // anything else (`dist/`, `build/`, generated stubs) was leaking
    // through. Post-filter rather than try to translate full gitignore
    // syntax (globstars, negation, anchors) into grep --exclude flags.
    const isIgnored = await loadIgnorePredicate(projectRoot);

    return new Promise<string>((resolve, reject) => {
      const grepArgs = [
        // -E for extended regex: LLMs write ERE-style patterns (`foo|bar`,
        // `\d+`) and BRE silently treats `|`/`+` as literals, returning
        // zero matches and leading the model to conclude the pattern is
        // genuinely absent.
        "-rnE",
        "--exclude-dir=.git",
        "--exclude-dir=node_modules",
        "--exclude=.env*",
        ...(glob ? ["--include", glob] : []),
        "--",
        pattern,
        searchPath,
      ];
      const proc = spawn("grep", grepArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: projectRoot,
      });

      let output = "";
      let outputBytes = 0;
      let truncated = false;
      const collect = (d: Buffer) => {
        if (truncated) return;
        outputBytes += d.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          proc.kill("SIGTERM");
          return;
        }
        output += d.toString();
      };
      proc.stdout.on("data", collect);
      proc.stderr.on("data", collect);

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        cleanup();
        reject(new Error(`grep: command timed out after ${timeout}ms`));
      }, timeout);
      const onAbort = () => {
        proc.kill("SIGTERM");
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      proc.on("close", (code) => {
        cleanup();
        const suffix = truncated ? "\n[output truncated — exceeded 1MB]" : "";
        // grep exits 1 when no matches found — not an error
        if (code !== null && code > 1 && !truncated) {
          resolve(`[exit ${code}]\n${output.trimEnd()}${suffix}`);
          return;
        }
        // Drop matches that fall under .gitignore. Each line is
        // `path:lineno:text`; the first colon separates the path. Paths
        // grep emits are relative to its cwd (projectRoot), or absolute
        // if the caller passed an absolute search path — normalize both
        // to a project-root-relative form before consulting the predicate.
        const filtered = output
          .split("\n")
          .filter((line) => {
            if (!line) return false;
            const colon = line.indexOf(":");
            if (colon <= 0) return true;
            const filePath = line.slice(0, colon);
            // grep -r emits paths relative to its cwd, prefixed `./` when
            // the search arg was `.`. normalize() collapses that prefix
            // (and any `foo/./bar`) so the predicate sees `src/foo.ts`,
            // not `./src/foo.ts` — gitignore patterns like `dist/` would
            // otherwise miss the leading-dot form entirely.
            const rel = isAbsolute(filePath)
              ? relative(projectRoot, filePath)
              : normalize(filePath);
            // Path may escape projectRoot when the caller searches
            // outside (rare, but supported). Don't filter what we can't
            // reason about — relative() returns "../..." in that case.
            if (rel.startsWith("..")) return true;
            return !isIgnored(rel, false);
          })
          .join("\n");
        resolve((filtered.trimEnd() || "(no matches)") + suffix);
      });

      proc.on("error", (err) => {
        cleanup();
        reject(new Error(`grep: ${err.message}`));
      });
    });
  },
};
