# 🧫 petricode

AGPL-3.0 specification for a coding agent harness, derived from the [Natural Framework](https://june.kim/the-natural-framework) — not from any proprietary source code.

## Provenance

This spec is informed by:
- [Diagnosis LLM](https://june.kim/diagnosis-llm) — six-role mapping of the agent stack (published March 2026)
- [SOAP Demo](https://github.com/kimjune01/soar-demo) — blind diagnostic pipeline applied to gemini-cli (Apache 2.0 source)
- The Natural Framework's six roles: Perceive, Cache, Filter, Attend, Remember, Consolidate
- Public open-source implementations (aider, opencode, goose, cline, codex) for reference

No proprietary source code was read, copied, or referenced.

## Structure

```
spec/
  00-architecture.md   — roles, tower structure, typed interfaces
  01-perceive.md       — input: terminal, filesystem, API responses
  02-cache.md          — tree-shaped context with progressive disclosure
  03-filter.md         — validation, policy, eviction, loop detection
  05-remember.md       — session persistence, filesystem CRUD
  06-consolidate.md    — the backward pass: skill extraction, memory distillation
  07-composition.md    — how roles compose across tower levels
  08-anti-patterns.md  — diagnosed failures from real systems
```

Attend (04) is intentionally absent — that's the human's job. The harness presents options and records decisions, but selection stays with the person at the keyboard.

## Why AGPL

MIT lets anyone fork the pipe, close it, and sell the throttled version. AGPL ensures improvements flow back to the commons.

## For maintainers

See `PETRICODE.md` for editing guidelines.

## License

AGPL-3.0. If you serve a harness built from this spec, your improvements stay open.
