# Bug Hunt Round 48

Reviewer: claude-sonnet-4-6 (Gemini slot)
Date: 2026-04-19
Scope: TUI, shell gating, gitignore, fileRefs, grep, sessions/headless/pipeline, providers, cache, transmit, perceive, tools, skiller.

## Triage outcome

- **#1 (StatusBar hint missing m)** — FIXED in `src/app/components/StatusBar.tsx:51`. Dropped the static `confirming` hint entirely; ToolConfirmation already renders its own keybind line that knows about the optional `m` (move-to-trash) binding.
- **#2 (paste cursor uses UTF-16 length)** — REJECTED. False positive. Both `cursor` and `combined.length` are UTF-16 indices; the segmenter walks UTF-16 boundaries. Advancing by `combined.length` lands the cursor at the end of the inserted text, which is necessarily a grapheme boundary (you can't paste a partial emoji). stepLeft from there walks to the previous segment correctly.
- **#3 (interruptedResult outcome ALLOW)** — FIXED in `src/agent/toolSubpipe.ts:113`. Changed to "DENY" so headless's `outcome === "DENY"` filter surfaces interrupted tools in the failure summary.
- **#4 (volley no timeout)** — FIXED in `src/convergence/volley.ts`. Added 90s per-call PROVIDER_TIMEOUT_MS via Promise.race; threaded an AbortSignal through Provider would be cleaner but Provider.generate doesn't accept one yet — bigger refactor than this round warrants.
- **#5 (.agents/ no size cap)** — FIXED in `src/perceive/contextDiscovery.ts:86`. tryRead now opens with fh.read into a 256KB buffer and appends `[truncated…]` when the cap fires. Mirrors readFile.ts and fileRefs.ts conventions.
- **#6 (empty tool_use_id)** — DEFERRED. Speculative — no verified provider returning empty IDs. The defensive `tc.id || crypto.randomUUID()` would be cheap but adds complexity for an unobserved scenario. Re-evaluate if a real provider 400 surfaces.
- **#7 (YAML quoted values)** — FIXED in `src/skiller/perceive.ts:115`. Strip a matched leading+trailing quote pair (single or double) before storing the value.
- **#8 (JSON.stringify twice)** — FIXED in `src/app/components/ToolConfirmation.tsx:167`. Compute argsPreview once with a single JSON.stringify call.
- **#9 (writeFile bytes vs code units)** — FIXED in `src/tools/writeFile.ts:44`. Use `Buffer.byteLength(content, "utf8")`.

---

## Bug 1 — StatusBar hint missing `m` keybind when alternative is offered

**File:** `src/app/components/StatusBar.tsx:51`

**Description:**
`PHASE_HINTS` for the `"confirming"` phase is hardcoded as:
```
"y allow  n deny"
```
But `ToolConfirmation.tsx` adds a third binding: `m` (move to trash) whenever a soft-delete alternative is present. A user staring at a confirmation prompt for `rm -rf` sees the hint bar say only `y allow  n deny` while the actual prompt box shows `↻ [m] move "foo" → /tmp/...  (recommended)`. The status bar hint is permanently out of sync with the real keybinding surface the moment an alternative exists.

**User-visible impact:** User reads the bottom hint, sees only two choices, may not realize `Enter` defaults to the move alternative (not deny when an alternative is present), and may press `y` to run as-is when they intended the safer option. Confusing and potentially destructive reflex error.

**Suggested fix:** Either (a) pass the `alternative` flag down into `StatusBar` and switch the hint to `"m move  y allow  n deny"` when it is set, or (b) drop the confirming row from `PHASE_HINTS` entirely and rely solely on `ToolConfirmation`'s own rendered keybinding line.

**Severity:** medium

---

## Bug 2 — `Composer` cursor advance uses raw `combined.length` (UTF-16 code units), not grapheme count, after paste

**File:** `src/app/components/Composer.tsx:262-265`

**Description:**
When the raw-stdin paste handler builds the combined string and inserts it, the cursor advance is:
```ts
cursor: prev.cursor + combined.length,
```
`String.length` counts UTF-16 code units. Pasting text that contains surrogate-pair emoji (e.g. "🎉") advances the cursor by 2 per emoji — one extra code unit. The first subsequent arrow-left then steps back by only 1 (via `stepLeft`), landing the cursor between the high and low surrogate, which `stepLeft` immediately snaps back to the cluster boundary. The net effect is a phantom extra cursor position after paste that resolves on the next movement, but until then backspace deletes the wrong character.

