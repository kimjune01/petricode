# 00 — Architecture

A coding agent harness is a pipe around inference. The pipe has five automated roles and one human role.

## The roles

| Role | Direction | Contract | Automated? |
|------|-----------|----------|------------|
| Perceive | forward | Transform external signals into structured input. Terminal keypresses, filesystem reads, API responses. | Yes |
| Cache | forward | Store and retrieve working state. Conversation history, UI state, token counts. Tree-shaped, not flat. | Yes |
| Filter | forward | Gate: accept or reject. Content validation, policy checks, eviction, loop detection. Every gate is a predicate. | Yes |
| Attend | forward | Select among alternatives with human judgment. Tool approval, plan confirmation, elicitation. | **No — human only** |
| Remember | forward | Persist to durable store. Session logs, filesystem writes. CRUD interface, lossless. | Yes |
| Consolidate | backward | Read from Remember, write procedures back to the substrate. Skill extraction, memory distillation. | Yes (triggered) |

## Attend is a human job

Attend is not a slot to fill with an algorithm. It is the point where the pipeline presents options and the human selects. The harness's job is to make Attend efficient — present the right information, at the right time, in the right format — but the selection itself stays with the human.

The harness implements Attend as **presentation + recording**, not as autonomous decision-making:
- Present tool calls for approval
- Present ambiguities for resolution
- Record every human decision (for Consolidate to read later)

## Tower structure

Each role can contain a sub-pipeline. This is recursive.

```
Top level:  P → C → F → [human] → R → Con
                |
Tool exec:  P → C → F → [human confirms] → R
                |
Streaming:  P → C → F → [inference] → R
                |
Context:    P → C → F
```

Gaps at lower levels propagate upward. A missing Filter inside Remember (no eviction) causes Remember at the top level to grow without bound.

**Subpipes may be partial.** The top-level loop completes all roles. Subpipes complete a prefix and stop — this is documented, not a gap. The context subpipe stops at Filter because progressive disclosure (Cache) handles what Attend would do.

## What the pipe is not

The pipe is not inference. Inference is the black box inside the streaming subpipe. The pipe receives the model's output and routes it through the forward roles. The pipe's quality determines how efficiently inference tokens are spent.

## Invariants

1. The top-level loop completes Perceive through Remember on every turn. Subpipes may be partial (documented prefixes).
2. Consolidate is optional per turn but mandatory per system. A system that never consolidates cannot learn.
3. Filter is the only role that can reject. All other roles transform or present.
4. Remember is lossless. Lossy operations belong to Filter (eviction) or Cache (compaction).

## Interfaces

Each automated role is a swappable slot. The formal contracts follow from [The Handshake](https://june.kim/the-handshake): each postcondition is the next stage's precondition. Rearrange and the contracts break.

```
Perceive:     raw → encoded
              Guarantee: parseable by next stage. Injects new bits.
              (raw_input) → PerceivedEvent | RetryableError

Cache:        encoded → indexed
              Guarantee: retrievable by key. Atomic under concurrent read/write.
              .append(turn) → void
              .read() → Content[]
              .compact() → CompactionResult
              .expand(root_id) → Content[]     # union-find: reinflate cluster
              .find(message_id) → root_id       # union-find: follow parent pointers

Filter:       indexed → selected
              Guarantee: strictly smaller. Losers suppressed, winners forwarded.
              (subject) → Pass | Reject(reason)

Remember:     selected → persisted
              Guarantee: retrievable on next cycle's Perceive. Lossless.
              .append(event) → void
              .read(session_id) → Session
              .list(filter?) → SessionSummary[]
              .prune(policy) → PruneResult
              .write_skill(skill) → void
              .read_skills() → Skill[]

Consolidate:  persisted → policy′
              Guarantee: backward pass. Reads from Remember, writes to substrate. Lossy.
              .run(sessions) → CandidateSkill[]
```

If contracts match, algorithms are swappable. If any contract is broken, the loop dies. Swapping an implementation means satisfying the same postcondition. The harness ships with one default per slot.
