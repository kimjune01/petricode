# Aider UX Pain Points: Reported and Fixed

Research from closed GitHub issues on [Aider-AI/aider](https://github.com/Aider-AI/aider), filtered to issues with 5+ comments that represent real user pain. Ranked by severity and relevance to a TUI coding agent.

---

## 1. Multiline Paste Breaks the Input Loop

**Issue:** [#3117](https://github.com/Aider-AI/aider/issues/3117) (16 comments)

**Problem:** Pasting text containing blank lines (paragraph breaks) into the prompt caused aider to treat each paragraph as a separate submission. The first paragraph would be sent immediately, and subsequent paragraphs would queue as separate messages or be lost entirely.

**How it manifested:** Users pasting error logs, code snippets, or multi-paragraph instructions would have their input truncated at the first blank line. Aider would start responding to an incomplete prompt. Users had to use the `{` bracket workaround or Shift+Enter for every newline.

**Resolution:** Traced to a `prompt-toolkit` version bump (3.0.48 to 3.0.50) that changed paste behavior on Windows. On macOS it never reproduced. The issue was partially mitigated by documenting the `{` multiline syntax, but the underlying prompt-toolkit regression on Windows cmd.exe was never fully fixed in aider -- users had to downgrade prompt-toolkit or switch to Windows Terminal.

**Petricode relevance:** HIGH. Any TUI that accepts free-form text input must handle paste events containing newlines as atomic operations. Bracket paste mode detection is essential. This is a first-minute UX failure that makes users distrust the tool.

---

## 2. File Creation Silently Fails or Corrupts Filenames

**Issue:** [#2879](https://github.com/Aider-AI/aider/issues/2879) (14 comments), [#2233](https://github.com/Aider-AI/aider/issues/2233) (13 comments)

**Problem:** Two related bugs. (a) When the LLM proposed creating a new file, aider would create a file named after the *language* (e.g., a file called `typescript` or `php`) instead of the actual filename. (b) In a separate regression in v0.61.0, new file creation would appear to fail with a red error message even though the file was actually created correctly.

**How it manifested:** Users would ask for a new component and find a file called `typescript` in their project root instead of `components/Header.tsx`. Or they'd see scary red errors and think the operation failed, manually copy-pasting code. Multiple users reported this across Sonnet models specifically.

**Resolution:** (a) Fixed by improving the SEARCH/REPLACE block parser to correctly extract filenames from LLM output that included language identifiers. (b) The spurious error message was a display bug -- file creation was working, but the UI showed a failure. Fixed by correcting the error-checking logic.

**Petricode relevance:** HIGH. When the agent writes files, the user must trust that the filesystem operation matches what was proposed. Silent filename corruption is catastrophic for trust. Always confirm file operations visually and validate filenames before writing.

---

## 3. Agent Enters Infinite Loop, Burns Tokens

**Issue:** [#1841](https://github.com/Aider-AI/aider/issues/1841) (17 comments)

**Problem:** Aider would get stuck in a loop where it appeared to call the LLM for every word of its response, consuming tokens at an enormous rate. A simple answer would burn 300k+ tokens instead of 2-3k.

**How it manifested:** Users would ask a simple question and see tokens climbing rapidly while output dribbled out one word at a time. The only escape was Ctrl-C and restarting the session. Some users walked away and came back to massive bills.

**Resolution:** The bug was traced to interactions between architect mode and streaming. Fixed in subsequent releases, though the exact mechanism involved improper re-submission of partial responses.

**Petricode relevance:** CRITICAL. A runaway agent that burns money silently is the worst possible UX failure. Petricode needs hard token budget limits per turn, visible cost tracking, and automatic circuit-breakers that halt execution if token consumption exceeds expected bounds.

---

## 4. `<no response>` Displayed Instead of Actual Output

**Issue:** [#1697](https://github.com/Aider-AI/aider/issues/1697) (12 comments)

**Problem:** Aider would print `**<no response>**` as a header, followed by the actual valid response below it. Users thought the tool was broken because the prominent "no response" label obscured the real output.

**How it manifested:** Every response would start with a bold "no response" line, making users think the LLM failed. The actual code changes appeared below but users often missed them or lost confidence. Ctrl-C wouldn't interrupt it cleanly on Windows.

**Resolution:** Fixed by correcting how streaming responses were assembled and displayed. The `<no response>` text was being emitted before the full response arrived.

**Petricode relevance:** MEDIUM. Never show failure states that are immediately contradicted by success. Streaming UI must buffer enough to know whether a response is empty before declaring it so.

---

## 5. Watch Mode Crashes on Large Repos

**Issue:** [#2646](https://github.com/Aider-AI/aider/issues/2646) (16 comments)

**Problem:** The `--watch-files` feature didn't respect `.gitignore` or `.aiderignore` at the OS level, causing it to watch every file in the directory tree. In repos with `.direnv`, `.jj`, `node_modules`, or other large ignored directories, this exceeded OS file watcher limits and crashed aider on startup.

**How it manifested:** 10+ second startup delays followed by a crash. Users with monorepos or repos with many generated files couldn't use watch mode at all. The `--subtree-only` flag was also ignored.

**Resolution:** Added `--subtree-only` support to the watcher. However, the fundamental issue -- that OS-level file watchers can't be filtered before being registered -- remained. Users with very large repos still needed to raise OS limits.

**Petricode relevance:** HIGH. File watching is essential for a TUI agent but must be scoped carefully. Always respect ignore files, scope to relevant subtrees, and fail gracefully with a clear message rather than crashing when OS limits are hit.

---

## 6. Tab Completion Hangs the Terminal

**Issue:** [#995](https://github.com/Aider-AI/aider/issues/995) (14 comments)

**Problem:** Tab-completing a filename would wrap the result in backtick characters and then hang, requiring a session restart. Related to terminal capabilities (CPR -- Cursor Position Request) not being supported in some terminal emulators.

**How it manifested:** Users would press Tab to complete a filename, see backtick-wrapped text appear, and then the terminal would freeze. No input accepted, no way to recover without killing the process. Reported in Kitty, Gnome Terminal, and other popular terminals.

**Resolution:** Partially mitigated by `--no-pretty` flag and by setting `TERM=xterm-256color`. Root cause was prompt-toolkit's CPR feature not being universally supported. Later versions improved terminal capability detection.

**Petricode relevance:** HIGH. Tab completion is muscle memory for terminal users. If it hangs the session, users will never try it again. Test completion across terminals (iTerm2, Kitty, Alacritty, tmux, SSH sessions). Degrade gracefully when terminal capabilities are missing.

---

## 7. Architect Mode Appends Instead of Creating New Files

**Issue:** [#2258](https://github.com/Aider-AI/aider/issues/2258) (16 comments)

**Problem:** In architect mode (two-model setup), when the architect LLM instructed the editor LLM to create a new file, the editor would instead append the file's contents to an existing file that was already in the chat context.

**How it manifested:** Users would ask for a new component and find its entire source code appended to the bottom of an existing file. The new file was never created. Reproducible with Sonnet as architect and Haiku as editor.

**Resolution:** Fixed by improving how the editor model parsed architect instructions for file creation vs. file modification. The SEARCH/REPLACE format needed clearer signals for "create new file" operations.

**Petricode relevance:** HIGH. Multi-model architectures (planner + executor) need unambiguous file operation semantics. "Create file X" and "modify file Y" must be distinct, validated operations that the user can verify before execution.

---

## 8. Ignored Files Leak into Context

**Issue:** [#479](https://github.com/Aider-AI/aider/issues/479) (13 comments)

**Problem:** Files listed in `.aiderignore` were still being included in the LLM context and could be modified by the LLM. The ignore file was only partially respected -- it prevented explicit `/add` but not repo-map inclusion.

**How it manifested:** Users would ignore sensitive files (credentials, config) or large generated directories, but the LLM would still "see" them in the repo map and attempt to modify them. Modifications to ignored files would fail or corrupt project state.

**Resolution:** Fixed by making aider fully and vocally ignore files matching the aiderignore spec -- excluded from repo map, from context, and from any write operations.

**Petricode relevance:** CRITICAL. Ignore semantics must be absolute. If a file is ignored, it must not appear in any context sent to the LLM, must not be writable, and must not appear in file listings. Users put credentials and secrets in ignore files and assume they're invisible.

---

## 9. Repetitive Confirmation Prompts Erode Flow

**Issue:** [#3009](https://github.com/Aider-AI/aider/issues/3009) (12 comments), [#2329](https://github.com/Aider-AI/aider/issues/2329) (12 comments)

**Problem:** Users had to type "Yes" for every file write, every shell command suggestion, and every architect-to-editor handoff. The `--yes` flag was too coarse -- it accepted everything, including dangerous shell commands and URL scraping.

**How it manifested:** Users described architect mode as "painful" because of constant yes/no interruptions. Power users wanted a middle ground: auto-accept code changes but still confirm shell commands. The lack of granularity in approval drove users to competing tools.

**Resolution:** Partially addressed with `--yes-always` and per-operation flags, but the fundamental tension between safety and flow was never fully resolved. Aider's position was that shell commands should always require explicit approval.

**Petricode relevance:** CRITICAL. Confirmation fatigue is the #1 UX killer for agentic tools. Petricode needs tiered approval: auto-approve read-only operations and code writes within session-added files, prompt for new file creation and file deletion, always confirm shell commands. Let users configure the trust level per session.

---

## 10. Annoying Startup Messages That Can't Be Suppressed

**Issue:** [#3072](https://github.com/Aider-AI/aider/issues/3072) (11 comments)

**Problem:** On every startup, aider prompted users to add `.aider*` to `.gitignore`, even when the global gitignore already handled it. Users who deliberately used a global gitignore to keep project repos clean were nagged on every session.

**How it manifested:** Every single `aider` invocation in a repo without a local `.gitignore` entry would show the prompt, requiring dismissal. For users working across many repos, this was a constant annoyance.

**Resolution:** Fixed by checking the global gitignore (`core.excludesfile`) before prompting. If `.aider*` was already globally ignored, the prompt was suppressed.

**Petricode relevance:** MEDIUM. Startup messages must be context-aware. Never nag about something the user has already handled. Check all relevant config locations before showing warnings. Provide `--quiet` or similar to suppress non-critical messages.

---

## 11. LLM Asks to Add Files Already in Context

**Issue:** [#315](https://github.com/Aider-AI/aider/issues/315) (11 comments)

**Problem:** The LLM would repeatedly ask the user to "add file X to the chat" even though the file was already added and in context. This was a repo-map bug where the LLM couldn't see which files were already available.

**How it manifested:** Users would add files, start working, and then the LLM would say "I need access to Wallet.js" -- a file that was already in the chat. Users would re-add it, wasting a turn. Repeated across sessions.

**Resolution:** Fixed by correcting the repo-map implementation so the LLM's system prompt accurately reflected which files were already in the read-write context.

**Petricode relevance:** HIGH. The agent must have an accurate model of its own context. If it asks for something it already has, users lose trust immediately. The system prompt and context tracking must be consistent and verifiable.

---

## 12. Streaming Response Corruption (metadata: dict -> meta dict)

**Issue:** [#3410](https://github.com/Aider-AI/aider/issues/3410) (9 comments)

**Problem:** A regression in v0.74.2 caused streaming responses to drop characters. Specifically, `metadata: dict` in Python source code would be received as `meta dict`, breaking all code that used it. The corruption happened before the LLM response reached aider's parser.

**How it manifested:** Users would ask for a simple change and find that aider had silently corrupted type annotations, variable names, and other tokens in their source code. The internal linter (flake8) would catch it, but the damage was done. Users described aider as "useless" during this period.

**Resolution:** Traced to a litellm dependency bug in SSE (Server-Sent Events) handling. The litellm networking code didn't properly reassemble chunked streaming data. Fixed by pinning or updating litellm.

**Petricode relevance:** CRITICAL. Silent code corruption is the ultimate trust destroyer. Every streamed response must be integrity-checked before being applied to files. Consider checksumming file contents before and after edits, and showing diffs that the user can verify.

---

## 13. Incompatible Model Settings Silently Break Everything

**Issue:** [#3177](https://github.com/Aider-AI/aider/issues/3177) (12 comments)

**Problem:** Setting `reasoning-effort: high` in the config file worked for o1/R1 models but caused Anthropic models to reject every request with an opaque `extra_body: Extra inputs are not permitted` error. Users didn't connect their config setting to the error.

**How it manifested:** Users would switch from an o1 model to Sonnet and suddenly every request would fail. The error message didn't mention `reasoning-effort` as the cause. Users thought Anthropic's API was broken.

**Resolution:** Fixed by making aider model-aware about which settings apply to which models. Incompatible settings are now warned about and ignored rather than passed through to the API.

**Petricode relevance:** HIGH. When supporting multiple LLM providers, settings must be validated per-model. Never pass provider-specific parameters to a provider that doesn't support them. Show clear warnings when a config value is being ignored and why.

---

## 14. Application.exit() Crash in Watch Mode

**Issue:** [#2716](https://github.com/Aider-AI/aider/issues/2716) (16 comments)

**Problem:** When using `--watch-files`, aider would crash with `Application is not running. Application.exit() failed` threading errors. The file watcher thread tried to interact with the prompt-toolkit application after it had been shut down.

**How it manifested:** The error appeared after every file change detection. Aider would still apply changes but users had to press Enter manually to continue, and the error stack traces polluted the terminal output.

**Resolution:** Fixed by properly synchronizing the file watcher thread with the prompt-toolkit application lifecycle.

**Petricode relevance:** HIGH. Background threads (file watchers, LSP, subprocess monitors) must never touch the TUI after it has been torn down. Use proper cancellation tokens and lifecycle management for all async operations.

---

## 15. Custom Timeout Not Configurable

**Issue:** [#276](https://github.com/Aider-AI/aider/issues/276) (28 comments)

**Problem:** The default 10-minute LLM request timeout was hardcoded and couldn't be changed. Users with slow local models (Ollama, local QwQ) would hit timeouts on long responses, especially reasoning models that could generate 20k+ tokens.

**How it manifested:** After 10 minutes of processing, the request would be killed and all progress lost. Users running local models at 13 tokens/sec with 20k token responses needed 25+ minutes. No way to configure this.

**Resolution:** Added `--timeout` flag allowing users to set custom request timeouts.

**Petricode relevance:** MEDIUM. Always make timeouts configurable, especially when supporting local models with wildly varying speeds. Show elapsed time during long requests so users know the tool hasn't frozen.

---

## Summary: Top Lessons for Petricode

| Priority | Lesson | Source Issues |
|----------|--------|---------------|
| P0 | Token budget limits and circuit-breakers for runaway agents | #1841 |
| P0 | Silent code corruption must be impossible -- integrity-check all edits | #3410 |
| P0 | Ignore semantics must be absolute -- ignored files never reach the LLM | #479 |
| P0 | Confirmation UX needs granularity, not a binary yes/no | #3009, #2329 |
| P1 | Multiline paste must work atomically (bracket paste mode) | #3117 |
| P1 | File creation must be unambiguous and verified | #2879, #2233, #2258 |
| P1 | Tab completion must never hang the terminal | #995 |
| P1 | Background threads must respect TUI lifecycle | #2716 |
| P1 | Model-specific settings must be validated per-provider | #3177 |
| P2 | File watching must respect ignore files and fail gracefully | #2646 |
| P2 | Context tracking must be accurate -- never ask for what you have | #315 |
| P2 | Startup noise must be context-aware and suppressible | #3072 |
| P2 | Timeouts must be configurable | #276 |
