# Bug Hunt Round 19

### Finding 1: `cli.ts` Argument Parsing Collisions
- **File:** src/cli.ts:79
- **Severity:** medium
- **Impact:** Hardcoded precedence causes `--prompt` to be completely ignored if `-p` is also passed, regardless of order. Additionally, if the user passes `-p` without a value and follows it with `--format json`, the parser incorrectly swallows `--format` as the prompt text and reads `json` as an undefined next arg or invalidates the run. Passing `-p` as the very last argument crashes the process.
- **Repro/Reasoning:** `args.indexOf("-p") !== -1 ? ... : args.indexOf("--prompt")` strictly prioritizes `-p`. `args[promptIdx + 1]` assumes the next token is the prompt without checking if it's another flag or undefined.
- **Suggested fix:** Use `args.findIndex` to get the earliest occurrence of `-p` or `--prompt`, and validate that the value exists and does not start with `--`.

### Finding 2: `/clear` Command Fails to Reset Pipeline Cache and Requires Exact Match
- **File:** src/app/App.tsx:210
- **Severity:** high
- **Impact:** The `/clear` command only resets the UI `state.turns`, leaving the pipeline's internal cache fully intact. The agent continues to remember the entire erased conversation on subsequent turns. Additionally, trailing spaces or arguments (e.g. `/clear please`) bypass the exact string match, leaving even the UI turns uncleared while falsely outputting "Conversation cleared."
- **Repro/Reasoning:** `tryCommand` accepts `/clear args` and returns the stub output, but `App.tsx` uses a strict `input.trim() === "/clear"` check. More critically, `pipeline.cache` is never cleared when the UI is reset.
- **Suggested fix:** Check `skillCmdName === "clear"` instead of the raw input. Expose a `clear()` method on the `Pipeline` (and underlying `UnionFindCache`) and invoke it when `/clear` is matched.

### Finding 3: Headless Mode Crashes on `EPIPE` During Output Drain
- **File:** src/cli.ts:98
- **Severity:** medium
- **Impact:** Piping `petricode -p "prompt" | head -n 1` causes an unhandled rejection crash when `stdout` closes early (`EPIPE`). This dumps a large stack trace into `.petricode/crash.log` and prints an error to `stderr`, polluting what should be a silent termination.
- **Repro/Reasoning:** `writeAndDrain` rejects on stream errors. `cli.ts` awaits these drains without a `try/catch`, falling through to the global `unhandledRejection` handler which logs a crash and exits with code 1 instead of 141 (SIGPIPE).
- **Suggested fix:** Wrap `writeAndDrain` calls in a `try/catch`, specifically checking for `err.code === "EPIPE"` to exit silently.

### Finding 4: Spinner Frame Not Reset on Reactivation (Stale Animation)
- **File:** src/app/spinner.ts:12
- **Severity:** low
- **Impact:** The science emoji spinner resumes from its previous animation frame when a new turn begins, causing visual discontinuity instead of a smooth start.
- **Repro/Reasoning:** The `useSpinner` hook clears the interval when `active` goes false, but does not reset the `frame` state to `0`. When `active` becomes true again, it picks up at the stale index.
- **Suggested fix:** Reset `setFrame(0)` inside the `if (!active)` block or within the cleanup function.

### Finding 5: Composer Stuck After Provider `AbortError`
- **File:** src/app/App.tsx:288
- **Severity:** high
- **Impact:** If the provider throws an `AbortError` (e.g. from a network timeout) without the user pressing Ctrl+C, the composer is left permanently disabled and the app is bricked.
- **Repro/Reasoning:** The `catch` block checks `err instanceof DOMException && err.name === "AbortError"`, assumes it was triggered by the TUI's `AbortController` (Ctrl+C), and silently returns. Because `abortRef.current` was already set to `null`, it can't distinguish a user abort from a provider timeout. Crucially, the phase remains stuck on `"running"` instead of reverting to `"composing"`.
- **Suggested fix:** Check `controller.signal.aborted` before nulling `abortRef.current` to properly distinguish intentional user interrupts from provider timeouts.

### Finding 6: `disableBracketedPaste` Pollutes Headless Terminal Output
- **File:** src/cli.ts:25
- **Severity:** low
- **Impact:** Running `petricode -p` in a TTY unconditionally appends the bracketed paste disable sequence (`\x1b[?2004l`) to stdout, even though headless mode never enables it.
- **Repro/Reasoning:** The `exit` handler calls `disableBracketedPaste` which checks for `isTTY` and fires the escape sequence. When rendering JSON or text directly to a terminal, the appended escape sequence may leak into the visual output.
- **Suggested fix:** Only register the exit handler if the TUI is actually booted, or set a boolean flag to track if bracketed paste was ever enabled.
## Test and Typecheck Results

- `bun test`: 0 failures (Ran 238 tests across 19 files).
- `bun run typecheck`: 0 errors.
