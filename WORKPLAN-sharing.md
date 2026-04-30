# Shared Sessions Work Plan

Sequence of work items for the messaging protocol MVP. Adds terminal-to-terminal session sharing to petricode. Design doc: `docs/messaging-protocol.md`.

When complete: host types `/share`, gets a link, guest types `petricode attach <url>`, both talk to the same agent in the same context window.

---

## 1. Event schema and SSE codec

**What it does.** Define `ShareEvent`, `ShareEventDraft`, and seven event types for living room + kitchen: `message.user`, `message.assistant`, `message.chunk`, `message.queued`, `tool.request`, `tool.result`, `turn.complete`. Each event has `id` (monotonic, zero-padded 15 digits), `type`, `ts` (ISO-8601), `actor`, `payload`, and optional `txn_id` (client-generated UUID for local echo reconciliation). No `room` field in v1 — all clients see all events.

`message.queued` is a distinct event type for guest messages that have been received but not yet entered the agent's context. It renders in a "pending" UI state. When the agent actually processes the message, a `message.user` event is emitted with the same `txn_id`, and the client swaps the queued indicator for the confirmed message.

Add a serializer that encodes events as SSE frames (`id:`, `event:`, `data:` with one-line JSON) and a parser that decodes SSE text back to `ShareEvent`. Newlines in payload escaped as `\n` in the data line.

**Depends on:** nothing

**Test:** Round-trip: serialize → SSE text → parse → deep-equal. Newline escaping. ID zero-padding. Multi-event stream parsing. `txn_id` round-trips correctly. `message.queued` serializes/parses.

**Files:**
- `src/share/events.ts`
- `test/share.events.test.ts`

---

## 2. Invite registry

**What it does.** In-memory store for invites. Each invite has: `id` (short random string for `/revoke`), `token` (32 bytes, base64url), `sessionId`, `scope` (`living` | `kitchen`), `createdAt`, and a derived `actor` string (`guest:<invite-id>`). The actor is server-assigned — clients cannot choose their own identity.

Operations: create invite (returns invite with token), validate token (returns invite or null), revoke by invite ID, list active invites.

**Depends on:** nothing

**Test:** Create → validate returns correct scope and actor. Revoke → validate returns null. Living scope rejects POST check. Kitchen scope accepts. List returns active invites with metadata.

**Files:**
- `src/share/invites.ts`
- `test/share.invites.test.ts`

---

## 3. Event log

**What it does.** Owns the canonical ordered list of `ShareEvent`s for a session and owns ID allocation. Two sources feed it:

1. **Persisted history** — on startup (or first `/share`), reads Transmit's `PerceivedEvent[]` and projects them through the adapter (item 6) into `ShareEvent`s. These get deterministic, stable IDs (e.g. derived from position in the persisted log) so replay produces the same IDs every time. IDs are assigned once and cached for the lifetime of the server process.

2. **Live events** — the bridge (item 7) submits `ShareEventDraft`s. The event log assigns IDs (continuing monotonically after the highest projected ID) and appends finalized `ShareEvent`s.

**Chunk compaction on replay:** Historical `message.chunk` events from completed turns are folded into a single `message.assistant` event during projection. Only the currently active turn (if any) retains raw chunks. This prevents replay bloat — 5 long agent responses could produce 10,000+ chunk events that would lock the client's event loop if replayed individually.

**In-flight turn projection:** If a guest connects mid-stream, the event log projects the currently streaming turn as a single `message.assistant` containing all accumulated text so far, followed by live `message.chunk`s from that point forward.

**Deduplication:** the event log tracks which source events (by turn ID or Transmit row ID) have already been projected. If a persisted event was also observed live (because `/share` was invoked mid-session), it appears once.

**Reconnect with missing IDs:** If a client sends a `Last-Event-ID` higher than the event log knows about (e.g., after a server restart that lost in-memory state), the server replays the full log from the beginning. The client must be prepared to drop unconfirmed local echoes and rebuild state from the replay.

On guest connect: replay the full event log (with chunk compaction). On reconnect with `Last-Event-ID`: replay only events after that ID (or full replay if ID is unknown).

**Depends on:** 1, 6

**Test:** Project a mock session → correct ShareEvent sequence with stable, monotonic IDs. Same projection run twice → same IDs. Append live events → IDs continue after highest projected. Replay from Last-Event-ID skips earlier events. Duplicate source event (persisted + live) appears once. Historical chunks compacted into single assistant message. In-flight turn projected as partial assistant message. Unknown Last-Event-ID triggers full replay.

