# Aider UX Research — Consolidated Findings

Fan-out research on paul-gauthier/aider GitHub issues, filtered by gemini adversarial review.
Only KEEP items survive. Organized by priority for petricode implementation.

## P0: Must-have for v0.1

### Bracketed Paste Mode (H1, H3)
**Convergent evidence from two independent angles.**
Terminals send pasted text as rapid keystrokes. If Enter triggers submit, multiline pastes get truncated. Ink doesn't handle bracketed paste natively.
- **Fix:** Listen for `\x1b[200~` / `\x1b[201~` escape sequences to buffer paste, or use Alt+Enter for submit.

### Diff Preview Before Apply (H4)
Users hate black-box file mutations. The #1 reason for aider→Claude Code migration.
- **MVP:** Show a clear diff summary at the `y/n` prompt. Rejection = tool call denied. No partial approvals for v0.1.

### Shell vs File Permission Separation (H4)
Shell commands are categorically more dangerous than file edits. Aider's `--yes-always` confusingly blocks shell but allows files.
- **MVP:** In cautious mode, visually distinguish shell commands (warning color) from file edits at confirmation. In yolo mode, stream stdout/stderr live so user can Ctrl+C.

### Streaming Markdown O(n^2) Prevention (H1, H3)
**Convergent evidence.** Re-parsing the entire growing response string on every token destroys the event loop.
- **Fix:** Debounced rendering or chunked tail-only parsing. Don't re-parse full string every token.

### Strict Tool Schema Validation (H1)
LLMs hallucinate arguments. Separate `create_file` (fails if exists) from `edit_file` (fails if not exists). Reject paths without extensions or with directory traversal.
- **Fix:** Zod schema validation on all tool calls.

### .gitignore Respect in File Operations (H1)
Bun's `fs.watch` doesn't auto-respect `.gitignore`. Feeding `.env` to an LLM is catastrophic.
- **Fix:** Parse `.gitignore` before any file tree traversal. Hardcode `.git`, `node_modules` as default exclusions.

### Never Drop Pending Edits on Interrupt (H4)
Aider's fatal bug: pending tool executions evaporate if a user prompt or timeout occurs.
- **Fix:** Orchestrator must queue edits. Timeout/interrupt preserves pending state, doesn't silently discard.

## P1: Important for UX quality

### Provider Capability Matrix (H1)
Setting `temperature: 0` on o1 throws. Anthropic rejects unknown params.
- **Fix:** Provider abstraction strips invalid params before sending. Per-model capability awareness.

### Tiered Stateful Permissions (H1)
Pressing 'y' 50 times for sequential file writes kills flow.
- **Fix:** Auto-approve edits to files already in context. Require approval for shell commands and new file creation.

### Convention Files / .cursorrules (H2)
Ecosystem standard. Users expect coding agents to read project-level instructions.
- **Fix:** Load `.petricode`, `.cursorrules`, or similar convention file into system prompt.

### Context State Injection (H1)
LLM asks to add files already in context = state desync.
- **Fix:** Inject `<currently_open_files>` into system prompt every turn.

### VSCode Terminal Fallback (H3)
Ink's cursor-repositioning ANSI breaks in VSCode terminal and multiplexers.
- **Fix:** Provide `--no-tui` append-only mode for broken terminal environments.

### Ctrl+Z Suspend Support (H3)
Raw mode swallows SIGTSTP. Ctrl+Z does nothing.
- **Fix:** Listen for `\x1a` in useInput, manually emit `process.kill(process.pid, 'SIGTSTP')`.

## P2: Nice to have / v0.2+

### Agentic Tool Workflows (H2)
Aider is text-only editing. Native shell execution, test running, git ops differentiate petricode.
- Already partially implemented via tool registry.

### Supervised Mode / Granular Approvals (H2)
Beyond binary y/n — diff-level approval for complex changes.
- Defer to v0.2. Binary y/n + diff preview is sufficient for v0.1.

### Deep Context: Docs RAG (H2)
Hallucinating missing dependency docs is aider's biggest failure on large codebases.
- Defer. Architectural moat opportunity but expensive to build correctly.

### MCP Server Support (H2)
Highest reaction count on aider. Makes petricode composable and embeddable by IDEs.
- Contradicts petricode's GOAL.md "Won't do: MCP" — revisit if thesis changes.

## CUT (not implementing)

- Hunk-by-hunk interactive staging — turns agent into git-rebase tool
- Custom undo engine — rely on git + ask-before-apply
- 4-tier autonomy system — binary yolo/cautious is cleaner
- IDE plugins — if we ever do this, MCP server is the path
- Dotfile hygiene complaints — already using `.petricode/` directory
- Model churn issues — already have dynamic JSON config

## Pruning Log

| Source | Raw findings | KEEP | DEMOTE | CUT |
|--------|-------------|------|--------|-----|
| H1 (pain points fixed) | 15 | 7 | 3 | 5 |
| H2 (requested features) | 20 | 5 | 2 | 13 |
| H3 (terminal rendering) | 16 | 4 | 2 | 10 |
| H4 (confirmation/safety) | 14 | 3 | 1 | 10 |
| **Total** | **65** | **19** | **8** | **38** |

Survival rate: 29% (19/65). Funnel working as intended.
