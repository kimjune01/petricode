# Bug Hunt Round 40

**1. Headless "cautious" mode silently auto-executes dangerous shell commands that "--permissive" mode blocks**
- **File:** `src/agent/toolSubpipe.ts`:360 (and `src/session/bootstrap.ts`)
- **Description:** In headless mode without a classifier, tools evaluating to `ASK_USER` (like `shell` in the default `cautious` mode) fall through and auto-execute because `!onConfirm` is true and `classification` is undefined. This means `petricode -p "rm -rf /"` silently executes the destructive command. However, if the user explicitly passes `--permissive`, the `permissiveShellGuard` intercepts the dangerous command, sets `dangerReason`, and explicitly DENIES it (line 343). This creates a paradox where the default "cautious" mode is effectively YOLO, while `--permissive` is safer.
- **Impact:** Users running headless without `--permissive` or `--yolo` have no protection against destructive shell commands hallucinated by the model.
- **Suggested Fix:** Default headless behavior should deny `ASK_USER` tools if there is no confirmation and no yolo flag, or `cautious` should apply the `permissiveShellGuard` as a baseline.
- **Severity:** High

**2. Composer drops leading keystrokes received in the same chunk as a fragmented bracketed paste**
- **File:** `src/app/components/Composer.tsx`:162
- **Description:** In `onRawInput`, if a stdin chunk contains typed characters followed by `PASTE_START`, but NO `PASTE_END` (a fragmented paste), the loop extracts the leading typed characters into `combined` and sets `isPasting.current = true`, but `madeProgress` remains `false` because the loop breaks on `endIdx === -1`. Because `madeProgress` is `false`, the `combined` text is discarded instead of being inserted into the input state. Meanwhile, `isPasting.current` is now `true`, so when Ink synchronously fires `useInput` for those same leading characters, they are ignored. 
- **Impact:** If a user types text and immediately pastes a large payload (or if a network buffer concatenates them), the typed text before the paste is permanently dropped if the paste's end marker hasn't arrived yet.
- **Suggested Fix:** If `startIdx > 0`, set `madeProgress = true` even if `endIdx === -1`, so the leading characters in `combined` are committed before waiting for the rest of the paste.
- **Severity:** Medium

**3. Forward Delete key deletes backwards (acts as Backspace) on macOS**
- **File:** `src/app/components/Composer.tsx`:297
- **Description:** To fix macOS Backspace (`\x7f`) being mapped to `key.delete` by Ink 5.2.1, the Composer handles `key.backspace || key.delete` as a backward deletion. However, the actual Forward Delete key (e.g., `\x1b[3~`) is also parsed by Ink as `key.delete`. By unconditionally treating `key.delete` as Backspace, the Composer breaks the Forward Delete key, causing it to delete the character *before* the cursor instead of the character *after*.
- **Impact:** Users cannot use the standard Forward Delete key to delete characters ahead of the cursor.
- **Suggested Fix:** Distinguish between the two by checking `ch` or tracking raw input, if possible, or mapping `Ctrl+D` logic to Forward Delete if it can be disambiguated.
- **Severity:** Low

**Triage of #3 (Forward Delete on macOS):** DEFERRED. Ink 5.2.1 collapses both `\x7f` (Backspace on macOS) and `\x1b[3~` (Forward Delete) to `key.delete` with no way to distinguish them in the keypress object. The macOS Backspace fix lives in the Composer because Ink can't be patched from here. Distinguishing the two would require tracking raw bytes in the existing `onRawInput` handler and threading the verdict into `useInput`, which is more state machinery than the rare Forward Delete usage warrants. Filed for future revisit if Ink upgrades parseKeypress.

---

**4. Grep `.gitignore` post-filter incorrectly truncates filenames containing `:\d+:`**
- **File:** `src/tools/grep.ts`:93
- **Description:** `isLineIgnored` parses grep output lines using `line.match(/^(.+?):\d+:/)`. Because `.+?` is non-greedy, if a file path itself contains a sequence that looks like a line number (e.g., `src/foo:12:bar.ts`), the match stops at the first colon-number-colon sequence. `sep[1]` becomes `src/foo`, and this truncated path is passed to `isIgnored`.
- **Impact:** Files with `:\d+:` in their names might bypass `.gitignore` rules (or be incorrectly ignored) because the filter evaluates a truncated path instead of the actual filename.
- **Suggested Fix:** Use `grep -Z` (null byte separator) to unambiguously delimit the file path from the line number, or match the last colon before the text.
- **Severity:** Low