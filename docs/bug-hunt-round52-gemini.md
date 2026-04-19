# Bug Hunt Round 52

## Triage outcome

- **#1 (`finalConvo` ReferenceError)** — FIXED in `src/agent/pipeline.ts`. This was a regression I introduced in round 51: when wrapping the cleanup `assembleTurn` in try/catch I dropped the `const finalConvo = ...` declaration. Renamed to `cleanupConvo` and re-declared from the post-syntheticTurn cache. Every session that hit `maxToolRounds` would have crashed with `ReferenceError`. **Reviewer caught a real high-severity regression — the IV&V loop earned its keep this round.**
- **#2 (fileRefs exact-cap false truncation)** — FIXED in `src/perceive/fileRefs.ts`. Adopted readFile.ts's two-clause check: only flag truncated when `bytesRead >= MAX_READ_BYTES && !(stats.size > 0 && stats.size <= MAX_READ_BYTES)`. The TOCTOU concern noted in the prior comment is real but rarer than the false-positive case for static config files.
- **#3 (contextDiscovery exact-cap false truncation)** — FIXED in `src/perceive/contextDiscovery.ts`. Same pattern as #2 — added a `stat()` call before `open()` so we can distinguish exact-cap files from real overflows. A `CLAUDE.md` of exactly 256KB no longer injects a false `[truncated…]` marker into the system context every turn.
- **#4 (volley `NO_ISSUES` strict equality)** — FIXED in `src/convergence/volley.ts`. Replaced strict equality with `/^no_issues[.!]?$/i` — accepts trailing punctuation and any case. Previously LLM responses like "NO_ISSUES." silently forced extra revision rounds at primary-tier cost.
- **#5 (skiller filter strips unmatched quotes)** — FIXED in `src/skiller/filter.ts`. Removed the redundant `replace(/^["']|["']$/g, "")` entirely — perceive.ts is already the source of truth (matched-pair strip). A typo'd skill `paths: "*.ts` (missing close quote) no longer flips from inert to a broad `*.ts` auto-trigger.

7 regression tests added; full suite 425 pass (was 419).

---

## 1. `ReferenceError: finalConvo is not defined` at max-tool-rounds cleanup

**File:** `src/agent/pipeline.ts:393`  
**Severity:** HIGH

The max-tool-rounds cleanup path at line 393 calls:
```typescript
currentTurn = await assembleTurn(primary.generate(finalConvo, { signal }), signal, onText);
```
`finalConvo` is never declared anywhere in `_turn()`. This is a `ReferenceError` that crashes the agent every time `maxToolRounds` is hit. The conversation `currentTurn` and `syntheticTurn` have been committed via `commitTurn` by this point (lines 376, 382–384), so the correct variable would be built from the updated cache:
```typescript
const cleanupConvo: Message[] = [
  ...systemMessages,
  ...this.cache.read().map(t => ({ role: t.role, content: t.content })),
];
currentTurn = await assembleTurn(primary.generate(cleanupConvo, { signal }), signal, onText);
```
**User-visible impact:** Any session that hits the tool-round ceiling (`maxToolRounds`, default 10) crashes with an unhandled `ReferenceError` instead of the intended graceful "max tool rounds reached" conclusion. Subsequent submits may also fail because the crash leaves the cache in a bad state (no assistant turn after the synthetic user turn).

---

## 2. False `[truncated…]` on exact-256KB `@file` references

**File:** `src/perceive/fileRefs.ts:90`  
**Severity:** MEDIUM

```typescript
const truncated = bytesRead >= MAX_READ_BYTES;   // fileRefs.ts line 90
```
`readFile.ts` (lines 63–65) has the correct guard:
```typescript
const truncated =
  bytesRead >= MAX_READ_BYTES &&
  !(stats.size > 0 && stats.size <= MAX_READ_BYTES);
```
A file whose size is exactly 262 144 bytes (256 KB) fills the buffer completely (`bytesRead === MAX_READ_BYTES`), but none of its content was dropped. `fileRefs.ts` marks it truncated and appends a false `[truncated — file is 262144 bytes, showing first 262144]` footer. The same file read via `file_read` gets no footer.

