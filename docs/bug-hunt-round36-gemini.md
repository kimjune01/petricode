# Bug Hunt Round 36

**1. App.tsx ANSI sanitizer leaks ANSI escape payloads as literal text**
- **Location:** `src/app/App.tsx`, around line 155
- **Description:** The regex `const safe = classification.rationale.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");` places the single-character control range `[\x00-\x08...` first. Since `\x1b` (ESC, `\x1b`) falls within the `\x0e-\x1f` range, the regex engine eagerly consumes the ESC character using the first branch. The remaining multi-character ANSI sequences (like `[31m`) then fail to match and are left intact as literal text in the rendered TUI output.
- **User-visible impact:** If the LLM generates ANSI styling or links in its triage rationale, the TUI prints raw garbage text like `[31m` or `]8;;link...` instead of fully stripping the formatting.
- **Suggested fix:** Reorder the regex branches to try the multi-character escape sequences before the single-character fallback. For example: `/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g`.
- **Severity:** Medium (UX degradation).

**2. Composer drops split bracketed pastes on rapid multi-paste fragmentation**
- **Location:** `src/app/components/Composer.tsx`, around lines 118-121
- **Description:** In the `onRawInput` stdin interceptor, if `madeProgress` becomes true (meaning at least one paste successfully ended in this chunk), the code unconditionally schedules `process.nextTick(() => isPasting.current = false)`. However, if the current chunk *also* contained the start of a subsequent paste (which is fragmented and continues into the next chunk), the parser loop correctly leaves `isPasting.current = true`. The unconditional `nextTick` incorrectly resets it to `false`. When the rest of the second paste arrives, the parser fails to find `PASTE_START`, clears the buffer, and silently drops the second paste payload.
- **User-visible impact:** If a user pastes rapidly (or programmatically injects text) such that multiple pastes land in one stdin chunk but the last paste is split across the chunk boundary, the final paste will be silently lost.
- **Suggested fix:** Only arm the `nextTick` reset if the parser is no longer pasting at the end of the loop: `if (!isPasting.current) { isPasting.current = true; process.nextTick(() => { isPasting.current = false; }); }`
- **Severity:** Low (rare edge case for manual pasting, but affects automated input tooling).

**3. grep tool truncation drops ignored files silently and causes false negatives**
- **Location:** `src/tools/grep.ts`, lines 134-165
- **Description:** The `grep` tool runs a raw `grep` subprocess and intentionally post-filters the matches using `.gitignore` rather than translating gitignore rules into `--exclude` flags. However, the stdout collector unconditionally counts bytes towards the `MAX_OUTPUT_BYTES` (1MB) limit. If an ignored directory (e.g. `dist/`, `build/`) contains a massive number of matches, the process hits the limit, sets `truncated = true`, and forcibly kills the `grep` search. The post-filter then completely removes these ignored lines, resulting in an empty or near-empty string.
- **User-visible impact:** A standard search for common terms (like `function`) will get bogged down returning matches from ignored build artifacts, triggering the 1MB hard limit. After post-filtering, the user receives `(no matches)\n[output truncated — exceeded 1MB]` while actual valid matches in the source code are permanently lost because the `grep` process was aborted early.
- **Suggested fix:** Pre-filter at the collector level (streaming lines and checking `isIgnored` before counting towards `outputBytes`), or heuristically append the project's root `.gitignore` directory entries (like `--exclude-dir=dist`) directly into the `grepArgs` to shield the subprocess from overwhelming noise.
- **Severity:** High (breaks core search functionality and leads to silent failure on standard JS/TS projects).