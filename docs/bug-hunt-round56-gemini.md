# Bug Hunt Round 56 (gemini)

This round focuses on the newer `/share` feature, identifying critical gaps in the guest's view of tool execution, state reconciliation errors during streaming, and a UI hang during agent failures.

---

### Bug 1 — Intermediate tool calls and results are omitted from shared sessions

**File:** `src/app/App.tsx:556` (and 463 for idle poll)

**Description:**
The TUI's main loop and the guest message polling interval both await the full `pipeline.turn()` call before emitting the resulting turn to the share bridge. However, `pipeline.turn()` is an iterative process that can execute multiple tool rounds (up to 10 by default). While assistant text chunks are streamed to guests in real-time via the `onText` callback, the actual `tool.request` and `tool.result` events are only generated when `ShareBridge.emitAssistantTurn()` is called. Since this is only called once after the *entire* pipeline loop finishes, all intermediate turns containing tool calls and their outputs are never appended to the share event log.

```ts
// App.tsx:556
const resultTurn = await pipeline.turn(input, {
  signal: controller.signal,
  onText: (delta) => {
    streamBufRef.current += delta;
    share?.bridge.emitStreamChunk(delta); // Only text is streamed
  },
});
// Only the FINAL turn is emitted. Intermediate tool turns in Pipeline.cache are ignored.
share?.bridge.emitAssistantTurn(resultTurn);
```

**User-visible impact:**
Guests watching a shared session see the agent's text appearing but never see any tool invocations (e.g., `grep`, `read_file`, `shell`). The agent might say "I will check the logs..." and then pause while running tools, and the guest sees nothing until the final response appears. This makes the "shared session" feel like a simple chat transcript rather than a live view of an autonomous agent's work.

**Suggested fix:**
Integrate the `ShareBridge` more deeply into the `Pipeline` or `App` state so that every turn committed to the cache (including intermediate tool/result turns) is also emitted to the bridge. A simple fix in `App.tsx` would be to use a callback or periodically project the pipeline's history to the bridge.

**Severity:** Medium

---

### Bug 2 — Reconnecting SSE clients during in-flight turns receive duplicate messages

**File:** `src/share/server.ts:133` and `src/share/eventLog.ts:37`

**Description:**
When a client connects without a `last-event-id`, the server sends a compacted history via `replayCompacted()`. For an in-flight assistant turn, this folds existing chunks into a single `message.assistant` with `partial: true`, using the ID of the **first** chunk. If the client then reconnects (due to a network blip or SSE timeout) using that ID, the server calls `eventLog.replay(lastEventId)`, which returns every raw event *after* that first chunk. This includes all subsequent chunks and the final full `message.assistant` turn.

The browser's `viewer.ts` blindly appends these events. It will show the partial folded message, then the "streaming" block for the replayed chunks, then a *new* assistant turn for the final message.

**User-visible impact:**
The viewer transcript becomes corrupted with duplicate entries for the same agent response. A user might see the same message twice, or a partial message followed by a full one, making the conversation history noisy and difficult to follow. This is especially common on unstable connections where SSE often reconnects.

**Suggested fix:**
In `ShareEventLog.replayCompacted()`, assign the ID of the compacted message to the ID of the **last** event that was folded (e.g., the last chunk or the `message.assistant` event), rather than the first one. This ensures that a reconnection using that ID will correctly resume *after* the folded content.

**Severity:** High

---

### Bug 3 — Guest viewer "agent is typing" block hangs indefinitely if agent loop fails

**File:** `src/app/App.tsx:478` (and 565)

**Description:**
In `App.tsx`, the guest processing loop (and the host's `handleSubmit`) streams chunks to guests using `share.bridge.emitStreamChunk(delta)`. In `viewer.ts`, receiving a `message.chunk` event displays the streaming block (`#streaming`). This block is only hidden when a `turn.complete` or a new `message.assistant` event arrives. If `pipeline.turn()` throws an error (e.g., provider timeout, rate limit, or crash), the code catches the error but never emits a finishing event to the guest bridge.

```ts
// App.tsx:478 (within guest poll interval)
try {
  const guestTurn = await pipeline.turn(msg.text, { ... });
  share.bridge.emitAssistantTurn(guestTurn); // This emits turn.complete
} catch (err) {
  // emitAssistantTurn is skipped! turn.complete is never sent.
  addSystemTurn(`[guest error] ${errMsg}`);
}
```

**User-visible impact:**
If the agent fails mid-response, guest viewers see the agent start typing and then get stuck in that state forever. The "agent" label and the purple border remain visible with a blinking cursor, even after the host has recovered and started a new turn. The guest has no way of knowing the previous turn failed.

**Suggested fix:**
Ensure `share.bridge.emitAssistantTurn()` (or at least a `turn.complete` / error event) is called even in the `catch` block of guest processing, or move the emission of `turn.complete` into a `finally` block that triggers whenever the streaming phase ends.

**Severity:** Medium

---

## Rejected / considered but false

- **`ShareEventLog.replayCompacted` crash on projected history** — FALSE. While the code accesses `chunkBuf.text` when a `message.assistant` arrives, it is guarded by `if (chunkBuf)`. If no chunks preceded the message (common in projected history), `chunkBuf` is null and the code safely falls through to a raw push.
- **CSRF on the share server** — FALSE. Although there are no explicit CSRF protections or CORS headers, the server's lack of CORS handling means any cross-origin browser request with a custom `Authorization` header will fail the preflight `OPTIONS` check (which returns 404), effectively blocking CSRF from other websites.
- **LoopDetector missing non-plain objects** — FALSE. `canonicalStringify` only handles plain objects/arrays, but `ToolCall.args` are guaranteed to be JSON-serializable types because they are parsed from provider-emitted JSON strings.
