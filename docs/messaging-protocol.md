# Messaging protocol for shared sessions

Wire protocol for the living room and kitchen. Two people, one agent
context window, message-level collaboration. The host runs petricode,
types `/share`, and gets a link. The guest pastes that link into their
own terminal (`petricode attach <url>`) and gets a full TUI with a
compose bar. Both talk to the same agent, same context window.

No extra server process. The host's petricode process opens an HTTP port
via `Bun.serve()` when `/share` is invoked — it's already a Bun process,
so serving SSE and handling POSTs costs a few lines, not a daemon. Guests
who don't have petricode installed can open the same link in a browser as
a zero-install fallback.

Character-level collaboration (cursor sharing, real-time typing, mosh-style
local echo) is a different protocol — probably WebSocket or WebTransport —
and is deferred. This doc covers message-level only.

## Design constraint: piggyback existing protocols

No custom wire format. Compose standards that already exist:

- **SSE** (`text/event-stream`) for server → client. Works from any HTTP
  client — `EventSource` in the browser, a streaming `fetch()` in
  `petricode attach`, `curl` in a pinch. Automatic reconnect with
  `Last-Event-ID`.
- **HTTP POST** for client → server. Message submission, approvals,
  presence signals. Ordinary JSON request/response.
- **Capability URLs** for auth. The token *is* the link. No login, no
  accounts, no OAuth dance.
- **Append-only event log** for durability. Transmit already does this —
  session JSONL on the host. The protocol is a projection of that log.

This is the same shape as tmate (capability strings, host-owned state,
clients come and go) without the SSH transport or terminal-frame encoding.
The difference: tmate needs a relay server for NAT traversal. Petricode
on a tailnet or LAN needs nothing beyond the host process itself.

## Rooms this protocol serves

From the intimacy gradient doc, two rooms need the wire:

| Room | See | Do | Protocol surface |
|---|---|---|---|
| **Living room** | full conversation, diffs, tool output | observe only | SSE subscribe |
| **Kitchen** | everything + compose bar | submit prompts, tagged `guest:<name>` | SSE subscribe + POST messages |

Porch (`GET /status` → JSON) and bedroom (local TUI) don't need a
streaming protocol. Study (tool approvals) extends the kitchen with
approval-specific POST endpoints — same protocol, wider verb set.

## Event model

Everything visible is an event. Events are append-only, monotonically
ordered, and assigned a durable ID by the host.

```
Event {
  id:       string        // monotonic, zero-padded (e.g. "000000000042")
  type:     string        // see catalog below
  ts:       ISO-8601      // host clock
  actor:    string        // "host", "agent", "guest:<name>"
  payload:  object        // type-specific
  txn_id?:  string        // client-generated UUID for local echo matching
}
```

### Event types (living room + kitchen)

```
message.user          user prompt entered the agent's context
message.queued        guest message received, not yet in agent context
message.assistant     agent response (complete or final chunk)
message.chunk         partial token during streaming
tool.request          agent proposes a tool call
tool.result           tool execution output
turn.complete         agent turn finished
```

`message.queued` is visual-only feedback — it tells clients a guest
message was received. When the agent actually processes it,
`message.user` is emitted with the same `txn_id`. The SSE timeline
always matches the agent's actual context order.

Other types (`tool.approval`, `session.snapshot`, `session.joined`,
`session.left`, presence, errors) will emerge when study and multi-guest
rooms get designed. Don't pre-commit to a catalog — let the event types
grow from what each room actually needs.

Events carry the minimum payload to reconstruct the conversation. Binary
data (file contents, screenshots) are pointers — a path or hash the guest
can fetch separately via `GET /sessions/{id}/files/{hash}`.

## Wire format

### Server → client: SSE

Standard `text/event-stream`. Each event maps to one SSE frame:

```
id: 000000000042
event: message.user
data: {"actor":"guest:alice","text":"try the failing test again"}

id: 000000000043
event: message.chunk
data: {"text":"Looking at the test now..."}

```

- `id:` enables automatic `Last-Event-ID` on reconnect.
- `event:` enables client-side `addEventListener` per type.
- `data:` is always one-line JSON (newlines in content are `\n` escaped).
- Heartbeat: `:keepalive\n\n` every 15 seconds to detect dead connections.

### Client → server: POST

