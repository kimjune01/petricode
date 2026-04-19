# Bug Hunt Round 32 (gemini)

## 1. UX Bugs

### 1. ANSI Stripper Destroys Formatting (`App.tsx`)
- **File/Line:** `src/app/App.tsx:288` inside `App()` / `useEffect`
- **What is wrong:** The rationale sanitizer strips `[\x00-\x1f...]` which indiscriminately removes standard whitespace control characters (newlines `\n`/`0x0A` and tabs `\t`/`0x09`).
- **Impact:** Multi-line rationale explanations from the triage classifier are squashed into a single illegible text block.
- **Fix:** Change the regex to preserve `\n`, `\r`, and `\t` (e.g. `/(?:(?!\x09|\x0a|\x0d)[\x00-\x1f]).../g`).
- **Severity:** Medium

### 2. Composer ignores `disabled` prop causing typing/paste desync (`Composer.tsx`)
- **File/Line:** `src/app/components/Composer.tsx:120` inside `useInput()`
- **What is wrong:** The `useInput` hook lacks `{ isActive: !disabled }` options. Thus, regular keystrokes are still captured and added to the text buffer even when `disabled=true` (e.g., during the "running" phase). Conversely, the bracketed paste `useEffect` *does* respect `disabled`.
- **Impact:** If a user pastes text while the agent is running, the terminal injects raw ANSI wrappers (like `\x1b[200~` and `\x1b[201~`) as regular keystrokes directly into the user's prompt.
- **Fix:** Pass `{ isActive: !disabled }` to `useInput()`.
- **Severity:** High

### 3. Bracketed Paste sequence fragmentation leakage (`Composer.tsx`)
- **File/Line:** `src/app/components/Composer.tsx:75` inside `onRawInput()`
- **What is wrong:** If multiple pasted chunks are concatenated into a single terminal emission, `s.includes(PASTE_START)` creates a substring starting *after* the first `PASTE_START`. It finds the first `PASTE_END` to slice out the `payload`. It then erroneously dumps the *remaining buffer* (including the subsequent `\x1b[200~second\x1b[201~` block) as raw ANSI into `tailPrintable`.
- **Impact:** Subsequent bracketed pastes in rapid succession bypass protection and spray escape codes into the Composer input.
- **Fix:** Recursively extract payloads via regex `/\x1b\[200~(.*?)\x1b\[201~/g` instead of `indexOf`.
- **Severity:** Medium

### 4. macOS Forward Delete acts as Backspace (`Composer.tsx`)
- **File/Line:** `src/app/components/Composer.tsx:162` inside `useInput()`
- **What is wrong:** Both `key.backspace` and `key.delete` are mapped to backwards delete (`nextCursor = prev.cursor - 1`). 
- **Impact:** Users with full keyboards pressing the actual Forward Delete key (`key.delete`) will experience backwards deletion instead of forward deletion.
- **Fix:** Differentiate between `key.delete` (Forward) and `key.backspace` (Backward), keeping `\x7f` or `ch === '\x7f'` handling if needed for macOS Backspace.
- **Severity:** Low

### 5. Timer Resource Leak on Unmount (`App.tsx`)
- **File/Line:** `src/app/App.tsx:265` inside `useInput()` timer management.
- **What is wrong:** `ctrlCTimerRef.current` is not cleared in the `useEffect` unmount cleanup.
- **Impact:** If a user presses `Ctrl+C` and the app immediately exits (or the component unmounts for another reason), the 1000ms timer will still fire, resulting in a state update warning for an unmounted component.
- **Fix:** Add `if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);` to the `abortRef.current?.abort();` cleanup hook.
- **Severity:** Low

## 2. Functional Bugs

### 1. Multiline Regex Mode Breakage (`grep.ts`)
- **File/Line:** `src/tools/grep.ts:51` inside `execute()`
- **What is wrong:** The grep arguments rely on `-rnE`. The `-E` flag operates strictly line-by-line and does not support matching newline characters (`\n`). 
- **Impact:** If the LLM supplies a multiline regex pattern (e.g. `foo\nbar`), `grep` will silently return zero matches because it strips newlines prior to evaluation, misleading the agent.
- **Fix:** Either sanitize incoming patterns containing `\n` to use a different matcher/fallback, or use `pcregrep` (`-P -z`) if available.
- **Severity:** High

