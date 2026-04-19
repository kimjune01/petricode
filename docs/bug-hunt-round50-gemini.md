# Bug Hunt Round 50

Three new confirmed bugs. Each was verified against source code — invalid or duplicate findings from the Explore agent were discarded.

## Triage outcome

- **#1 (shell.ts truncation drops overflow chunk)** — FIXED in `src/tools/shell.ts:61-83`. Mirrored grep.ts's per-codepoint partial-fill so the shell output uses the full 1MB cap budget instead of dropping ~64KB on the truncating chunk.
- **#2 (double killGraceTimer leak)** — FIXED in `src/tools/shell.ts` and `src/tools/grep.ts`. Added defensive `if (killGraceTimer) clearTimeout(killGraceTimer);` before each reassignment in both the truncation and abort paths. Real impact was only a stray 2s no-op SIGKILL on a dead pid, but the GC reference would otherwise persist.
- **#3 (Ctrl+C + confirmation key race)** — FIXED in `src/app/App.tsx:391`. Added `if (!confirmResolveRef.current) return;` after the existing `state.pendingToolCall` guard. confirmResolveRef is a ref (synchronous), so the Ctrl+C handler nulls it before the racing y/n keypress reaches handleToolConfirm; the new guard makes the second handler a no-op instead of emitting a spurious "Allowed:" turn and freezing the TUI in "running".

---

## BUG 1 — shell.ts: Truncation drops entire overflow chunk, not a partial fill

**File:** `src/tools/shell.ts`, lines 61–83  
**Severity:** Low

### Description

When shell output hits the 1 MB cap, `collect()` discards the entire chunk that caused the overflow without partially filling the buffer up to the cap:

```ts
outputBytes += Buffer.byteLength(chunk, "utf8");
if (outputBytes > MAX_OUTPUT_BYTES) {
  truncated = true;
  clearTimeout(timer);
  proc.kill("SIGTERM");
  killGraceTimer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
  return;          // ← chunk is dropped entirely
}
output += chunk;   // ← only reached when within cap
```

`grep.ts` was fixed in a prior round (round 49) to do a byte-safe, per-codepoint partial fill when a chunk straddles the cap boundary. `shell.ts` was not updated.

### Impact

The model sees up to `MAX_OUTPUT_BYTES − (chunk_size − 1)` bytes instead of `MAX_OUTPUT_BYTES`. For a 64 KB stdout chunk, the model could get up to ~64 KB less output than the cap allows. The `[output truncated]` marker is still appended, so the model knows truncation occurred, but the cutoff point is inconsistent with grep.

### Suggested Fix

Mirror the `grep.ts` fix: before setting `truncated = true`, compute how many bytes remain under the cap, walk `chunk` codepoint-by-codepoint (or use the same `for (const ch of chunk)` loop with `Buffer.byteLength(ch)`) and append the UTF-8-safe partial slice.

---

## BUG 2 — shell.ts + grep.ts: Double `killGraceTimer` assignment leaks the truncation timer

**Files:** `src/tools/shell.ts` lines 79, 108; `src/tools/grep.ts` lines 180, 228  
**Severity:** Low

### Description

Both files share the same variable `killGraceTimer` for two independent paths: (1) the truncation path and (2) the abort path. If truncation fires first, `killGraceTimer` is set. If an abort signal then arrives before the process exits, `onAbort` overwrites `killGraceTimer` with a new timer:

**shell.ts truncation path (line 79):**
```ts
killGraceTimer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
```
**shell.ts abort path (line 108):**
```ts
killGraceTimer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
// ← overwrites the truncation timer; first one is now leaked
```

`cleanup()` in the `close` handler only clears the *second* timer (the current value of `killGraceTimer`). The first timer fires 2 seconds later, calling `proc.kill("SIGKILL")` on an already-dead process.

The same pattern exists in `grep.ts` at lines 180 and 228.

### Impact

A stray 2-second timer leaks per occurrence. `proc.kill("SIGKILL")` on a dead PID returns `ESRCH` and is silently ignored by the OS, so there is no observable crash or misbehavior. The timer does hold a reference that prevents GC until it fires.

### Suggested Fix

Use two separate variables (`truncGraceTimer` and `abortGraceTimer`) and clear both in `cleanup()`. Or, before setting `killGraceTimer` in either path, check and clear the existing timer first: `if (killGraceTimer) clearTimeout(killGraceTimer);`.

---

## BUG 3 — App.tsx: Ctrl+C + confirmation key in same stdin batch leaves TUI stuck in "running" with spurious "Allowed:" message

**File:** `src/app/App.tsx`, lines 157–173 (Ctrl+C handler) and 391–415 (`handleToolConfirm`)  
**Severity:** Low

### Description

When a terminal sends `^Cy` (or `^Cn`) as a single stdin chunk — which can happen if the user presses both keys in rapid succession — Ink processes both keypresses synchronously before React renders. The ordering:

1. **`^C` fires** (App's `useInput`): `abortRef.current.abort()`, `confirmResolveRef.current.reject(AbortError)`, `confirmResolveRef.current = null`, `abortRef.current = null`. `setState({phase: "composing"})` is *queued* (not committed yet).

2. **`y` fires** (ToolConfirmation's `useInput`): `resolvedRef.current = true`, calls `onConfirm("allow")` → `handleToolConfirm("allow")`.

3. Inside `handleToolConfirm`:
   - `state.pendingToolCall` is still non-null (old render state) → guard passes
   - `confirmResolveRef.current` is null → resolve skipped (correct)
   - `addSystemTurn("Allowed: <toolname>")` → **spurious success message**
   - `setState({phase: "running", pendingToolCall: null})` → **overrides the "composing" setState**

4. React batches both `setState` calls; depending on order, `phase` ends up as `"running"` with `abortRef.current = null` and no pipeline in flight.

Result: TUI displays the spinner ("thinking…") indefinitely. Because `abortRef.current` is null, the `running/confirming` branch of the Ctrl+C handler is never entered. The user can only escape with a second Ctrl+C (the "double-tap exits" path), which exits the entire process.

### Impact

User sees a spurious "Allowed: [toolname]" system message for a tool that was aborted, then the TUI freezes in "thinking…" state. The session is unrecoverable without double-Ctrl+C → exit. This only triggers when the terminal coalesces `^C` and `y`/`n` into a single stdin write — rare but possible with aggressive keyboard repeat rates or paste.

### Suggested Fix

In `handleToolConfirm`, check `confirmResolveRef.current` before generating the summary and changing phase. If `confirmResolveRef.current` is null, the confirmation was already rejected (Ctrl+C path raced here first) — bail early with no state update:

```ts
const handleToolConfirm = useCallback((decision: ConfirmDecision) => {
  if (!state.pendingToolCall) return;
  if (!confirmResolveRef.current) return; // ← add this guard
  confirmResolveRef.current.resolve(decision);
  confirmResolveRef.current = null;
  // ... rest unchanged
}, [state.pendingToolCall, pendingAlternative, addSystemTurn]);
```

This makes `handleToolConfirm` idempotent with the Ctrl+C path: if Ctrl+C already nulled the ref, the confirmation key is a no-op.
