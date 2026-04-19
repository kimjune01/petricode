# Bug Hunt Round 41

### 1. Dangerous shell predicate misses `git push` with refspec modifiers (e.g., `+main`)
- **File:** `src/filter/shellDanger.ts:32`
- **Description:** The regex for `git push --force` (`\bgit\s+push\s+(?:[^;&|\n]*\s)?(?:--force(?:-with-lease)?|-f)\b`) only checks for explicit flags. It misses refspec force pushes that use the `+` prefix to force-update a branch (e.g., `git push origin +main`).
- **User-visible impact:** In `--permissive` mode, an LLM issuing `git push origin +main` will bypass the dangerous shell guard and execute immediately without user confirmation, irrecoverably rewriting remote history.
- **Suggested fix:** Broaden the `git push` regex to also catch refspecs prefixed with `+`, for example: `/\bgit\s+push\s+(?:[^;&|\n]*\s)?(?:\+[^\s]+|--force(?:-with-lease)?|-f)\b/`.
- **Severity:** High

### 2. `shellRewrite` tokenize fails to unescape characters in quoted strings
- **File:** `src/filter/shellRewrite.ts:145`
- **Description:** The `tokenize` function captures double-quoted and single-quoted strings into `m[1]` and `m[2]` but does not unescape the captured contents. If a file path contains a literal escaped quote (e.g., `rm "foo \" bar"`), the token is captured exactly as `foo \" bar`. `shellQuote` then wraps it in single quotes (`'foo \" bar'`), creating a rewritten command that attempts to `mv` a non-existent file named `foo \" bar` instead of the actual file `foo " bar`.
- **User-visible impact:** The soft-delete alternative for `rm` will fail with a "No such file or directory" error when targeting files whose names require escaping. The user is safe from data loss, but the recommended safe alternative is broken.
- **Suggested fix:** Unescape the regex captures before pushing them to the `tokens` array (e.g., replacing `\"` with `"` and `\\` with `\` for double-quoted captures).
- **Severity:** Medium

### 3. `grep` tool silently fails when given path-based globs
- **File:** `src/tools/grep.ts:60`
- **Description:** The `grep` tool forwards the `glob` argument directly to GNU/BSD `grep`'s `--include` flag. However, `grep --include` matches against the *base name* of a file, not the full path. If an LLM passes a path-based glob like `src/**/*.ts` (which they frequently do, assuming ripgrep semantics), `grep` will return 0 matches because a base name cannot contain `/`.
- **User-visible impact:** The agent silently receives an empty search result when using valid path globs, leading it to falsely conclude that the code doesn't exist and hallucinate or fail the task.
- **Suggested fix:** Reject the tool call with a clear error message if the `glob` string contains `/` or `**`, or replace `grep` with `ripgrep` / a `find` + `grep` combo.
- **Severity:** Medium

### 4. `Composer` cursor navigation splits multi-codepoint grapheme clusters
- **File:** `src/app/components/Composer.tsx:28`
- **Description:** The `stepLeft` and `stepRight` functions only handle UTF-16 surrogate pairs. They do not account for grapheme clusters composed of multiple codepoints (e.g., emojis combined with a Zero Width Joiner like `👨‍👩‍👧‍👦`, regional indicator flags like `🇺🇸`, or variation selectors).
- **User-visible impact:** When a user types or pastes complex emojis and uses the left/right arrow keys or backspace to navigate, the cursor will land inside the grapheme cluster. Subsequent typing or deletion splits the cluster, corrupting the text into invalid or unintended characters (e.g., splitting a family emoji into individual people).
- **Suggested fix:** Use `Intl.Segmenter` to iterate over valid grapheme cluster boundaries instead of manually checking for surrogate pairs.
- **Severity:** Medium
