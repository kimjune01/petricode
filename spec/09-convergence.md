# 09 — Convergence

The monoidal contract. Every artifact in the pipe converges — running the same operation twice produces the same result. This is not a feature; it is the composition guarantee. Without it, skills don't compose, Consolidate oscillates, and the pipe is unreliable.

Reference: [Volley](https://june.kim/volley), [The Compression Tower](https://june.kim/compression-tower), [The Handshake](https://june.kim/the-handshake).

## The protocol

Two models bounce an artifact until neither can improve it.

```
Primary drafts → Reviewer challenges → Primary revises → Reviewer challenges → stable
```

- **Primary** (persistent context): accumulates understanding across rounds. Drifts toward coherence with its own history.
- **Reviewer** (fresh context): reads the artifact cold every round. No memory of previous rounds. No anchoring to earlier drafts. Catches what familiarity hides.

Convergence occurs when the reviewer finds nothing to challenge. Empirically, two rounds suffice in 90% of cases (consistent with Delphi studies). Hard stop at five rounds — if still changing, the input was underspecified. Halt and return to the human.

## Why two models

Self-review catches less than cross-review. Familiarity breeds complacency — the more familiar you are with a text, the more errors you overlook. The reviewer reads cold, as a stranger would. The persistent side accumulates understanding; the fresh side verifies legibility.

The spec converges when it doesn't need the conversation history to make sense.

## Where convergence fires

The protocol runs at every composition boundary in the pipe:

| Where | What converges | Primary | Reviewer |
|-------|---------------|---------|----------|
| Before human gates | Artifacts (tool plans, diffs, reports) | Main model | Reviewer model |
| Skill creation | Candidate skill (does it converge as a fixed-point operator?) | Consolidate inner pipe | Reviewer model |
| Skill composition | Composed skill chain (does A→B→C converge?) | Skill executor | Reviewer model |
| Spec improvement | PR against petricode | Consolidate | Reviewer model |
| Implementation (Forge) | Volley→Merge→Volley: spec sharpening, then PR cleaning | Primary | Reviewer |

## The monoidal contract

Skills are fixed-point operators. Running a converged skill twice produces the same output. This is the identity law of the monoid:

```
skill(skill(x)) = skill(x)
```

The "a bit" qualifier dampens a skill to idempotency — the second pass finds almost nothing to change. Two iterations to convergence is the empirical finding.

Compositions of convergent skills are convergent. A pipeline of fixed-point operators has a fixed point:

```
(f ∘ g ∘ h)(x) converges if f, g, h each converge individually
```

This is why `/copyedit` = `/humanize` → `/tighten` → `/readability` → `/flavor` works as a single invocation. Each component converges independently. The composition inherits convergence.

## Convergence for Consolidate

Consolidate's inner pipe must converge — it runs the same protocol:

1. **Inner Filter** extracts candidate patterns. The reviewer challenges: "Is this a real invariant or a habit?" Converge on the pattern set.
2. **Inner Scoring** ranks candidates by time×quality. The reviewer challenges: "Does this ranking hold on held-out sessions?" Converge on the ranking.
3. **Skill generation** produces candidate skills. The reviewer challenges: "Does this skill converge as a fixed-point? Does it compose with existing skills?" Converge on the candidate.
4. **Human approves.** The converged candidate reaches the human. The human only Attends what survived cross-review.

Without convergence, Consolidate oscillates — each run produces different candidates from the same input. The pipe would learn different things each time. Convergence makes learning reproducible.

## Interface

```
Convergence:
  .volley(artifact: string, primary: Provider, reviewer: Provider) → ConvergedArtifact
  .is_converged(a: string, b: string) → boolean   # did the reviewer find changes?
  .rounds_taken() → number

ConvergedArtifact:
  content: string
  rounds: number
  reviewer_findings: string[]    # what the reviewer flagged each round
  converged: boolean             # false if hit hard stop
```

The protocol is a utility, not a role. Any role can call it. Filter calls it before human gates. Consolidate calls it on skill candidates. Forge calls it on specs and PRs. The convergence protocol is to petricode what `retryWithBackoff` is to vendor harnesses — infrastructure that every role uses.

## Failure modes

- **Shared blind spot:** neither model knows the domain well enough to challenge a flawed assumption. The artifact converges on a wrong premise. Mitigation: the human gate catches what cross-review can't.
- **Oscillation:** the reviewer and primary disagree and keep ping-ponging. Hard stop at five rounds prevents infinite loops.
- **Wrong problem:** the input confidently describes the wrong thing. The volley produces an elegant convergence on it. Mitigation: the human checks each gate's output against intent, not against internal consistency.

## Anti-patterns

- Self-review only (primary reviews its own output — anchoring, diminishing returns)
- No hard stop (unlimited rounds — oscillation risk, wasted tokens)
- Convergence check on surface form instead of semantics (reformatting triggers false "changed" signal)
- Skipping convergence before human gates (human sees unreviewed drafts, Attend cost increases)
