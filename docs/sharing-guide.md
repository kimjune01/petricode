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

If bore is installed, `/share` auto-starts a tunnel — no extra
terminal, no signup, no auth token:

```bash
# Install bore once
cargo install bore-cli
# or download a binary from https://github.com/ekzhang/bore/releases

# Then just /share — petricode handles the tunnel
petricode
> /share kitchen
# First time: "Starting tunnel... run /share again in a few seconds."
> /share kitchen
# Prints: http://bore.pub:XXXXX/sessions/{id}/events?token={token}
```

The guest uses the URL as-is — it's publicly reachable via bore's
free relay at bore.pub. No signup, no rate limits.

If bore isn't installed, `/share` tries ngrok as a fallback (requires
a free account). If neither is available, it prints a localhost URL
and a hint.

### Self-hosting the relay

If you don't want to depend on bore.pub, run your own relay:

```bash
# On any VPS with a public IP
bore server
# Clients connect with: bore local 7742 --to your-server.com
```

### Other tunnel options

```bash
# Cloudflare Tunnel (free, no account for quick tunnels)
cloudflared tunnel --url localhost:7742

# Tailscale Funnel
tailscale funnel 7742

# ngrok (requires free account)
ngrok http 7742
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
