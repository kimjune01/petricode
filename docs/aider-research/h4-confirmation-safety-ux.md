# H4: Confirmation and Safety UX -- Lessons from Aider's GitHub Issues

Research date: 2026-04-15. Source: Aider-AI/aider GitHub issues, sorted by comment count and relevance.

---

## 1. Auto-commit behavior

**What users want:** The community is deeply split, but the split follows a clear pattern based on workflow.

**Always (default today):** Aider auto-commits every change. Paul Gauthier's position is that git *is* the safety net -- `/undo` reverts the last commit, and the commit history gives you a full audit trail. The argument: undo-via-git is strictly more powerful than discard-before-apply, because committed changes are recoverable while discarded changes are lost.

**Never (`--no-auto-commits`):** A large cohort of power users strongly prefer this. They want to review diffs in their IDE, stage selectively, and write their own commit messages. Issue [#879](https://github.com/Aider-AI/aider/issues/879) (10 comments) shows users who want `/commit` to respect already-staged files, not `git add -a` everything. Users work around this with `git stash push --keep-index` before aider commits.

**Ask:** The most-requested and most-contentious behavior. Issue [#649](https://github.com/Aider-AI/aider/issues/649) (39 comments, 28+ thumbs-up on the key comment) is aider's most emotionally charged UX issue. Users want to preview diffs and approve/reject *before* changes hit disk. Paul's response: use `--show-diffs` and `/undo`. The community's counter: undo-after-the-fact has higher cognitive load than approve-before-the-fact, especially when the LLM makes multiple changes and only some are wrong.

**The Claude Code comparison keeps surfacing.** Multiple commenters in #649 (from March 2025 onward) explicitly cite Claude Code's hunk-by-hunk approval as the reason they switched away from aider. Key quote from @tskj: "With Claude Code it feels like pair programming, I watch as it writes small hunks at a time and give feedback. With Aider it feels like code review, which is much more tedious." Another from @clinta: "the workflow where claude code asks to confirm each change before saving it, and at any point I can hit escape and provide clarification... is very natural."

**The Aidermacs data point is telling.** The most popular Emacs frontend for aider *disables auto-commit by default* and adds an ediff-based review step. The Aidermacs author called aider's auto-commit "very intrusive."

### Lesson for petricode

Three modes are necessary, not one: always-commit, never-commit, and ask-per-hunk. The default should be ask-per-hunk (Claude Code's model) -- it is what users coming from modern AI tools expect. The "undo is sufficient" argument underestimates cognitive load in multi-file changes. Provide all three and let the user choose, but default to the interactive model.

---

## 2. Command execution safety

**The shell command problem is aider's most confusing safety decision.** Aider can suggest shell commands extracted from the LLM's markdown response. Three separate issues reveal the design tension:

- [#1173](https://github.com/Aider-AI/aider/issues/1173) (10 comments): Users found shell command suggestions annoying -- the LLM would suggest `rm` commands, `git commit` (duplicating aider's own commits), and commands with placeholder paths. Paul added `--no-suggest-shell-commands`.

- [#3903](https://github.com/Aider-AI/aider/issues/3903) (10 comments): `--yes-always` *silently skips* shell commands rather than auto-running them. Users expected it to auto-run everything. The maintainer's explicit position: shell commands require `explicit_yes_required=True` even when `--yes-always` is set. This is intentional safety -- but the UX is confusing because the flag's name suggests "yes to everything."

- [#3830](https://github.com/Aider-AI/aider/issues/3830) (13 comments): Users wanting full YOLO mode find that even `--yes-always` doesn't get them there. A fork (agent-aider) was created to flip `explicit_yes_required` to false. But even that fork's author found aider's architecture insufficient for true agentic use -- it gets stuck in reflection loops.

**The proposed solution from #3903 is elegant:** separate flags for file operations vs. shell commands. @bobwhitelock proposed `--prompt-for-run` / `--no-prompt-for-run` as orthogonal to `--yes-always`, giving three states: (1) yes-always but skip shell, (2) yes-always but prompt for shell, (3) yes-always including shell. Paul hasn't responded.

### Lesson for petricode

Shell command execution needs its own permission tier, separate from file modifications. Three levels: (a) never run commands, (b) prompt before each command, (c) auto-run. Default should be (b). The `--yes-always` naming trap teaches us: name flags precisely. "Auto-approve file edits" and "auto-run shell commands" should be independent, clearly-named settings. A single `--yes` flag that means different things for different operations breeds confusion.

---

## 3. File modification permissions

**Aider's model is simple: files are either "in the chat" (editable) or not.** There is no per-file permission, no read-only-but-editable distinction at the approval layer. The LLM can edit any file in the chat without per-file confirmation.

**The critical bug in #4314** (10 comments) reveals a deeper problem: when the LLM both edits files AND requests new files to be added in the same response, aider *discards all the edits* if the user agrees to add the new files. The LLM then proceeds as if its edits were applied. Users call this "absolutely renders the entire product useless." The workaround: always say "no" to file-add requests, then manually add files in the next step.

**New file creation also bypasses meaningful consent.** Issue #932 describes a first-time user whose staged changes were committed by aider and then aider created and committed new changes the user never asked for -- all from a `/add` command that was misunderstood. The user abandoned aider.

**The aiderignore mechanism** ([#1676](https://github.com/Aider-AI/aider/issues/1676), 16 comments) is aider's file-level access control: a `.aiderignore` file (gitignore syntax) that prevents files from being added to the chat or appearing in the repo map. This is project-level, not per-session.

### Lesson for petricode

File permissions should operate at three granularities: (1) project-level ignore/allow (aiderignore equivalent), (2) session-level read-only vs editable, and (3) per-edit confirmation for the interactive mode. The #4314 bug teaches a structural lesson: never discard work the LLM has already done just because the user answered a file-add prompt. Apply edits first, then ask about adding files. Treat file creation as a separate permission from file modification -- new files appearing out of nowhere is alarming to users.

---

## 4. Undo mechanisms

**`/undo` is aider's primary safety mechanism**, and it works *only* with auto-commits enabled. Issue [#1018](https://github.com/Aider-AI/aider/issues/1018) (10 comments) captures the fundamental problem: users who disable auto-commits (which many power users do) lose `/undo` entirely. There is no way to revert changes within a session without git.

**What users actually want from undo:**
- Revert file changes from the last prompt (not just the last commit)
- Revert chat history too (drop the last prompt/response pair so the context isn't polluted)
- Multi-level undo (not just the last change, but arbitrary depth)
- An undo that works without git (for scripts, non-repo directories, etc.)

**The `/undo` + auto-commit model has a specific failure mode:** when the LLM makes multiple changes across prompts and only a middle change is bad, you have to undo everything back to that point. There is no selective undo.

**Proposed solutions from the community:**
- @kanzure in #1018 proposed an `--edit-flow` mode: show the user all proposed file changes in a diff viewer before writing to disk. Let the user edit/accept/reject per-file.
- @Emasoft in #649 proposed a 5-action model per atomic change: APPLY, MODIFY, SKIP, STOP, REVERT. This is the most fully-articulated confirmation UX I found in the issues.
- External tool Mantra ([comment in #1018](https://github.com/Aider-AI/aider/issues/1018#issuecomment-3932626327)) provides session-state snapshots across AI tools, acting as "git for AI conversations."

### Lesson for petricode

Undo must work independently of git. Three mechanisms: (1) per-edit undo (before commit -- just don't apply), (2) per-prompt undo (revert all changes from the last prompt, including chat history), (3) git-based undo (for committed changes). The Emasoft 5-action model (APPLY/MODIFY/SKIP/STOP/REVERT) is worth studying as a maximal-control UX, though the default should be simpler (accept/reject per hunk, with escape to interrupt). Session state snapshots -- so you can rewind to any point in a conversation -- would be a differentiator.

---

## 5. "YOLO mode" equivalents

**What full-auto looks like in aider:** `--yes-always` approves file additions, file edits, and architect suggestions. But it deliberately *blocks* shell commands (see section 2). There is no built-in way to run aider fully unattended with command execution.

**What breaks:**
- Shell commands don't execute (#3903)
- Reflection loops: the LLM gets stuck retrying the same failing edit 3 times, then stops. The retry limit isn't configurable (#3830).
- File-add prompts still appear and block execution even with `--yes`
- The LLM discards its own edits when requesting file adds (#4314)

**The architect mode default change is instructive.** Architect mode previously required user approval before the editor model applied changes. In March 2025, `--auto-accept-architect` was added and made the default. This removed one human-in-the-loop checkpoint. Users were split: some loved the speed, others ([#3543](https://github.com/Aider-AI/aider/issues/3543)) felt it made architect indistinguishable from code mode and wasted tokens on bad edits.

**What users actually want from YOLO mode:**
1. Set a task and walk away (true agentic mode)
2. Auto-run shell commands including tests
3. Loop until tests pass (not just 3 reflections)
4. No prompts of any kind

Nobody in the issues has reported a satisfying YOLO experience with stock aider. The fork agent-aider attempted it but the author found aider's architecture "not the best or even a competent agentic coder."

### Lesson for petricode

YOLO/auto mode is a spectrum, not a binary. Design it as escalating tiers:
- **Tier 0 (interactive):** confirm every hunk, prompt for commands
- **Tier 1 (semi-auto):** auto-approve file edits, prompt for shell commands
- **Tier 2 (auto with guardrails):** auto-approve everything, but sandbox shell commands (container/nsjail), configurable retry limits
- **Tier 3 (full auto):** everything runs, no prompts, with a kill switch and full audit log

Each tier should be one flag or one config key. Avoid aider's trap of having `--yes`, `--yes-always`, `--auto-accept-architect`, and `--no-suggest-shell-commands` as separate flags that interact in confusing ways. A single `--autonomy=0|1|2|3` is clearer.

---

## Cross-cutting observations

1. **The maintainer's mental model vs. users' mental model:** Paul Gauthier consistently views git as the safety net and `/undo` as sufficient. Users consistently view preview-before-apply as the baseline expectation. Both are valid, but the user expectation is now set by Claude Code and Cursor, not by aider.

2. **First-use experience is critical.** Issue #932 shows that a single bad auto-commit on first run caused a user to abandon the tool entirely. The default behavior should be the safest behavior, with opt-in to less safe modes.

3. **The `--yes` flag namespace is a mess.** `--yes` (approve most things), `--yes-always` (approve everything except shell), `--auto-accept-architect` (approve architect-to-editor handoff), `--no-suggest-shell-commands` (suppress command suggestions entirely). This is four flags controlling what should be one graduated permission level.

4. **Signed commits reveal an identity problem.** Issue #1600 shows that aider modifies the git author name (appending "aider") which breaks GPG signing. The lesson: don't silently modify user identity or attribution metadata. If you want to mark AI-generated commits, use trailers, not author modification.

5. **The "add file and discard edits" bug (#4314) is a trust-destroyer.** When the tool silently throws away work, users lose faith in the entire system. Any confirmation prompt that can cause data loss is a design error.

---

## Key issues referenced

| # | Title | Comments | Category |
|---|-------|----------|----------|
| [649](https://github.com/Aider-AI/aider/issues/649) | Confirm each change before applying | 39 | Confirmation UX |
| [3830](https://github.com/Aider-AI/aider/issues/3830) | YOLO mode | 13 | Full-auto |
| [3903](https://github.com/Aider-AI/aider/issues/3903) | --yes-always doesn't run shell commands | 10 | Command safety |
| [1018](https://github.com/Aider-AI/aider/issues/1018) | Undo prompt command | 10 | Undo |
| [879](https://github.com/Aider-AI/aider/issues/879) | Only commit staged files | 10 | Auto-commit |
| [1173](https://github.com/Aider-AI/aider/issues/1173) | Disable suggest running commands | 10 | Command safety |
| [932](https://github.com/Aider-AI/aider/issues/932) | Surprising first-use experience | 13 | First-run safety |
| [2329](https://github.com/Aider-AI/aider/issues/2329) | Auto-accept architect suggestions | 12 | Confirmation UX |
| [3543](https://github.com/Aider-AI/aider/issues/3543) | Architect mode auto updating code | 14 | Confirmation UX |
| [4314](https://github.com/Aider-AI/aider/issues/4314) | Discards changes when adding files | 10 | File permissions |
| [1375](https://github.com/Aider-AI/aider/issues/1375) | Extend --yes option | 4 | Full-auto |
| [1600](https://github.com/Aider-AI/aider/issues/1600) | Support for signed commits | 11 | Git integration |
| [3371](https://github.com/Aider-AI/aider/issues/3371) | Add files with --no-git | 12 | File permissions |
| [1676](https://github.com/Aider-AI/aider/issues/1676) | Aiderignore use info/exclude | 16 | File permissions |
