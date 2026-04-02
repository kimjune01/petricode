# 🧫 petricode

Experimental coding agent harness. AGPL-3.0. TypeScript + Bun.

A laboratory for agent architectures with six [Natural Framework](https://june.kim/the-natural-framework) roles: Perceive, Cache, Filter, Attend (human), Remember, Consolidate. Each automated role is a swappable interface. The goal is to experiment our way into a harness that actually learns between sessions.

## Quick start

```bash
bun install
bun test                    # 176 tests, no API keys needed
bun run src/cli.ts          # TUI shell (stub response — pipeline not wired to CLI yet)
```

## Sanity check (requires API keys)

See [TESTING.md](TESTING.md) for the full testing guide, including how to run sanity checks with real models.

```bash
export ANTHROPIC_API_KEY=sk-...
export OPENAI_API_KEY=sk-...
bun run test-drive.ts       # one-shot pipeline test with real providers
```

## Architecture

Five automated slots, one human slot. Every slot is an interface in `src/core/contracts.ts`.

```
User input → Perceive → Cache → Filter → [human decides] → Remember → Consolidate
```

Three model tiers: primary (Anthropic), reviewer (OpenAI), fast (cheap). The reviewer is a [Maxwell's demon](https://june.kim/forge) — it sits at the gate between volley rounds, selects which changes pass, and the artifact's entropy decreases. Paid for honestly in reviewer tokens.

## Structure

```
src/
  core/           contracts, types, runtime DI, errors
  agent/          pipeline, loop, turn assembly, context, tool subpipe
  providers/      anthropic, openai adapters, router, retry
  cache/          union-find hot/cold zones, TF-IDF, LRU eviction
  filter/         content validation, policy, loop detection, tool masking, circuit breaker
  perceive/       context discovery, @file refs, skill discovery
  remember/       SQLite sessions, skill store, decision store
  consolidate/    triple extraction, candidate generation
  convergence/    volley protocol
  tools/          file read/write, shell, grep, glob, registry
  skills/         loader, activation, $ARGUMENTS substitution
  session/        bootstrap, resume
  config/         models, defaults
  commands/       slash commands (/exit, /help, /compact, /skills, /consolidate)
  app/            Ink TUI components
spec/             role specifications and anti-patterns
test/             176 tests + test harness (PipelineRig, golden providers)
worklog/          timestamped work log
```

## Provenance

No proprietary source code was read, copied, or referenced. `reference/features.md` lists provenance-clean open-source implementations (Apache 2.0, MIT) for each feature. Test harness design adapted from [gemini-cli](https://github.com/google-gemini/gemini-cli) (Apache 2.0).

## License

AGPL-3.0. Improvements to the pipe stay in the commons.
