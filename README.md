# 🧪 claude-left

AGPL-3.0 specification for a coding agent harness, derived from the [Natural Framework](https://june.kim/the-natural-framework) diagnosis — not from any proprietary source code.

## Provenance

This spec is derived from:
- [Diagnosis LLM](https://june.kim/diagnosis-llm) — six-role mapping of the agent stack (published March 2026)
- [SOAP Demo](https://github.com/kimjune01/soar-demo) — blind diagnostic pipeline applied to gemini-cli (Apache 2.0 source)
- The Natural Framework's six roles: Perceive, Cache, Filter, Attend, Remember, Consolidate

No proprietary source code was read, copied, or referenced. The architecture follows from the framework's structural requirements — what a correct pipe *must* have, not what any vendor *happens* to have.

## Structure

```
spec/
  00-architecture.md   — six-role pipeline, tower structure
  01-perceive.md       — input: terminal, filesystem, API responses
  02-cache.md          — tree-shaped context with progressive disclosure
  03-filter.md         — validation, policy, eviction, loop detection
  04-attend.md         — human gates, elicitation, plan approval
  05-remember.md       — session persistence, filesystem CRUD
  06-consolidate.md    — the backward pass: skill extraction, memory distillation
  07-composition.md    — how roles compose across tower levels
  08-anti-patterns.md  — flat cache, no eviction, model-gated retry (diagnosed failures)
```

## Why AGPL

MIT lets anyone fork the pipe, close it, and sell the throttled version. AGPL ensures improvements flow back to the commons. See [soar-demo worklog](https://github.com/kimjune01/soar-demo) for the full argument.

## License

AGPL-3.0. If you serve a harness built from this spec, your improvements stay open.
