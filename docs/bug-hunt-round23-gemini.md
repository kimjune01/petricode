# Bug Hunt Round 23

### Finding 1: `process.execPath` in `Bun.spawn` is brittle and inconsistent
- **File:** test/headless.test.ts:337
- **Severity:** Medium
- **Impact:** Spawning `process.execPath` may fail to run the CLI if the test runner overrides it or if it resolves to a test worker executable instead of the intended `bun` runtime CLI.
- **Repro/Reasoning:** The rest of the suite consistently uses `"bun"` as the executable (e.g., inside `runCli`). In the Bun test runner, `process.execPath` can sometimes point to internal worker executables or aliases that do not perfectly replicate the global `bun` command. If this causes the spawn to fail or crash immediately (e.g., exiting with code 127), the test will falsely pass because the exit code is not 2.
- **Suggested fix:** Change `process.execPath` to `"bun"` to match the established pattern in `runCli` and guarantee consistent execution across environments.

### Finding 2: False positive on slow CI due to premature SIGTERM
- **File:** test/headless.test.ts:341
- **Severity:** High
- **Impact:** The test will falsely pass on slow machines/CI environments, potentially masking a parser regression.
- **Repro/Reasoning:** The test hardcodes a 1500ms timeout to kill the process. If a slow CI environment takes more than 1500ms to initialize V8/JSC and parse arguments, the `SIGTERM` kill fires before the CLI has a chance to execute the parsing logic. When killed by `SIGTERM`, the process exits with a signal-based code (like 143), which trivially satisfies the `expect(code).not.toBe(2)` assertion. The `stderr` will also be empty, satisfying the negative assertions. The test passes because it timed out, not because it succeeded.
- **Suggested fix:** Instead of a hard timeout and negative assertions, wait for a positive signal (e.g., a specific log indicating bootstrap has started) or refactor the test to use an environment variable or mock that allows the process to exit predictably when parsing succeeds.

### Finding 3: False positive on early crash race condition
- **File:** test/headless.test.ts:345
- **Severity:** High
- **Impact:** The test will pass even if the CLI crashes unexpectedly or fails to start at all.
- **Repro/Reasoning:** If the process exits *before* 1500ms with any non-2 exit code (e.g., `code: 1` due to a syntax error, a missing env var, or a spawn failure), `proc.exited` resolves and the `killer` timeout is cleared. The assertions `expect(code).not.toBe(2)` and negative string checks on `stderr` will pass. This means any fatal error other than `code: 2` is treated as a successful "hand-off" to bootstrap, which is a dangerous assumption.
- **Suggested fix:** Ensure the exit code is verified strictly, or assert that stdout/stderr contains a known good string emitted by the bootstrap phase to confirm the hand-off actually occurred.

### Finding 4: Negative assertions on stderr hide related errors
- **File:** test/headless.test.ts:346
- **Severity:** Medium
- **Impact:** The test will falsely pass if the runtime error message changes slightly or if it emits a different but related parser error.
- **Repro/Reasoning:** The assertions `expect(stderr).not.toContain("requires a prompt string")` and `expect(stderr).not.toContain("Unknown flag")` evaluate to true for *any* other string, including empty strings or new error messages like `Invalid argument: --format`. This makes the test brittle to error message formatting changes or other runtime failures.
- **Suggested fix:** Assert for the exact expected behavior or output, rather than relying on excluding specific substrings.
