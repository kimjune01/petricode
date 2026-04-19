# Bug Hunt Round 51

Five new bugs confirmed against source code. False positives from the automated pass (shellRewrite quoting, contextDiscovery newline marker, matchesGlob backslash, ToolConfirmation [m] guard) were verified and discarded.

## Triage outcome

- **#1 (contextDiscovery NUL sniff)** — FIXED in `src/perceive/contextDiscovery.ts`. Mirrored the readFile.ts pattern: check first `min(bytesRead, 4096)` bytes for NUL, return null on binary content. A CLAUDE.md/.agents/* file overwritten by a build artifact (sqlite db, image, compiled binary) is now silently dropped instead of injecting decoded garbage every turn.
- **#2 (pipeline cleanup AbortError)** — FIXED in `src/agent/pipeline.ts`. Wrapped the cleanup `assembleTurn` call in try/catch for AbortError; on abort, commit a `[max tool rounds reached — interrupted]` assistant placeholder before re-throwing. Without this, the cache ended with `[assistant tool_calls, user tool_results]` and the next user submit appended a second user-role turn → provider 400 "messages must alternate" on every subsequent send. Session was unrecoverable without `/clear`.
- **#3 (resolvedRef stale)** — REJECTED. Premise is wrong: ToolConfirmation is conditionally rendered in `App.tsx:435` (`state.phase === "confirming" && state.pendingToolCall`), so it unmounts when phase transitions to "running" between confirmations and `useRef(false)` re-initializes on next mount. The reasoning relies on "the pipeline calls onConfirm" but the pipeline awaits a Promise — multiple React renders happen between confirmations.
- **#4 (BOM strip)** — FIXED in `src/perceive/contextDiscovery.ts`. Mirrored skiller/perceive.ts: strip a leading U+FEFF after decode. Windows-authored CLAUDE.md (Notepad / VS Code with BOM-on-save) no longer injects U+FEFF as the first character of system context.
- **#5 (truncation message malformed)** — FIXED in `src/tools/readFile.ts`. Replaced `${stats.size || "≥"+MAX_READ_BYTES} bytes` (operator precedence pitfall: produced "≥262144 bytes" with no space and bare "showing first 262144" with no unit on size-0 virtual files) with an explicit `sizeDesc` conditional that includes "bytes" and a space.

5 regression tests added; full suite 419 pass (was 415).

---

## Bug 1 — `contextDiscovery.ts`: Binary files not sniffed in `tryRead()`

**File:** `src/perceive/contextDiscovery.ts:91–113`

**Description:** `tryRead()` decodes file contents with `TextDecoder` but never checks for NUL bytes (the binary-detection heuristic used everywhere else). If a file in the `INSTRUCTION_FILES` list (`CLAUDE.md`, `AGENTS.md`, etc.) or in a `.agents/` directory is a compiled binary, sqlite database, or image, its raw bytes are decoded as UTF-8 and injected into the model's system context as replacement characters and garbage.

`readFile.ts:51–53` and `fileRefs.ts:77–78` both sniff the first 4096 bytes for NUL and refuse binary content. `contextDiscovery.ts` has no equivalent check.

**User-visible impact:** A corrupted or accidentally replaced instruction file (e.g. `CLAUDE.md` written over by a build artifact) silently loads ~256KB of garbage into the context on every turn, wasting the context window and producing confusing model behavior with no error message.

**Suggested fix:** After `fh.read(buf, ...)`, sniff `buf.slice(0, Math.min(bytesRead, 4096)).indexOf(0) !== -1` and `return null` on binary content, matching the pattern in `readFile.ts`.

**Severity:** med

---

## Bug 2 — `pipeline.ts`: AbortError during max-rounds cleanup leaves invalid conversation state

**File:** `src/agent/pipeline.ts:370–404`

**Description:** When the tool loop hits `maxToolRounds - 1`, the pipeline synthesizes "max rounds exceeded" tool results (committed to cache at line 383) and then calls `primary.generate(finalConvo, { signal })` to get a cleanup text response. If the user presses Ctrl+C while this cleanup `generate` call is in flight, `assembleTurn` throws `AbortError`. This propagates out of the for-loop without reaching the `break` at line 404, so the cleanup assistant turn is **never committed**.

The cache now ends with a `user`-role synthetic tool-result turn (no assistant response following it). On the next user submit, the conversation is:

```
assistant: [tool_use blocks]
user:      [tool_results: "Error: max tool rounds exceeded"]
user:      [new user message]   ← two consecutive user messages
```

Anthropic's API rejects this with a 400 "messages must alternate" error. The error path in `_turn()` line 304 then commits the new user turn to cache before re-throwing, making every subsequent submit worse (one more consecutive user message each time). The session is unrecoverable without `/clear`.

