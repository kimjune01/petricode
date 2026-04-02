# 00 — Architecture

A coding agent harness is a pipe around inference. The pipe has six roles. Five forward, one backward.

## The six roles

| Role | Direction | Contract |
|------|-----------|----------|
| Perceive | forward | Transform external signals into structured input. Terminal keypresses, filesystem reads, API responses. |
| Cache | forward | Store and retrieve working state. Conversation history, UI state, token counts. Tree-shaped, not flat. |
| Filter | forward | Gate: accept or reject. Content validation, policy checks, eviction, loop detection. Every gate is a predicate. |
| Attend | forward | Select among alternatives with human judgment. Tool approval, plan confirmation, elicitation. The bottleneck. |
| Remember | forward | Persist to durable store. Session logs, filesystem writes. CRUD interface, lossless. |
| Consolidate | backward | Read from Remember, write procedures back to the substrate. Skill extraction, memory distillation, preference learning. The cron job. |

## Tower structure

Each role can contain a sub-pipeline of all six roles. This is recursive.

```
Top level:  P → C → F → A → R → Con
                |
Tool exec:  P → C → F → A → R → (no Con)
                |
Streaming:  P → C → F → [inference black box] → R
                |
Context:    P → C → F → (no A, no R, no Con)
```

Gaps at lower levels propagate upward. A missing Filter inside Remember (no eviction) causes Remember at the top level to grow without bound.

## What the pipe is not

The pipe is not inference. Inference is the black box inside the streaming subpipe. The pipe receives the model's output and routes it through the forward roles. The pipe's quality determines how efficiently inference tokens are spent.

A flat pipe (all context loaded, no eviction, no consolidation) burns more tokens per task. A structured pipe (tree-shaped cache, automatic eviction, skill extraction) burns fewer. The vendor's incentive determines which one ships.

## Invariants

1. Every forward pass completes Perceive through Remember. Skipping a role creates a gap.
2. Consolidate is optional per pass but mandatory per system. A system that never consolidates cannot learn.
3. Attend requires a human. If the human is unavailable, the pipeline stops at the Attend gate. There is no fallback.
4. Filter is the only role that can reject. All other roles transform.
5. Remember is lossless. Lossy operations belong to Filter (eviction) or Cache (compaction).
