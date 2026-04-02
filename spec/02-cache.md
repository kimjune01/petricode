# 02 — Cache

Store and retrieve working state for the current session. The agent's working memory.

## Interface

```
Cache:
  .append(turn: Turn) → void
  .read() → Content[]
  .compact() → CompactionResult { removed_tokens: number, preserved_pct: number }
  .expand(root_id: string) → Content[]          # reinflate a cluster to source messages
  .find(message_id: string) → string             # follow parent pointers to cluster root
  .load_context(path: string) → ContextFragment | null
  .token_count() → number
```

## Data structures

### Conversation history (compound cache)

Two zones, managed by a [union-find forest](https://june.kim/union-find-compaction):

**Hot** — the last N messages (e.g., 10), served raw. When the window overflows, the oldest message graduates to cold.

**Cold** — everything older, managed by a union-find forest. On graduation:
1. The new message keeps its timestamp and gets a TF-IDF vector (cheap, local).
2. Compare against cluster centroids by cosine similarity.
3. Above merge threshold → `union` into that cluster. Below → new singleton.
4. Hard cap on cluster count forces closest pair to merge when exceeded.
5. Centroids update as weighted averages.

**Read path:** vectorize the incoming prompt, find the nearest cluster root, inject that cluster's summary alongside the hot window. Summaries are pre-merged at write time. Context stays bounded.

**Why union-find, not flat summarization:**
- **Provenance.** Every summary traces back to source messages through `find()`. Auditable.
- **Recoverability.** `expand(root_id)` reinflates a cluster. Raw messages stay addressable. Flat summarization destroys them.
- **Incremental.** Messages graduate one at a time. Each graduation is near-O(1). No batch stall.
- **Cheaper.** Each `union` feeds a small cluster to a cheap summarizer (e.g., Haiku). Smaller prompts, smaller models.
- **Persistent.** The forest serializes as parent pointers (integers). Save it, load it next session, clusters intact.

Reference: [union-find compaction](https://june.kim/union-find-compaction) — experiment showed 15–18pp recall advantage over flat summarization at 200 messages with the same token budget.

### Context as clusters

Instruction files (AGENTS.md, .agents/) are messages too — they enter the forest on discovery, tagged by source path. The union-find forest handles both conversation history and project context in one structure. No separate trie or tree. Progressive disclosure is just "expand the cluster rooted at this path."

Global instructions merge into a cluster at forest root. Project instructions form a nearby cluster. Subdirectory instructions stay as singletons until accessed, then merge by semantic similarity with the conversation they're relevant to.

### UI state

Master state object for interactive rendering: history items, streaming state, pending items, tool confirmations.

### Metadata caches

- Token count estimate (updated per response, used for overflow check)
- Loaded path set (dedup for context discovery)

## Compaction

Three distinct operations, each with different lossiness:

- **Compact:** lossless, reversible, in-cache restructuring. Graduate old messages from hot to cold (union-find merge). Full data preserved through parent pointers. Reversible via `expand()`.
- **Suppress:** remove clusters from the active retrieval set without deleting data. Suppressed clusters remain in Remember and can be re-activated. Reclaims context tokens without losing data.
- **Prune:** actual durable deletion. Only happens in Remember via Filter @ Remember (see 03-filter.md). Cache never prunes.

The distinction from consolidation: compaction is ops, consolidation is learning.

- **Trigger:** token count exceeds threshold (e.g., 50% of model limit)
- **Order:** compaction MUST run before overflow rejection. Never reject a message without attempting compaction first.
- **Strategy:**
  1. Compact: graduate oldest hot messages to cold via union-find merge.
  2. Suppress: exclude oldest/smallest cold clusters from retrieval index. They stay in Remember, recoverable.
  3. Only if suppression is insufficient: report overflow to the user.

## Unlocks

Three things follow from persistent union-find forests:

1. **No sidebar.** Prior conversations arrive as pre-merged clusters. No blank window, no "as we discussed last time."
2. **Multiplayer.** Two users feed the same forest. Both can query it. Shared memory without shared prompts.
3. **Branching.** Fork the forest for a what-if conversation. The fork inherits all context. Git branches for conversations.

## Anti-patterns

- Flat summarization (destroys provenance, batch stall, drops footnote facts)
- No compaction trigger (let the context overflow, then reject the message)
- Overflow check that runs before compaction attempt
- Compaction that discards source messages instead of archiving them
