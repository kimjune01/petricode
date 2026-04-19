# Bug Hunt Round 55

## Triage outcome

- **#1 (GlobTool drops hidden dirs)** — FIXED in `src/tools/glob.ts`. Switched `glob.scan({ dot: false })` → `dot: true`. The gitignore filter still excludes `.git/`, `.petricode/`, and any user-ignored hidden dir, but `**/*.yml` now traverses non-gitignored hidden dirs like `.github/workflows/`. A model issuing glob to discover CI config no longer gets a misleading empty result.
- **#2 (TextDecoder stream flag misaligned with truncated)** — FIXED in `src/perceive/contextDiscovery.ts`. Tied `{ stream: truncated }` to the same `bytesRead >= MAX_READ_BYTES && !(statSize > 0 && statSize <= MAX_READ_BYTES)` condition. Pre-fix an exact-cap file ending mid-codepoint had the decoder buffer the partial UTF-8 sequence and silently drop it (decode is called once; no follow-up flush). This was a defect in my round 54 work — the truncated flag tightened correctly, but the stream flag was left on the looser condition.

3 regression tests added; full suite 432 pass (was 429).

---

### Bug 1 — GlobTool silently drops all hidden directories from wildcard patterns

**File:** `src/tools/glob.ts:41`

**Description:**
`BunGlob.scan` is called with `{ dot: false }` (Bun's default, but explicitly passed here). With `dot: false`, the `*` and `**` wildcards do not traverse directories whose names start with `.`. This means a model-issued call like `glob("**/*.yml")` will silently return no results for `.github/workflows/ci.yml`, `.circleci/config.yml`, or any other hidden-directory config. The agent never knows it missed them—it just sees fewer matches and may conclude the project has no CI configuration.

**User-visible impact:**
- Agent running `glob("**/*.yml")` to understand CI/CD setup returns empty or partial results, silently missing all GitHub Actions workflows and similar hidden-dir configs.
- No error message, no indication that hidden dirs were skipped—the agent may draw incorrect conclusions from the truncated result.
- Explicitly-dotted patterns like `glob(".github/**")` still work because the dot is literal in the pattern, not a wildcard expansion.

**Suggested fix:**
Change line 41 from:
```ts
for await (const path of glob.scan({ cwd, dot: false })) {
```
to:
```ts
for await (const path of glob.scan({ cwd, dot: true })) {
```
Gitignore filtering is already applied to every yielded path (lines 44–49), so `.petricode/`, `.git/`, and any other user-gitignored hidden directories remain excluded. The change only opens up traversal for hidden dirs that the user has not gitignored (like `.github/`).

**Severity:** Medium

---

### Bug 2 — contextDiscovery.ts TextDecoder uses wrong `stream` flag for exact-cap files

**File:** `src/perceive/contextDiscovery.ts:124`

**Description:**
`tryRead` passes `{ stream: bytesRead >= MAX_READ_BYTES }` to `TextDecoder.decode`. This sets `stream: true` for **two** cases:
1. Files genuinely larger than `MAX_READ_BYTES` (correct — holds back incomplete trailing bytes so they aren't decoded as U+FFFD before the truncation marker).
2. Files **exactly** `MAX_READ_BYTES` bytes on disk (incorrect — `statSize <= MAX_READ_BYTES` so `truncated` will be `false`, but the decoder is told to buffer incomplete trailing bytes that it will never flush).

For exact-cap files ending with a split multi-byte character (CJK, emoji, accented chars), the TextDecoder buffers the incomplete sequence internally and never emits it, because `decode()` is called exactly once and there is no follow-up call to flush. The clean return value silently loses the last partial codepoint, and no `[truncated]` marker is added because `truncated` is `false`.

`readFile.ts` (and `fileRefs.ts`) fixed this in an earlier round by computing the real `truncated` flag before calling `decode()`, then passing `{ stream: truncated }`. `contextDiscovery.ts` was not updated to match.

Note: `statSize` is already computed at line 99–103, before the decode at line 122, so the fix does not require restructuring.

**User-visible impact:**
Low in practice—valid UTF-8 files normally end on character boundaries, so `stream: true` buffers nothing. Risk is: a CLAUDE.md or `.agents/*` context file that is exactly 262,144 bytes and ends mid-codepoint (e.g., a CJK-heavy file edited to the byte cap) will silently drop the last character every turn with no truncation hint, causing subtle instruction corruption injected into the system context.

**Suggested fix:**
Before the `TextDecoder.decode` call, compute the correct stream flag using the same logic already used for `truncated`:
```ts
const streamMode =
  bytesRead >= MAX_READ_BYTES &&
  !(statSize > 0 && statSize <= MAX_READ_BYTES);
const decoded = new TextDecoder("utf-8").decode(
  buf.slice(0, bytesRead),
  { stream: streamMode },
);
```

**Severity:** Low

---

## Rejected / False from explore agent analysis

- **grep final flush missing isLineIgnored check** — FALSE. `isLineIgnored(stdoutBuf)` is already called at line 247 before `append()`.
- **Composer isPasting multi-chunk race** — FALSE. The `if (!isPasting.current)` guard at line 276 prevents a nextTick reset when a second paste is already in flight. The nextTick fires after useInput processes the same chunk (prependListener ordering), so resets are correctly deferred.
- **App.tsx handleToolConfirm stale closure** — THEORETICAL ONLY. `useCallback` dep on `state.pendingToolCall` recreates the callback after each render. Between tool confirmations there is always a `running` phase that forces a re-render before the next tool is shown, eliminating the window.
- **toolSubpipe.ts priorToolCalls comment** — NOT A BUG. The comment refers to `batchPriors` (full batch, used for the classifier). The sequential `priorToolCalls` at line 192 is dead code (accumulated but unread after the batch-priors optimization); not a correctness defect.
- **OpenAI synth_id collision** — LOW/THEORETICAL. The `synth_${idx}_${Date.now()}` ID would only collide if two entries share the same stream index in the same millisecond, which OpenAI's streaming protocol prevents (indices are unique per turn).
