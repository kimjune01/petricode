# Bug Hunt Round 8

## Findings

### 1. `.gitignore` pattern ordering is ignored
- **Severity**: High
- **File:line**: `src/filter/gitignore.ts:38`
- **Description**: `buildIgnorePredicate` completely separates patterns into `positive` and `negative` arrays, processing all positive patterns first and then all negative patterns. This violates gitignore semantics where order strictly matters (e.g. a later positive pattern can re-ignore a file un-ignored by a previous negative pattern).
- **Impact**: Files that should be ignored may be leaked to the LLM, or required files may be incorrectly invisible.
- **Suggested fix**: Iterate over patterns sequentially in reverse order; the first matching pattern dictates the ignore status. Do not separate them by positive/negative upfront.

### 2. Path expansion (`@path`) reads sensitive files outside the workspace
- **Severity**: High (Security)
- **File:line**: `src/perceive/fileRefs.ts:20`
- **Description**: `expandFileRefs` directly passes the unvalidated `filePath` to `readFile`. It does not restrict reads to the project directory or filter sensitive filenames.
- **Impact**: An LLM (via prompt injection) or a user could easily extract arbitrary sensitive system files (e.g., `@~/.ssh/id_rsa`, `@/etc/passwd`, `@.env`) into the active context and transmit them over the network.
- **Suggested fix**: Validate the path using the `validateFilePath` logic from `pathValidation.ts` to ensure the path resides safely within the project boundary and is not in the `ALWAYS_EXCLUDED` list.

### 3. Network streams do not abort, causing ghost generation and UI hang
- **Severity**: High
- **File:line**: `src/agent/turn.ts:37` & `src/providers/anthropic.ts:79`
- **Description**: `assembleTurn` and the provider's `generate` method do not accept an `AbortSignal`. When the user aborts via Ctrl+C, the network request isn't cancelled and `assembleTurn` blocks until completion. The abort check in `Pipeline._turn` (`if (signal?.aborted)`) is only evaluated *after* the entire stream finishes.
- **Impact**: Aborting an action visually updates the TUI but silently leaves a ghost generation running, wasting tokens, blocking the pipeline, and delaying the user's next turn.
- **Suggested fix**: Pass `signal` through `Pipeline._turn` into `provider.generate` and `assembleTurn`. Wire the provider's native `abort` mechanics to the signal, and ensure `assembleTurn` handles or yields partial state properly when the signal fires.

### 4. Shell and Grep child processes leak indefinitely on abort
- **Severity**: High
- **File:line**: `src/tools/shell.ts:26` & `src/tools/grep.ts:28`
- **Description**: Tool execution functions do not accept an `AbortSignal`. If the user hits Ctrl+C to abort the agent loop during a long-running command, the `Pipeline` aborts but the `spawn` processes keep running in the background.
- **Impact**: Orphaned shell and grep processes consume CPU, memory, and potentially hold file locks indefinitely (or until the shell's rigid 30s timeout hits; `grep` has no timeout).
- **Suggested fix**: Pass `AbortSignal` to tool executors and wire it to the `spawn` process via `proc.kill()` so child processes are actively terminated when the pipeline aborts.

### 5. `ToolConfirmation` violates UX Spec on timeout and defaults
- **Severity**: Medium
- **File:line**: `src/app/components/ToolConfirmation.tsx:64` & `75`
- **Description**: The component uses a 60-second `setTimeout` to auto-resolve, violating UX Spec #67 ("Confirmation waits indefinitely"). Additionally, the `useInput` block explicitly ignores the `Enter` key, violating UX Spec #63 ("Enter without letter defaults to safe action").
- **Impact**: Users stepping away will have commands automatically executed/rejected. Users pressing `Enter` to confirm a safe action will be confused when nothing happens.
- **Suggested fix**: Remove the 60-second timer. Add a `key.return` check in `useInput` to trigger `onConfirm(false)` (or `true` if safe).

### 6. Missing prompt history navigation (Up/Down arrows)
- **Severity**: Medium
- **File:line**: `src/app/components/Composer.tsx:142`
- **Description**: The `useInput` hook in the `Composer` handles many control keys but completely lacks logic for `key.upArrow` and `key.downArrow`.
- **Impact**: Violates UX Spec #29 and #30. Users cannot navigate backward or forward through their prompt history.
- **Suggested fix**: Implement history navigation by saving submitted prompts to a history array and wiring `key.upArrow` and `key.downArrow` to cycle through them, updating `nextInput` and `nextCursor` accordingly.

### 7. Bracketed paste loses interleaved normal keystrokes
- **Severity**: Low
- **File:line**: `src/app/components/Composer.tsx:83`
- **Description**: In `onRawInput`, `pasteBuffer` retains characters received *after* a `PASTE_END` sequence in the same chunk. However, `isPasting.current` stays true until the next tick, causing Ink's `useInput` to silently drop any normal keystrokes that arrived in that same chunk.
- **Impact**: If a user pastes text and types immediately (or a terminal/macro sends characters instantly post-paste), those appended characters are dropped.
- **Suggested fix**: Extract the remaining trailing characters from `pasteBuffer` and explicitly insert them, or better integrate the paste parser so it doesn't block Ink from processing non-paste keystrokes in the same chunk.

## Test Results

The suite has a failing test related to a recent intentional code change:
```text
✗ fileRefs > missing @file produces error marker [0.69ms]
Expected to contain: "[file not found"
Received: "look at @/var/.../nope.txt"
```
**Note:** `src/perceive/fileRefs.ts` was intentionally loosened to fail silently in round 7, but `test/perceive.test.ts:35` was not updated to reflect this behavior.