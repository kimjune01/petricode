# 07 — Composition

How the roles compose across tower levels. A role at one level can contain a sub-pipeline at the next level down.

## Tower levels

### Top level — the agent loop

```
User input → Perceive → Cache → Filter → [human decides] → Transmit → Consolidate
```

The main loop: user types, agent perceives, caches context, filters invalid state, presents options for human decision, transmits the session, consolidates into skills.

### Tool execution subpipe

```
Model response → Perceive (extract tool calls) → Cache (queue) → Filter (policy) → [human confirms] → Transmit (results to history)
```

Triggered when the model returns function calls. Each tool call goes through its own mini-pipeline.

### Streaming subpipe

```
API call → Perceive (receive chunks) → Cache (buffer) → Filter (validate) → [inference] → Transmit (add to history)
```

The API response stream. Filter validates each chunk. The model's internals are behind the API boundary.

### Context management subpipe

```
Filesystem → Perceive (discover paths) → Cache (dedup loaded paths) → Filter (trust gate)
```

Stops at Filter. Progressive disclosure (Cache tree structure) handles context selection without needing a separate selection step.

## Composition rules

1. **Gaps propagate upward.** A missing Filter inside Transmit (no eviction) causes Transmit at the top level to grow without bound.

2. **Roles at different levels are independent.** Filter at the top level (content validation) and Filter inside Transmit (eviction) are different mechanisms that happen to play the same role at different tower levels.

3. **Subpipes may be partial.** The top-level loop completes all roles. Subpipes complete a documented prefix and stop. An undocumented gap is a bug. A documented gap is a design choice.

4. **Consolidate is top-level only.** The backward pass reads from the aggregate session store (top-level Transmit) and writes to procedural memory. Sub-pipe-level Consolidate is a future extension.

5. **The black box stays black.** The harness does not model the inference pipeline's internal roles. It treats the model as: input (prompt) → output (response).

6. **Human decisions happen at boundaries.** The human confirms tool calls (tool exec subpipe) and approves plans (top level). The harness presents; the human selects. No autonomous Attend.
