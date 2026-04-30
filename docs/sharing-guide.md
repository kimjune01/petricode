# Sharing a petricode session

Two people, one agent, same context window. The host runs petricode,
shares a link, the guest opens it in their terminal.

## Quick start (LAN / tailnet)

If both people can reach each other directly (same wifi, Tailscale,
VPN):

```bash
# Host
petricode
> /share kitchen
# Prints: http://localhost:7742/sessions/{id}/events?token={token}
# Copy the URL, send it to the guest
```

```bash
# Guest
petricode attach http://{host-ip}:7742/sessions/{id}/events?token={token}
```

The guest gets a full TUI with a compose bar. Both talk to the same
agent.

For read-only access (no compose bar), use `/share` without `kitchen`:

```bash
> /share
# Guest can watch but not submit
```

## Remote sharing (over the internet)

If ngrok is installed, `/share` auto-starts a tunnel — no extra
terminal needed:

```bash
# Install ngrok once (macOS)
brew install ngrok

# Then just /share — petricode handles the tunnel
petricode
> /share kitchen
# First time: "Starting tunnel... run /share again in a few seconds."
> /share kitchen
# Prints: https://abc123.ngrok-free.app/sessions/{id}/events?token={token}
```

The guest uses the URL as-is — it's publicly reachable.

If ngrok isn't installed, `/share` prints a localhost URL and a hint
to install ngrok. You can also use any tunnel manually:

### Manual tunnel alternatives

```bash
# Cloudflare Tunnel (free, no account for quick tunnels)
cloudflared tunnel --url localhost:7742

# Tailscale Funnel
tailscale funnel 7742

# bore (open source, self-hostable)
bore local 7742 --to bore.pub
```

With a manual tunnel, pass the hostname to petricode:

```bash
petricode --share-host random-words.trycloudflare.com
> /share kitchen
```

## What each person sees

**Host** — normal petricode TUI. Everything works as usual. Guest
messages appear in the conversation tagged with the guest's identity
(e.g. `[guest:a3f2]`). The agent processes them after the current turn
completes. Host messages always go first.

**Guest (kitchen)** — full TUI with compose bar. Submitted messages
show as "queued" until the agent processes them. Streaming text appears
live. Tools, diffs, and agent responses render the same as on the host.

**Guest (living room)** — read-only TUI. No compose bar. Can watch
the conversation and streaming output but cannot submit.

## Managing invites

```bash
# List active invites
> /revoke

# Revoke a specific invite
> /revoke a3f2

# Share multiple times — each /share creates a new invite
> /share kitchen    # invite for Alice
> /share kitchen    # separate invite for Bob
> /share            # read-only invite for your manager
```

Each invite has its own token and identity. Revoking one doesn't
affect others. Invites live until `/revoke` or the session ends.

## How it works

- **SSE** streams events from host to guest (server-sent events over
  HTTP — works through any proxy or tunnel)
- **POST** sends guest messages to the host
- **Capability URLs** — the token in the URL is the credential. No
  login, no accounts
- Guest messages are queued and processed between agent turns. The
  SSE timeline always matches the order the agent actually processed
  messages

For protocol details, see [messaging-protocol.md](messaging-protocol.md).

## Troubleshooting

**Guest can't connect:** The guest must be able to reach the host's
port 7742. On LAN, use the host's IP. Over the internet, use a tunnel
(ngrok, cloudflared, etc.).

**"Unauthorized" error:** The token may have been revoked or the
session may have ended. Ask the host for a new `/share` link.

**Stale session after restart:** Event IDs are scoped to the server
process. If petricode restarts, old links won't work. The guest will
get a full replay of the new session on reconnect.

**High latency on guest side:** This is message-level collaboration,
not character-level. The guest sees streaming text as it arrives, but
their own messages are processed between agent turns. This is by
design — the host owns the context window.
