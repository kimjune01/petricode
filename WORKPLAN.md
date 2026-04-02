# petricode MVP Work Plan

Sequence of work items for v0.1. First item produces a running process. Last item is a usable coding agent.

---

## 1. Scaffold

**What it does.** Initialize the Bun project with TypeScript config, directory structure, and a minimal `petricode` CLI entry point. Opens a minimal Ink app with a status line, accepts keystrokes, exits cleanly. Runnable spine from day one.

**Depends on:** nothing

**Test:** `bun run src/cli.ts --help` prints usage. `bun run src/cli.ts` opens the TUI shell and exits with `q` or `Ctrl+C` without a stack trace. `bun test` runs and reports zero failures.

**Files:**
- `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`
- `src/cli.ts` (entry point)
- `src/app/App.tsx` (minimal Ink shell)
- `src/config.ts` (config loader)

---

## 2. Slot Contracts

**What it does.** Define TypeScript interfaces for all five automated roles (`Perceive`, `Cache`, `Filter`, `Remember`, `Consolidate`) plus shared domain types (`Turn`, `ToolCall`, `Skill`, `Session`, `Decision`). Add a runtime container that wires slots by interface so callers never reference concrete implementations.

**Depends on:** 1

**Test:** `bun test` includes a contract test that instantiates the runtime with stub implementations and asserts all five slots are registered and callable.

**Files:**
- `src/core/contracts.ts` (role interfaces)
- `src/core/types.ts` (domain types)
- `src/core/runtime.ts` (DI container)
- `src/core/errors.ts`
- `test/runtime.contract.test.ts`

---

## 3. Provider Trait and Three Tiers

**What it does.** Implement the `Provider` interface (`generate`, `model_id`, `token_limit`, `supports_tools`) with Anthropic and OpenAI adapters, both streaming. Startup config maps three tiers (primary, reviewer, fast) to concrete provider+model pairs. Fail fast if any tier is unwired. Every call site declares which tier it uses — no silent fallback.

**Depends on:** 2

**Test:** `bun test` verifies adapter shape, tier resolution, and a mocked streamed response for each tier. Integration test loads config, resolves all three tiers, asserts: (a) `model_id()` returns distinct values for primary vs. reviewer, (b) primary and reviewer resolve to different vendors, (c) startup fails if any tier is unwired, (d) fast tier is callable and routed correctly.

**Files:**
- `src/providers/provider.ts` (interface)
- `src/providers/anthropic.ts`, `openai.ts`
- `src/providers/router.ts` (tier resolution)
- `src/config/models.ts`
- `petricode.config.example.json`
- `test/providers.test.ts`

---

## 4. Agent Loop (Headless)

**What it does.** Top-level forward pipe: accept a prompt string, send to primary provider with streaming, collect the response, detect tool-use blocks, return a structured `Turn`. Runs in a `while` loop until the model emits no tool calls. No TUI yet — driven by a test harness that feeds prompts programmatically.

**Depends on:** 3

**Test:** Use a mocked provider that returns a canned stream. Assert: (a) turn assembly produces a structured `Turn` with role and content, (b) a stream containing a tool-use block is detected and parsed, (c) the loop iterates when tool calls are present and stops when they aren't, (d) tool results from the previous iteration appear in the next prompt.

**Files:**
- `src/agent/loop.ts`
- `src/agent/turn.ts` (Turn, ToolCall types)
- `test/agent.loop.test.ts`

---

## 5. Tool Execution

**What it does.** Five core tools: `FileRead`, `FileWrite`, `Shell`, `Grep`, `Glob`. Each conforms to `Tool` interface (`name`, `schema`, `execute`). The executor dispatches tool-call blocks from the agent loop to matching tools. Shell has configurable timeout. File writes gated by policy (auto-approve in headless mode for now).

**Depends on:** 4

