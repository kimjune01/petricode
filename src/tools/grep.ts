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

    // Reject path-shaped globs up front. `--include` is fnmatch on the
    // basename only — `src/**/*.ts` matches nothing, returns silently
    // (zero hits), and the model concludes the code doesn't exist.
    // LLMs trained on ripgrep semantics pass path globs constantly;
    // surface the misuse with a fixable error instead of lying with
    // empty results. The caller can pass `path: "src"` for directory
    // scoping and `glob: "*.ts"` for the basename filter.
    if (glob && (glob.includes("/") || glob.includes("**"))) {
      throw new Error(
        `grep: 'glob' matches basenames only (e.g. '*.ts'), not paths. `
          + `Got '${glob}'. For directory scoping pass 'path' instead `
          + `(e.g. {path: 'src', glob: '*.ts'}).`,
      );
    }

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
        // --null replaces the colon between path and lineno with a NUL
        // byte. Lets the post-filter parser unambiguously split path from
        // lineno even when the path itself contains `:\d+:` sequences (a
        // file named `src/foo:12:bar.ts` previously got truncated to
        // `src/foo` and bypassed the gitignore check). Long form is
        // portable across BSD grep (macOS) and GNU grep (Linux); BSD's
        // `-Z` is the decompress flag, not --null.
        "--null",
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

      // Pre-filter ignored matches at the collector instead of after
      // the byte cap fires. Without this, a search that hits ignored
      // build artifacts (`dist/bundle.js` with thousands of matches)
      // can saturate the 1MB budget before grep ever reaches `src/`,
      // killing the process and leaving the post-filter with `(no
      // matches)` even though valid hits exist. Line-buffer stdout so
      // we can run isIgnored() on whole `path:lineno:text` records.
      const isLineIgnored = (line: string): boolean => {
        if (!line) return false;
        // With --null on the grep invocation, the path/lineno separator
        // is a NUL byte (path\0lineno:content) instead of a colon. Split
        // on NUL so a file path containing `:\d+:` doesn't truncate
        // before the gitignore check.
        const nul = line.indexOf("\0");
        if (nul === -1) return false;
        const filePath = line.slice(0, nul);
        const rel = isAbsolute(filePath)
          ? relative(projectRoot, filePath)
          : normalize(filePath);
        // Caller searched outside projectRoot — predicate has no
        // basis for filtering, keep the line. Use a precise escape
        // check rather than `startsWith("..")`: bare `startsWith`
        // false-positives on legitimate intra-project files like
        // `..env`, `...config`, `..foo`, exempting them from the
        // gitignore filter and flooding grep with files that should
        // have been excluded.
        if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
          return false;
        }
        // On Windows, path.normalize/relative emit `\`-separated
        // paths; the gitignore predicate splits on `/` and would
        // see the whole path as one segment, missing every
        // dir-level rule. Normalize to forward slashes.
        return isIgnored(rel.replace(/\\/g, "/"), false);
      };

      const append = (piece: string): boolean => {
        const bytes = Buffer.byteLength(piece, "utf8");
        if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
          // Append the largest UTF-8-safe slice that still fits under
          // the cap instead of throwing the whole chunk (~64KB) away.
          // setEncoding('utf8') already aligned chunk boundaries to
          // codepoints; iterating `for (const ch of …)` walks chars
          // (not raw bytes), so Buffer.byteLength gives the cost per
          // codepoint and we never split a multibyte sequence.
          const remaining = MAX_OUTPUT_BYTES - outputBytes;
          let kept = "";
          let keptBytes = 0;
          for (const ch of piece) {
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
          // Clear the timeout the moment truncation fires. If the
          // grep process ignores SIGTERM, the still-armed timer
          // would race in, SIGKILL, and reject the promise with a
          // timeout error — discarding the partial output we just
          // kept. Cleared timer means the close handler resolves
          // with truncated content as expected.
          clearTimeout(timer);
          proc.kill("SIGTERM");
          return false;
        }
        output += piece;
        outputBytes += bytes;
        return true;
      };

      let stdoutBuf = "";
      const collectStdout = (chunk: string) => {
        if (truncated) return;
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line || isLineIgnored(line)) continue;
          if (!append(line + "\n")) return;
        }
      };
      // Stderr isn't `path:lineno:text` (it's grep diagnostics), so
      // skip the line filter — but keep the same byte cap so a
      // runaway stderr can't blow past MAX_OUTPUT_BYTES either.
      const collectStderr = (chunk: string) => {
        if (truncated) return;
        append(chunk);
      };
      proc.stdout.on("data", collectStdout);
      proc.stderr.on("data", collectStderr);

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
        // Flush any trailing line grep emitted without a final \n
        // (last line of file with no terminating newline). Same
        // ignored-line + byte-cap rules as the streaming collector.
        if (stdoutBuf && !truncated) {
          if (!isLineIgnored(stdoutBuf)) append(stdoutBuf);
          stdoutBuf = "";
        }
        const suffix = truncated ? "\n[output truncated — exceeded 1MB]" : "";
        // grep exits 1 when no matches found — not an error
        if (code !== null && code > 1 && !truncated) {
          resolve(`[exit ${code}]\n${output.trimEnd()}${suffix}`);
          return;
        }
        resolve((output.trimEnd() || "(no matches)") + suffix);
      });

      proc.on("error", (err) => {
        cleanup();
        reject(new Error(`grep: ${err.message}`));
      });
    });
  },
};
