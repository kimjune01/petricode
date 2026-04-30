# petricode

Experimental coding agent harness. AGPL-3.0. TypeScript + Bun.

## What this is

A laboratory for agent architectures with six Natural Framework roles: Perceive, Cache, Filter, Attend (human), Transmit, Consolidate. Each automated role is a swappable interface. The spec is in `spec/`. The work plan is in `WORKPLAN.md`.

## Ambiguity heuristic

Contracts are correct. Cache owns its invariants. Spec wins on the user-facing path. Code wins on internals. When uncertain, be pragmatic — convergence will happen.

## Current state

MVP v0.1 complete. All 14 work plan items implemented. 176 tests passing.

**Not wired yet:**
- CLI doesn't bootstrap the pipeline (TUI shows stub response). Deferred — TUI-only for now.
- PerceivedEvent is planned to become an episodic memory node (frequency counter, source provenance, cheap-model merge). Not yet implemented.

## Stack

- **Runtime:** Bun (not Node)
- **Language:** TypeScript, strict mode
- **TUI:** Ink/React
- **Database:** bun:sqlite
- **API clients:** `@anthropic-ai/sdk`, `openai`
- **Test runner:** `bun test`
- **Union-find cache:** custom (no library), LRU eviction
- **Package manager:** bun

## Build, test, sanity check

```bash
bun install          # install deps
bun test             # 525 tests, no API keys needed
bunx tsc --noEmit    # typecheck
bun run src/cli.ts   # TUI shell (stub response)
```

For sanity checks with real models, see [TESTING.md](TESTING.md).

## Architecture

Five automated slots, one human slot. Every slot is an interface in `src/core/contracts.ts`.

```
User input → Perceive → Cache → Filter → [human decides] → Transmit → Consolidate
```

Three model tiers configured at startup — primary (Anthropic), reviewer (OpenAI), fast (cheap). Every call site declares which tier. No silent fallback. Provider trait in `src/providers/provider.ts`.

### Key constraints

- **No vendor lock-in.** Provider trait abstracts the API boundary.
- **No flat cache.** Union-find with hot/cold zones, LRU eviction. See `spec/02-cache.md`.
- **Filter = predicates.** Pass/fail, not ranking. See `spec/03-filter.md`.
- **Attend = human.** Present options, record decisions. No autonomous Attend.
- **Volley before human gates.** Primary drafts, reviewer challenges. Validates inputs (empty artifact, self-review). See `spec/09-convergence.md`.
- **Manual Consolidate only.** `/consolidate` extracts candidates, human approves. See `spec/06-consolidate.md`.
- **Skills = markdown + YAML frontmatter.** Discoverable from disk. See `spec/04-skills.md`.
- **Binary data = file pointers.** Never inline base64 in session logs.
- **Tool schema validation.** Deterministic type checking with actionable error messages.

### Test harness

`test/harness/` provides PipelineRig (headless pipeline testing), GoldenProvider (JSONL envelope replay), WorkspaceFixture (isolated dirs), and FileTree (declarative temp filesystem). See [TESTING.md](TESTING.md).

## Provenance

Do NOT reference, copy from, or read any proprietary source code. `reference/features.md` lists provenance-clean open-source implementations (Apache 2.0, MIT) for each feature. Test harness design adapted from gemini-cli (Apache 2.0).

## Commit style

Descriptive messages. `item N: <name>` for work plan items. `fix:` prefix for bug fixes. `D<N>:` prefix for deferred decision implementations.

## What to defer

MCP, automatic Consolidate triggers, hooks, recursive inner towers, plan mode, git worktree isolation, session branching, CLI pipeline wiring, --resume. Full list in `beyond-mvp.md`.
