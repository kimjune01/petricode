# Roadmap

High-level features. The cache layer is built on [union-find compaction](https://june.kim/union-find-compaction); the items below are the user-visible affordances that compaction unlocks, plus the framework gap (Consolidate) and a polish pile.

Granular bug fixes live in `docs/bug-hunt-round*.md`. clig.dev compliance items live in `docs/design-pass-clig-gemini.md`. This file is intentionally thin.

---

## Cross-session continuity ("no sidebar")

Today: `--resume <id>` rehydrates a single named session.

The unlock the union-find post promises: prior conversations arrive as pre-merged clusters automatically, vectorized against the new session's incoming messages. No "as we discussed last time" preamble, no manual session picking.

- Auto-rehydrate the N most relevant cold clusters from prior sessions on every new turn (vector match against the current message)
- Eviction policy — the deferred choice from the post; today the forest grows monotonically
- Session-merge UX — when does a new conversation count as the same thread vs. a new thread?

## Provenance UI

The forest already supports `find()` (root for a leaf) and `expand(root_id)` (reinflate a cluster). Today neither is surfaced.

- TUI affordance to expand a cited cluster back to its source messages
- Audit view: "this answer drew on these summaries, which came from these messages"
- Source attribution in headless `--format json` output

## Branching

Fork the forest for a what-if conversation. The fork inherits all context. Git branches for conversations.

- `petricode --branch <name>` to fork an active session
- Diff between branches (which clusters diverged)
- Merge two branches' forests (union the clusters)

## Multiplayer

Two people feeding the same forest. Both can query it. Shared memory without shared prompts.

- Concurrency story for the sqlite-backed store (writer locks, conflict resolution)
- Auth/identity per writer
- Per-user views over a shared underlying forest

## Consolidate

The sixth Natural Framework role. Currently unwired. The post's framing: compaction is ops, consolidation is learning. A cron that reads from the store and writes new retrieval procedures.

- Periodic job that scans the cluster forest and proposes new tools, scaffolds, or skill prompts
- Feedback loop: which retrievals fired, which were useful, which were ignored
- Owner: needs design before scoping

## Polish pile (carryover from bug hunt + design pass)

Each is small to medium and well-scoped — fold into a release rather than a feature.

- **clig.dev #6** — TTY auto-detect: today the TUI boots even when stdin/stdout aren't a terminal; should fall back to headless or fail with a clear message
- **clig.dev #7** — `--yes` flag for headless destructive tools; today `-p` auto-allows everything implicitly
- **clig.dev #9** — slash command naming consistency (`/clear`, `/compact` vs `/model`, `/skills`)
- **clig.dev #10** — JSONC config so `petricode.config.json` can carry inline comments
- **Round 20 #5** — aborted tool batch synthesizes "Interrupted" for already-completed tools, breaking LLM coherence on Ctrl+C mid-batch
