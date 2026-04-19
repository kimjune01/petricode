# Host-guest sessions with an intimacy gradient

Design sketch for cross-device petricode. The agent stops being tied to a
terminal session; it lives as a daemon on a host (your home box, a VPS, an
ephemeral container) and devices attach as guests with graded access.

## Why daemon, not "sync sessions"

The cheap version of cross-device is syncing `~/.petricode/sessions/*.jsonl`
via iCloud / Syncthing / git. That gives read-only resume — open the same
project on the other device, scroll prior turns. Useful as a "what was I
doing" recap; not a real handoff. Tool execution can't follow you because
the filesystem doesn't follow you.

Live handoff requires moving the agent off the device. Once you do, the
session outlives any individual client: kick off a long task on the host,
close the laptop, attach from your phone an hour later, agent's still
running. The agent process is the persistent thing; devices come and go.

This is the **agent-as-daemon** pattern. tmux-over-ssh is the existence
proof. The product is `petricoded serve` + `petricode attach <session>`.

Side benefit that isn't a side: the same architectural move resolves the
capability/safety treadmill. Reversibility becomes "snapshot the
container," real YOLO becomes defensible because the worst case is
`docker rm`, and `policy.ts` runs in one place that no client can
unilaterally loosen.

## Why intimacy gradient, not ACLs

ACLs are flat: a list of (principal, permission) rows, sprinkled across
features. They invite the question "who can do X?" but not "what is the
appropriate posture for this room?"

Christopher Alexander, *A Pattern Language* #127 — buildings should grade
from public → semi-public → semi-private → private. Front porch, foyer,
living room, kitchen, study, bedroom. Each room has a natural set of
appropriate behaviors; the gradient is the design, not an afterthought
sprinkled over the floor plan.

Applied to a multi-device agent session, rooms write themselves:

| Room | Who | What they see | What they do |
|---|---|---|---|
| **Porch** | anyone with the URL | "session active, last activity 12s ago" | nothing |
| **Foyer** | linked colleagues | task summary, phase, token count | nothing |
| **Living room** | trusted readers | full conversation, file diffs | observe only |
| **Kitchen** | invited guests | everything + an input bar marked `guest:alice` | submit prompts (host can ignore) |
| **Study** | co-pilot | everything + ASK_USER approvals | approve dangerous tools |
| **Bedroom** | you | everything | snapshot, rollback, change policy, kill daemon |

## Why this beats permission bits

- **Each room has a natural UX.** Porch = webhook / status JSON. Foyer =
  status page. Living room = read-only TUI mirror. Kitchen = TUI with an
  input bar that annotates submissions with the guest identity. You don't
  design "permissions"; you design rooms, and the affordances follow.

- **Crossing a threshold is a ceremony.** Pairing code, host confirms,
  time-bound elevation, audit log entry. Different from flipping a bit. A
  guest doesn't *accidentally* end up in the bedroom; they got invited.

- **The host doesn't defend against the inner rooms.** The rooms define
  what reaches the host. Compromised porch is a non-event. Compromised
  kitchen is annoying. Bedroom requires the host's keys, which never leave
  the host.

- **Context-sensitive room assignment.** Same laptop, different network →
  different room. Tailscale identity + network context auto-downgrades.
  Office wifi = study. Hotel wifi = living room. Phone in airport =
  kitchen, max.

- **Multi-presence is a feature.** Different devices in different rooms
  simultaneously. Phone in foyer (notifications + status), laptop in study
  (driving). The agent is the house; you're whoever you are in whichever
  room you're in.

## How this reframes safety

The whole "YOLO mode" tension comes from treating
`--dangerously-skip-permissions` as a property of the agent. With rooms,
it's a property of the *client* — "this client is in the bedroom." Outside
guests still hit the gates that match their room. A bedroom client paired
with an ephemeral container is real YOLO that's actually defensible:
unlimited capability inside a blast radius bounded by `docker rm`.

The other pieces fall in:

- **Capability constraints become spatial.** Path validation, tool
  allowlists, output caps — these don't change, but they're now applied
  per-room rather than globally. Living room might have a 64KB output cap;
  bedroom has 1MB.
- **Reversibility is cheap.** One host = one place to snapshot.
  `petricoded snapshot` before a risky tool, `petricoded rollback` if it
  goes sideways. We talked about this being the only durable safety bet —
  host-guest is what makes it implementable.
- **Observability is social, not technical.** "What's the agent doing"
  channel is the foyer URL. Send your manager the foyer link. Send your
  pair the kitchen invite. The same primitive serves debugging,
  collaboration, and accountability.

## Hard parts

Mostly infrastructure:

- **Auth & pairing** — Tailscale identity is the cheap path (`tsnet`
  library, host announces itself on the tailnet, guest auths via SSO).
  Without Tailscale you're building tokens + a rendezvous server.
- **NAT traversal** — same answer: Tailscale, or stand up a relay.
- **TUI over network** — Ink rendering is fine over a fast pipe but you
  want mosh-style local echo for typing latency.
- **Wire protocol** — websocket carrying turn deltas + tool-result chunks
  + render frames. Not hard, but the API design is the actual product
  surface.
- **Reconnect semantics** — guest drops mid-tool-execution; on reattach,
  replay the buffer. tmux already does this; the lesson is "buffer
  everything since last ack."

## MVP

Three rooms, two new ones, both small:

1. **Bedroom** — already exists (the local TUI).
2. **Porch** — host exposes `GET /status` returning JSON
   `{phase, last_activity_at, turn_count}`. Webhook-able.
3. **Living room** — read-only TUI mirror over websocket. Same Ink
   render, no input bar.

Plus the daemon plumbing: `petricoded serve` wraps the existing engine,
exposes a websocket. `petricode attach <url>` runs the client. Sessions
keyed by id, daemon persists `~/.petricode/sessions/<id>.jsonl` as today.

Kitchen, study, full multi-guest collaboration wait until there's
actually a second person.

## Product question

Two distinct products live in this design:

- **"My home box, just for me"** — Tailscale + single-user, simple. Side
  project scope. The bedroom is on every device you own; the porch
  exists for your own status checks.
- **"Shared agent for a team"** — multi-user, ACLs on top of rooms, real
  auth, observability, audit. Company scope.

The first is a weekend if you stay disciplined about not boiling the
ocean on auth. The second is years.

## Provenance

Conversation between June and Claude (Opus 4.7), 2026-04-18, while
halting bug-hunt round 39. Started from "I am dreaming of sessions I can
share across devices," landed at the intimacy-gradient framing.
