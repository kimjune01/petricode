# H3: Terminal Rendering Issues in Aider

Research into aider's GitHub issues for terminal UX problems -- rendering bugs,
keybinding conflicts, color/theme issues, and platform-specific breakage.

Source: [Aider-AI/aider](https://github.com/Aider-AI/aider) issues, searched
2026-04-15.

---

## Rendering Bugs

### 1. Rich/Pygments O(n^2) CPU spike on large streaming responses
**Issue:** [#930](https://github.com/Aider-AI/aider/issues/930) (14 comments)

Rich's `Syntax` rendering re-parses the entire markdown buffer on every
streaming token. With long LLM responses, this becomes quadratic -- py-spy
showed 100% CPU in `rich/text.py divide()`, `rich/segment.py`, and
`pygments/lexer.py get_tokens_unprocessed()`. Users reported 1 token/sec
from Claude Sonnet on moderate codebases.

**Fix trajectory:** Paul initially said "use `--no-pretty`" which also killed
input history (arrow keys emitted raw escape codes). Community pushed back hard.
He then split the flag into `--no-pretty` (disables markdown rendering only) and
`--no-fancy-input` (disables prompt_toolkit input). This let users keep
keybindings while disabling the expensive rendering path.

**Lesson for petricode:** Never couple rendering mode to input mode. If you have
a "plain mode" escape hatch, make it granular: output rendering and input
handling are independent concerns. Also: streaming markdown rendering must be
incremental, not re-render-from-scratch on each token.

### 2. Pygments Lua lexer causes 100% CPU hang
**Issue:** [#3196](https://github.com/Aider-AI/aider/issues/3196) (27 comments, still open)

Pygments 2.19.1 introduced a regex regression in the Lua lexer that causes
catastrophic backtracking on space-indented Lua code. The process hangs at 100%
CPU and doesn't respond to Ctrl-C. This affects not just pretty output but also
`--no-pretty` mode because the autocomplete/input system also runs Pygments for
syntax-aware file completion.

Root cause traced upstream to Pygments ([pygments/pygments#2839](https://github.com/pygments/pygments/issues/2839)).
Workaround: downgrade to Pygments 2.18, or use `--no-fancy-input`.

**Lesson for petricode:** If you depend on a syntax highlighting library for
both output rendering AND input completion, a single upstream regression can
freeze your entire UI. Pin or vendor critical parsing dependencies. Add a timeout
or watchdog around any lexer call -- if it takes >100ms, bail out and show
unhighlighted text.

### 3. VSCode terminal duplicates streamed output
**Issue:** [#124](https://github.com/Aider-AI/aider/issues/124) (7 comments),
[#457](https://github.com/Aider-AI/aider/issues/457) (3 comments)

Rich's live-updating markdown display uses cursor repositioning (ANSI CSI
sequences) to redraw rendered blocks as streaming tokens arrive. VSCode's
terminal emulator doesn't fully support these sequences, causing the same
block to render multiple times, cluttering the screen.

**Fix:** Aider auto-detects VSCode via the `TERM_PROGRAM` env var and disables
pretty output. Users who want it anyway must run aider in a real terminal
alongside VSCode.

**Lesson for petricode:** Detect degraded terminal environments (`TERM=dumb`,
`TERM_PROGRAM=vscode`, running inside Emacs vterm) and gracefully degrade
output. Never assume ANSI cursor repositioning works everywhere. The
`--no-pretty` workaround makes output "hard to read" per users -- so
graceful degradation should still include basic color, just no cursor
repositioning.

### 4. Scrollback corruption during streaming
**Issue:** [#457](https://github.com/Aider-AI/aider/issues/457)

Scrolling or resizing the terminal while Rich is streaming causes output to
overwrite itself repeatedly. This is inherent to Rich's approach of using
cursor movement to update a "live" display region.

**Lesson for petricode:** If using live/animated terminal output, use the
alternate screen buffer for the animated portion, or accept that scrollback
interaction during streaming will be broken. Alternatively, adopt a
line-by-line append model instead of in-place rewriting.

---

## Keybinding Conflicts

### 5. Ctrl+Z doesn't suspend (job control)
**Issues:** [#701](https://github.com/Aider-AI/aider/issues/701),
[#2528](https://github.com/Aider-AI/aider/issues/2528)

prompt_toolkit intercepts Ctrl+Z by default, preventing the standard Unix
SIGTSTP signal from reaching the process. Users expect Ctrl+Z to suspend any
terminal program. This was eventually fixed by adding explicit Ctrl+Z handling
in the prompt_toolkit key bindings that sends SIGTSTP to the process group.

**Lesson for petricode:** If using a TUI input library that captures raw
keypresses, explicitly handle Ctrl+Z to suspend the process. Don't swallow
standard Unix signals. Test all standard terminal control sequences: Ctrl+C
(interrupt), Ctrl+Z (suspend), Ctrl+D (EOF), Ctrl+L (clear).

### 6. Readline kill ring doesn't persist across prompts
**Issue:** [#1473](https://github.com/Aider-AI/aider/issues/1473)

Ctrl+A, Ctrl+K, Ctrl+Y (readline kill/yank) worked within a single prompt but
the kill ring was reset between prompts. So you couldn't yank text you killed
in a previous command.

**Fix:** Share the clipboard/kill ring state across prompt sessions.

**Lesson for petricode:** If using prompt_toolkit or similar, reuse the
PromptSession or at least persist the clipboard between invocations.

### 7. Vi mode / .inputrc not respected
**Issue:** [#3644](https://github.com/Aider-AI/aider/issues/3644),
[#823](https://github.com/Aider-AI/aider/issues/823)

Users with `set -o vi` in their shell or custom `.inputrc` bindings expect the
same behavior in aider. prompt_toolkit doesn't read `.inputrc` -- it has its
own vi mode that must be explicitly enabled. Aider added a `--vim` flag but
doesn't auto-detect the user's shell setting.

**Lesson for petricode:** Either read the user's `.inputrc` / shell editing
mode preference and mirror it, or clearly document that the input system is
independent of the shell. Auto-detecting `set -o vi` from the parent shell
environment would be ideal.

### 8. Multiline input: no Ctrl+Enter, unclear keybindings
**Issue:** [#105](https://github.com/Aider-AI/aider/issues/105) (8 comments)

Users wanted Ctrl+Enter for multiline input. prompt_toolkit can't express
Ctrl+Enter as a key binding (terminal limitation). Aider went through
several iterations: `{` / `}` delimiters, then Meta+Enter (Esc then Enter),
then eventually a configurable multiline mode.

**Lesson for petricode:** Ctrl+Enter is not reliably detectable in terminals
(it depends on the terminal emulator sending a distinct escape sequence).
Design multiline input around Alt/Meta+Enter (widely supported), or use a
toggle mode. Document the keybinding prominently.

### 9. Keybinding to clear input undiscoverable
**Issue:** [#3938](https://github.com/Aider-AI/aider/issues/3938)

Users typed long messages then wanted to abort and switch to a command. Ctrl+C
clears the input (prompt_toolkit behavior) but users didn't know this -- they
expected Ctrl+C to only interrupt running tasks. Ctrl+U (readline: kill line
backward) also works but was undocumented.

**Lesson for petricode:** Document all keybindings. Make Escape an explicit
"clear input" binding. Show a hint on first use.

---

## Color / Theme Issues

### 10. `dark-mode: true` overrides all custom color settings
**Issue:** [#3163](https://github.com/Aider-AI/aider/issues/3163) (9 comments)

When `dark-mode: true` was set in the config, custom `user-input-color`,
`assistant-output-color`, etc. were silently ignored. The dark-mode flag set
its own palette and applied it last, clobbering user overrides. Similarly,
`--code-theme` was overridden by dark/light mode (Monokai vs Solarized
Light hardcoded).

**Lesson for petricode:** Theme presets (dark/light) should set defaults that
custom color settings override, not the other way around. Precedence order:
user-specified colors > theme preset > auto-detected defaults.

### 11. YAML `#` in hex color values parsed as comments
**Issue:** [#3163](https://github.com/Aider-AI/aider/issues/3163)

Users wrote `user-input-color: #c9d2a3` in YAML config. The `#` was
interpreted as a YAML comment, silently truncating the value. Fix: quote
the value (`'#c9d2a3'`).

**Lesson for petricode:** If config uses YAML/TOML and accepts hex colors,
either validate color values at parse time and emit a clear error, or
accept colors without the `#` prefix and normalize internally.

### 12. Missing `#` prefix crashes with ColorParseError
**Issues:** [#2861](https://github.com/Aider-AI/aider/issues/2861),
[#2922](https://github.com/Aider-AI/aider/issues/2922)

Passing `--user-input-color bcbdbf` (no `#`) causes an uncaught exception
from Rich's `Color.parse()` or prompt_toolkit's `parse_color()`. The error
message is unhelpful and crashes the program.

**Lesson for petricode:** Validate all user-provided color values at startup.
If a 6-char hex string is given without `#`, prepend it. Wrap color parsing
in try/except and fall back to defaults with a warning, never crash.

### 13. Horizontal separator tied to input color, not independently configurable
**Issue:** [#2466](https://github.com/Aider-AI/aider/issues/2466) (11 comments)

The green horizontal rule between messages uses `--user-input-color`, which
isn't obvious. Users whose terminal already uses green for pane borders
couldn't distinguish them. Paul confirmed the coupling but there's no
independent `--separator-color` setting.

**Lesson for petricode:** UI chrome (separators, borders, labels) should have
independent color settings or at least documented derivation from the base
palette.

---

## Platform-Specific Problems

### 14. prompt_toolkit crashes on Windows without console (NoConsoleScreenBufferError)
**Issue:** [#1244](https://github.com/Aider-AI/aider/issues/1244) (9 comments)

When aider is invoked via `subprocess.run()` on Windows (no attached console),
prompt_toolkit's `Win32Output` tries to get the console screen buffer and
crashes with `NoConsoleScreenBufferError`. This blocks all scripting/automation
use cases on Windows.

**Fix:** Use `--yes` to skip confirmations, or use aider's scripting API
instead of subprocess invocation.

**Lesson for petricode:** Detect headless/non-interactive invocation
(`sys.stdin.isatty()`, `os.isatty()`) and skip all interactive input. On
Windows specifically, catch `NoConsoleScreenBufferError` and fall back to
plain I/O.

### 15. TERM=dumb (Emacs, SSH pipes) breaks watch-files
**Issue:** [#2716](https://github.com/Aider-AI/aider/issues/2716) (16 comments)

With `TERM=dumb` (common in Emacs vterm, eshell, and some SSH configurations),
prompt_toolkit's Application can't run properly. The `--watch-files` feature
tried to call `Application.exit()` on a prompt that never started, crashing
with "Application is not running."

**Fix:** Aider now detects `TERM=dumb` and disables fancy input and
watch-files. The Emacs community was unhappy because watch-files is the
killer feature for editor integration, but Paul explained that watch-files
requires the ability to interrupt the input prompt, which needs a capable
terminal.

**Lesson for petricode:** `TERM=dumb` must be a first-class supported
configuration. Design the architecture so that file-watching and prompt
interruption don't require a fully capable terminal emulator. Use signals or
IPC instead of prompt_toolkit's `Application.exit()` for cross-thread
communication.

### 16. PowerShell 7 vs PowerShell 5.1 shell detection on Windows
**Issue:** [#2898](https://github.com/Aider-AI/aider/issues/2898) (8 comments)

Aider's `/run` command invoked the wrong PowerShell version on Windows,
losing PATH and aliases. Windows machines often have both PowerShell 5.1
(`powershell.exe`) and PowerShell 7 (`pwsh.exe`) with different profiles.

**Lesson for petricode:** On Windows, detect and use the same shell the user
launched from. Don't hardcode `cmd.exe` or assume a specific PowerShell
version.

---

## Summary of Lessons for Petricode

| Category | Key Takeaway |
|----------|-------------|
| **Rendering** | Streaming markdown must be incremental, not O(n^2). Never re-render the full buffer on each token. |
| **Rendering** | Pin or watchdog syntax highlighting dependencies. A single upstream regex regression can freeze the entire UI. |
| **Rendering** | Detect degraded terminals and gracefully degrade -- but keep basic color. Don't couple output rendering to input handling. |
| **Keybindings** | Honor Ctrl+Z (suspend), Ctrl+C (interrupt). Don't swallow standard Unix signals. |
| **Keybindings** | Persist kill ring / clipboard across prompts. Detect user's vi/emacs preference. |
| **Keybindings** | Ctrl+Enter is unreliable in terminals. Use Alt+Enter for multiline. |
| **Color** | Theme presets should be defaults, not overrides. User-specified colors always win. |
| **Color** | Validate color input at startup. Normalize `#` prefix. Never crash on bad color values. |
| **Platform** | Detect headless mode and disable interactive features. Catch Windows console errors. |
| **Platform** | `TERM=dumb` is a real deployment target (Emacs, SSH). Design file-watching to work without prompt_toolkit. |
| **Architecture** | `--no-pretty` was aider's universal escape hatch but it was too coarse. Granular feature flags (`--no-pretty`, `--no-fancy-input`, `--no-stream`) let users disable exactly what's broken. |