The `useInput` handler for regular typed characters correctly uses `ch.length` (which is 2 for an astral char typed one at a time), but the paste handler's `combined.length` is also correct for code-unit advancement — the real issue is that both paths use code-unit counts while `stepLeft`/`stepRight` reason about grapheme clusters. The inconsistency manifests only when the pasted text contains grapheme clusters wider than one JS string index (ZWJ emoji, regional indicators), causing the cursor position to point mid-cluster immediately after paste.

**User-visible impact:** After pasting a block containing multi-codepoint emoji, the cursor position is one or more code units off. Backspace deletes the wrong character until the user moves the cursor to re-snap to a grapheme boundary. Rare but real on modern text.

**Suggested fix:** After building `combined`, derive its grapheme count using the same `segmenter` (if available) before adding to the cursor:
```ts
const advance = segmenter
  ? [...segmenter.segment(combined)].length
  : combined.length;
cursor: prev.cursor + advance,
```
This matches the approach used in `stepLeft`/`stepRight`.

**Severity:** low

---

## Bug 3 — `toolSubpipe`: `interruptedResult` marks outcome as `"ALLOW"` for tools never executed

**File:** `src/agent/toolSubpipe.ts:109-116`

**Description:**
```ts
function interruptedResult(tc: ToolCall): ToolResult {
  return {
    toolUseId: tc.id,
    name: tc.name,
    outcome: "ALLOW",           // ← incorrect
    content: INTERRUPTED_CONTENT,
  };
}
```
A tool that was interrupted before execution (Ctrl+C before the tool ran, or a mid-batch abort after prior tools finished) is returned with `outcome: "ALLOW"`. This means `headless.ts`'s partial-results reporting logic (`err.partialResults.filter((r) => r.outcome === "DENY")`) will never flag the interrupted tools as failed — they look identical to successfully ALLOWed tools. A CI consumer checking the JSON escalation output for `DENY`-outcome partials to surface pre-escalation failures will silently miss interrupted tools, thinking they completed successfully.

**User-visible impact:** In headless mode with the classifier enabled, a `ClassifierEscalation` carries `partialResults` that include interrupted tools marked `"ALLOW"`. `headless.ts` prints a `"tool X failed before escalation"` note only for `outcome === "DENY"` items, so interrupted tools are silently omitted from the pre-escalation failure summary. Scripts/CI consuming the exit-2 JSON output see them listed as successful executions.

**Suggested fix:** Use a new outcome (e.g. `"INTERRUPTED"`) or reuse `"DENY"` for interrupted results. At minimum, filter them separately:
```ts
outcome: "DENY",  // treat unexecuted interrupted tools as denied, not allowed
content: INTERRUPTED_CONTENT,
```
Then `headless.ts`'s existing `r.outcome === "DENY"` filter naturally catches them and surfaces the interruption in stderr.

**Severity:** medium

---

## Bug 4 — `volley.ts` passes `AbortSignal`-less `ModelConfig` to both providers; a hung reviewer blocks indefinitely

**File:** `src/convergence/volley.ts:24-31`

