# 06 — Consolidate

The backward pass. Read from Remember, write procedures back to the substrate. The role that makes the agent learn. Contains its own inner pipeline (P→C→F→A→Con→R), recursively, bits diminishing at each level until passthrough.

Reference: [Consolidation Codec](https://june.kim/consolidate-codec), [The Consolidate Pipe](https://june.kim/consolidate-pipe), [The Compression Tower](https://june.kim/compression-tower).

## Interface

```
Consolidate:
  .run(sessions: Session[]) → CandidateSkill[]
  .classify_frame(episode: Episode) → 'I' | 'P' | 'B'
  .extract_keyframes(window: Episode[]) → Keyframe[]
  .detect_convergence(patterns: Pattern[]) → Pattern[]   # independent rediscovery, not frequency
  .evict(store: EpisodicStore, policy: EvictionPolicy) → EvictResult
  .rank(candidates: CandidateSkill[]) → CandidateSkill[]  # by time_saved × quality_preserved
```

## Contract

```
Consolidate:  persisted → policy′
              Guarantee: backward pass. Reads from Remember asynchronously,
              writes to the substrate. Lossy. Reshapes how each stage processes.
```

- **Reads from:** Remember (session logs, decision records, tool outcomes)
- **Writes to:** procedural memory (skills, instructions, preferences)
- **Does not:** modify the current session. Consolidate affects the *next* session.
- **Requires human approval:** the human decides what the agent learns. No unsupervised learning.
- **Offline:** runs asynchronously, with access to the full buffer. Not inline with the forward pass.

## The inner pipe

Consolidate contains its own six roles. Each solves a specific problem:

### Inner Perceive — the codec

Episodes arrive as a stream with high temporal redundancy. Most frames look like the previous frame. Classify into three types ([Consolidation Codec](https://june.kim/consolidate-codec)):

- **I-frame** (keyframe): complete snapshot. Self-contained. Expensive to store. Random-access anchor.
- **P-frame** (predicted): forward diff from previous reference. Stores only what changed. Cheap.
- **B-frame** (bidirectional): references both past and future. Most compressed. Only constructible offline with lookahead.

**GOP (group of pictures):** how many P-frames between I-frame extractions. This is the consolidation frequency parameter. Adaptive: fire when the ratio of new I-frames to total stored episodes exceeds a threshold.

### Inner Cache — the decision log

Structured records of each human decision, stored in Remember:

- Decision type (approve, reject, modify, ignore)
- Context presented at decision time
- Outcome (what happened after the decision)
- **Problem frame** — what problem was being solved, not just what tools were used

### Inner Filter — convergence detection

**Not frequency — independent rediscovery.** The harness learned this the hard way: extracting `Read→Edit→Edit` at 35× is Cache-level labor, not Filter-level craft. Frequency promotes habits. Convergence promotes invariants.

The test: did multiple trajectories independently arrive at the same pattern? If so, promote. If only one trajectory, decay.

**What to extract:** problem→approach→outcome triples, not tool→tool→tool sequences. Skills compress strategy, not implementation. "When planning a refactor, default to modifying the fewest files possible" is a skill. "Read→Edit→Edit" is a log entry.

### Inner Scoring — rank by compression value

Among patterns that pass convergence detection, score by: **time saved × quality preserved**. (This is not Attend — it's automated ranking that prepares candidates for human review.)

- High product → promote to skill candidate
- Low product → evict
- Time is measurable (clock time per task at each compression level)
- Quality is measurable (output evaluation against the same standard)

The product separates useful compression from bad macros (time saved, quality lost) and verbose wrappers (quality preserved, no time saved).

### Inner Consolidate — meta-learning

The recursive step. Which *types* of patterns keep earning promotion? Which convergence thresholds are too aggressive or too lenient? This is where the pipe tunes its own parameters. At zero bits, passthrough.

### Inner Remember — write the policy update

Write approved skills to procedural memory. The output isn't a summary of what happened. It's a change to how the forward pass runs next cycle.

```
~/.config/petricode/skills/<skill-name>.md
```

See [04-skills.md](04-skills.md) for skill format and lifecycle.

## Six requirements

Consolidation fails when any of these is missing ([The Consolidate Pipe](https://june.kim/consolidate-pipe)):

| # | Requirement | Failure without it |
|---|---|---|
| 1 | **Multiple trajectories** | Memorization, no generalization |
| 2 | **Shared storage outliving any trajectory** | No cross-trajectory comparison |
| 3 | **Convergence detection** (independent rediscovery, not frequency) | Noise promoted to signal |
| 4 | **Eviction** | Monotonic rule accumulation |
| 5 | **Offline execution** with access to full buffer | No B-frame construction |
| 6 | **Write target that changes the forward pass** | Compression without learning |

## The compression tower

Skills stack into levels ([The Compression Tower](https://june.kim/compression-tower)):

**Level 0: Episodes.** Raw task execution. Twenty minutes of manual work producing twenty episodes.

**Level 1: Skills.** Repeated manual patterns compressed into single invocations. Each skill is a fixed-point operator — running it twice produces the same output. The "a bit" qualifier dampens to idempotency.

**Level 2: Compositions.** Skills compose into higher-order skills. `/copyedit` = `/humanize` → `/tighten` → `/readability` → `/flavor`, run to convergence. A pipeline of fixed-point operators has a fixed point.

**Level 3: Self-improving compositions.** The learning step adds bind: the output of one composition becomes the input context for the next, carrying what was learned. Monoid (levels 1-2) becomes monad (level 3).

The ranking metric across all levels: **time saved × quality preserved**. Each transition compresses time while preserving quality. The compression ratio is the measure of expertise.

## Forgetting as bitrate adaptation

Under memory pressure, drop in order:

1. **B-frames first.** Most dependent, most reconstructible. Losing them costs detail but preserves structure.
2. **P-frames next.** Reconstruct from nearest I-frame. Losing them costs continuity.
3. **I-frames last.** Self-contained. Losing one means losing an entire segment with no recovery.

This is the eviction policy for Filter @ Remember, informed by the codec structure.

## Trigger

When does Consolidate fire?

- **Manual:** user invokes consolidation explicitly. **(MVP — implement this first.)**
- **End of session:** review accumulated decisions. *(post-MVP)*
- **Threshold:** N new I-frames accumulated since last run. *(post-MVP)*
- **Adaptive GOP:** fire when ratio of new I-frames to total episodes exceeds threshold. *(post-MVP)*

The trigger is the missing piece in current harnesses. The capability exists. The trigger doesn't. MVP ships manual-only; automatic triggers are experiments.

## Input parameters (knobs)

The pipe is fixed. The feed is the lever:

- **Volume:** how many episodes before triggering. Too few → nothing converges. Too many → inner Perceive drowns.
- **Diversity:** structural (N agents), counterfactual (LLM-generated alternatives), temporal (same agent over time), stochastic (noise-augmented replay). Ordered by signal quality.
- **Frequency:** how often the cron job fires. Adaptive: fire when new I-frames accumulate.
- **Granularity:** what counts as an episode. A tool call, a task, a session. Finer = more episodes, less variation each.

## Known weaknesses

From [harness experiments](https://june.kim/consolidation):

- Tool sequences are the wrong extraction target. `Read→Edit→Edit` at 35× is Cache-level labor, not Filter-level craft.
- Single-word continuations ("yes", "fix") lose intent from previous turn. Need turn chaining.
- Frequency ≠ importance. Intent-first perception (TF-IDF on prompt tokens) beats n-gram frequency.
- Need problem→approach→outcome triples, not tool→tool→tool sequences. Skills compress strategy, not implementation.

## Self-improvement: PRs against petricode

The spec is procedural memory for the harness. Consolidate writes to procedural memory. Therefore Consolidate can write improvements to the spec itself.

```
Harness runs → sessions accumulate
    ↓
Consolidate extracts patterns about the harness itself
  "convergence threshold too aggressive — 3 false promotions in 10 runs"
  "eviction fires too early — users re-request evicted sessions"
  "codec GOP of 100 is too long for volatile environments"
    ↓
Consolidate generates a PR against kimjune01/petricode
    ↓
Human reviews → merge or reject
    ↓
AGPL: improvement stays in the commons
```

This is the compression tower applied to the harness's own architecture. Level 0: raw experience running the harness. Level 1: skills for using the harness. Level 2: spec improvements that change how the harness works. Level 3: improvements to how spec improvements are generated.

The human approves at every level. AGPL increases the chance that improvements from networked forks remain available to the commons — it doesn't guarantee upstreaming, but it keeps the source inspectable.

## Anti-patterns

- No trigger (Consolidate exists but never fires)
- Unsupervised learning (agent writes skills without human approval)
- Consolidate that modifies the current session (that's Cache compaction)
- Reading from the current context window instead of from Remember (that's in-context learning, not Consolidate)
- Extracting tool sequences instead of decision heuristics (compresses labor, not intellect)
- Frequency-based promotion (promotes habits, not invariants)
