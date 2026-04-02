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

## Model-agnostic, multi-model

The pipe is not inference. Inference is the black box inside the streaming subpipe. The pipe receives the model's output and routes it through the forward roles. The pipe's quality determines how efficiently inference tokens are spent.

The harness operates with any two SOTA models simultaneously — one from each major vendor. This is a design requirement, not a convenience feature:

- **No vendor lock-in.** The pipe works regardless of which model fills the black box. Switching models is a config change, not an architecture change.
- **Two models, different jobs.** The primary model handles the main conversation (the forward pass). The secondary model is the **reviewer** — it reads every artifact before it reaches the human and catches obvious issues so the human only Attends what actually requires judgment. This is the codex-sniff pattern: send the draft to a second SOTA model, apply mechanical fixes, present only ambiguities to the human.
- **Where the reviewer fires:** before every human gate. Before tool confirmation (did the model propose something dangerous?). Before plan approval (is the plan internally consistent?). Before Consolidate presents skill candidates (are the candidates well-formed?). Before any artifact leaves the pipe (is the output correct?). The reviewer is Filter running on a different model than the one that generated the content.
- **Provider interface.** A single `Provider` trait abstracts the API boundary:

```
Provider:
  .generate(prompt: Content[], config: ModelConfig) → AsyncGenerator<StreamChunk>
  .model_id() → string
  .token_limit() → number
  .supports_tools() → boolean
```

Three models configured at startup:

- **Primary:** SOTA from vendor A. The agent's main model. Handles conversation, tool calls, reasoning.
- **Reviewer:** SOTA from vendor B. Cross-reviews artifacts before human gates. Applies mechanical fixes. Flags issues the primary is blind to (its own biases, hallucinations, style tics). Always a different model than the primary — self-review catches less than cross-review.
- **Fast:** cheap model from either vendor. Earns its keep via speed, not depth. Handles high-volume internal ops: compaction summaries, union-find cluster merging, loop detection queries, TF-IDF vectorization, convergence detection scoring. Work that runs many times per session and can't wait for SOTA latency.

The routing is explicit — the harness never silently falls back between tiers. Each call site declares which tier it needs: primary for generation, reviewer for cross-check, fast for throughput.

Supported out of the box: Anthropic API, OpenAI API. Any provider implementing the trait works. The harness does not privilege either vendor.

## Convergence

Every composition in the pipe converges — running the same operation twice produces the same result. This is the monoidal contract. Skills are fixed-point operators. Composed skills inherit convergence. The Volley protocol (primary drafts, reviewer challenges, converge in two rounds) enforces this at every boundary. See 09-convergence.md.

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
              Minimum: .append(turn) / .read() / .compact() / .token_count()
              Extensions: .expand(root_id) / .find(message_id) / .load_context(path)
              See 02-cache.md for full interface.

Filter:       indexed → selected
              Guarantee: strictly smaller. Losers suppressed, winners forwarded.
              Minimum: (subject) → Pass | Reject(reason)
              See 03-filter.md for gate catalog.

Remember:     selected → persisted
              Guarantee: retrievable on next cycle's Perceive. Lossless.
              Minimum: .append(event) / .read(session_id) / .list(filter?)
              Extensions: .prune(policy) / .write_skill(skill) / .read_skills() / .delete_skill(name)
              Extensions: .list_decisions(filter?) → DecisionRecord[]
              See 05-remember.md for full interface.

Consolidate:  persisted → policy′
              Guarantee: backward pass. Reads from Remember, writes to substrate. Lossy.
              Minimum: .run(sessions) → CandidateSkill[]
              Extensions: .classify_frame() / .extract_keyframes() / .detect_convergence() / .rank()
              See 06-consolidate.md for full interface.
```

If contracts match, algorithms are swappable. If any contract is broken, the loop dies. Swapping an implementation means satisfying the same postcondition. The harness ships with one default per slot.
