# Bug Hunt Round 45

> Reviewer: `claude --model sonnet` (gemini still throws on Vertex
> serialization, codex still unauthenticated). Same fallback as
> rounds 43–44.

## Triage outcome

- **#1 (`permissiveShellGuard` never wired)** — FIXED in `src/session/bootstrap.ts:184`. The local var was computed and never passed to `pipelineOpts`, silently making `--permissive` equivalent to `--yolo` since the round 40 wiring landed. **High severity** — this was the headline regression of this round.
- **#2 (ToolConfirmation strips tabs/newlines)** — FIXED in `src/app/components/ToolConfirmation.tsx:21`. Mirror App.tsx's exclusion of `\t \n \r` from the C0 strip so multi-line classifier rationales render as multiple lines.
- **#3 (sessionStore corrupted-row crash)** — FIXED in `src/transmit/sessionStore.ts`. Added `safeParseJson` helper used at all five sites; one corrupted DB row now warns + degrades to empty content/metadata for that turn instead of throwing out of `read`/`list`/`readFull` and bricking session resume.
- **#4 (decisionStore corrupted-row crash)** — FIXED in `src/transmit/decisionStore.ts:54`. Same pattern, scoped inline since this is the only call site in the file.

## Bug 1: `permissiveShellGuard` never wired into pipeline — `--permissive` and `--yolo` are identical

**File:** `src/session/bootstrap.ts:137,175-184`

**Description:** `permissiveShellGuard` is computed at line 137 (`const permissiveShellGuard = mode === "permissive"`) and even documented in the adjacent comment ("wired below via permissiveShellGuard"), but is never added to `pipelineOpts` (lines 175–184). `Pipeline.init()` therefore always receives `permissiveShellGuard: undefined`, which it treats as `false`. The re-check of dangerous shell commands inside `runToolSubpipe` (toolSubpipe.ts:321) — `if (permissiveShellGuard && policyOutcome === "ALLOW")` — never fires.

**Impact:** `--permissive` mode and `--yolo` mode are functionally identical. In permissive mode, `rm -rf /`, `sudo`, `git push --force`, `dd of=/dev/sda`, and every other pattern in `PATTERNS[]` auto-execute without prompting the user, defeating the entire purpose of the distinction between `--permissive` ("yes to reversible, escalate un-undoable") and `--yolo` ("yes to everything"). A user who specifically chooses `--permissive` over `--yolo` for safety gets no additional protection.

**Fix:** Add `permissiveShellGuard` to `pipelineOpts`:
```ts
const pipelineOpts: PipelineOptions = {
  router,
  projectDir,
  sessionId,
  registry,
  policyRules,
  onConfirm: opts.onConfirm,
  classifier,
  onClassified: opts.onClassified,
  permissiveShellGuard,   // ← add this line
};
```

**Severity:** high

---

## Bug 2: `ToolConfirmation.tsx` ANSI strip regex collapses multi-line rationales

**File:** `src/app/components/ToolConfirmation.tsx:21`

**Description:** The local `ANSI_RE` constant uses `[\x00-\x1f\x7f-\x9f]` which spans the entire C0 control block, including `\x09` (tab), `\x0a` (LF), and `\x0d` (CR). The `stripAnsi()` function applied to classifier rationales before rendering therefore collapses all embedded newlines and tabs into nothing. Compare to App.tsx line 234, which explicitly preserves these bytes with `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]` and even carries a comment: "Preserve `\t` (`\x09`), `\n` (`\x0a`), `\r` (`\x0d`) — stripping them squashes multi-line rationales into one illegible run."

**Impact:** The confirmation prompt shows the classifier's rationale as one run-on line whenever the rationale contains newlines (e.g., a bulleted "reasons to escalate" from the Flash classifier). The user cannot easily read the justification for why the tool was flagged, making the confirmation decision less informed.

**Fix:** Change the character class in `ANSI_RE` to match App.tsx's pattern:
```ts
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
```

**Severity:** low

---

## Bug 3: `sessionStore.ts` — `JSON.parse` without try-catch crashes all session operations on a single corrupted row

**File:** `src/transmit/sessionStore.ts:127,153,178,188,197`

**Description:** Five `JSON.parse` call sites in `SessionStore` have no error handling:
- Line 127: `JSON.parse(row.content_json)` in `read()`
- Line 153: `JSON.parse(s.metadata_json)` in `list()`
- Lines 178, 188, 197: three `JSON.parse` calls in `readFull()`

These parse data written to SQLite by petricode itself, but JSON can be corrupted by a prior crash mid-write, manual inspection edits, or filesystem issues. A single row with invalid JSON causes the entire `map()` call to throw, which propagates uncaught out of `read()` / `list()` / `readFull()`, permanently breaking session resume and list operations with no user-readable error ("SyntaxError: Unexpected token" from SQLite row).

**Impact:** A corrupted session database row causes `petricode --resume <id>` and `/sessions` to crash with an opaque JS error. The session is inaccessible with no graceful fallback or skip-the-bad-row recovery.

**Fix:** Wrap each `JSON.parse` in a try-catch that returns a safe default (`[]` for content arrays, `{}` for metadata objects) and either skips the bad row or returns a placeholder, and logs a warning. Example for `read()`:
```ts
content: this.internalizeContent(
  (() => { try { return JSON.parse(row.content_json); } catch { return []; } })()
),
```

**Severity:** med

---

## Bug 4: `decisionStore.ts` — `JSON.parse` without try-catch crashes decision listing

**File:** `src/transmit/decisionStore.ts:54`

**Description:** `presented_context: JSON.parse(r.presented_context_json)` in `DecisionStore.list()` has no error handling. Same mechanism as Bug 3 — a single corrupted row in the `decisions` table throws and prevents the entire `list()` result from being returned.

**Impact:** Any caller of `DecisionStore.list()` (e.g., session audit/review tooling) will crash on a corrupted row with no skip-and-continue option.

**Fix:** Wrap in try-catch: `presented_context: (() => { try { return JSON.parse(r.presented_context_json); } catch { return {}; } })()`.

**Severity:** low