**Test:** Unit tests per tool: FileRead reads a temp file, Shell runs `echo hello`, Grep finds a pattern, Glob matches a glob. Executor test: construct an explicit tool-call block (`{name: "glob", args: {pattern: "*.ts"}}`), dispatch through the registry, assert schema validation passes, tool executes, and result is structured for reinjection into the loop.

**Files:**
- `src/tools/tool.ts` (interface)
- `src/tools/readFile.ts`, `writeFile.ts`, `shell.ts`, `grep.ts`, `glob.ts`
- `src/tools/registry.ts` (executor + dispatch)
- `test/tools.test.ts`

---

## 6. Perceive and Context Discovery

**What it does.** `@path` file reference expansion (resolve before model sees it). Hierarchical context discovery: global `~/.config/petricode/instructions` → project `.agents/` → subdirectories. Skill discovery from markdown+YAML frontmatter on disk. Path normalization and trust-bounded filesystem reads.

**Depends on:** 2

**Test:** Create `.agents/instructions.md` in a temp dir. Assert discovery returns it with correct precedence rank. `@src/index.ts` in a message resolves to file contents with metadata. Malformed skill frontmatter is rejected. Discovery output is a normalized `ContextFragment[]` — system prompt assembly is deferred to item 11.

**Files:**
- `src/perceive/perceiver.ts` (interface impl)
- `src/perceive/contextDiscovery.ts`
- `src/perceive/fileRefs.ts`
- `src/perceive/skillDiscovery.ts`
- `test/perceive.test.ts`

---

## 7. Remember (SQLite)

