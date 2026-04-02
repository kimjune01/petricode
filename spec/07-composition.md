# 07 — Composition

How the six roles compose across tower levels. A role at one level can contain a sub-pipeline of all six roles at the next level down.

## Tower levels

### Top level — the agent loop

```
User input → Perceive → Cache → Filter → Attend → Remember → Consolidate
                                            ↑
                                      (human gate)
```

The main loop: user types, agent perceives, caches context, filters invalid state, presents for human attention, remembers the session, consolidates into skills.

### Tool execution subpipe

```
Model response → Perceive (extract tool calls) → Cache (queue) → Filter (policy) → Attend (confirm) → Remember (results to history)
```

Triggered when the model returns function calls. Each tool call goes through its own mini-pipeline. Consolidate is absent — no learning from tool execution patterns (future extension point).

### Streaming subpipe

```
API call → Perceive (receive chunks) → Cache (buffer) → Filter (validate) → [inference black box] → Remember (add to history)
```

The API response stream. Filter validates each chunk. The model's internal Perceive → Cache → Filter → Attend is behind the API boundary — invisible to the harness.

### Context management subpipe

```
Filesystem → Perceive (discover paths) → Cache (dedup loaded paths) → Filter (trust gate)
```

Stops at Filter. No Attend (no selection among contexts — see 02-cache.md for progressive disclosure as the structural solution). No Remember (CLI doesn't write back to instruction files). No Consolidate (no learning from context usage).

## Composition rules

1. **Gaps propagate upward.** A missing Filter inside Remember (no eviction) causes Remember at the top level to grow without bound.

2. **Roles at different levels are independent.** Filter at the top level (content validation) and Filter inside Remember (eviction) are different mechanisms that happen to play the same role at different tower levels.

3. **Attend gates are recursive.** Tool confirmation is Attend inside the tool execution subpipe. Plan approval is Attend at the top level. Both require the human but for different decisions.

4. **Consolidate is always top-level.** Even though each subpipe could theoretically have its own Consolidate, in practice the backward pass reads from the aggregate session (top-level Remember) and writes to procedural memory. Sub-pipe-level Consolidate is a future extension.

5. **The black box stays black.** The harness does not model the inference pipeline's internal roles. It treats the model as: input (prompt) → output (response). The harness's quality is independent of the model's quality.

## Composition invariant

For each tower level, the pipeline either:
- Completes all six roles (full loop)
- Completes Perceive through Remember with Consolidate absent (forward-only pipe)
- Completes a prefix of the forward roles and stops (partial pipe, documented as intentional)

An undocumented gap is a bug. A documented gap is a design choice.
