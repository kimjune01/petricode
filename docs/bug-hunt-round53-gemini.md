# Bug Hunt Round 53

Three new bugs found. All verified against source.

## Triage outcome

- **#1 (abortRef blind-null race)** — FIXED in `src/app/App.tsx`. Both the success and catch nulling sites in `handleSubmit` now compare identity (`if (abortRef.current === controller) abortRef.current = null`). Prevents a Ctrl+C → Enter race from orphaning turn 2's controller, which would have left it un-Ctrl+C-able and waved a third concurrent submit through the double-submit guard. The Ctrl+C handler still blind-nulls (it owns the controller it just aborted).
- **#2 (serializeSkill JSON write vs parseFrontmatter raw read)** — DEFERRED. Currently latent: the consolidator-written fields (`confidence`, `source_sessions`, `generated`) are not consumed by the pipeline today. Both candidate fixes are behavior changes: option 1 (add `JSON.parse` to parseFrontmatter) would re-type existing string-valued YAML scalars in user-authored skills (`description: 0.6` → number); option 2 (skip stringify for strings) would still leave the load path inconsistent across loaders. Worth revisiting once a real consumer of the typed values lands.
- **#3 (JSON.stringify circular-ref crash)** — FIXED in `src/app/components/ToolConfirmation.tsx`. Wrapped the fallback `JSON.stringify(toolCall.args)` in try/catch with a `[args unavailable]` fallback. Provider-parsed args can't cycle today, but a future SDK extension or programmatic test helper that constructs a cyclic ToolCall would otherwise crash mid-render and freeze the TUI in `confirming` with no prompt visible — only a kill could recover.