**Files:**
- `src/share/eventLog.ts`
- `test/share.eventLog.test.ts`

---

## 4. SSE server

**What it does.** `Bun.serve()` wrapper. On `GET /sessions/{id}/events?token=...`: validate token via invite registry, verify session ID matches the invite's session, replay from event log, then hold connection open for live events. Fan out new events to all connected clients. Heartbeat `:keepalive\n\n` every 15 seconds. Track connections by invite so revocation can close them.

Starts lazily on first `/share`. Default port 7742. Host/port override is CLI plumbing owned by item 8.

**Depends on:** 1, 2, 3

**Test (integration):** Start server, connect with valid token → receive replayed events. Push a new event → all clients receive it. Reconnect with `Last-Event-ID` → only missed events. Invalid token → 401. Wrong session ID → 403. Heartbeat arrives within 20s. Revoke invite → connection closed.

**Files:**
- `src/share/server.ts`
- `test/share.server.test.ts`

---

## 5. Guest message queue + POST endpoint

**What it does.** Two things that must ship together:

1. **FIFO message queue** — guest messages land here. The agent loop drains it between turns. Host messages always go first.

2. **POST endpoint** — `POST /sessions/{id}/messages` on the same `Bun.serve()` instance. Validates kitchen token (living → 403). Accepts JSON `{text, txn_id}` where `txn_id` is a client-generated UUID. Server derives `actor` from the invite. On POST, the server emits a `message.queued` event (with the `txn_id`) to the SSE stream — this tells all clients the message was received but not yet processed. The message goes into the FIFO queue. Returns `201` with the `message.queued` ShareEvent. When the agent loop drains the queue and actually processes the message, the bridge emits a `message.user` event with the same `txn_id`. The guest client reconciles: swaps the "queued" indicator for the confirmed message.

   This two-phase broadcast solves the timeline divergence: the SSE event order always matches the agent's actual context order. `message.queued` is visual-only feedback, `message.user` is the canonical context entry.

**Depends on:** 4

**Test (integration):** POST with kitchen token → 201, `message.queued` event appears on SSE with correct `txn_id`. POST with living token → 403. Invalid token → 401. Missing `text` → 400. Actor is server-derived. When agent drains queue, `message.user` appears on SSE with same `txn_id`. Host submits while guest message is queued → host's `message.user` appears before guest's `message.user` on SSE. SSE timeline matches agent context order.

**Files:**
- `src/share/queue.ts`
- `src/share/server.ts` (extend)
- `test/share.queue.test.ts`

---

## 6. Pipeline → ShareEvent projection adapter

**What it does.** Pure mapping layer: converts existing pipeline types (`Turn`, `PerceivedEvent`, `ToolCall`, streaming chunks) into `ShareEventDraft`s (no `id` — the event log assigns IDs). No side effects — takes a pipeline event, returns a draft. Handles:

- Host prompt → `message.user` with `actor: "host"`
- Assistant text → `message.assistant` (final) or `message.chunk` (streaming)
- Tool call proposal → `tool.request`
- Tool execution output → `tool.result`
- Turn boundary → `turn.complete`

**Depends on:** 1

**Test:** Map each pipeline event type → correct draft type, actor, and payload. Ordering: user before assistant, tool.request before tool.result, turn.complete last. No ID assertions — the adapter doesn't assign IDs.

**Files:**
- `src/share/adapter.ts`
- `test/share.adapter.test.ts`

---

## 7. Live bridge into the pipeline

**What it does.** Hooks the projection adapter (item 6) into the running pipeline. Observes pipeline events as they happen and submits the resulting `ShareEventDraft`s to the event log (item 3), which assigns IDs and fans out finalized `ShareEvent`s to SSE clients. Also hooks guest message queue drain into the agent loop — between turns, the loop checks the queue and processes pending guest messages.

This is the integration point. The pipeline doesn't change its interfaces — the bridge is an observer that emits share events as a side effect.

**Depends on:** 3, 5, 6

**Test (integration):** Run a headless agent turn with the share server active. SSE client receives `message.user(host)` → `message.assistant` → `turn.complete` in order. Tool calls produce `tool.request` → `tool.result`. Guest POST during turn → message queued → processed after turn completes. IDs monotonic across the full sequence. Guest message echo does not trigger a second agent processing.

**Files:**
- `src/share/bridge.ts`
- `src/agent/loop.ts` (extend to drain queue between turns)
- `test/share.bridge.test.ts`

