# petricode

Experimental coding agent harness. AGPL-3.0. TypeScript + Bun.

## What this is

A laboratory for agent architectures with six Natural Framework roles: Perceive, Cache, Filter, Attend (human), Remember, Consolidate. Each automated role is a swappable interface. The spec is in `spec/`. The work plan is in `WORKPLAN.md`.

## Ambiguity heuristic

Contracts are correct. Cache owns its invariants. Spec wins on the user-facing path. Code wins on internals. When uncertain, be pragmatic — convergence will happen.

## Implementation

Follow `WORKPLAN.md` sequentially. Each item has: what it does, dependencies, test, expected files. Do not skip ahead — each item builds on the previous.

### Current state

No implementation yet. Start at item 1 (Scaffold).

### Stack

- **Runtime:** Bun (not Node)
- **Language:** TypeScript, strict mode
- **TUI:** Ink/React
- **Database:** bun:sqlite
- **API clients:** `@anthropic-ai/sdk`, `openai`
- **Test runner:** `bun test`
- **Union-find cache:** custom (no library)
- **Package manager:** bun

### Build and test

```bash
bun install          # install deps
bun test             # run all tests
bun run src/cli.ts   # launch petricode
```

### Architecture

Five automated slots, one human slot. Every slot is an interface in `src/core/contracts.ts`.

```
User input → Perceive → Cache → Filter → [human decides] → Remember → Consolidate
```

Three model tiers configured at startup — primary (Anthropic), reviewer (OpenAI), fast (cheap). Every call site declares which tier. No silent fallback. Provider trait in `src/providers/provider.ts`.

### Key constraints

- **No vendor lock-in.** Provider trait abstracts the API boundary.
- **No flat cache.** Union-find with hot/cold zones from day one. See `spec/02-cache.md`.
- **Filter = predicates.** Pass/fail, not ranking. See `spec/03-filter.md`.
- **Attend = human.** Present options, record decisions. No autonomous Attend.
- **Volley before human gates.** Primary drafts, reviewer challenges. See `spec/09-convergence.md`.
- **Manual Consolidate only.** `/consolidate` extracts candidates, human approves. See `spec/06-consolidate.md`.
- **Skills = markdown + YAML frontmatter.** Discoverable from disk. See `spec/04-skills.md`.
- **Binary data = file pointers.** Never inline base64 in session logs.
- **Compact before overflow.** Never reject without attempting compaction first.

### Provenance

Do NOT reference, copy from, or read any proprietary source code. `reference/features.md` lists provenance-clean open-source implementations (Apache 2.0, MIT) for each feature. Use those as reference.

### Commit style

One commit per work plan item. Message: `item N: <name>` (e.g., `item 1: scaffold`). Commit after tests pass.

### What to defer

MCP, automatic Consolidate triggers, hooks, recursive inner towers, plan mode, git worktree isolation, session branching. Full list in `beyond-mvp.md`. If it's not in `WORKPLAN.md`, don't build it.
