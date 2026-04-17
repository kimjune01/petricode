# Bug Hunt Round 21

### Finding 1: Impossible to pass a headless prompt starting with a dash (`-`)
- **File:** `src/cli.ts:112`
- **Severity:** high
- **Impact:** Users are completely prevented from providing a headless prompt that starts with a hyphen (e.g. `petricode -p "- bug: fix the loop"` or `petricode -p "-f is broken"`). The parser categorically rejects it.
- **Repro/Reasoning:** To prevent an edge case where `-p` swallows a subsequent flag if the user forgot the prompt string (e.g. `petricode -p --format text`), `parseArgs` explicitly rejects any `next` token starting with `-` (`if (!next || next.startsWith("-"))`). Since `-p` requires a value and there is no `=value` fallback syntax or support for positional prompts, there is absolutely no way to pass a dashed string as the prompt. Even using the `--` sentinel (e.g. `petricode -p -- "- bug"`) fails because the sentinel itself starts with a dash and gets rejected.
- **Suggested fix:** Remove `next.startsWith("-")` and unconditionally consume the next argument as the prompt if `-p` or `--prompt` is specified. Trust the user to provide the correct value.

### Finding 2: `--format` without `-p` is silently ignored, launching TUI
- **File:** `src/cli.ts:214`
- **Severity:** medium
- **Impact:** If a user specifies an output format but forgets the prompt (e.g. `petricode --format json`), the CLI silently ignores the format flag and launches the interactive TUI instead of reporting a misuse error.
- **Repro/Reasoning:** The parser correctly sets `parsed.format = "json"` but doesn't validate if `-p` was also provided. After parsing, `parsed.errors` is empty and `parsed.prompt` is undefined, so the routing block bypasses `if (parsed.prompt !== undefined)` and falls directly into the `else` block containing `await import("./app/App.js")`. The format flag is silently dropped.
- **Suggested fix:** After parsing args, add a validation check: `if (parsed.format !== "text" && parsed.prompt === undefined) parsed.errors.push("--format requires -p/--prompt.");`

### Finding 3: Headless test `-p "--list"` makes a false claim and passes for the wrong reason
- **File:** `test/headless.test.ts:327`
- **Severity:** medium
- **Impact:** The test suite harbors a false positive regarding the parser's internal state. The test comment claims the parser "actually consumes the value as -p's argument ... and does NOT trigger the --list session lister", but in reality, it explicitly rejects it and parses it as a top-level flag.
- **Repro/Reasoning:** When `arg` is `"-p"` and `next` is `"--list"`, the `next.startsWith("-")` check evaluates to true. It pushes an error and does `i++` (not `i += 2`). The next loop iteration then naturally parses `"--list"` as a flag and correctly sets `out.list = true`. The only reason the test's `expect(stdout).not.toContain("Recent sessions")` assertion passes is because `cli.ts` happens to check `parsed.errors.length > 0` and exits with code 2 *before* it evaluates the `if (parsed.list)` block. The test does not exercise what it claims.
- **Suggested fix:** If the intention is to consume the argument, the parser must be fixed. If the intention is to reject it, the test comment should be corrected to reflect that it rejects the value, parses it as a flag on the next iteration, and avoids the lister only due to an early error exit.

### Finding 4: `--prompt is recognized` test is timing-dependent and brittle
- **File:** `test/headless.test.ts:350`
- **Severity:** low
- **Impact:** On a heavily loaded system or CI runner, this test will randomly pass (false positive) even if `--prompt` parsing is completely broken.
- **Repro/Reasoning:** The test spawns a child process and forcefully kills it with `SIGTERM` after a 1.5-second timeout, asserting `expect(code).not.toBe(2)`. If the machine is slow enough that `bun` takes >1.5s just to load imports before evaluating `parseArgs`, the process is killed (yielding code 143 or null), which trivially satisfies `.not.toBe(2)`. A slow system therefore results in a passing test instead of a timeout failure.
- **Suggested fix:** Mock the execution environment (e.g., pass an invalid `projectDir` or environment variables) so the process naturally and deterministically exits with code 1 instead of relying on an arbitrary sleep and signal kill.
