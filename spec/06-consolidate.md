# 06 — Consolidate

The backward pass. Read from Remember, write procedures back to the substrate. The role that makes the agent learn.

Reference: [Consolidation Codec](https://june.kim/consolidate-codec), [The Consolidate Pipe](https://june.kim/consolidate-pipe), [The Compression Tower](https://june.kim/compression-tower).

## Interface

```
Consolidate:
  .run(sessions: Session[]) → CandidateSkill[]
```

MVP ships one method. The human does the rest.

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

## How it works (MVP)

1. User invokes `/consolidate`.
2. The fast model reads accumulated sessions and decision records from Remember.
3. It extracts problem→approach→outcome triples — what problem was being solved, what approach was taken, what happened.
4. Similar triples across sessions are grouped.
5. Each group is presented to the human as a candidate skill.
6. Each candidate runs through Volley (reviewer cross-checks) before presentation.
7. Human approves, rejects, or edits each candidate.
8. Approved candidates are written as skill files via `Remember.write_skill()`.

The human is doing the ranking, the convergence detection, and the quality judgment. The model is doing the extraction and grouping. This is Consolidate with the human filling most of the inner roles.

## Trigger

- **Manual only (MVP).** User invokes `/consolidate` explicitly.

Automatic triggers (end-of-session, threshold-based, adaptive) are experiments for post-MVP. See `beyond-mvp.md`.

## What makes a good candidate

- Multiple sessions arrived at the same approach independently (convergence, not frequency)
- The approach compressed time without degrading quality
- The pattern is about strategy ("when planning a refactor, modify the fewest files possible"), not implementation ("Read→Edit→Edit")

## Anti-patterns

- No trigger (Consolidate exists but never fires)
- Unsupervised learning (agent writes skills without human approval)
- Consolidate that modifies the current session (that's Cache compaction)
- Reading from the current context window instead of from Remember (that's in-context learning, not Consolidate)
- Extracting tool sequences instead of decision heuristics (compresses labor, not intellect)
- Frequency-based promotion (promotes habits, not invariants)
