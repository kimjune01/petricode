# Bug Hunt Round 39

1. `gitignore.ts` string trimming breaks leading/trailing space rules (Logic/Spec)
File: `src/filter/gitignore.ts` (line 44)
Description: `parseGitignore` applies `rawLine.trim()` to each line. The gitignore spec states that spaces preceding the first character are significant (not ignored). Furthermore, trailing spaces escaped with a backslash (`\ `) are significant. `trim()` indiscriminately drops all leading spaces and drops the trailing space from an escaped suffix (e.g., `foo\ ` becomes `foo\`), mangling both types of patterns.
User-visible impact: Files with leading spaces in their names cannot be ignored. Patterns ending in `\ ` designed to match trailing-space files will fail to match.
Fix: Remove `.trim()`. Manually remove trailing `\r` (for Windows checkouts) and only strip unescaped trailing spaces, leaving leading spaces and escaped trailing spaces intact.
Severity: Medium

2. `fileRefs.ts` TOCTOU truncation race condition on growing files (Logic/Resource)
File: `src/perceive/fileRefs.ts` (line ~55)
Description: `bufSize` is capped by `Math.min(stats.size, MAX_READ_BYTES)` rather than simply allocating `MAX_READ_BYTES`. If a file (like a live log) grows between the `stat` call and the `fh.read` call, the read will be artificially restricted to the older `stats.size`. Because `bytesRead` won't reach `MAX_READ_BYTES`, `truncated` remains `false` and the new data is silently dropped without notifying the LLM that truncation occurred.
User-visible impact: Inlined `@path` mentions for actively growing files will silently miss the newest bytes appended just before reading, without rendering the `[truncated...]` warning, potentially confusing the LLM about the log's tail.
Fix: Remove the `stats.size` cap and always allocate `MAX_READ_BYTES` (or use a dynamic buffer approach). `bytesRead` will naturally reflect the actual bytes read up to the cap.
Severity: Low

3. `App.tsx` unmount leaks pending onConfirm promise, hanging toolSubpipe (Resource/Lifecycle)
File: `src/app/App.tsx` (line ~83)
Description: The cleanup function in `App`'s `useEffect` triggers `abortRef.current?.abort()` but fails to reject the pending `confirmResolveRef.current` if the TUI is unmounted while in the `"confirming"` phase. Because `toolSubpipe` awaits `onConfirm` and does not race it against `signal?.aborted`, the unresolved promise causes the pipeline execution thread to hang indefinitely.
User-visible impact: If the app terminates or unmounts the main component during an active tool confirmation prompt, the underlying pipeline agent leaks as a zombie thread that never resolves or exits cleanly.
Fix: Add `confirmResolveRef.current?.reject(new DOMException("Aborted", "AbortError")); confirmResolveRef.current = null;` to the `useEffect` cleanup block alongside the abort call.
Severity: Medium
4. `grep.ts` incorrectly skips gitignore evaluation for filenames starting with `..` (Logic/Security)
File: `src/tools/grep.ts` (line ~973)
Description: In `isLineIgnored`, `rel.startsWith(\"..\")` is used to skip the `isIgnored` check for files residing outside `projectRoot`. However, this primitive check erroneously matches legitimate files inside the project whose names simply begin with `..` (e.g. `...`, `..foo`, `..env`).
User-visible impact: Any file or directory inside the project root whose name begins with `..` will permanently bypass all `.gitignore` rules and always be included in grep results, even if it was explicitly meant to be ignored.
Fix: Use a safer path check, such as `rel === \"..\" || rel.startsWith(\"../\") || rel.startsWith(\"..\\")` to accurately identify paths exiting the root without collaterally matching internal filenames.
Severity: Medium