**Description:**
`collectResponse` calls `provider.generate(prompt, { max_tokens: 4096 })` with no `signal`. There is no timeout and no cancellation path inside `volley`. If either the primary or reviewer provider hangs (network partition, rate-limit that doesn't surface as an error, provider-side stuck stream), `volley` itself hangs indefinitely with no way to interrupt it. The caller has no `AbortSignal` to pass in because `volley`'s signature does not accept one.

```ts
async function collectResponse(provider: Provider, prompt: Message[]): Promise<string> {
  let text = "";
  for await (const chunk of provider.generate(prompt, { max_tokens: 4096 })) {
```

**User-visible impact:** Any call site that invokes `volley` (consolidator, /consolidate command) can permanently hang the agent process if a provider call stalls. The user sees a spinner with no progress and no timeout.

**Suggested fix:** Add an optional `signal?: AbortSignal` parameter to `volley` and thread it into `collectResponse`'s `ModelConfig`. Callers that have an abort signal (headless, TUI) should pass it through. Also add an internal per-round timeout (e.g. `DEFAULT_TIMEOUT = 60_000`) so rogue providers can't block unbounded even when no external signal is present.

**Severity:** medium

---

## Bug 5 — `contextDiscovery.ts` reads all files in `.agents/` without size cap, can OOM or stall

**File:** `src/perceive/contextDiscovery.ts:86-92`

**Description:**
`tryRead` calls `readFile(path, "utf-8")` with no size limit. Files inside `.agents/` subdirectories are read completely into memory. A large file (a 50MB training corpus accidentally placed in `.agents/`) is slurped entirely before being pushed into `system_content`. Contrast with `fileRefs.ts` and `readFile.ts`, both of which cap reads at 256KB.

Additionally, `discoverContext` is called on every `perceiver.perceive()` invocation (every turn), so a large `.agents/` file re-reads from disk on every user message and inflates the system prompt by its full size, potentially blowing past the provider's context window and failing every subsequent turn with a 400 context-limit error.

**User-visible impact:** (1) A misconfigured project with a large file in `.agents/` causes OOM or provider context-overflow errors that look like mysterious model failures. (2) Even with normal-size files, there is no feedback to the user about how much `.agents/` content is being included — the context summary only shows file count and token estimate, not per-file sizes.

**Suggested fix:** Apply the same 256KB cap in `tryRead` that `fileRefs.ts` and `readFile.ts` use; append a `[truncated ...]` marker when the cap fires. Optionally emit a `console.warn` if any `.agents/` file exceeds the cap so developers notice misuse during development.

**Severity:** medium

---

## Bug 6 — `SessionStore.appendTurn` silently drops tool calls when `tool_use_id` is NULL in SQLite

**File:** `src/transmit/sessionStore.ts:122-135`

**Description:**
`appendTurn` inserts tool calls with:
```ts
this.db.run(
  "INSERT INTO tool_calls (message_id, tool_use_id, name, args_json, result) VALUES (?, ?, ?, ?, ?)",
  [turn.id, tc.id, tc.name, JSON.stringify(tc.args), result]
);
```
If `tc.id` is an empty string (LLM returned an empty tool_use id, which some providers do transiently), SQLite stores it as an empty string. On `readFull`, the tool call is reconstructed but its `id` will be `""`, which is falsy. Looking at `readFull`:
```ts
id: tc.tool_use_id ?? crypto.randomUUID(),
```
Since `""` is not null/undefined, `??` won't fire — the reconstructed tool call gets `id: ""`. This is a different but related issue: if `tc.tool_use_id` is `null` in the DB (which can happen if the schema allows it), `readFull` synthesizes a random UUID, so resumed sessions will have mismatched tool_use_ids for those calls and the tool_result content blocks won't pair with them in provider replay.

**User-visible impact:** Resumed sessions with tool calls that had null or empty tool_use_ids show corrupted conversation history: the provider receives `tool_result` blocks whose `tool_use_id` doesn't match any `tool_use` in the conversation, triggering provider-side 400 errors on the resumed session.

**Suggested fix:** In `appendTurn`, validate `tc.id` is non-empty before insert and log a warning if it's empty. In `readFull`, also guard against the empty-string case: `id: (tc.tool_use_id || null) ?? crypto.randomUUID()`.

**Severity:** low

---

## Bug 7 — `skiller/perceive.ts` YAML parser: multi-word / quoted values parsed incorrectly

**File:** `src/skiller/perceive.ts:109-117`

**Description:**
The frontmatter parser splits on the first `:` and `.trim()`s the value:
```ts
const key = trimmed.slice(0, colonIdx).trim();
const value = trimmed.slice(colonIdx + 1).trim();
frontmatter[key] = value;
```
YAML values like `description: "Fix flaky tests: a how-to"` produce `value = '"Fix flaky tests: a how-to"'` (with surrounding double-quotes retained as literal characters). A skill's `description` field then shows up in the TUI skills listing (via `pipeline._turn` → `manualSkills.map`) with literal quote chars: `"Fix flaky tests: a how-to"`. This looks odd to the user and is wrong semantically.

More critically, a `paths:` value like `paths: "src/**/*.ts"` (with quotes for the glob) is stored as the string `"src/**/*.ts"` — with the surrounding quote characters. `matchAutoTriggers` has a strip-quotes step (`rawPaths.replace(/^["']|["']$/g, "")`), so auto-trigger path globs are handled. But any other quoted frontmatter value (e.g. `description:`, `version:`, arbitrary metadata) silently retains its quotes.

**User-visible impact:** The `/skills` command and the `<available_skills>` system block show skill descriptions with spurious surrounding quote marks (e.g. `"summarize code"`). Not a crash, but poor UX and confusing for skill authors who add quoted YAML values as standard YAML practice.

**Suggested fix:** After extracting `value`, strip surrounding single or double quotes (and unescaped inner quotes where applicable), or delegate YAML parsing to a minimal library for at least the scalar case. The existing `matchAutoTriggers` workaround should be removed and the fix applied uniformly at parse time.

**Severity:** low

---

## Bug 8 — `ToolConfirmation` fallback args preview calls `JSON.stringify` twice per render

**File:** `src/app/components/ToolConfirmation.tsx:167-169`

**Description:**
```tsx
<Text dimColor> {JSON.stringify(toolCall.args).slice(0, 120)}
  {JSON.stringify(toolCall.args).length > 120 ? " [...]" : ""}
</Text>
```
`JSON.stringify(toolCall.args)` is called twice on every render. For a tool call with large args (e.g. a `file_write` with 256KB of content), both calls pay the full serialization cost — the first to render the slice, the second just to check whether to append `" [...]"`. The args object can be arbitrarily large (the cap on content was added to tool output, not to tool call args themselves).

**User-visible impact:** Confirmation prompts for large `file_write` or `shell` calls (with long commands) cause a visible render stutter. Not a crash, but measurable lag in the interactive confirmation UX.

**Suggested fix:** Call `JSON.stringify` once, store it in a local variable:
```tsx
const serialized = JSON.stringify(toolCall.args);
const preview = serialized.slice(0, 120) + (serialized.length > 120 ? " [...]" : "");
```

**Severity:** low

---

## Bug 9 — `writeFile.ts` reports byte count as `content.length` (UTF-16 code units), not bytes

**File:** `src/tools/writeFile.ts:44`

**Description:**
```ts
return `Wrote ${content.length} bytes to ${path}`;
```
`String.length` in JavaScript returns the number of UTF-16 code units, not bytes. For a file containing non-ASCII characters (CJK, emoji, accented Latin), the actual byte count written by `writeFile(resolved, content, "utf-8")` may be significantly larger — each CJK character is 3 bytes in UTF-8, each surrogate pair is 4 bytes. The success message tells the model an incorrect byte count, which can confuse it when it tries to reason about file size for subsequent reads (e.g., deciding whether a file exceeds the 256KB read cap).

**User-visible impact:** After writing a file heavy with non-ASCII content, the model is told e.g. "Wrote 1000 bytes" when the file is actually 2400 bytes on disk. This rarely matters but can mislead the model's reasoning about whether the file needs to be truncated on next read.

**Suggested fix:** Replace `content.length` with `Buffer.byteLength(content, "utf8")`:
```ts
return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
```

**Severity:** low

---

## Summary

| # | File | Mechanism | Severity |
|---|------|-----------|----------|
| 1 | `src/app/components/StatusBar.tsx:51` | Confirming hint missing `m` keybind | medium |
| 2 | `src/app/components/Composer.tsx:262` | Paste cursor uses UTF-16 `.length`, not grapheme count | low |
| 3 | `src/agent/toolSubpipe.ts:113` | `interruptedResult` outcome is `"ALLOW"` instead of `"DENY"` | medium |
| 4 | `src/convergence/volley.ts:24` | No abort signal or timeout on provider calls | medium |
| 5 | `src/perceive/contextDiscovery.ts:86` | `.agents/` files read without size cap | medium |
| 6 | `src/transmit/sessionStore.ts:129` | Null/empty tool_use_id corrupts resumed sessions | low |
| 7 | `src/skiller/perceive.ts:115` | YAML quoted values retain surrounding quote chars | low |
| 8 | `src/app/components/ToolConfirmation.tsx:167` | `JSON.stringify` called twice per render on args | low |
| 9 | `src/tools/writeFile.ts:44` | Byte count uses UTF-16 `.length`, not actual UTF-8 bytes | low |