**User-visible impact:** Users who `@`-reference an instruction file, config, or generated file of exactly 256 KB see a misleading "file truncated" warning and the model may reason that it's missing content when it isn't. Inconsistency with `file_read` is confusing.

**Suggested fix:** Apply the same two-clause check as `readFile.ts`:
```typescript
const truncated =
  bytesRead >= MAX_READ_BYTES &&
  !(stats.size > 0 && stats.size <= MAX_READ_BYTES);
```

---

## 3. Same false truncation banner in context discovery (`CLAUDE.md`, `.agents/`)

**File:** `src/perceive/contextDiscovery.ts:117`  
**Severity:** MEDIUM

`tryRead()` uses the same single-clause check:
```typescript
return bytesRead >= MAX_READ_BYTES
  ? `${clean}\n[truncated — context fragment exceeded ${MAX_READ_BYTES} bytes]`
  : clean;
```
An instruction file (e.g. `CLAUDE.md`, a `.agents/*.md` skill file) whose disk size is exactly 256 KB gets a false `[truncated…]` marker injected into the **system context on every turn**. The model sees this marker every turn and may believe its instructions were cut off, leading to degraded behavior.

**Suggested fix:** Same as above — check `!(stats.size > 0 && stats.size <= MAX_READ_BYTES)`. Requires calling `stat()` before `fh.read()` inside `tryRead()`.

---

## 4. Volley convergence check rejects "NO_ISSUES." — extra rounds, wasted API calls

**File:** `src/convergence/volley.ts:102`  
**Severity:** LOW

```typescript
if (reviewResponse.trim() === "NO_ISSUES") {
```
The check is case-sensitive and requires the response to be **exactly** the string `NO_ISSUES` (after whitespace trim). LLMs occasionally append punctuation (`NO_ISSUES.`) or produce mixed-case responses. Each false-negative forces an extra revision round at primary-tier cost, even though the reviewer found nothing wrong.

**User-visible impact:** `/consolidate` runs take longer and use more tokens when the reviewer returns `NO_ISSUES.` instead of `NO_ISSUES`. With `MAX_ROUNDS=5` this can mean 3–4 unnecessary rounds (primary revise → reviewer re-check) on an already-correct artifact.

**Suggested fix:**
```typescript
if (/^NO_ISSUES[.!]?$/i.test(reviewResponse.trim())) {
```
Accepts `NO_ISSUES`, `no_issues`, `NO_ISSUES.`, and `NO_ISSUES!` — all equivalent intent.

---

## 5. `skiller/filter.ts` strips unmatched quotes from path globs

**File:** `src/skiller/filter.ts:78`  
**Severity:** LOW

```typescript
const paths = rawPaths.replace(/^["']|["']$/g, "");
```
This strips **any** leading quote OR **any** trailing quote, even if unmatched (`"*.ts` → `*.ts`, `*.ts'` → `*.ts`). `skiller/perceive.ts` (lines 124–130) strips only **matched pairs**:
```typescript
if ((first === '"' || first === "'") && first === last) {
  value = value.slice(1, -1);
}
```
Because `perceive.ts` runs first and stores the stripped value in `skill.frontmatter.paths`, the `filter.ts` strip is a no-op for well-formed YAML. But if a skill author writes a malformed glob like `paths: "*.ts` (missing closing quote), `perceive.ts` keeps the leading `"` (no matching pair), while `filter.ts` strips it, producing the glob `*.ts` instead of `"*.ts`. The actual path-glob semantics differ: `"*.ts` is not a valid glob and would never fire, but `*.ts` fires on every TypeScript file — an unintended broad auto-trigger.

**User-visible impact:** A skill with a typo'd `paths` value accidentally auto-triggers on every `.ts` file in the project, injecting unwanted skill context into every TypeScript-related turn.

**Suggested fix:** Use the same matched-pair logic as `perceive.ts`, or rely solely on `perceive.ts`'s stripping and remove the redundant `replace` in `filter.ts` entirely (the comment at line 77–78 acknowledges it's a "duplicate workaround").
