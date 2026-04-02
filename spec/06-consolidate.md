# 06 — Consolidate

The backward pass. Read from Remember, write procedures back to the substrate. This is the role that makes the agent learn.

## What Consolidate does

Consolidate reads accumulated experience from Remember (session logs, decision records, tool results) and writes back to procedural memory (skills, instructions, preferences). It changes how the agent processes the *next* session.

```
Remember (session logs, decisions)
    ↓ Consolidate reads
    ↓ Extracts patterns, distills preferences, generates skills
    ↓ Consolidate writes
Procedural memory (skills, instructions, preferences)
    ↓ Perceive reads next session
Agent behaves differently
```

## Components

### 1. Event logger (Perceive for Consolidate)

Record user edits, rejections, approvals, and tool outcomes during the session.

- What did the user accept vs. reject?
- Which tool calls succeeded vs. failed?
- Where did the user take over manually after the agent's attempt?

### 2. Decision log (Cache for Consolidate)

Structured records of each human decision, stored in Remember.

- Decision type (approve, reject, modify, ignore)
- Context presented at decision time
- Outcome (what happened after the decision)

### 3. Pattern extractor (Filter for Consolidate)

Identify recurring patterns in the decision log. Reject noise, surface signal.

- Frequency: how often does this pattern appear?
- Consistency: does the user always decide the same way?
- Threshold: only extract patterns above N occurrences with M% consistency

### 4. Skill generator (Attend for Consolidate)

From extracted patterns, generate candidate skills. Present to the human for approval.

- Each candidate: trigger condition, action, expected outcome
- Human selects which candidates become real skills
- This is the Attend gate inside Consolidate — the human decides what the agent learns

### 5. Skill writer (Remember for Consolidate)

Write approved skills to procedural memory.

```
~/.config/agent/skills/<skill-name>.md
```

- Skills are markdown files with frontmatter (name, description, trigger)
- CRUD: create new, update existing, delete stale

### 6. Trigger (the crontab)

When does Consolidate fire?

- **End of session:** review accumulated decisions, extract patterns
- **Threshold:** N decisions accumulated without consolidation
- **Idle time:** agent has no pending tasks
- **Scheduled:** daily/weekly distillation of accumulated experience
- **Manual:** user invokes consolidation explicitly

The trigger is the missing piece in current harnesses. The capability exists (skill creation works when prompted). The trigger doesn't.

## Distillation

Consolidate compresses episodic memory (session logs) into semantic memory (skills, preferences). This is lossy by design — the goal is to extract reusable procedures, not to preserve every detail.

```
Episodic: "In session 47, user rejected the 3-file refactor and did it in 1 file"
Episodic: "In session 52, user rejected the split and kept it in 1 file"
Episodic: "In session 58, user said 'stop splitting files'"
    ↓ distillation
Semantic: "User prefers single-file changes over multi-file refactors"
    ↓ skill
Skill: "When planning a refactor, default to modifying the fewest files possible"
```

## Contract

- **Reads from:** Remember (session logs, decision records)
- **Writes to:** procedural memory (skills, instructions, preferences)
- **Does not:** modify the current session's behavior. Consolidate affects the *next* session.
- **Requires Attend:** the human approves what the agent learns. No unsupervised learning.
- **Convergence:** two iterations of scored feedback are enough to converge (empirical finding from slop-detection).

## Anti-patterns

- No trigger (Consolidate exists but never fires)
- Unsupervised learning (agent writes skills without human approval)
- Consolidate that modifies the current session (that's Cache compaction)
- Reading from the current context window instead of from Remember (that's Attend, not Consolidate)
