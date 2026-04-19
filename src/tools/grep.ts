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
        // -I: skip binary files. Without it, grep emits `Binary file X
        // matches` lines that lack the `path:lineno:text` shape and so
        // bypass the post-filter's gitignore check (no colon → kept) —
        // letting `dist/bundle.js` matches flood the LLM context.
        "-I",
        // -D skip: don't follow into FIFOs/character devices. Without it,
        // grep blocks indefinitely on a named pipe inside the search tree.
        "-D",
        "skip",
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
      // setEncoding aligns chunk boundaries to whole UTF-8 code points.
      // Without it, a multi-byte char split across two 'data' events
      // decodes to U+FFFD on each half — corrupting CJK/emoji matches.
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");

      let output = "";
      let outputBytes = 0;
      let truncated = false;
      const collect = (chunk: string) => {
        if (truncated) return;
        const chunkBytes = Buffer.byteLength(chunk, "utf8");
        if (outputBytes + chunkBytes > MAX_OUTPUT_BYTES) {
          // Append the largest UTF-8-safe slice of `chunk` that still
          // fits under the limit instead of throwing the whole chunk
          // (up to ~64KB) away. Walk by character so we don't split a
          // multibyte codepoint mid-sequence — setEncoding gave us a
          // string of complete codepoints; Buffer.byteLength below
          // rebuilds the byte cost per char.
          const remaining = MAX_OUTPUT_BYTES - outputBytes;
          let kept = "";
          let keptBytes = 0;
          for (const ch of chunk) {
            const n = Buffer.byteLength(ch, "utf8");
            if (keptBytes + n > remaining) break;
            kept += ch;
            keptBytes += n;
          }
          if (kept) {
            output += kept;
            outputBytes += keptBytes;
          }
          truncated = true;
          proc.kill("SIGTERM");
          return;
        }
        outputBytes += chunkBytes;
        output += chunk;
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
            // grep -n emits `path:lineno:text`. Naive indexOf(":") would
            // truncate paths that legitimately contain a colon (rare on
            // POSIX, common on Windows-shared mounts and `My:File.tsx`
            // style names) and pass the wrong path to isIgnored. Anchor
            // on the FIRST `:digit+:` boundary, which is unambiguous —
            // the lineno field is always digits.
            const sep = line.match(/^(.+?):\d+:/);
            if (!sep) return true;
            const filePath = sep[1]!;
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