---

## 8. `/share` and `/revoke` slash commands

**What it does.** Two new slash commands:

- **`/share [kitchen]`** — generates an invite for the current session. Starts the SSE server on first invocation. Prints the capability URL. Default room: living (read-only). `/share kitchen` grants submit access.
- **`/revoke [invite-id]`** — revokes an invite, closes matching SSE connections. No argument lists active invites with ID, scope, created-at, and connection count.

Also owns the CLI/config plumbing for `--share-host` (host:port override for LAN use).

**Depends on:** 2, 4

**Test (integration):** `/share` produces a valid URL. Connecting to the URL works and rejects wrong tokens. `/share kitchen` token has kitchen scope. `/revoke` lists invites. Revoke by ID closes connections. Second `/share` reuses the running server. `--share-host` overrides the URL host in the printed link.

**Files:**
- `src/commands/share.ts`
- `src/commands/revoke.ts`
- `src/commands/index.ts` (register both)
- `src/argv.ts` (extend for `--share-host`)
- `test/share.commands.test.ts`

---

## 9. `petricode attach` command

**What it does.** New CLI entry point: `petricode attach <url>`. Parses the capability URL (session ID + token). Opens a streaming fetch to the SSE endpoint. Renders incoming events in the Ink TUI — reuses existing components (`MessageList`, `ToolGroup`, `StatusBar`, `Markdown`). A guest-side state reducer converts `ShareEvent[]` into the shape existing components expect.

For kitchen tokens: shows a compose bar (`Composer` component). Generates a `txn_id` per submission. POSTs messages on submit. Shows local echo in "queued" state. When `message.queued` arrives on SSE with matching `txn_id`, confirms receipt. When `message.user` arrives with matching `txn_id`, swaps queued indicator for confirmed message. For living tokens: no compose bar.

Shows connection status in the status bar (connected / reconnecting / disconnected). On disconnect, reconnects with `Last-Event-ID`. **Watchdog timer:** if no SSE frame (event or heartbeat) arrives within 20 seconds, the client force-aborts the connection and triggers reconnect. This catches silent connection death (laptop sleep, NAT state drop) that `EventSource`/`fetch` don't detect on their own.

Token handling: `petricode attach` sends the token via `Authorization: Bearer` header (not in the URL). The `?token=` query param is only for browser `EventSource` fallback, which can't set headers.

**Depends on:** 4 (living-room-only), 5 (kitchen submit), 7 (full shared-agent behavior)

**Test:** Automated: URL parsing extracts session ID and token. SSE client reconnects with Last-Event-ID. POST submission returns `message.queued` with `txn_id`; later `message.user` arrives with same `txn_id`. Living token suppresses compose bar. Watchdog fires after 20s silence. Bearer token sent in header, not URL. Manual: two terminals, host and guest, submit from both sides.

**Files:**
- `src/attach.ts` (entry point)
- `src/app/AttachApp.tsx` (guest TUI)
- `src/share/client.ts` (SSE consumer + POST submitter + state reducer)
- `src/argv.ts` (extend for `attach` subcommand)
- `test/share.client.test.ts`

---

## 10. End-to-end test

**What it does.** Automated integration test. Full flow, no manual intervention:

1. Start a headless host session with a mock provider.
2. Invoke `/share kitchen`.
3. Connect a programmatic SSE client.
4. Host submits a prompt → events stream to guest.
5. Guest POSTs a message → event visible on stream → agent processes it after current turn → response streams to both.
6. Assert: host and guest received the same event sequence by event ID. IDs monotonic. No duplicate processing. Host message processed before guest message when both are queued.

**Depends on:** 7, 8

**Test:** This *is* the test. Green means the MVP works.

**Files:**
- `test/share.e2e.test.ts`

---

## Dependency graph

```
1 (schema) ──┬──→ 6 (adapter) ──→ 3 (event log) ──→ 4 (SSE server) ──→ 5 (queue+POST) ──→ 7 (bridge) ──→ 10 (e2e)
             │                                        ↑                                      ↑              ↑
2 (invites) ─┼────────────────────────────────────────┤                                      │              │
             │                                        └──→ 8 (/share + /revoke) ─────────────┼──────────────┘
             │                                        └──→ 9 (attach) ───────────────────────┘
             │                                             ↑              ↑
             │                                             5 (POST) ──────┘
             │                                             7 (bridge) ────┘
```

Items 1 and 2 have no dependencies on each other and can be built in parallel.
