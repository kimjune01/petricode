# Goal

🧫 Build an **experimental harness** — a coding agent that fills all six Natural Framework roles with clean, swappable interfaces. Not a product. A laboratory.

## What this is

A harness for experimenting with agent architectures. Every automated role (Perceive, Cache, Filter, Remember, Consolidate) has a slot. Every slot has a clean interface. Algorithms, data structures, and entire inner towers can be swapped in and out without touching the rest of the pipe. Attend stays with the human.

The goal is to **experiment our way into a full-6-slotted harness** — one that actually learns, actually evicts, actually discloses context progressively. The kind of pipe that vendors won't build because it would reduce token consumption.

## What this is not

- Not a clone of any vendor product. Not feature-parity with any specific tool.
- Not a product. No telemetry, no analytics, no RLHF reporting, no vendor-serving observability.
- Not enterprise software. No managed settings, no SSO, no org-wide policy enforcement.

## Look and feel

The harness should feel familiar to anyone who's used a modern terminal coding agent. Follow familiar terminal-agent conventions:

- **Logo:** 🧫 (petri dish) — growing code cultures in the commons
- **Terminal UI:** Ink/React-based. Conversation history with message bubbles, tool call groups with collapsible output, streaming markdown rendering, status line at bottom.
- **Color palette:** Muted dark theme with accent colors for different message types (user, assistant, tool results, errors).
- **Tool output:** Collapsible tool call groups. Show tool name, brief result, expandable full output. Progress indicators for long-running operations.
- **Input:** Multi-line editor at bottom. Slash command autocomplete. @-file references. Paste detection.
- **Diff display:** Inline diffs for file edits with syntax highlighting.

The interaction patterns and keyboard shortcuts should feel natural to anyone who's used terminal coding agents. This is clean-room design from public conventions, not imitation of a specific vendor.

## Design principles

### 1. Simple and easy to maintain

When in doubt, choose the simpler option. A 100-line module that's easy to read beats a 30-line module that's clever. Maintenance cost is the binding constraint — this is a research platform, not a startup.

### 2. Full user-facing functionality

Everything the user sees and touches works well. Terminal input, tool execution, streaming, session persistence, skills, MCP — the forward pipe is complete. The user shouldn't feel like they're using a research prototype.

### 3. Swappable slots

Each automated role is an interface, not an implementation. The harness ships with one default implementation per slot. Experiments swap implementations without changing the interface.

```
Perceive:     (raw_input) → PerceivedEvent | RetryableError
Cache:        .append(turn) / .read() / .compact() / .load_context(path) / .token_count()
Filter:       (subject) → Pass | Reject(reason)
Remember:     .append(event) / .read(session_id) / .list(filter) / .prune(policy) / .write_skill(skill)
Consolidate:  .run(sessions) → CandidateSkill[]
```

Attend is the human. The harness presents options and records decisions. No autonomous Attend slot.

### 4. Discard vendor-serving functionality

Strip anything that serves the vendor rather than the user:

- No telemetry or analytics reporting to a remote server
- No RLHF data collection or feedback pipelines
- No anti-distillation defenses or DRM
- No identity concealment or undercover modes
- No client attestation or unauthorized-client blocking
- No usage tracking beyond what the user asks for

The harness serves the person at the keyboard. Period.

### 5. Inner towers are first-class

The composition spec (07-composition.md) defines four tower levels. Each level's pipeline is composed from the same slot interfaces. An experiment that improves Filter @ Remember (eviction inside the session store) uses the same Filter interface as Filter @ top (content validation).

This means the tower is recursive by construction, not by convention.

## MVP (v0.1)

Cut the first milestone to what one person can ship:

1. Top-level agent loop (prompt → model → tool calls → results → next turn)
2. Basic TUI (conversation display, input, tool output)
3. Tool execution (file read/write, shell, grep/glob)
4. Session persistence (SQLite)
5. One concrete interface per automated role
6. Manual Consolidate trigger only (user invokes skill extraction)
7. Union-find compound cache from day one (hot/cold zones, provenance, incremental graduation). No flat cache — [that's an anti-pattern](https://june.kim/union-find-compaction).
8. Three-model tiers from day one. Primary (SOTA vendor A) for the agent loop. Reviewer (SOTA vendor B) for cross-review before every human gate. Fast (cheap, either vendor) for high-volume internal ops — compaction, cluster merging, loop detection. Anthropic + OpenAI out of the box.

**Defer:** MCP, recursive inner towers, polished learn-from-history workflows, automatic Consolidate triggers.

## Experiment targets

Listed in order of impact, informed by the SOAP diagnosis:

1. **Consolidate** — the missing role. Extract patterns from past sessions, distill into skills, fire on a trigger. This is the experiment that matters most.
2. **Cache** — tune union-find parameters (merge threshold, cluster cap, graduation policy). Measure token usage per task, recall, overflow frequency.
3. **Filter @ Remember** — automatic eviction policies. Measure disk growth, startup time, OOM frequency.
4. **Inner towers** — swap the tool execution subpipe, measure tool success rate. Swap the streaming subpipe, measure retry frequency.

## Success criteria

The harness succeeds if:

1. Running the same task twice with different slot implementations produces measurably different outcomes (the slots actually matter)
2. A new researcher can swap a slot implementation in under an hour by reading the interface
3. The Consolidate slot, when enabled, measurably improves task performance on session N+1 compared to session 1
4. The harness is pleasant to use for real coding work, not just experiments

## License

AGPL-3.0. Improvements to the pipe stay in the commons.
