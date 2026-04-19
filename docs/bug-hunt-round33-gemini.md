# Bug Hunt Round 33 (gemini)

## 1. gitignore.ts: Unpruned sequential traversal of ignored directories
- **File/Line**: `src/filter/gitignore.ts` in `collectGitignores` (around line 43)
- **Description**: The directory walker traverses the project tree top-down and sequentially `await`s recursive calls to `collectGitignores`. However, it only skips directories hardcoded in `ALWAYS_EXCLUDED` (`node_modules`, `.git`, etc.) and does not prune the search using the patterns collected so far. According to git semantics, if a directory (like `build/`, `target/`, or `dist/`) is excluded, it and all its contents are ignored, and git never searches it for nested `.gitignore` files. By traversing blindly, the tool forces thousands of sequential `readdir` and `readFile` operations into massive build folders, causing severe performance degradation.
- **User-visible impact**: Initializing the context or executing tools like `grep` can take minutes on large codebases or monorepos that contain large ignored build directories, as the agent wastes time deeply traversing folders git would natively skip.
- **Suggested fix**: After parsing the `.gitignore` in the current directory and pushing to `out`, compile a temporary predicate (`const isIgnored = buildIgnorePredicate(out);`). Before recursing, check `if (isIgnored(sub, true)) continue;` to safely prune ignored directories. (Also consider using `Promise.all` for concurrent sibling traversal).
- **Severity**: High

## 2. grep.ts: Binary file matches bypass gitignore filter and leak into context
- **File/Line**: `src/tools/grep.ts` in `execute` (around line 144)
- **Description**: The `grep` command does not include the `-I` flag, meaning it searches binary files. When it finds a match in a binary file, it outputs a line formatted as `Binary file ./dist/bundle.js matches` instead of the standard `path:lineno:text`. The post-filter splits lines and checks `if (colon <= 0) return true;`. Because the binary match output lacks a colon, it trivially passes this check and is included in the final output. This completely bypasses the `isIgnored` check.
- **User-visible impact**: When searching for patterns in a project with compiled assets or binary files, the LLM's context window is flooded with "Binary file ... matches" lines from directories (like `dist/`) that should have been ignored.
- **Suggested fix**: Add the `-I` flag to the `grepArgs` array to completely ignore binary files at the source, preventing them from being searched or appearing in the output.
- **Severity**: High

## 3. fileRefs.ts: Naive 256KB truncation bisects multi-byte UTF-8 characters
- **File/Line**: `src/perceive/fileRefs.ts` in `expandFileRefs` (around line 46)
- **Description**: When reading a file larger than `MAX_READ_BYTES` (262,144 bytes), the file is read into a buffer and exactly `bytesRead` bytes are decoded via `.toString("utf-8")`. If the exact 256KB boundary lands in the middle of a multi-byte UTF-8 character, Node's decoder emits the replacement character (``). Unlike `grep.ts` which safely slices by code point to avoid this, `fileRefs.ts` performs a naive byte slice.
- **User-visible impact**: A large file referenced via `@path` might occasionally end with a broken character (``) immediately before the `[truncated...]` footer.
- **Suggested fix**: Decode using `buf.slice(0, bytesRead).toString("utf-8")` but then perform a character-safe slice, or copy the robust char-by-char accumulation from `grep.ts`.
- **Severity**: Low

## Test failures
All tests pass.