# 02 — Cache

Store and retrieve working state for the current session. The agent's working memory.

## Data structures

### Conversation history

Alternating user/model turns. Each turn contains typed parts: text, function calls, function responses, thoughts, inline data.

```
Content[] history — append-only during session, compactable
```

### Context tree (progressive disclosure)

Context files form a path hierarchy. Load root eagerly, deeper levels on demand.

```
~/.config/agent/          ← global (always loaded)
  instructions.md
project/                  ← level 1 (loaded on session start)
  AGENT.md
  .agent/
    instructions.md
project/src/api/          ← level 2+ (loaded when model accesses files in subtree)
  .agent/
    instructions.md
```

**Token budget per level:** root gets N tokens, each deeper level gets N/2 (geometric decay). Total context usage is O(log n) of the project tree, not O(n).

### UI state

Master state object for interactive rendering: history items, streaming state, pending items, dialog states, tool confirmations.

### Metadata caches

- Token count estimate (updated per response, used for overflow check)
- IDE context delta (tracks what was sent, sends only changes)
- Loaded path set (dedup for context discovery)

## Compaction

Compaction is VACUUM — reclaims space without changing processing behavior.

- **Trigger:** token count exceeds threshold (e.g., 50% of model limit)
- **Strategy:** reverse token budget. Iterate history backwards, preserve recent N% (e.g., 30%). Truncate old tool outputs (save full output to temp file, replace with summary + pointer).
- **Invariant:** compaction does not change the agent's behavior on the next turn. It only reduces the token footprint of the same information.

## Anti-patterns

- Flat context (load everything into one string — O(n) growth, context rot)
- No compaction trigger (let the context overflow, then reject the message)
- Compaction that changes semantics (that's Consolidate, not Cache)

## Contract

- **Append:** O(1) to add a turn
- **Read:** O(1) to get current history
- **Compaction:** preserves recent context, summarizes old context, saves full data to temp storage
- **Context loading:** O(log n) of project tree via progressive disclosure
