# Bug Hunt Round 38

Found 4 new bugs.

### 1. gitignore negated character classes erroneously match directory separators
**Description**: In `src/filter/gitignore.ts`, the regex conversion for negated character classes (e.g., `[!a-z]`) emits `[^a-z]`. In JavaScript regex, a negated character class matches *any* character not in the set, which includes the directory separator `/`. According to `man gitignore`, wildcards and character classes must never match `/`. As a result, a pattern like `[!a-z]` will incorrectly ignore paths containing subdirectories (like `foo/bar`), as the `[^a-z]` class inadvertently swallows the `/`.
**Location**: `src/filter/gitignore.ts` around line 231 (in `patternToRegex`).
**User-visible impact**: Valid files inside subdirectories will be silently ignored if a `.gitignore` contains a negated character class, breaking file discovery for tools like `grep` and `glob`.
**Suggested fix**: Add `/` to the negated character class body during conversion, so `[!abc]` becomes `[^abc/]` instead of `[^abc]`.
**Severity**: Medium

### 2. gitignore parser throws runaway regex SyntaxError on escaped brackets `\[`
**Description**: In `src/filter/gitignore.ts` (`patternToRegex`), the regex used to extract character classes (`/\[((?:\\.|[^\]/])+)\]/g`) does not verify whether the opening `[` is escaped. If a user's `.gitignore` contains an escaped literal bracket (e.g., `\[abc\]`), the parser greedily extracts `abc\` as the character class body. This causes the metacharacter escape pass to produce a final regex string of `\\[abc\]` (literal backslash, open class, `a`, `b`, `c`, escaped bracket). The regex engine throws `SyntaxError: Invalid regular expression: missing terminating ] for character class`, crashing the tool.
**Location**: `src/filter/gitignore.ts` around line 229 (in `patternToRegex`).
**User-visible impact**: If any `.gitignore` in the project contains escaped brackets like `\[`, the `grep` tool and any other path resolution dependent on `loadIgnorePredicate` will throw an unhandled exception and fail entirely.
**Suggested fix**: Mask escaped brackets (e.g., `\\[` and `\\]`) into temporary sentinel strings *before* running the character class extraction regex, restoring them alongside the other masked metacharacters.
**Severity**: High

### 3. Composer leaks bracketed paste escape bytes due to chunk fragmentation
**Description**: The `onRawInput` hook in `src/app/components/Composer.tsx` intercepts raw `stdin` chunks to capture bracketed paste payloads. If `indexOf(PASTE_START)` is `-1` and no progress was made, it clears `pasteBuffer`. If the `\x1b[200~` escape sequence itself is fragmented across two `data` events (e.g., chunk 1 ends with `\x1b[20`, chunk 2 starts with `0~...`), `indexOf` fails on the first chunk and clears the buffer. The remaining `0~` and the pasted text are then passed to `useInput` as regular typing, bypassing the paste protections and leaking the broken escape sequence suffix (`0~`, `201~`) into the visible input text.
**Location**: `src/app/components/Composer.tsx` around line 90.
**User-visible impact**: Users pasting large blocks of text over SSH or on slow/heavily buffered connections may sporadically see `0~` or `201~` injected into their prompt, and the paste will be processed keystroke-by-keystroke (triggering slow re-renders) instead of synchronously.
**Suggested fix**: Before clearing `pasteBuffer`, check if the trailing bytes form a prefix of `PASTE_START`. If they do, retain those bytes in the buffer for the next chunk instead of clearing them unconditionally.
**Severity**: Medium

### 4. grep.ts post-filter breaks on Windows due to platform-specific path separators
**Description**: In `src/tools/grep.ts`, the `isLineIgnored` filter extracts the file path from grep's output and passes it through `path.normalize()` or `path.relative()`. On Windows, these Node.js path utilities convert `/` separators into `\`. However, the `isIgnored` predicate from `src/filter/gitignore.ts` strictly expects `/`-separated paths, as it uses `relativePath.split("/")` to evaluate path segments against gitignore rules. Consequently, `isIgnored` processes `src\foo.ts` as a single monolithic segment, bypassing all directory-level exclusion rules (like `node_modules` or `.git`) and failing to filter out ignored files on Windows.
**Location**: `src/tools/grep.ts` around line 76 (in `isLineIgnored`).
**User-visible impact**: On Windows machines, `grep` will flood the LLM context with build artifacts and `node_modules` matches because the gitignore post-filter silently fails to exclude them.
**Suggested fix**: Convert backslashes to forward slashes before passing the relative path to `isIgnored` (e.g., `isIgnored(rel.replace(/\\/g, "/"), false)`).
**Severity**: Medium