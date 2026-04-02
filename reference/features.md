# Feature Reference — Provenance-Clean Implementations

All features described behaviorally. No proprietary source referenced.

## Shared features (open-source implementations exist)

| # | Feature | Best reference | License | Key files |
|---|---------|---------------|---------|-----------|
| 1 | Terminal input | aider | Apache 2.0 | `aider/io.py` — prompt_toolkit, vi/emacs, multi-line |
| 2 | Conversation history | aider | Apache 2.0 | `aider/coders/base_coder.py` — done_messages + cur_messages, token tracking |
| 3 | Context compression | goose | Apache 2.0 | `crates/goose/src/context_mgmt/mod.rs` — LLM summarization at 80% threshold |
| 4 | Tool execution | opencode | MIT | `packages/opencode/src/tool/` — Zod-typed tools with execute() |
| 5 | Tool confirmation | goose | Apache 2.0 | `crates/goose/src/permission/` — AllowOnce/AllowAlways/Deny with oneshot channels |
| 6 | Streaming | cline | Apache 2.0 | `src/core/api/transform/stream.ts` — provider-agnostic stream transformer |
| 7 | Retry with backoff | opencode | MIT | `packages/opencode/src/session/retry.ts` — exponential, retry-after header parsing |
| 8 | Loop detection | cline | Apache 2.0 | `src/core/task/loop-detection.ts` — canonical tool call signatures, soft/hard thresholds |
| 9 | Session persistence | goose | Apache 2.0 | `crates/goose/src/session/session_manager.rs` — SQLite-backed, resume by ID |
| 10 | Instructions loading | codex | Apache 2.0 | `codex-rs/core/src/project_doc.rs` — walks root→CWD concatenating AGENTS.md |
| 11 | Skills/commands | opencode | MIT | `packages/opencode/src/skill/index.ts` — SKILL.md discovery, frontmatter, templates |
| 12 | Plan mode | opencode | MIT | `packages/opencode/src/tool/plan.ts` — plan→build agent switch with approval |
| 13 | Context discovery | aider | Apache 2.0 | `aider/repomap.py` — tree-sitter tags, PageRank ranking, SQLite cache |
| 14 | MCP support | opencode | MIT | `packages/opencode/src/mcp/index.ts` — stdio/SSE/HTTP transports, OAuth |
| 15 | Consolidation | codex | Apache 2.0 | `codex-rs/core/src/memories/` — two-phase extract+consolidate from past sessions |

## Unique features (no open-source equivalent — behavioral descriptions only)

### 1. Hooks system
User-defined shell commands that execute automatically at lifecycle events (before/after tool use, session start/stop, file change). Hooks can block actions, modify tool inputs, inject context, or defer for external approval. Four types: command, HTTP, prompt, agent.

### 2. Auto mode (classifier-gated autonomy)
A separate classifier model reviews each tool call against conversation context before execution. Blocks actions that escalate beyond task scope or appear driven by injection. Strips tool results from classifier input. Falls back to manual prompting after repeated blocks.

### 3. OS-level sandbox
Filesystem and network isolation on all subprocesses via OS primitives (Seatbelt on macOS, bubblewrap on Linux). Configurable write/read allowlists. Network traffic through domain-restricted proxy. All child processes inherit boundaries.

### 4. Git worktree isolation
Creates a temporary git worktree for a subagent or parallel session — isolated copy of the repo. Changes committed in worktree branch without affecting working directory. Auto-cleanup if no changes made.

### 5. Subagents with custom configuration
Specialized agents defined as markdown files with YAML frontmatter. Each runs in its own context window with custom system prompt, restricted tools, specific model, independent permissions, scoped MCP servers, and persistent cross-session memory.

### 6. Path-scoped rules
Instruction files scoped to specific file paths via glob patterns in YAML frontmatter. Rules without path scoping load at session start; path-scoped rules load on demand when matching files are accessed.

### 7. Plugin system with marketplaces
Plugins bundle skills, agents, hooks, MCP servers, and settings into a distributable package with a manifest. Installed via command. Namespaced to prevent conflicts. Supports official and custom marketplaces.

### 8. LSP integration (language server)
Real-time code intelligence from a running language server. After each file edit, automatically reports type errors. Jump to definition, find references, type info, symbol listing, call hierarchy.

### 9. Side questions (/btw)
Quick side-question that sees full conversation context but has no tool access. Answer discarded from history, preserving context for the main task.

### 10. Auto memory (agent-written persistent notes)
Agent automatically saves notes for itself across sessions: build commands, architecture notes, code style preferences. Stored as plain markdown. Agent curates the index. Loaded at session start.

### 11. Remote control
Connects a local session to a web or mobile interface over outbound HTTPS. Session runs locally with full filesystem access. Multiple devices can control simultaneously. Auto-reconnects.

### 12. Cloud sessions
Runs tasks on managed cloud VMs that clone your repo, execute in sandbox, push changes to a branch. Setup scripts, diff review, auto-fix of CI failures.

### 13. Teleport
Pulls a cloud session into your local terminal. Fetches remote branch, checks out locally, loads full conversation history.

### 14. Managed settings (enterprise)
Organization-wide configuration deployed via MDM/Group Policy. Includes behavioral guidance, technical enforcement (tool deny lists, sandbox requirements, API routing), forced login methods. Users cannot override.

### 15. Code review (multi-agent PR analysis)
Fleet of specialized agents analyze PR diffs in parallel. Posts inline comments by severity. Populates GitHub check run. Configurable triggers. Respects project-level review rules.

### 16. Scheduled tasks
Cloud tasks (survive machine sleep), desktop tasks (local file access), and in-session recurring prompts with cron expressions and natural-language intervals.

### 17. Channels (event push)
External event sources (Telegram, Discord, webhooks) push messages into a running session. Agent reads and replies through the same channel.

### 18. Chrome integration
Connects to browser extension via native messaging. Opens tabs, navigates, clicks, types, reads console, takes screenshots, shares browser login state.

### 19. Computer use
Opens native apps, clicks, types, scrolls, takes screenshots on the actual desktop. Per-app approval. Global abort key.

### 20. Context window visualization
Interactive simulation showing how the context window fills: what loads automatically, what each file costs in tokens, when rules fire.