4 regression tests added (2 for #1, 1 for #3, plus one Ctrl+C-blind-null-still-permitted carve-out via region-restricted regex); full suite 427 pass (was 425).

---

## Bug 1 — abortRef.current blind-null race in handleSubmit

**File:** `src/app/App.tsx:344` and `src/app/App.tsx:358`
**Severity:** Medium

**Description:**
`handleSubmit` creates an `AbortController` per turn and stores it in `abortRef.current`. On success (line 344) and on error/abort (line 358) it unconditionally sets `abortRef.current = null`. The race:

1. Turn 1 is in flight: `abortRef.current = controller1`.
2. User hits Ctrl+C. Handler (line 161) does `controller1.abort()` then `abortRef.current = null`. Phase → "composing".
3. User immediately presses Enter (guard at line 245 passes because ref is null). `abortRef.current = controller2`. Turn 2 starts.
4. Turn 1's `AbortError` settles asynchronously in the `catch` block: `abortRef.current = null` — **erases controller2**.

After step 4:
- The Ctrl+C handler for turn 2 reads `null` and skips the abort (`if (... && abortRef.current)` is false).
- The double-submit guard at line 245 allows a third concurrent submit.
- Turn 2 runs to completion with no way for the user to interrupt it.

The window is narrow but real: the user must submit again before the first `AbortError` settles (a few event-loop ticks), which is achievable with rapid Ctrl+C → Enter.

**User impact:** Running turn can't be Ctrl+C'd; guard allows a spurious third submit; TUI appears stuck in "running" with no response to Ctrl+C.

**Suggested fix:** Use identity comparison instead of unconditional null:
```typescript
// Line 344 (success path)
if (abortRef.current === controller) abortRef.current = null;

// Line 358 (catch path)
if (abortRef.current === controller) abortRef.current = null;
```
`controller` is in scope in both blocks via closure.

---

## Bug 2 — serializeSkill writes JSON-encoded values that parseFrontmatter reads back as raw strings

**Files:** `src/skiller/transmit.ts:50–57` (write) and `src/skiller/perceive.ts:131` (read)
**Severity:** Low–Medium

**Description:**
`serializeSkill` serializes every non-`name`/non-`trigger` frontmatter field with `JSON.stringify(value)` (line 57). When skills are written by the consolidator (`writeApproved` in `src/commands/consolidate.ts:68–74`), the persisted frontmatter looks like:

```
confidence: 0.6          ← JSON number literal (no quotes)
source_sessions: ["abc"] ← JSON array literal
generated: true          ← JSON boolean literal
```

`discoverSkills` → `parseFrontmatter` (the load path used by the pipeline) reads values as raw strings with only a simple quote-pair strip (line 131). It does **not** call `JSON.parse`. So when a saved skill is reloaded:

- `confidence: 0.6` → stored as `"0.6"` (string, not number)
- `source_sessions: ["abc"]` → stored as `'["abc"]'` (literal JSON text, not array)
- `generated: true` → stored as `"true"` (string, not boolean)

The most fragile consequence: if a skill is given an array-valued `paths` field (e.g. because a future code path passes `paths: ["src/**", "*.ts"]`), `serializeSkill` writes it as `paths: ["src/**","*.ts"]`. After reload, `matchAutoTriggers` in `filter.ts:68` checks `typeof rawPaths !== "string"`. The value IS a string now (`'["src/**","*.ts"]'`), so the check passes, but `matchesGlob` tries to compile that JSON literal as a glob pattern, which never matches real paths. Auto-trigger silently fails with no warning.

Currently non-breaking because the consolidator always uses `trigger: "manual"` and the affected fields (`confidence`, `source_sessions`, `generated`) are not consumed by the pipeline. But the divergence is a latent trap.

**User impact:** Skills created via `/consolidate` and reloaded would have incorrect frontmatter types for any non-string metadata fields. Array-valued `paths` on auto-trigger skills would silently prevent firing.

**Suggested fix (two options):**
1. In `parseFrontmatter`, after stripping quotes, try `JSON.parse(value)` and fall back to the raw string if it fails — mirrors what `parseSkill` in `skiller/transmit.ts:82–86` already does.
2. In `serializeSkill`, write strings without JSON.stringify (bare values): `lines.push(\`${key}: ${value}\`)`, relying on the quote-strip in parseFrontmatter for strings that contain colons.

---

## Bug 3 — JSON.stringify without try-catch in ToolConfirmation argsPreview

**File:** `src/app/components/ToolConfirmation.tsx:139`
**Severity:** Low

**Description:**
The fallback args preview is computed as:
```typescript
const s = JSON.stringify(toolCall.args);
return s.slice(0, 120) + (s.length > 120 ? " [...]" : "");
```

`JSON.stringify` throws a `TypeError: cyclic object value` if the object contains circular references. Tool args come from `JSON.parse` of the provider stream, so they can never be circular in practice. However, any programmatic path that constructs a `ToolCall` with a cycle (a test helper, a future SDK extension, or a provider bug that returns a pre-parsed object) would crash the `ToolConfirmation` component before the user can approve or deny, leaving the TUI broken with an unresolvable confirmation prompt.

**User impact:** Confirmation prompt crashes; phase is "confirming" with no component rendered; user must kill the process.

**Suggested fix:**
```typescript
const argsPreview = preview == null
  ? (() => {
      try {
        const s = JSON.stringify(toolCall.args);
        return s.slice(0, 120) + (s.length > 120 ? " [...]" : "");
      } catch {
        return "[args unavailable]";
      }
    })()
  : null;
```

---

## Rejected agent findings (with reasons)

The exploratory agent also flagged 14 other items. After code verification, all were rejected:

- **Cache tool-result inner loop infinite loop** — false. `this.hot.shift()` is called inside the loop body; the array always shrinks, preventing any revisit of `hot[0]`.
- **Pipeline turn append order race** — false. The catch block at line 304 commits `userTurn` before re-throwing; the abort check at line 315 commits `assistantTurn` after `commitTurn(userTurn)` at line 310. Ordering is correct.
- **decisionStore missing safeParseJson** — false. Lines 52–64 already have a try-catch with the same fallback behavior.
- **ToolConfirmation resolvedRef stale** — pre-existing deferred item; not a new mechanism.
- **editFile validates old_string after file read** — style nitpick, not a bug.
- **Retry provider drops streamed chunks** — correct design (mid-stream retry is impossible); not a bug.
- **Glob tool cwdPrefix fragile for absolute paths** — path validation upstream ensures containment before execute(); no practical attack path.
- Remaining items: speculative race conditions that require premises that cannot arise (LLM can't produce circular JSON, SQL uses parameterized queries, etc.).