### 2. Output Head Boundary Truncation Loss (`grep.ts`)
- **File/Line:** `src/tools/grep.ts:74` inside `collect()`
- **What is wrong:** If the `outputBytes > MAX_OUTPUT_BYTES`, `truncated = true` is set, and the function immediately `return`s. It discards the *entirety* of the current chunk (which can be up to 64KB of buffer).
- **Impact:** Up to 64KB of valid, readable matching lines just before the 1MB limit boundary are irreversibly lost. 
- **Fix:** Append the exact slice of the chunk that fits under the 1MB limit before truncating.
- **Severity:** Medium

### 3. Missing Binary File Protection (`fileRefs.ts`)
- **File/Line:** `src/perceive/fileRefs.ts:31` inside `expandFileRefs()`
- **What is wrong:** The `stats.isFile()` check allows binary files to pass through and be forcefully read as UTF-8. 
- **Impact:** Referencing `@image.png` or an executable dumps 256KB of raw binary garbage into the LLM context, consuming massive tokens and permanently corrupting context.
- **Fix:** Check for null bytes in the first few kilobytes or utilize a mimetype/isbinaryfile utility before stringifying.
- **Severity:** High

### 4. Word-Boundary Failure causes Collateral Replacements (`fileRefs.ts`)
- **File/Line:** `src/perceive/fileRefs.ts:6` at `FILE_REF_PATTERN = /@([^\s]+)/g`
- **What is wrong:** The regex does not enforce a preceding space/word-boundary. It will match `@domain.com` inside the string `email@domain.com`.
- **Impact:** If a file named `domain.com` happens to exist in the project, the email will be mysteriously mangled and replaced with the file's contents.
- **Fix:** Change the regex to require a leading space or start-of-string: `/(?:^|\s)@([^\s]+)/g`.
- **Severity:** Medium

### 5. Escaped `#` Gitignore Mismatch (`gitignore.ts`)
- **File/Line:** `src/filter/gitignore.ts:107` inside `patternToRegex()`
- **What is wrong:** Lines that start with `\#foo` are successfully loaded (they aren't treated as comments), but the regex builder blindly escapes all backslashes (`\\[.+^...`). The pattern becomes `\\#foo`, matching a literal backslash rather than `#foo`.
- **Impact:** A file legitimately named `#foo` cannot be ignored using standard `.gitignore` escaping syntax.
- **Fix:** Pre-process the `\#` gitignore escape sequence just like `\*` and `\?` before executing regex character escaping.
- **Severity:** Low

### 6. Trailing Space Destruction (`gitignore.ts`)
- **File/Line:** `src/filter/gitignore.ts:21` inside `parseGitignore()`
- **What is wrong:** `line.trim()` unceremoniously strips all trailing spaces. Gitignore semantics mandate that spaces escaped with a backslash (`\ `) must be preserved.
- **Impact:** Patterns targeting directories with trailing spaces cannot be correctly filtered.
- **Fix:** Manually parse or strip only unescaped trailing spaces.
- **Severity:** Low

### 7. Ignorance of Nested `.gitignore` Precedence (`gitignore.ts`)
- **File/Line:** `src/filter/gitignore.ts:18` inside `parseGitignore()`
- **What is wrong:** The parser exclusively loads the `.gitignore` located at the root of `projectDir`. It performs no directory traversal to discover or respect `.gitignore` files nested in subdirectories.
- **Impact:** Nested rules and negated overrides deep in monorepos or vendor folders are completely ignored, flooding search results with artifacts that should be excluded.
- **Fix:** Walk the path segments and accumulate `.gitignore` contents hierarchically up to the root when evaluating a path.
- **Severity:** High

## Test failures
All tests pass.
