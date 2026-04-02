# Beyond MVP

Features deferred from v0.1. Each requires the MVP to be validated first — a working pipe with union-find cache, three model tiers, convergence protocol, manual Consolidate, and basic TUI.

Ordered by expected impact, not effort.

## Tier 1 — Experiments (why petricode exists)

### Automatic Consolidate triggers
End-of-session review, threshold-based (N new I-frames), adaptive GOP. The manual trigger proves the pipe works; automatic triggers prove it can learn without being asked.

### Consolidate inner pipeline
Replace the human-powered extraction with a full inner pipe (P→C→F→A→Con→R). Inner Perceive classifies episodes as I/P/B frames (codec). Inner Cache stores structured decision logs with problem frames. Inner Filter detects convergence via independent rediscovery, not frequency. Inner Scoring ranks by `time_saved × quality_preserved`. Inner Consolidate tunes its own extraction parameters (meta-learning). Inner Remember writes approved skills. Each level operates at diminishing bits until passthrough. Reference: [Consolidation Codec](https://june.kim/consolidate-codec), [The Compression Tower](https://june.kim/compression-tower).

### Compression tower
Skills stack into levels. Level 0: episodes. Level 1: skills (fixed-point operators). Level 2: compositions (`/copyedit` = `/humanize` → `/tighten` → `/readability` → `/flavor`). Level 3: self-improving compositions (output of one becomes input context for next — monoid becomes monad). The ranking metric across all levels: time saved × quality preserved.

### Forgetting as bitrate adaptation
Under memory pressure, drop B-frames first (most reconstructible), P-frames next (reconstruct from nearest I-frame), I-frames last (self-contained, no recovery). Eviction policy for Filter @ Remember, informed by the codec structure.

### Self-improving PRs
Consolidate generates PRs against petricode itself. The pipe inspects its own spec, finds where assumptions broke, proposes fixes. Human reviews. AGPL keeps improvements in the commons.

### Convergence detection tuning
Independent rediscovery vs. frequency. Problem→approach→outcome triples vs. tool sequences. The extraction quality determines whether skills are useful or noise.

### Cache parameter tuning
Union-find merge threshold, cluster cap, graduation policy, hot window size. Measure recall, token usage, overflow frequency across real sessions.

### Self-improving PRs
Consolidate generates PRs against petricode itself. The pipe inspects its own spec, finds where assumptions broke, proposes fixes. Human reviews.

### Skill composition engine
Compose skills into higher-order skills (`/copyedit` = `/humanize` → `/tighten` → `/readability` → `/flavor`). Verify composed convergence. Level 2 of the compression tower.

## Tier 2 — Usability (makes real coding pleasant)

### MCP support
Model Context Protocol — stdio, SSE, StreamableHTTP transports. Tool discovery from MCP servers. Reference: opencode's implementation (MIT).

### Hooks system
User-defined shell commands at lifecycle events (before/after tool use, session start/stop, file change). Block actions, modify inputs, inject context. Reference: publicly documented patterns from vendor CLIs.

### Path-scoped rules
Instruction files scoped to file paths via glob patterns. Load on demand when matching files are accessed. Progressive disclosure through the union-find forest.

### Git worktree isolation
Temporary worktree for parallel tasks. Changes committed in worktree branch without affecting working directory. Auto-cleanup if no changes.

### Plan mode
Two-phase workflow: plan agent proposes, human approves, build agent executes. Switch between agents within a session. Reference: opencode's implementation (MIT).

### Voice input
Push-to-talk for natural language input. Transcription → text buffer. For when typing is slower than talking.

### IDE integration
VS Code extension that connects to a running petricode session. Visual diff review, inline tool output, file navigation from conversation.

## Tier 3 — Infrastructure (makes experiments reproducible)

### Evaluation harness
Automated measurement of success criteria: slot-swap produces different outcomes, Consolidate improves session N+1, researcher swaps a slot in under an hour. Benchmark suite with synthetic and real tasks.

### Multiplayer forests
Two users feed the same union-find forest. Shared memory without shared prompts. Requires conflict resolution on concurrent merges.

### Session branching
Fork the union-find forest for what-if conversations. The fork inherits all context. Git branches for conversations.

### Subagents with custom configuration
Specialized agents as markdown files with restricted tools, specific model tier, scoped skills. Built-in: Explore (fast, read-only), Plan (research).

### Plugin system
Bundle skills, agents, hooks, and MCP servers into distributable packages. Install via command. Namespaced to prevent conflicts.

### Automatic eviction (Filter @ Remember)
Age × size scoring, threshold-based pruning, safety floor. The band-aid for unbounded session growth. Ship after enough sessions accumulate to test eviction policies.

## Tier 4 — Reach (network effects)

### Remote control
Connect a local session to a web or mobile interface. Session runs locally, controlled from anywhere.

### Cloud sessions
Run tasks on managed infrastructure. Clone repo, execute in sandbox, push to branch. Teleport results back to local terminal.

### Chrome / browser integration
Connect to browser via native messaging. Navigate, click, type, read console, take screenshots. Share login state.

### Channels (event push)
External event sources push messages into a running session. Telegram, Discord, webhooks. Agent reads and replies through the same channel.

### Scheduled tasks
Cloud-scheduled recurring tasks. Daily PR reviews, dependency audits, CI failure analysis. Survive machine sleep.

### Marketplace
Community distribution of skills, plugins, and agents. AGPL ensures shared improvements flow back.

## Tier 5 — Quality of life (unprioritized, defer until after MVP)

Sourced from public documentation of aider, opencode, cline, goose, and vendor CLIs. Prioritize after MVP validates the core pipe.

- Theme picker with light/dark/colorblind variants
- Rebindable keybindings via JSON config
- Vim editing mode
- External editor for prompt composition (Ctrl+G → $EDITOR)
- Token usage / cost display (`/cost`, `/usage`, `/stats`)
- Customizable status line (model, context %, cost, git branch)
- Automatic edit checkpointing with rewind (`/rewind`)
- Copy last response / export conversation to file
- Image paste from clipboard
- Interactive diff viewer for uncommitted changes
- Security review command for pending changes
- Named sessions with resume-by-name
- Fork session (branch off a resumed session)
- Prompt ghost-text suggestions based on conversation history
- Bash mode with `!` prefix (run shell, output to context)
- Reverse prompt history search (Ctrl+R)
- Live model switching mid-session
- Effort level adjustment (low/medium/high/max)
- Terminal bell / custom notification on completion
- Auto-commit with attribution (Co-authored-by)
- Scrape webpage into chat (`/web`)
- Output style presets (default, explanatory, learning)
- Chat language setting
- Doctor/diagnostics command (`/doctor`)
- Verbose/debug transcript toggle
- In-session task list with persistence across compactions
- Stash current prompt (Ctrl+S, like git stash for input)
- Conditional rules that activate on file patterns

## Not planned

- Telemetry / analytics reporting to remote servers
- RLHF data collection
- Anti-distillation defenses / DRM
- Identity concealment / undercover mode
- Client attestation
- Managed enterprise settings / SSO / org-wide policy
- Usage tracking beyond what the user asks for