**What it does.** Session persistence in SQLite. Tables: `sessions`, `messages`, `tool_calls`, `decisions`. Every turn appended to DB. `--resume <session_id>` reloads. `--list` shows recent sessions. Binary tool output stored as file pointer, not inline (anti-pattern #5). Skill CRUD writes to `~/.config/petricode/skills/` on disk. Typed decision records (`decision_type`, `subject_ref`, `presented_context`, `problem_frame`, `outcome_ref`) persisted here — Consolidate reads these as structured input.

**Depends on:** 2

**Test:** Run a session with two turns. Kill. Relaunch with `--resume`. Conversation history intact. Unit tests: append/read/list/prune/write_skill round-trip. Binary attachment stored as pointer, not base64. Decision record round-trip: write a structured decision, read it back, assert all fields present.

**Files:**
- `src/remember/sqlite.ts` (interface impl)
- `src/remember/schema.sql`
- `src/remember/sessionStore.ts`
- `src/remember/skillStore.ts`
- `src/remember/decisionStore.ts`
- `test/remember.test.ts`

---

## 8. Union-Find Compound Cache

**What it does.** Hot zone: ring buffer of last N turns (default 10), served raw. Graduation: oldest hot turn moves to cold on overflow. Cold zone: union-find forest with TF-IDF vectors and cosine similarity merging. Weighted-average centroids. Hard cap on cluster count forces closest-pair merges. `compact()` graduates and merges — uses the fast tier for cluster summarization. `read()` returns hot + relevant cold summaries. `expand(root_id)` reinflates a cluster. `find(message_id)` follows parent pointers. Compaction always fires before overflow rejection (anti-pattern #6).

**Depends on:** 3

**Test:** Append 50 turns — `token_count()` stays bounded below 2x hot window cost. `find()` on an early message returns a cluster root. `expand()` on that root returns original messages. Two semantically similar messages merge; two dissimilar stay separate. Compaction runs before overflow. Fast tier is called for cluster summarization (mock provider, assert tier = fast).

**Files:**
- `src/cache/cache.ts` (interface impl)
- `src/cache/unionFind.ts` (forest)
- `src/cache/tfidf.ts`
- `src/cache/similarity.ts`
- `src/cache/compaction.ts`
- `test/cache.test.ts`

---

## 9. Filter Suite and Volley

**What it does.** Predicate-style filters, each returning `Pass | Reject(reason)`. Four MVP gates: (a) content validation — reject empty responses, trigger retry; (b) tool output masking — replace oversized output with `[masked — N tokens]`; (c) policy engine — ALLOW/DENY/ASK_USER per tool, default ASK_USER for writes and shell; (d) loop detection — tier 1 (same tool + same args N times). Gates compose as a chain: first rejection stops. Plus the Volley convergence utility: primary drafts → reviewer challenges → converge in ≤5 rounds. Fires before every human gate.

**Depends on:** 3, 5

**Test:** Unit per gate: empty response → Reject; 100K-token output → masked; file-write without confirmation → ASK_USER; same tool call 5× → Reject on 5th. Volley: flawed artifact flagged in round 1, fixed by round 2. `rounds_taken() <= 5`. Well-formed artifact converges in 1 round.

**Files:**
- `src/filter/filter.ts` (interface, chain)
- `src/filter/contentValidation.ts`
- `src/filter/toolMasking.ts`
- `src/filter/policy.ts`
- `src/filter/loopDetection.ts`
- `src/convergence/volley.ts`
- `test/filter.test.ts`
- `test/volley.test.ts`

---

## 10. Basic TUI

**What it does.** Ink/React terminal UI: scrollable conversation history (user/assistant/tool messages), streaming markdown rendering, tool call groups with collapsible output, multi-line input at bottom, status line (model name, token count from Cache). Tool confirmation prompts for Attend (uses policy gate from Filter). Reviewer notes panel (uses Volley from item 9). Slash command parsing (`/exit`, `/help`, `/compact`, `/skills` wired; others registered dynamically). `@`-file autocomplete.

**Depends on:** 1, 4, 5, 9

**Test:** Launch `bun run src/cli.ts`, type a question, see streamed response. Tool call shows confirmation prompt (policy gate wired). `/exit` exits cleanly. Smoke test: launch process, send prompt via stdin, assert exit 0 after `/exit`.

**Files:**
- `src/app/App.tsx` (updated)
- `src/app/components/MessageList.tsx`
- `src/app/components/Composer.tsx`
- `src/app/components/ToolGroup.tsx`
- `src/app/components/ToolConfirmation.tsx`
- `src/app/components/StatusBar.tsx`
- `src/app/components/ReviewerNotes.tsx`
- `src/app/state.ts`
- `src/commands/index.ts`

---

## 11. Wire the Forward Pipe

**What it does.** Connect all five forward roles into the top-level agent loop. Each turn: Perceive (expand @-refs, load context) → Cache (append, read context window via union-find) → primary model → Filter (content validation) → tool calls through Filter (policy) → Attend (TUI confirmation) → tool execution → Remember (append to SQLite + Cache hot zone). Volley fires before every human gate. Status line shows `token_count()` from Cache.

**Depends on:** 6, 7, 8, 9, 10

**Test:** Full integration in a temp project with `.agents/instructions.md`. Ask it to read a file and edit it. Observe: instruction context loaded (Perceive), token count displayed (Cache), file-write triggers confirmation (Filter + Attend), edit persisted (Remember), turn recorded in SQLite. Kill and resume — conversation intact.

**Files:**
- `src/agent/loop.ts` (major update — wires all roles)
- `src/agent/pipeline.ts` (role composition)
- `src/agent/context.ts` (context assembly)
- `src/agent/toolSubpipe.ts`
- `test/integration.test.ts`

---

## 12. Skills

**What it does.** Skills are markdown files with YAML frontmatter. Discovered from `~/.config/petricode/skills/` and `project/.agents/skills/`. Slash commands matched by `name`. `/tighten path/to/file` injects skill body as system context, replaces `$ARGUMENTS`, restricts `allowed-tools`. Auto-triggered skills (with `paths` globs) activate when the agent touches matching files. `/skills` lists available skills.

**Depends on:** 6, 11

**Test:** Create a skill with `trigger: slash` and body "Respond with exactly: Hello from skill." `/greet` → response contains "Hello from skill." Auto skill with `paths: "*.test.ts"` — touch a test file — skill context appears. `/skills` lists both.

**Files:**
- `src/skills/loader.ts`
- `src/skills/activation.ts`
- `src/skills/types.ts`
- `src/commands/skills.ts`
- `test/skills.test.ts`

---

## 13. Manual Consolidate

**What it does.** `/consolidate` reads all sessions and decision records from Remember for the current project. Extracts problem→approach→outcome triples using the fast model. Groups similar triples across sessions. Presents candidate skills to the human in TUI for approval/rejection/editing. Each candidate runs through Volley before presentation. Approved skills written via `Remember.write_skill()`. MVP scope is simple extraction + human approval — full codec (I/P/B classification), ranked scoring (`time_saved × quality_preserved`), and convergence detection via independent rediscovery are deferred to beyond-MVP experimentation.

**Depends on:** 7, 9, 12

**Test:** Seed three sessions with the same pattern (read file → find bug → fix). `/consolidate` produces at least one candidate. Approve it. Skill file exists on disk with valid frontmatter. New session: `/skills` lists the new skill.

**Files:**
- `src/consolidate/consolidator.ts` (interface impl)
- `src/consolidate/extractor.ts` (problem→approach→outcome triples)
- `src/app/components/ConsolidateReview.tsx`
- `src/commands/consolidate.ts`
- `test/consolidate.test.ts`

---

## 14. Polish and End-to-End

**What it does.** Stabilization pass. Retry with exponential backoff + jitter on both providers. Circuit breaker on quota exhaustion. `/help` with full command listing, `/clear` to reset hot zone. Error surfaces in TUI (provider errors, tool failures, parse errors) as actionable messages, not stack traces. Session resume on startup. Default config for Anthropic + OpenAI tiers. Verify discovered context (instructions, skills, file refs) enters the union-find cache with source provenance and remains expandable by path.

**Depends on:** 11, 12, 13

**Test:** End-to-end in a real repo: (1) start session, (2) read files with `@path`, (3) propose and execute approved edits, (4) observe streaming + reviewer notes + tool confirmation, (5) kill and resume, (6) `/consolidate` on accumulated sessions, (7) approve a skill, (8) new session invokes the skill. Token count in status line stays bounded across 30 turns. `/help` lists all commands. Context provenance: `expand()` on a context cluster returns the original instruction file path.

**Files:**
- `src/providers/retry.ts`
- `src/filter/circuitBreaker.ts`
- `src/session/resume.ts`
- `src/session/bootstrap.ts`
- `src/config/defaults.ts`
- `src/app/components/ErrorDisplay.tsx`
- `test/e2e.test.ts`

---

## Dependency Graph

```
1  Scaffold
│
2  Slot Contracts
├───────────┬───────────┐
3  Providers 6  Perceive  7  Remember
│           │           │
4  Loop    8  Cache ────┘
│           │
5  Tools    │
│           │
9  Filter+Volley
│           │
10 TUI ─────┘
│
11 Wire Forward Pipe
│
12 Skills
│
13 Manual Consolidate
│
14 Polish + E2E
```

Items 6, 7 depend on 2. Item 8 depends on 3 (fast tier for compaction). Item 10 depends on 1, 4, 5, 9.

## MVP Coverage

| Requirement | Items |
|-------------|-------|
| Top-level agent loop | 4, 11 |
| Basic TUI | 1, 10 |
| Tool execution | 5 |
| Session persistence | 7 |
| One interface per role | 2, 6, 7, 8, 9, 13 |
| Manual Consolidate | 13 |
| Union-find compound cache | 8 |
| Three model tiers | 3 |

## Deferred

MCP, automatic Consolidate triggers, hooks, path-scoped rules, git worktree isolation, plan mode, recursive inner towers, automatic eviction (Filter @ Remember), subagents, plugin system, session branching, multiplayer forests. Full consolidation codec (I/P/B classification, keyframe extraction, independent rediscovery detection, `time_saved × quality_preserved` ranking).
