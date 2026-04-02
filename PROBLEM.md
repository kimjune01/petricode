# Problem: petricode MVP work plan

## Context

petricode is an AGPL-3.0 experimental coding agent harness with swappable slots for five automated roles (Perceive, Cache, Filter, Remember, Consolidate) and one human role (Attend). The full spec is in `spec/`. The goal is in `GOAL.md`. Post-MVP features are in `beyond-mvp.md`.

## The task

Produce a concrete work plan for the MVP (v0.1). The plan should be a sequence of implementable work items that one person can ship. Each item should be independently testable.

## MVP scope (from GOAL.md)

1. Top-level agent loop (prompt → model → tool calls → results → next turn)
2. Basic TUI (conversation display, input, tool output)
3. Tool execution (file read/write, shell, grep/glob)
4. Session persistence (SQLite)
5. One concrete interface per automated role
6. Manual Consolidate trigger only
7. Union-find compound cache (hot/cold zones, provenance, incremental graduation)
8. Three model tiers: primary (SOTA A), reviewer (SOTA B), fast (cheap)

## Constraints

- **Language:** TypeScript with Bun runtime (fast startup, native test runner, compatible with Ink/React for TUI)
- **TUI:** Ink/React — follow familiar terminal-agent conventions
- **Dependencies:** minimize. Union-find is custom. SQLite via better-sqlite3 or bun:sqlite. API clients for Anthropic + OpenAI.
- **Testing:** Bun test runner. Each work item has a test that proves it works.
- **No vendor lock-in:** Provider trait abstracts API boundary. Three tiers configured at startup.
- **Convergence protocol:** built in from the start. Volley between primary and reviewer before human gates.
- **Skills:** discoverable from disk, invocable as slash commands, manual creation only (no auto-Consolidate yet).

## What the work plan should contain

For each work item:
- **Name** (short)
- **What it does** (2-3 sentences)
- **Depends on** (which prior items)
- **Test** (how to verify it works)
- **Files** (expected files created/modified)

Order items so each one builds on the previous. The first item should produce a running process. The last item should be a usable coding agent.

## Ambiguity heuristic

When in doubt: keep it simple, no regressions, UX improvement. Defer anything that isn't needed for a person to sit down and use petricode for real coding work with three model tiers and a union-find cache.

## Read these files before planning

- `GOAL.md`
- `spec/00-architecture.md`
- `spec/02-cache.md`
- `spec/04-skills.md`
- `spec/05-remember.md`
- `spec/06-consolidate.md`
- `spec/09-convergence.md`
- `reference/features.md` (for provenance-clean reference implementations)