**User-visible impact:** A user who (1) triggers 10+ tool calls in one turn and (2) presses Ctrl+C during the final cleanup response gets stuck: every subsequent submit fails with a provider 400 error until they discover `/clear`.

**Suggested fix:** Wrap the `assembleTurn` call at line 389 in a try/catch for `AbortError`. On abort, still `break` from the for-loop (leaving `currentTurn` as whatever partial state existed). The finally in `_runTurn` will persist committed turns, and the caller handles the AbortError cleanly without spiraling.

**Severity:** med

---

## Bug 3 — `ToolConfirmation.tsx`: `resolvedRef` stale during React state-batching

**File:** `src/app/components/ToolConfirmation.tsx:97–126`

**Description:** `resolvedRef` is reset to `false` via a `useEffect` that depends on `[toolCall.id]`. React's passive effects run **after paint**, not synchronously on re-render.

When two tool confirmations arrive back-to-back in a single React batch — i.e. the pipeline calls `onConfirm` for tool B before the previous `setState` for phase=running has committed — the ToolConfirmation component stays mounted (React reconciles by position without a key). The `useEffect` reset for the new `toolCall.id` has not yet fired. In this window, `resolvedRef.current` is still `true` from the previous confirmation, and any keystroke (y/n/Enter) is dropped by `if (resolvedRef.current) return` at line 107.

The component `useRef(false)` only re-initializes when the component unmounts and remounts, which does NOT happen when React batches both the phase=running and phase=confirming state updates into a single render pass.

**User-visible impact:** A user who presses the confirmation key very rapidly on successive tool prompts has their first keystroke on the second prompt silently swallowed. They must press the key a second time.

**Suggested fix:** Replace the `useEffect` reset with a `useLayoutEffect` (runs synchronously after DOM mutations, before paint) so the ref is cleared before any keypress event can arrive. Alternatively, add a `key={toolCall.id}` prop to `<ToolConfirmation>` in `App.tsx` line 436 to force unmount/remount between tool calls, guaranteeing a fresh `useRef(false)`.

**Severity:** low (tight timing requirement; rare in practice but reproducible under rapid multi-tool flows)

---

## Bug 4 — `contextDiscovery.ts`: BOM not stripped from instruction files

**File:** `src/perceive/contextDiscovery.ts:101–104`

**Description:** `tryRead()` decodes file contents with `new TextDecoder("utf-8")` without stripping the UTF-8 BOM (`\ufeff`, U+FEFF). If `CLAUDE.md` or any `.agents/*.md` file was saved on Windows with a BOM (the default for many Windows text editors), the context fragment delivered to the model starts with a literal `\ufeff` character.

`skiller/perceive.ts` explicitly strips BOM from skill files (it strips leading `U+FEFF` before YAML parsing). This inconsistency means skills work correctly with BOM but instruction files silently inject the marker into the model's system prompt.

**User-visible impact:** Windows users who author `CLAUDE.md` with a BOM-saving editor see the model treat `\ufeffThis project is…` as valid instructions starting with a garbage character. YAML blocks at the top of instruction files are also broken if the BOM appears inside the YAML.

**Suggested fix:** In `tryRead()`, after decoding, strip a leading `\ufeff`:
```typescript
const clean = decoded.startsWith("\ufeff") ? decoded.slice(1) : decoded;
```
Mirror the pattern from `skiller/perceive.ts`.

**Severity:** low

---

## Bug 5 — `readFile.ts`: Truncation message malformed for virtual files (size 0)

**File:** `src/tools/readFile.ts:80`

**Description:** Line 80 uses `stats.size || "≥"+MAX_READ_BYTES` to format the truncation message. When `stats.size === 0` (virtual files like `/proc/cpuinfo` that report size 0 but yield real content), the expression evaluates to the string `"≥262144"` (operator precedence: `"≥" + 262144`), producing:

```
[truncated — file is ≥262144 bytes, showing first 262144]
```

The `≥` character runs directly into the digit with no space, and the "showing first" count is bare bytes with no unit — inconsistent with the `${stats.size} bytes` form used for normal files.

**User-visible impact:** Users reading large `/proc` or `/sys` files see a slightly garbled truncation marker. Minor clarity issue.

**Suggested fix:** Use an explicit conditional instead of `||`:
```typescript
const sizeDesc = stats.size > 0 ? `${stats.size} bytes` : `≥${MAX_READ_BYTES} bytes`;
return `${body}\n[truncated — file is ${sizeDesc}, showing first ${MAX_READ_BYTES} bytes]`;
```

**Severity:** low
