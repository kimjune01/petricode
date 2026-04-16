# Aider: Most Requested Features (by Reaction Count)

Researched 2026-04-15 from [Aider-AI/aider](https://github.com/Aider-AI/aider) GitHub issues.
Sorted by total reactions (thumbs-up + heart + rocket + hooray + eyes).

---

## Rank 1 -- MCP (Model Context Protocol) Support
**237 reactions** | 22 comments | OPEN
[#3314](https://github.com/Aider-AI/aider/issues/3314), [#2525](https://github.com/Aider-AI/aider/issues/2525) (duplicate, 139 reactions), [#4506](https://github.com/Aider-AI/aider/issues/4506) (26 reactions)

Users want aider to act as both an MCP client (consuming tool servers) and an MCP server (so Claude Desktop, Cursor, etc. can drive aider). AiderDesk already ships this; users want it in the CLI. Combined demand across three issues is the highest in the repo.

**Petricode relevance:** MCP client support is table-stakes for any new coding TUI. MCP server mode would let petricode be embedded inside other editors.

---

## Rank 2 -- GitHub Copilot as Model Provider
**119 reactions** | 212 comments | OPEN
[#2227](https://github.com/Aider-AI/aider/issues/2227)

Users with Copilot subscriptions want to route aider through GitHub's Copilot API to avoid separate API billing. Extremely active thread (212 comments).

**Petricode relevance:** Low priority for initial launch, but shows users care deeply about free/bundled model access. Provider flexibility matters.

---

## Rank 3 -- Config File Location (XDG/Modern Standards)
**78 reactions** | 14 comments | OPEN
[#216](https://github.com/Aider-AI/aider/issues/216)

Aider scatters dotfiles in `$HOME`. Users want XDG-compliant config paths (`~/.config/aider/`). Ongoing since 2023.

**Petricode relevance:** High. Get this right from day one. Use XDG on Linux, `~/.config` on macOS, `%APPDATA%` on Windows.

---

## Rank 4 -- Add Claude 4 Models
**62 reactions** | 12 comments | OPEN
[#4063](https://github.com/Aider-AI/aider/issues/4063)

Users want rapid model support when new releases drop. Shows friction in aider's model registration workflow.

**Petricode relevance:** Design model config so adding new models is a user-side YAML/JSON change, not a code release.

---

## Rank 5 -- Emacs Integration
**61 reactions** | 0 comments | OPEN
[#1913](https://github.com/Aider-AI/aider/issues/1913)

Request for first-class Emacs integration. Community has built `aider.el` and `aidermacs` independently.

**Petricode relevance:** A TUI with a clean stdio protocol can be embedded in Emacs trivially. Design for headless/pipe mode.

---

## Rank 6 -- Inspiration from Claude Code (Agent Features)
**58 reactions** | 48 comments | OPEN
[#3362](https://github.com/Aider-AI/aider/issues/3362)

Meta-issue requesting Claude Code-style capabilities: deeper thinking, git operations (rebase, merge conflict resolution), autonomous multi-step workflows. Opened by the author of aidermacs/emigo.

**Petricode relevance:** Direct competitive signal. Users want: (1) extended thinking, (2) git-native operations, (3) autonomous task execution. Core design goals.

---

## Rank 7 -- VSCode Extension
**56 reactions** | 36 comments | OPEN
[#68](https://github.com/Aider-AI/aider/issues/68)

Oldest open feature request (June 2023). Users want IDE-embedded aider similar to Copilot Chat.

**Petricode relevance:** Low for TUI, but reinforces that editor integration is a universal demand. A clean protocol layer enables this later.

---

## Rank 8 -- Tool/Function Call Integration
**42 reactions** | 4 comments | OPEN
[#2672](https://github.com/Aider-AI/aider/issues/2672)

Users want aider to leverage LLM tool-use capabilities for build/test/deploy/GitOps workflows rather than just text editing.

**Petricode relevance:** High. Native tool-use (shell execution, test running, file operations) is the core agent loop. Aider's text-only approach is its biggest architectural limitation.

---

## Rank 9 -- Supervised Mode (Confirm Each Change)
**41 reactions** | 39 comments | OPEN
[#649](https://github.com/Aider-AI/aider/issues/649)

Users want a mode where each atomic change is shown as a diff and requires explicit approval before being applied.

**Petricode relevance:** Critical UX feature. Design a permission/approval model with granularity: auto-approve reads, prompt for writes, require confirmation for destructive operations.

---

## Rank 10 -- PyCharm / JetBrains Support
**40 reactions** | 13 comments | OPEN
[#483](https://github.com/Aider-AI/aider/issues/483)

JetBrains IDE plugin request. Similar demand pattern to VSCode.

**Petricode relevance:** Same as VSCode -- clean protocol enables future IDE integrations.

---

## Rank 11 -- Cursor Rules / Convention Files
**37 reactions** | 5 comments | OPEN
[#3303](https://github.com/Aider-AI/aider/issues/3303)

Users want per-project convention files (like Cursor's `.cursorrules`) that automatically inject style/framework rules into the system prompt. Suggests a hooks architecture with event triggers (on-edit, on-file-add).

**Petricode relevance:** High. Support `.claude/CLAUDE.md`, `.cursorrules`, `AGENTS.md`, and a native convention format. Convention files are a competitive differentiator.

---

## Rank 12 -- Uninstall Documentation
**33 reactions** | 9 comments | OPEN
[#3030](https://github.com/Aider-AI/aider/issues/3030)

Users can't figure out how to cleanly uninstall aider. Signals messy installation story.

**Petricode relevance:** Ship with a clean install/uninstall story from day one.

---

## Rank 13 -- Documentation/RAG for Large Projects
**28 reactions** | 5 comments | OPEN
[#1005](https://github.com/Aider-AI/aider/issues/1005)

Users working on large codebases find aider hallucinates APIs because it lacks documentation context. Want RAG or doc-ingestion support.

**Petricode relevance:** High. Context management for large codebases is the hard problem. Consider documentation indexing, semantic search, and incremental context loading.

---

## Rank 14 -- Support for Other/Local LLMs
**28 reactions** | 133 comments | CLOSED (implemented)
[#172](https://github.com/Aider-AI/aider/issues/172)

Originally aider was GPT-only. This was the catch-all for multi-model support. Now resolved -- aider supports many providers via litellm.

**Petricode relevance:** Already table-stakes. Use litellm or similar abstraction from the start.

---

## Rank 15 -- User-Defined Location for Cache Files
**27 reactions** | 4 comments | OPEN
[#2325](https://github.com/Aider-AI/aider/issues/2325)

Users want `.aider.tags.cache.v3` relocated. Part of the broader "aider pollutes my repo root" complaint.

**Petricode relevance:** Keep all tool artifacts in a single `.petricode/` directory. Never scatter files in the repo root.

---

## Rank 16 -- Move .aider Files into .aider Directory
**25 reactions** | 3 comments | OPEN
[#2860](https://github.com/Aider-AI/aider/issues/2860)

Same theme as #2325 and #216. Users want a single `.aider/` directory instead of multiple dotfiles.

**Petricode relevance:** Same as above. Single directory, clean gitignore story.

---

## Rank 17 -- Only Commit Staged Files
**24 reactions** | 10 comments | OPEN
[#879](https://github.com/Aider-AI/aider/issues/879)

Aider's `/commit` stages and commits everything. Users who stage selectively find this breaks their workflow. Also misses new files.

**Petricode relevance:** High. Respect the user's git staging area. Never auto-stage files the user didn't ask to commit.

---

## Rank 18 -- Dependencies in Repo Map
**24 reactions** | 13 comments | OPEN
[#3603](https://github.com/Aider-AI/aider/issues/3603)

Aider excludes submodules and vendored deps from its repo map, causing hallucinated APIs. Users want dependency symbols indexed.

**Petricode relevance:** Repo map / code intelligence should include dependency type signatures. Consider indexing `node_modules/.d.ts`, vendored code, and submodules at the symbol level.

---

## Rank 19 -- Gemini CLI OAuth Provider
**24 reactions** | 2 comments | OPEN
[#4283](https://github.com/Aider-AI/aider/issues/4283)

Users want to use Gemini via Google OAuth (free tier) rather than paid API keys.

**Petricode relevance:** Low priority but signals demand for zero-cost model access paths.

---

## Rank 20 -- Auto-Add Suggested Files
**21 reactions** | 9 comments | OPEN
[#2632](https://github.com/Aider-AI/aider/issues/2632)

When aider suggests adding files to context, users want a one-command way to accept all suggestions rather than manually `/add`-ing each.

**Petricode relevance:** High UX signal. Context management should be low-friction. Consider auto-adding with user confirmation, or a single "accept all suggestions" shortcut.

---

## Notable Mentions (just outside top 20)

| Reactions | Issue | Description | Status |
|-----------|-------|-------------|--------|
| 22 | [#1341](https://github.com/Aider-AI/aider/issues/1341) | Voice mode shouldn't require OpenAI key | OPEN |
| 21 | [#3350](https://github.com/Aider-AI/aider/issues/3350) | Bash-like tab autocomplete for `/add` | OPEN |
| 18 | [#1086](https://github.com/Aider-AI/aider/issues/1086) | Claude prompt caching | CLOSED (implemented) |
| 18 | [#544](https://github.com/Aider-AI/aider/issues/544) | Add to nixpkgs | OPEN |
| 18 | [#69](https://github.com/Aider-AI/aider/issues/69) | Learn from documentation (RAG) | CLOSED (partially) |
| 15 | [#2754](https://github.com/Aider-AI/aider/issues/2754) | Web search integration | OPEN |
| 13 | [#3153](https://github.com/Aider-AI/aider/issues/3153) | Discuss with architect before accepting | OPEN |
| 13 | [#723](https://github.com/Aider-AI/aider/issues/723) | Review mode with checklist | OPEN |
| 11 | [#74](https://github.com/Aider-AI/aider/issues/74) | Automatic context window management | CLOSED (partially) |
| 11 | [#1814](https://github.com/Aider-AI/aider/issues/1814) | Plugin architecture | OPEN |
| 11 | [#2075](https://github.com/Aider-AI/aider/issues/2075) | Custom tool support | OPEN |
| 10 | [#249](https://github.com/Aider-AI/aider/issues/249) | Custom instructions | CLOSED (implemented via conventions) |

---

## Synthesis: What Users Want Most

Grouped by theme, the demand signal tells a clear story:

### 1. Extensibility & Tool Ecosystem (MCP, tools, plugins)
Issues: #3314, #2525, #4506, #2672, #2075, #1814, #99
Combined reactions: ~300+
Users want aider to be a platform, not a monolith. MCP support is the single highest-demand feature.

### 2. IDE & Editor Integration
Issues: #68, #483, #650, #1913
Combined reactions: ~160+
Users want aider embedded in their editor. A clean protocol/API layer is the enabler.

### 3. Context & File Management
Issues: #1005, #3603, #2632, #74, #69, #349
Combined reactions: ~120+
Large-project usability is the biggest unsolved problem. Users want: auto-context, dependency awareness, RAG, and smarter file suggestions.

### 4. File/Config Hygiene
Issues: #216, #2325, #2860, #3030
Combined reactions: ~160+
Aider's file sprawl is a persistent irritant. XDG compliance, single config directory, clean install/uninstall.

### 5. User Control & Approval Workflows
Issues: #649, #879, #3153, #723, #3085
Combined reactions: ~110+
Users want granular control over what changes get applied and committed. Supervised mode, staged-only commits, architect review loops.

### 6. Convention/Rules Files
Issues: #3303, #249, #960
Combined reactions: ~50+
Per-project coding conventions that auto-inject into prompts. Cross-compatible with Cursor, Claude Code, etc.

### 7. Model Provider Flexibility
Issues: #2227, #4063, #4283, #172
Combined reactions: ~230+
Users want to bring whatever model/provider they have. Quick support for new models. Free-tier access paths.
