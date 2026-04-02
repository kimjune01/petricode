# Work Log

## 2026-04-01

### 20:45 — MVP v0.1 complete: all 14 work plan items implemented

Built the full petricode MVP using blind-blind-merge methodology. Two agents implemented each work item independently in worktrees, then merged. 158 tests passing, 15 commits.

### 21:30 — Codex volley round 1: 14 findings fixed

Sent all source to codex (GPT-5.4) in 4 parallel batches. 14 bugs found, all fixed. Key fixes: Content[][] → Message[] with explicit roles, multi-tool streaming, ToolCall.id, union-find memory leak, skill serialization round-trip, blob restore, grep -- terminator, volley accumulated findings.

### 21:45 — Codex volley round 2: 4 remaining findings fixed

OpenAI multi-tool index tracking, PerceivedEvent role persistence, ToolCall.id in schema, skill injection XML tags.

### 22:00 — Deferred decisions resolved (D1-D8)

D1: PerceivedEvent is episodic memory, not a lossy Turn. Enrich with frequency counter and source provenance. Cheap model for semantic merge. Same pattern as union-find cache but for Remember.
D2: CLI wiring deferred past MVP. TUI only for now.
D3: --resume deferred.
D4: Keep current TF-IDF params (pretuned from union-find-compaction experiment). Drift is known.
D5: Add AGENTS.md to context discovery, fix relevance ordering (subdirectory > project > global), show loaded count + tokens on TUI startup. Fix now.
D6: Decision records are episodic memories too — absorb into PerceivedEvents. Same as D1.
D7: Deterministic type-checking adapter for tool schemas with actionable error messages. Fix now.
D8: Union-find cache eviction is LRU, not threshold-based compaction. Remove token_limit auto-compact. Fix now.