```
POST /sessions/{id}/messages
Authorization: Bearer {token}
Content-Type: application/json

{
  "text": "try the failing test again",
  "txn_id": "a1b2c3d4-..."
}
```

The server derives `actor` from the invite — the client does not choose
its identity. `txn_id` is a client-generated UUID for local echo
reconciliation.

Response: `201 Created` with the `message.queued` event:

```json
{
  "id": "000000000042",
  "type": "message.queued",
  "ts": "2026-04-30T18:22:01Z",
  "txn_id": "a1b2c3d4-..."
}
```

The guest shows local echo in a "queued" state. When the agent processes
the message, a `message.user` event is emitted with the same `txn_id` —
the client swaps the queued indicator for the confirmed message. The SSE
timeline always matches the agent's actual context order.

This is Matrix's `txn_id` pattern, not just a retry idempotency key —
it's the only bulletproof way to match local echo to confirmed event when
the SSE broadcast can arrive before the POST response.

## Auth: capability URLs

No accounts. The token is the credential. Each room gets its own token.

```
https://host:port/sessions/{session_id}/events?token={living_token}
https://host:port/sessions/{session_id}/events?token={kitchen_token}
```

Living token grants SSE subscribe only. Kitchen token grants SSE subscribe +
POST messages. The same token cannot be elevated — to upgrade someone from
living room to kitchen, generate a new link.

Token shape: 32 bytes, base64url-encoded. Generated by the host on
`/share` or a `/invite` slash command.

### Token hygiene

`petricode attach` sends the token via `Authorization: Bearer` header —
it uses `fetch`, not browser `EventSource`, so headers work. The
`?token=` query param is only for the browser fallback, which can't set
custom headers on `EventSource`.

For the browser fallback, set `Referrer-Policy: no-referrer` on
responses. Consider exchanging the URL token for an `HttpOnly
SameSite=Strict` session cookie on first browser hit, then redirecting to
a clean URL. Keeps the bearer out of browser history and referrer
headers. Not required for tailnet/LAN use — nice-to-have for anything
internet-facing.

### Revocation

The host types `/revoke` in the TUI to kill an active invite. Open SSE
connections using that token get closed by the server. The simplest
implementation: the host process holds a set of live tokens in memory;
`/revoke` removes the token, and the next heartbeat check closes
matching connections.

## Concurrency

Messages queue. If the agent is mid-turn and a guest submits, the message
lands in a FIFO queue. The SSE stream immediately shows a
`message.queued` event — the guest knows their message was received. But
the agent doesn't process it until the current turn completes.

When the agent drains the queue, a `message.user` event is emitted with
the same `txn_id`. This is the canonical entry into the agent's context.
The SSE event order for `message.user` events always matches the order
the agent actually processed them.

If the host submits while a guest message is queued, host goes first.
Host owns the context window. No interrupts, no priority inversion — 
just a FIFO with host-first precedence.

## Reconnection

SSE's built-in reconnect handles the common case. `EventSource` (browser)
and `petricode attach` (TUI) both send `Last-Event-ID` automatically.
The host replays all events after that ID from the append-only log.

If the client sends a `Last-Event-ID` the server doesn't recognize (e.g.,
after a server restart that lost in-memory state), the server replays the
full log from the beginning. The client must be prepared to drop
unconfirmed local echoes and rebuild state from the replay.

For a late joiner (guest connects to a session already in progress), the
host replays the full event log with **chunk compaction**: historical
`message.chunk` events from completed turns are folded into single
`message.assistant` events. Only the currently active turn (if any)
retains raw chunks. This prevents replay bloat — long agent responses can
produce thousands of chunk events that would lock the client's event loop
if replayed individually.

If a guest connects mid-stream, the replay includes the in-flight turn
as a single `message.assistant` with all accumulated text so far,
followed by live `message.chunk`s from that point forward.

**Client-side watchdog:** `EventSource` and basic `fetch` don't detect
silent connection death (laptop sleep, NAT state drop). The client must
implement a watchdog: if no SSE frame (event or heartbeat) arrives within
20 seconds, force-abort and reconnect with `Last-Event-ID`.

## Endpoints

```
GET  /status                                    porch: JSON status blob
GET  /sessions/{id}/events?token={token}        SSE event stream
POST /sessions/{id}/messages                    submit a message (kitchen+)
```

