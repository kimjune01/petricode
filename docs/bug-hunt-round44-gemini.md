# Bug Hunt Round 44

Three new bugs found — two medium, one low.

> Reviewer note: same fallback as round 43 — gemini still throws on
> Vertex serialization, codex still unauthenticated. Reviewer was
> `claude --model sonnet`.

## Triage outcome

- **#1 (writeFile double-prefix)** — FIXED in `src/tools/writeFile.ts:32`. Inner throw now drops the `file_write:` prefix; outer catch supplies it once.
- **#2 (readFile inlines binary)** — FIXED in `src/tools/readFile.ts`. Replaced the size-bifurcated read path with the same NUL-byte sniff `fileRefs.ts` uses; binary content now throws a clear error instead of dumping U+FFFD garbage into context. Bonus: virtual files (/proc, /sys) that report size 0 but yield content now read correctly because we no longer cap allocation by stats.size.
- **#3 (truncation/SIGTERM/timeout race)** — FIXED in both `src/tools/shell.ts:62` and `src/tools/grep.ts` (the latter has the same pattern). `clearTimeout(timer)` now fires the moment truncation triggers so the still-armed timer can't race in, SIGKILL the process, and reject with a generic timeout error after we've already collected the truncated body. The close handler resolves with the truncated output as intended.

---

## Bug 1 — `file_write` double-prefix error message

**File:** `src/tools/writeFile.ts:29–37`

**Description:** When `file_write` is called on a path that is not a regular file (e.g. a directory or FIFO), the error message is double-prefixed: `file_write: file_write: not a regular file: /path`.

Root cause: the "not a regular file" check lives inside an inner try-catch whose only job is to pass through ENOENT and re-throw everything else. The thrown error already contains the `file_write:` prefix. The outer catch then prepends another `file_write:` before surfacing it to the caller.

Contrast with `readFile.ts`, where the stat+isFile check is inside the same single try-catch that prefixes the message — so the message is formed correctly once.

```typescript
// inner try:
throw new Error(`file_write: not a regular file: ${path}`);
// inner catch re-throws ↑ (not ENOENT)
// outer catch then wraps it:
throw new Error(`file_write: ${msg}`);  // → "file_write: file_write: not a regular file: …"
```

**User-visible impact:** Model and user see `file_write: file_write: not a regular file: /some/dir` instead of `file_write: not a regular file: /some/dir`. Doubled prefix is confusing and looks like a bug in the error-handling layer rather than a path problem.

**Suggested fix:** Throw a prefix-free message in the inner block and let the outer catch apply the single prefix, matching `readFile.ts`:
```typescript
if (!existing.isFile()) {
  throw new Error(`not a regular file: ${path}`);  // no "file_write:" here
}
```

**Severity:** Low-medium

---

## Bug 2 — `file_read` tool inlines binary files without NUL detection

**File:** `src/tools/readFile.ts:38–51`

**Description:** `ReadFileTool` reads any file under 256 KB and returns its content as a UTF-8 string, with no check for binary content. `fileRefs.ts` (used for `@path` expansion) sniffs the first 4 096 bytes for NUL bytes and silently skips binary files. `ReadFileTool` does not.

If the model issues `file_read` on a PNG, compiled binary, SQLite database, or any other binary file that happens to be under 256 KB, the raw bytes are decoded via `fh.readFile("utf-8")`, producing a string of replacement characters and garbage that is then inlined verbatim into the model context.

**User-visible impact:**
- Token budget consumed by replacement-character noise.
- The model gets meaningless content that it cannot act on and that can confuse subsequent reasoning.
- For files with only a few NUL bytes, the content looks like valid text with occasional `\x00`, which could mislead the model into treating binary headers as code.

**Suggested fix:** Add the same NUL-byte sniff that `fileRefs.ts` uses before returning content. Read up to `MAX_READ_BYTES` into a Buffer first, check the first 4096 bytes for `\x00`, and refuse with a clear error if any are found:
```typescript
const buf = Buffer.alloc(Math.min(stats.size || MAX_READ_BYTES, MAX_READ_BYTES));
const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
if (buf.slice(0, Math.min(bytesRead, 4096)).indexOf(0) !== -1) {
  throw new Error(`binary file (NUL bytes detected): ${path}`);
}
```

**Severity:** Medium

---

## Bug 3 — Shell truncation + SIGTERM-ignored timeout race

**File:** `src/tools/shell.ts:56–65, 78–81`

**Description:** When output exceeds `MAX_OUTPUT_BYTES` (1 MB), `collect()` sets `truncated = true`, calls `proc.kill("SIGTERM")`, and returns. The 30-second timeout timer is **not cleared** at this point — it keeps running.

If the spawned process traps or ignores SIGTERM (common for shell scripts that override signal handling), the timer fires before the process terminates. The timer handler calls `proc.kill("SIGKILL")` and **rejects** the promise with a timeout error. When the process finally closes (from SIGKILL), the `close` handler tries to `resolve(truncatedOutput)`, but the promise is already settled and the resolve is silently dropped.

Result: the user and model see a generic timeout error (`shell: command timed out after 30000ms`) instead of the partial output with the `[output truncated — exceeded 1MB]` marker. The partial content that was collected is thrown away.

Contrast with `grep.ts`, which also SIGTERMs on truncation but faces the same race. Both tools share this design.

**User-visible impact:** Commands that produce large output AND run long-lived subprocesses (e.g. `find | xargs something-slow`) fail with a confusing timeout error rather than returning the first megabyte of results. The model retries or reports failure rather than using the partial output.

**Suggested fix:** Clear the timer immediately when truncation fires, so the only two termination paths left are `close` (from the eventual SIGKILL or cooperative exit) and the abort signal:
```typescript
if (outputBytes > MAX_OUTPUT_BYTES) {
  truncated = true;
  clearTimeout(timer);  // prevent timeout from racing the SIGTERM
  proc.kill("SIGTERM");
  return;
}
```
If the process still doesn't die, a follow-up SIGKILL can be scheduled explicitly after a short grace period.

**Severity:** Low

---

*Hunt converged after verifying all three bugs against source. No additional bugs found.*
