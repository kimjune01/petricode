# Goal

🧫 Build an **experimental harness** — a coding agent that fills all six Natural Framework roles with clean, swappable interfaces. Not a product. A laboratory.

## What this is

A harness for experimenting with agent architectures. Every role (Perceive, Cache, Filter, Attend, Remember, Consolidate) has a slot. Every slot has a clean interface. Algorithms, data structures, and entire inner towers can be swapped in and out without touching the rest of the pipe.

The goal is to **experiment our way into a full-6-slotted harness** — one that actually learns, actually evicts, actually discloses context progressively. The kind of pipe that vendors won't build because it would reduce token consumption.

## What this is not

- Not a Claude Code clone. Not feature-parity with any vendor product.
- Not a product. No telemetry, no analytics, no RLHF reporting, no vendor-serving observability.
- Not enterprise software. No managed settings, no SSO, no org-wide policy enforcement.

## Look and feel

The harness should feel familiar to anyone who's used a modern terminal coding agent. Emulate the look-and-feel of Claude Code based on publicly available screenshots, demos, and documentation:

- **Logo:** 🧫 (alembic) — an experiment, not a product
- **Terminal UI:** Ink/React-based, similar layout. Conversation history with message bubbles, tool call groups with collapsible output, streaming markdown rendering, status line at bottom.
- **Color palette:** Muted dark theme with accent colors for different message types (user, assistant, tool results, errors). Match the general aesthetic visible in public demos and screenshots.
- **Tool output:** Collapsible tool call groups. Show tool name, brief result, expandable full output. Progress indicators for long-running operations.
- **Input:** Multi-line editor at bottom. Slash command autocomplete. @-file references. Paste detection.
- **Diff display:** Inline diffs for file edits with syntax highlighting.

The goal is that a Claude Code user sits down and feels at home. The interaction patterns, visual hierarchy, and keyboard shortcuts should feel natural. This is clean-room visual design from public references, not code copying.

## Design principles

### 1. Simple and easy to maintain

When in doubt, choose the simpler option. A 100-line module that's easy to read beats a 30-line module that's clever. Maintenance cost is the binding constraint — this is a research platform, not a startup.

### 2. Full user-facing functionality

Everything the user sees and touches works well. Terminal input, tool execution, streaming, session persistence, skills, MCP — the forward pipe is complete. The user shouldn't feel like they're using a research prototype.

### 3. Swappable slots

Each role is an interface, not an implementation. The harness ships with one default implementation per slot. Experiments swap implementations without changing the interface.

```
Perceive:     trait/interface → default: terminal + filesystem + API retry
Cache:        trait/interface → default: tree-shaped context with compaction
Filter:       trait/interface → default: validation + policy + eviction + loop detection
Attend:       trait/interface → default: tool confirmation + plan approval + elicitation
Remember:     trait/interface → default: SQLite sessions + filesystem + skill store
Consolidate:  trait/interface → default: two-phase extract + distill from past sessions
```

Swapping Cache from tree to flat is a one-line config change. Swapping Consolidate from extract+distill to a neural approach is implementing one interface. Swapping an entire inner tower (e.g., replacing the tool execution subpipe) is composing slot implementations.

### 4. Discard vendor-serving functionality

Strip anything that serves the vendor rather than the user:

- No telemetry or analytics reporting to a remote server
- No RLHF data collection or feedback pipelines
- No anti-distillation defenses or DRM
- No undercover mode or identity concealment
- No client attestation or unauthorized-client blocking
- No usage tracking beyond what the user asks for

The harness serves the person at the keyboard. Period.

### 5. Inner towers are first-class

The composition spec (07-composition.md) defines four tower levels. Each level's pipeline is composed from the same slot interfaces. An experiment that improves Filter @ Remember (eviction inside the session store) uses the same Filter interface as Filter @ top (content validation).

This means the tower is recursive by construction, not by convention.

## Experiment targets

Listed in order of impact, informed by the SOAP diagnosis:

1. **Consolidate** — the missing role. Extract patterns from past sessions, distill into skills, fire on a trigger. This is the experiment that matters most.
2. **Cache** — tree-shaped progressive disclosure vs. flat. Measure token usage per task, context relevance, overflow frequency.
3. **Filter @ Remember** — automatic eviction policies. Measure disk growth, startup time, OOM frequency.
4. **Attend** — active elicitation with pushback tracking. Measure question acceptance rate, task completion quality.
5. **Inner towers** — swap the tool execution subpipe, measure tool success rate. Swap the streaming subpipe, measure retry frequency.

## Success criteria

The harness succeeds if:

1. Running the same task twice with different slot implementations produces measurably different outcomes (the slots actually matter)
2. A new researcher can swap a slot implementation in under an hour by reading the interface
3. The Consolidate slot, when enabled, measurably improves task performance on session N+1 compared to session 1
4. The harness is pleasant to use for real coding work, not just experiments

## License

AGPL-3.0. Improvements to the pipe stay in the commons.