That's the whole surface for living room and kitchen. Invite creation and
revocation happen through `/share` and `/revoke` slash commands in the
host TUI — they don't need HTTP endpoints because only the host creates
invites.

Additional endpoints to consider later: `GET /snapshot` (compacted state
for late joiners if full replay gets slow), `GET /files/{hash}` (binary
content fetch for large tool output).

## How this maps to the pipe

The protocol is a projection of what Transmit already persists:

- **Transmit** appends every event to the session log. The SSE stream is a
  live cursor over that log.
- **Perceive** on the host side receives guest `POST /messages` as
  `PerceivedEvent`s, tagged with the guest identity. They enter the
  message queue just like host input.

Room-scoped visibility filtering (living room sees conversation but not
tool approvals, etc.) can start as a simple allowlist on event types per
token scope. Whether this lives in Filter proper or in the SSE fanout
code is an implementation choice — the protocol doesn't care.

## Slash command: `/share`

The host types `/share` (or `/share kitchen`) in the TUI. The harness:

1. Starts the HTTP server if not already running (default: `localhost:7742`).
2. Generates a capability token for the requested room.
3. Prints the URL to the host's TUI.
4. The host copies and sends the link to the guest.

```
petricode> /share kitchen
🔗 Kitchen invite (read + submit):
   https://localhost:7742/sessions/abc123/events?token=dGhpcyBpcyBhIHRva2Vu...
   Expires: 24h. Revoke with /revoke <invite-id>.
```

`/share` with no argument defaults to living room (read-only).

## What the guest sees

### Terminal client (primary path)

```
petricode attach https://host:7742/sessions/abc123?token=dGhpcyBpcyBh...
```

The attach command:

1. Parses the capability URL, extracts session ID and token.
2. Opens a streaming HTTP connection to the SSE endpoint (standard
   `fetch()` with `Accept: text/event-stream`).
3. Renders the conversation in the same Ink TUI as the host — message
   bubbles, tool output, streaming markdown. The guest's TUI is driven
   by the event stream, not by local inference.
4. If kitchen-level: shows a compose bar at the bottom. Messages are
   `POST`ed to the host and local-echoed until the server event confirms.
5. Shows connection status in the status line (connected / reconnecting).
6. On disconnect, reconnects automatically with `Last-Event-ID`.

The guest TUI reuses the existing Ink components — `MessageBubble`,
`ToolCallGroup`, `StatusLine`. The only new piece is the SSE event
consumer that feeds them, replacing the local pipeline as the data source.

### Browser fallback (zero-install, read-only)

If the guest doesn't have petricode installed, the same URL opened in a
browser serves a minimal read-only HTML page — living room only:

1. Connects to the SSE endpoint via `EventSource`.
2. Renders the conversation as streaming markdown → HTML.
3. Connection status indicator. No compose bar.

No build step, no framework. Single HTML file served by the host. Vanilla
`EventSource` + a few hundred lines of JS. `Bun.serve()` on the host
handles HTTP, SSE, and static files natively — content negotiation
(`Accept: text/event-stream` vs `text/html`) decides which response the
client gets. To submit messages, install petricode and use
`petricode attach`.

## Reaching the host from the internet

On a tailnet or LAN, the guest can reach the host directly — nothing to
do. Over the internet, the host is behind NAT. Use an existing tunnel
service instead of building a relay:

- **ngrok** — `ngrok http 7742` gives a public URL. Free tier works.
  SSE passes through cleanly.
- **Cloudflare Tunnel** — `cloudflared tunnel --url localhost:7742`.
  Free, no account required for quick tunnels. Good for longer sessions.
- **bore** — `bore local 7742 --to bore.pub`. Open source, self-hostable.
- **localtunnel** — `npx localtunnel --port 7742`. Quick, less reliable.
- **Tailscale Funnel** — `tailscale funnel 7742`. If both parties are on
  the same tailnet, skip the funnel and connect directly.

The `/share` command could detect whether `localhost` is the only route
and suggest running a tunnel. Or accept a `--tunnel` flag that spawns
one automatically. Implementation detail — the protocol doesn't change
either way, since the tunnel is just TCP forwarding.

## What this doesn't cover (deferred)

