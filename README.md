# 🧫 petricode

Experimental coding agent harness. AGPL-3.0. TypeScript + Bun.

A laboratory for agent architectures with six [Natural Framework](https://june.kim/the-natural-framework) roles: Perceive, Cache, Filter, Attend (human), Transmit, Consolidate. Each automated role is a swappable interface. The goal is to experiment our way into a harness that actually learns between sessions.

## Quick start

```bash
bun install
bun test                    # 525 tests, no API keys needed
bun run src/cli.ts          # TUI shell (interactive, full pipeline)
```

## Sanity check (requires API keys)

See [TESTING.md](TESTING.md) for the full testing guide, including how to run sanity checks with real models.

```bash
export ANTHROPIC_API_KEY=sk-...
export OPENAI_API_KEY=sk-...

# One-shot headless turn
bun run src/cli.ts -p "summarize README.md"

# Sticky-session back-and-forth (file holds the session ID)
bun run src/cli.ts -p "pick a number 1–10" --session-file /tmp/pc
bun run src/cli.ts -p "what number did you pick?" --session-file /tmp/pc
```

Auth: Anthropic + OpenAI accept `*_API_KEY` env vars. Google goes through
Vertex AI when `GOOGLE_APPLICATION_CREDENTIALS` is set (project resolved
from `GOOGLE_CLOUD_PROJECT` or `gcloud config get-value project`), or
through the Gemini API when `GOOGLE_API_KEY` is set.

## Architecture

Five automated slots, one human slot. Every slot is an interface in `src/core/contracts.ts`.

```
User input → Perceive → Cache → Filter → [human decides] → Transmit → Consolidate
```

Three model tiers: primary (Anthropic), reviewer (OpenAI), fast (cheap). The reviewer is a [Maxwell's demon](https://june.kim/forge) — it sits at the gate between volley rounds, selects which changes pass, and the artifact's entropy decreases. Paid for honestly in reviewer tokens.

### Session sharing

Host types `/share kitchen`, gets a shareable URL. Guest runs `petricode attach <url>` for a full TUI with compose bar. Both talk to the same agent, same context window.

For remote sharing (over the internet), install [bore](https://github.com/ekzhang/bore) — a free, open-source tunnel with no signup:

```bash
# macOS arm64
curl -sL https://github.com/ekzhang/bore/releases/download/v0.6.0/bore-v0.6.0-aarch64-apple-darwin.tar.gz | tar xz && mv bore ~/bin/

# or via cargo
cargo install bore-cli
```

`/share` auto-starts a bore tunnel if available. See [docs/sharing-guide.md](docs/sharing-guide.md) for details. Protocol spec: [docs/messaging-protocol.md](docs/messaging-protocol.md).

## Structure

```
src/
  core/           contracts, types, runtime DI, errors
  agent/          pipeline, loop, turn assembly, context, tool subpipe
  providers/      anthropic, openai adapters, router, retry
  cache/          union-find hot/cold zones, TF-IDF, LRU eviction
  filter/         content validation, policy, loop detection, tool masking, circuit breaker
  perceive/       context discovery, @file refs, skill discovery
  transmit/       SQLite sessions, skill store, decision store
  consolidate/    triple extraction, candidate generation
  convergence/    volley protocol
  tools/          file read/write, shell, grep, glob, registry
  skills/         loader, activation, $ARGUMENTS substitution
  session/        bootstrap, resume
  config/         models, defaults
  commands/       slash commands (/exit, /help, /compact, /skills, /share, /revoke)
  share/          shared sessions (SSE server, event log, invite registry, bridge, client)
  app/            Ink TUI components
spec/             role specifications and anti-patterns
test/             525 tests + test harness (PipelineRig, golden providers)
worklog/          timestamped work log
docs/             design docs (host-guest intimacy gradient, messaging protocol)
```

## Provenance

No proprietary source code was read, copied, or referenced. `reference/features.md` lists provenance-clean open-source implementations (Apache 2.0, MIT) for each feature. Test harness design adapted from [gemini-cli](https://github.com/google-gemini/gemini-cli) (Apache 2.0).

## License

AGPL-3.0. Improvements to the pipe stay in the commons.
