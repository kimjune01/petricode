# Bug Hunt Round 37

1. **Composer leaks 8-bit C1 control characters (High)**
   - **File/Line:** `src/app/components/Composer.tsx` (Line ~167) `/\x1b\[[0-9;]*[a-zA-Z]|[\x00-\x08\x0b-\x1f\x7f]/g`
   - **Description:** The ANSI sanitization regex for multi-char pasted input explicitly targets the 7-bit `\x1b` sequence but fails to include the 8-bit C1 control range (`\x80-\x9f`). Specifically, it drops `\x7f` but leaves `\x9b` (the 8-bit equivalent of `\x1b[`, CSI) untouched.
   - **User-visible impact:** An attacker can embed an 8-bit CSI terminal sequence (e.g., `\x9b2J` to clear the screen, or `\x9b]8;;url...` OSC) in copied text. When pasted and eventually echoed by the TUI or LLM, it executes the control code, breaking the terminal or injecting malicious rendering.
   - **Suggested fix:** Expand the single-character drop range to include C1 controls, matching `App.tsx`: `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]`.

2. **fileRefs fails to expand quoted paths when `@` is outside quotes (Medium)**
   - **File/Line:** `src/perceive/fileRefs.ts` (Line ~20) `const trailingMatch = rawPath.match(/[.,;:!?)\]}>"'` + "`" + `]+$/);`
   - **Description:** When a user types a path reference wrapped in quotes (e.g., `@"src/foo.ts"`), the regex `([^\s]+)` captures `"src/foo.ts"`. The trailing cleanup logic successfully removes the closing quote, but leaves the leading quote intact (`"src/foo.ts`). The `fs.stat` lookup then fails because the leading quote is treated as part of the filename.
   - **User-visible impact:** Valid file references like `@"path/to/file"` fail to inline their contents silently, leading the agent to hallucinate or miss critical requested context.
   - **Suggested fix:** Apply a leading punctuation strip (e.g., `rawPath.replace(/^["'([{]+/, "")`) in addition to the trailing strip before validating the path.

3. **gitignore breaks git's character class patterns (Medium)**
   - **File/Line:** `src/filter/gitignore.ts` (Line ~168) `regex = regex.replace(/[.+^${}()|[\]\\]/g, "\\$&");`
   - **Description:** The `patternToRegex` function aggressively escapes the `[` and `]` brackets before converting glob sequences. However, the `.gitignore` specification natively supports glob character classes (e.g., `*[a-z]*.js`). By escaping them, `[a-z]` becomes the literal string `\[a-z\]` instead of a regex character set.
   - **User-visible impact:** Standard `.gitignore` patterns using character ranges will fail to ignore the intended files, exposing them to tools like `grep` and flooding the context window.
   - **Suggested fix:** Skip escaping `[` and `]` when sanitizing the glob pattern, or safely map glob character classes to regex character classes during the conversion phase.

4. **grep bisects output lines if filenames contain newlines (Low)**
   - **File/Line:** `src/tools/grep.ts` (Line ~102) `while ((nl = stdoutBuf.indexOf("\n")) !== -1) { ... }`
   - **Description:** The line-buffered `stdout` collector splits grep output strictly on `\n`. If a matched file's name contains a literal newline character, the `file:line:content` output is bisected. The first half (the prefix of the filename) fails the `isLineIgnored` colon parser and is errantly allowed through; the second half causes an invalid parse and is likely dropped.
   - **User-visible impact:** Searching across a project containing files with embedded newlines corrupts the `grep` output returned to the agent, potentially leaking ignored file contents.
   - **Suggested fix:** Use the `--null` (`-Z`) flag with `grep` to separate filenames with `\x00` and `\n` to unambiguously parse the filename and line content.

5. **fileRefs ignores 0-byte special files (Low)**
   - **File/Line:** `src/perceive/fileRefs.ts` (Line ~43) `const { bytesRead } = bufSize > 0 ? await fh.read(...) : { bytesRead: 0 };`
   - **Description:** The buffer sizing logic binds the read buffer strictly to `stats.size`. If the target is a 0-byte file that generates data when read (such as virtual files in `/proc` or `sysfs` mounted inside a workspace, or some FUSE file systems), `bufSize` calculates to 0. Consequently, `bytesRead` is 0, and the file is inlined as an empty string.
   - **User-visible impact:** If a user attempts to include context from a virtual 0-byte file (e.g., `@/proc/cpuinfo` if working in a Linux environment or a FUSE mount), the agent receives an empty file rather than the actual dynamic content.
   - **Suggested fix:** Do not cap the initial buffer read to `stats.size` if it is 0. Instead, allocate a minimum buffer (e.g., 4096 bytes) or rely on the `MAX_READ_BYTES` cap directly for the first read to capture dynamically generated content.