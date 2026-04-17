# Bug Hunt Round 20

### Finding 1: Headless unhandled rejection on bootstrap failure
- **File:** `src/headless.ts:81` / `src/cli.ts:108`
- **Severity:** high
- **Impact:** If `petricode -p` fails to bootstrap (e.g. invalid `--resume` session ID, missing project directory), the process crashes ungracefully with a cryptic "Crash logged to..." message and exits 1, instead of printing the actual initialization error to `stderr`.
- **Repro/Reasoning:** `runHeadless` calls `await bootstrap(...)` without a try/catch block. The `try/catch` inside `runHeadlessTurn` only protects the pipeline turn itself. In `cli.ts`, `await runHeadless()` is also unprotected, causing the rejection to bubble up to the global `unhandledRejection` handler.
- **Suggested fix:** Wrap the `bootstrap()` call inside `runHeadless` in a try/catch, returning a `HeadlessResult` with `exitCode: 1` and the error message in `stderr`, or wrap the top-level invocation in `cli.ts`.

### Finding 2: `indexOf` argument parser blind to flag vs. value boundaries
- **File:** `src/cli.ts:98`
- **Severity:** high
- **Impact:** The CLI fails to parse `-p` and `--resume` correctly if a prompt string or session ID happens to match another flag. Worse, if the prompt string exactly matches a top-level command like `--list`, the tool executes that command and exits without ever running the prompt.
- **Repro/Reasoning:** Run `petricode -p "--list"`. It outputs recent sessions and exits 0 instead of treating `--list` as the prompt value. Run `petricode --resume -p "hello"`. It incorrectly consumes `-p` as the session ID. The parser uses `args.indexOf` and `args.includes` which scan the entire array blindly, ignoring whether an item is a flag or the value belonging to a preceding flag.
- **Suggested fix:** Implement a linear argument parser loop that advances an index (`while (i < args.length)`), correctly distinguishing between flags and consuming their subsequent values.

### Finding 3: `?` wildcards inside `**` globstars silently break `.gitignore` parsing
- **File:** `src/filter/gitignore.ts:114`
- **Severity:** high
- **Impact:** Any `.gitignore` or `.geminiignore` pattern containing `**` (e.g. `src/**/*.ts`) is silently corrupted and fails to match files correctly, causing files to be erroneously included or excluded from context.
- **Repro/Reasoning:** The `patternToRegex` function replaces `**` with the placeholder `⟨SLASHGLOBSTAR⟩`, which later expands to `(/.*)?/`. However, the subsequent `.replace(/\?/g, "[^/]")` step accidentally targets the literal `?` regex character *inside* the newly generated `(/.*)?/`, morphing it into `(/.*)[^/]/`. This completely breaks the regex structure.
- **Suggested fix:** Move the `?` glob wildcard replacement (`.replace(/\?/g, "[^/]")`) to run *before* the globstar replacements, or protect it using a `⟨QUESTION⟩` placeholder.

### Finding 4: `@file` reference expansion bypasses 256KB read limit
- **File:** `src/perceive/fileRefs.ts:28`
- **Severity:** high
- **Impact:** A user mentioning `@large-file.mp4` (or any file > 256KB) causes the entire file to be read into memory and injected into the prompt, bypassing the `MAX_READ_BYTES` safety cap enforced in the standard `ReadFileTool`. This can easily exhaust memory or model token limits.
- **Repro/Reasoning:** `fileRefs.ts` uses `await readFile(absPath, "utf-8")` without stat-checking the file size, whereas `src/tools/readFile.ts` properly implements a 256KB cap and truncation logic.
- **Suggested fix:** Adopt the same `stat` size check and truncation logic in `fileRefs.ts` that exists in `ReadFileTool`.

### Finding 5: Aborted tool runs synthesize "Interrupted" for previously completed tools
- **File:** `src/agent/toolSubpipe.ts:111` & `src/agent/pipeline.ts:374`
- **Severity:** high
- **Impact:** If the LLM issues multiple tool calls in a single turn, and the user aborts (via Ctrl+C) during the `ASK_USER` confirmation or execution of a *later* tool, the pipeline discards the successful results of the *earlier* tools. It synthesizes "Interrupted by user" for *all* tools in the batch. This breaks LLM coherence, as it is told earlier tools were not executed when they actually modified the system.
- **Repro/Reasoning:** `runToolSubpipe` executes sequentially. If a tool throws `AbortError`, `pipeline.turn` catches it and calls `commitInterruptedToolCalls`. This helper iterates over *all* `tool_calls` from the current turn, blindly emitting "Interrupted" for all of them, ignoring the partial `toolResults` accumulated by `runToolSubpipe`.
- **Suggested fix:** `runToolSubpipe` should catch `AbortError` internally, append an "Interrupted" result for the aborted tool, synthesize "Interrupted" for any remaining unexecuted tools, and return the mixed array of results normally so `pipeline.turn` can cache the true, exact state.

### Finding 6: `grep` defaults to basic regex, breaking standard LLM queries
- **File:** `src/tools/grep.ts:43`
- **Severity:** medium
- **Impact:** The grep tool's schema advertises the `pattern` argument as a "Regex pattern". LLMs natively write Extended Regular Expressions (ERE) like `foo|bar` or `\d+`. However, the spawned `grep` command uses `-rn` (Basic Regular Expressions), which treats `|` and `+` as literals unless escaped. This causes valid searches to silently find zero matches.
- **Repro/Reasoning:** `grepArgs` is configured as `["-rn", "--exclude-dir=..."]`. To support standard regex semantics expected by LLMs without heavy escaping, it needs the `-E` flag.
- **Suggested fix:** Change `-rn` to `-rnE` in the `grepArgs` array.

### Finding 7: `Pipeline.clear()` leaks `LoopDetector` state
- **File:** `src/agent/pipeline.ts:333`
- **Severity:** low
- **Impact:** Using `/clear` wipes the conversation cache but leaves the `loopDetector` history intact. If the LLM starts the new conversation by legitimately calling the exact same tool and arguments that it used right before the clear, the loop detector will falsely reject it.
- **Repro/Reasoning:** `Pipeline.clear()` calls `this.cache.clear()` but fails to call `this.loopDetector.reset()`.
- **Suggested fix:** Add `this.loopDetector.reset()` to the `Pipeline.clear()` method.

## Test Results

- **`bun test`:** 242 pass, 0 fail (0 failures).
- **`bun run typecheck`:** 0 errors.