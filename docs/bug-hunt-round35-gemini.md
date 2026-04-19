# Bug Hunt Round 35

1. **Composer trailing keystroke loss (High)**
   - **File/Line:** `src/app/components/Composer.tsx` (Line ~87) `const startIdx = pasteBuffer.indexOf(PASTE_START); if (startIdx === -1) { pasteBuffer = ""; break; }`
   - **Description:** The `onRawInput` bracketed paste handler aggressively clears `pasteBuffer` if no `PASTE_START` is found in the remaining buffer, even if a paste was just successfully processed (`madeProgress === true`). This discards legitimate typed keystrokes that arrived in the same `stdin` chunk immediately trailing the `PASTE_END` sequence. Furthermore, because `isPasting.current` is kept `true` for the remainder of the tick to suppress duplicate Ink events, `useInput` also ignores these trailing characters.
   - **User-visible impact:** If a user pastes text and immediately types characters (or if a macro/script sends paste + text rapidly), the typed characters are silently dropped.
   - **Suggested fix:** Only clear `pasteBuffer` if no progress was made in the current loop iteration. Change to: `if (!madeProgress) pasteBuffer = "";`

2. **Composer Delete key mapped to Backspace (Medium)**
   - **File/Line:** `src/app/components/Composer.tsx` (Line ~186) `else if (key.backspace || key.delete) { ... stepLeft ... }`
   - **Description:** The input handler assumes Ink's `key.delete` strictly corresponds to the macOS Backspace key (`\x7f`). However, the actual Forward Delete key (`\x1b[3~`) also sets `key.delete = true` in Ink. By mapping both to a backward deletion, the Forward Delete key becomes broken.
   - **User-visible impact:** Pressing the Forward Delete key on standard keyboards deletes backward (like Backspace), confusing users who expect it to delete the character under/after the cursor.
   - **Suggested fix:** Handle forward deletion natively for `key.delete` while ensuring macOS Backspace (`\x7f`) correctly triggers the backward deletion logic if Ink mischaracterizes it.

3. **fileRefs ignores `@path` mentions enclosed in punctuation (Medium)**
   - **File/Line:** `src/perceive/fileRefs.ts` (Line ~7) `const FILE_REF_PATTERN = /(?<=^|\s)@([^\s]+)/g;`
   - **Description:** The regex relies on a lookbehind `(?<=^|\s)` to ensure `@` is not part of an email address. This strict boundary prevents the regex from matching valid file references that are immediately preceded by punctuation, such as opening parentheses, quotes, or brackets (e.g. `(@src/index.ts)` or `"@src/index.ts"`).
   - **User-visible impact:** If a user types a file mention inside quotes or parentheses, it fails to expand into the file contents, leading the agent to miss explicitly requested context.
   - **Suggested fix:** Expand the lookbehind to allow common opening punctuation, or use a negative lookbehind for word characters: `(?<!\w)@([^\s]+)`.

4. **App.tsx hangs if parallel tools require confirmation (Medium)**
   - **File/Line:** `src/app/App.tsx` (Line ~44) `confirmResolveRef.current = { resolve, reject };`
   - **Description:** The `onConfirm` callback overwrites the singleton `confirmResolveRef.current` without checking if a prior confirmation is still pending. If the pipeline triggers multiple confirmations concurrently (e.g., parallel tool calls that both need `ASK_USER`), the reference to the first promise's `resolve`/`reject` functions is lost.
   - **User-visible impact:** The TUI will surface the latest confirmation prompt, but the earlier tool calls will remain permanently suspended because their promises can never be resolved, hanging the pipeline execution.
   - **Suggested fix:** Queue incoming confirmations or maintain a map of pending confirmations so each tool call can be individually resolved.

5. **grep truncates file paths containing colons (Low)**
   - **File/Line:** `src/tools/grep.ts` (Line ~136) `const colon = line.indexOf(":"); ... const filePath = line.slice(0, colon);`
   - **Description:** GNU grep separates the filename, line number, and matched content using colons (`file:line:content`). When parsing this output, if a legitimately matched file's name contains a colon, `indexOf(":")` finds the colon *inside* the filename. This truncates the path passed to `isIgnored`, corrupting the gitignore check.
   - **User-visible impact:** Matches inside valid files containing colons (e.g., `src/My:Component.tsx`) might be dropped or incorrectly filtered.
   - **Suggested fix:** Parse the grep output line more robustly, for example by matching the first colon that is immediately followed by a line number: `line.match(/^(.+?):(\d+):/)`.