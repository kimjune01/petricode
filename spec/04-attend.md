# 04 — Attend

Select among alternatives with human judgment. Attend is the bottleneck — it requires a human. If the human is unavailable, the pipeline stops.

## Gates

### Tool confirmation

Before executing a tool that modifies state, present it to the human for approval.

- **Present:** tool name, arguments, preview (diff for file edits)
- **Outcomes:** approve (once), approve (always for this tool), reject, modify and approve
- **Resolution:** event bus with correlation ID. Support multiple resolution paths (terminal input, IDE diff view). Race: first resolution wins.
- **Modal:** blocks further input until the human responds.

### Plan approval

Before executing a multi-step plan, require informal discussion followed by formal approval.

- **Discussion first:** the agent must discuss the plan before presenting a formal approval dialog. No immediate "approve this plan?" on first turn.
- **Approval sets mode:** the human selects an approval mode (default, auto-approve, etc.) that applies for the duration of the plan.
- **Non-interactive:** plan mode must degrade gracefully when `ask_user` is denied.

### Elicitation

The agent asks the human questions to resolve ambiguity. This is Attend — the agent proposes, the human selects.

- **One question at a time.** Don't dump a quiz.
- **Confidence tags:** human rates each answer (high/medium/low/unsure). Downstream processing respects these ratings.
- **Mandatory:** if the agent cannot resolve an ambiguity without human input, it stops and asks. It does not guess.

## Requirements

1. Every Attend gate must be bypassable by policy (for automation). But the default is to ask.
2. Attend gates are recorded — every human decision is persisted (for Consolidate to read later).
3. The agent must not manufacture false urgency to trigger Attend. Only genuine ambiguity or state-changing operations warrant a gate.

## Anti-patterns

- Dumping all questions at once (overwhelms the human)
- Guessing when uncertain instead of asking (error propagation)
- Attend gates in non-interactive mode without fallback (silent hang)
- No recording of human decisions (Consolidate has nothing to read)