- **Character-level collaboration** — real-time typing, cursor sharing,
  composing together in the same text box. Different protocol, probably
  WebSocket with OT or CRDT. Different doc.
- **Terminal frame mirroring** — piping the Ink render tree over the wire
  so the guest sees the exact TUI. Needs a binary frame protocol.
  WebSocket or WebTransport.
- **Multi-session** — one session per host process for now. Running
  `petricoded` as a multi-session daemon is a bigger architectural change.
- **Study room** — tool approval over the wire. Same protocol shape, but
  the approval flow needs its own event types and UX. Extends kitchen, not
  a rewrite.

## MVP

The smallest thing that lets two people share a session over a terminal.

### What ships

1. **`/share` slash command.** Host types `/share` or `/share kitchen`.
   Starts `Bun.serve()` on port 7742 if not already running. Generates a
   capability token, prints the URL. One room per token — living (SSE
   only) or kitchen (SSE + POST).

2. **SSE fanout.** `GET /sessions/{id}/events?token=...` streams the
   session's event log as `text/event-stream`. On connect, replays the
   full log from the beginning, then streams live events. Heartbeat every
   15s. Reconnect replays from `Last-Event-ID`.

3. **Message POST.** `POST /sessions/{id}/messages` accepts a JSON
   `{text, txn_id}` body with a kitchen token. Server derives actor from
   the invite. Emits `message.queued` immediately, enqueues for agent.
   When processed, emits `message.user` with same `txn_id`.

4. **`petricode attach <url>`.** Guest-side command. Parses the
   capability URL, opens an SSE connection, renders the conversation in
   the same Ink TUI as the host. Kitchen tokens get a compose bar.
   Local echo on submit.

5. **`/revoke` slash command.** Host kills an active invite. Server
   closes matching SSE connections.

### What doesn't ship

- Browser fallback page. Terminal-to-terminal only for v1.
- Tunnel integration. Guest must be able to reach host (LAN, tailnet,
  manual ngrok). `/share` prints `localhost` — the host runs a tunnel
  themselves if needed.
- Token expiry. Tokens live until `/revoke` or the session ends.
- Snapshot endpoint. Full replay is fine at message-level scale.
- Room-scoped event filtering. All connected clients see all events.
  Visibility filtering comes when study room ships.
- `GET /status` (porch). Nice-to-have, not needed for two-person collab.

### Work items

| # | Name | What | Test |
|---|------|------|------|
| 1 | SSE server | `Bun.serve()` wrapper that holds SSE connections, fans out events, replays on connect. Token validation on connect. | Unit: connect, receive event, reconnect with Last-Event-ID replays missed events. |
| 2 | `/share` command | Generate token, start server if needed, print URL. Store active tokens in memory. | Unit: command produces valid URL. Integration: connect to the URL, receive events. |
| 3 | Message POST | `POST /messages` validates kitchen token, appends to queue, returns event ID. | Unit: POST with valid token → 201. POST with living token → 403. |
| 4 | Queue integration | Guest messages enter the agent's message queue. Processed FIFO after current turn. Host messages go first. | Integration: guest POST during agent turn → message queued → processed after turn completes. |
| 5 | `petricode attach` | CLI command. SSE consumer → Ink TUI. Compose bar for kitchen tokens. Local echo. | Manual: two terminals, host and guest, submit messages from both sides. |
| 6 | `/revoke` command | Remove token from active set, close matching SSE connections. | Unit: revoke → next heartbeat closes connection. |

Items 1–3 are independently testable without a running agent (mock event
source). Item 4 requires the agent loop. Item 5 requires a running host.
Item 6 is small and can land with 1 or 2.

## Provenance

Protocol composed from existing standards:
- SSE: [W3C Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- Reconnect with Last-Event-ID: [MDN EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)
- Idempotency keys: [Stripe API](https://stripe.com/docs/api/idempotent_requests)
- Local echo + transaction IDs: [Matrix Client-Server API](https://spec.matrix.org/unstable/client-server-api/)
- Capability URLs: [tmate](https://tmate.io/), [Upterm](https://upterm.dev/)
- Mercure (SSE + event store): [IETF draft](https://www.ietf.org/archive/id/draft-dunglas-mercure-07.html)
- Research assist: codex (GPT-5.5) + Gemini 3.1 Pro, 2026-04-30
