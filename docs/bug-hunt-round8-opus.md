# Bug Hunt Round 8 (opus)

Adversarial IV&V findings on petricode. New bugs only — round 1–7 fixes excluded.

---

## 1. Security: file-ref expansion can silently exfiltrate sensitive files

- **Severity:** high
- **File:line:** `src/perceive/fileRefs.ts:3` (`FILE_REF_PATTERN`), `src/perceive/fileRefs.ts:17-25` (no validation before `readFile`)
- **Description:** After the round-7 loosening, `@([^\s]+)` accepts any non-whitespace token, including absolute paths to sensitive files. There is no path-validation step (the `pathValidation` module is only wired into `toolSubpipe`). On macOS/Linux, a user (or a pasted log line) containing `@/etc/passwd`, `@/Users/me/.ssh/id_rsa`, or `@~/.aws/credentials` (when the literal path resolves) will be inlined into the prompt and sent to the LLM provider. Read failures are now silent (no `[file not found]`), so the user has no signal that secret exfiltration occurred or was attempted. Inlined content is wrapped in `<file path="...">` tags and indistinguishable from normal context.
- **Impact:** Silent data leak to the model provider. A user who pastes a stack trace, log, or generated text containing what looks like an `@-mention` can ship secrets out of band. Trust boundary inversion: input that LOOKS textual exfiltrates files.
- **Suggested fix:** Apply `validateFilePath(rawPath, projectDir)` before `readFile`, identically to how `toolSubpipe` validates tool args. Reject paths outside the project directory and skip silently (or log to a diagnostics channel). Optionally: also reject any path whose basename starts with `.env` / matches an `ALWAYS_EXCLUDED` segment, so an attacker can't pull `.env` from inside the project either.

---

## 2. Logic: assembleTurn reorders text relative to multi-tool responses

- **Severity:** medium
- **File:line:** `src/agent/turn.ts:52-66` (`tool_use_start` handler) and `78-89` (`done` handler)
- **Description:** `assembleTurn` keeps a single global `textBuffer` but a per-index `toolMap`. On `tool_use_start`, it flushes `textBuffer` immediately to `content[]` but keeps the previously-started tool sitting in the map. On `done`, all in-flight tools are flushed AFTER any trailing text. Concrete reordering trace for a model that emits `text0 → tool1(idx=1) → text1 → tool2(idx=3) → done` (legal for OpenAI multi-tool streaming and Anthropic multi-block responses):
  - After `text0`: `textBuffer = "text0"`.
  - `tool_use_start(1)`: flush textBuffer → `content = ["text0"]`. tool1 in map.
  - `text1` deltas: `textBuffer = "text1"`.
  - `tool_use_start(3)`: flush textBuffer → `content = ["text0", "text1"]`. tool2 in map. **tool1 still in map and not in content.**
  - `done`: flush tools sorted by index → `content = ["text0", "text1", tool1, tool2]`.
  Actual model intent: `[text0, tool1, text1, tool2]`. Result: text-1 and tool-1 swapped.
- **Impact:** When a model emits commentary between tool calls (e.g. "First I'll read the file… now let me edit it…"), the rendered transcript and persisted history mis-attribute commentary to the wrong tool. Confuses the user and corrupts conversation history fed back to the model on the next turn.
- **Suggested fix:** When `tool_use_start` arrives, flush the textBuffer as text, then ALSO flush every existing tool in `toolMap` (in insertion order or by index) to `content[]` and clear the map, before inserting the new tool. The `index` from providers refers to content-block ordering, so a new block always means earlier blocks are complete.

---

## 3. UX: Ctrl+D exits regardless of input contents

- **Severity:** medium
- **File:line:** `src/app/App.tsx:117-119`
- **Description:** `if (key.ctrl && _ch === "d" && state.phase === "composing") { exit(); }`. The Ctrl+D handler in `App.tsx` runs unconditionally during composing — it does not check whether the Composer has any text. The Composer's internal Ctrl+D handler (Composer.tsx:170-174) treats non-empty input as forward-delete and only "lets App handle exit" when input is empty (`return prev`), but App's `useInput` fires in parallel and exits anyway. The early-return inside Composer doesn't suppress App's handler.
- **Impact:** Pressing Ctrl+D mid-input quits petricode and discards typed text, even though the spec (item 27) and Composer's own comment say Ctrl+D is EOF only at empty prompt. Same risk if user does forward-delete via Ctrl+D habit — they exit instead.
- **Suggested fix:** App needs to know if the composer is empty. Lift composer's input-empty signal up (e.g. `onEmptyChange` callback or a shared ref) and gate App's Ctrl+D on `composerEmpty === true`. Alternatively, remove Ctrl+D handling from App entirely and have Composer call `useApp().exit()` directly when its input is empty.

---

## 4. UX: Confirmation auto-resolve race when remaining hits 0 then a new tool arrives

- **Severity:** medium
- **File:line:** `src/app/components/ToolConfirmation.tsx:79-100`
- **Description:** Two effects collide on rapid tool succession. The reset effect (`useEffect([toolCall.id])`, line 79) sets `resolvedRef.current = false` and calls `setRemaining(60)` synchronously inside the effect, but `setRemaining` is async — the closure in the auto-resolve effect (`useEffect([remaining, mode, onConfirm])`, line 95) still sees the stale `remaining = 0` from the previous tool's countdown. When `onConfirm` identity changes (handleToolConfirm in App.tsx is `useCallback([state.pendingToolCall, addSystemTurn])` — recreated on every new pendingToolCall), the auto-resolve effect re-fires with `remaining === 0` and the just-cleared `resolvedRef.current === false`, calling `onConfirm(mode === "yolo")` instantly without user input.
- **Impact:** If tool A's confirmation times out (or runs to 0s) and tool B is queued back-to-back, tool B is auto-decided in the same render cycle — auto-allowed in yolo mode, auto-denied in cautious mode — without ever being presented to the user.
- **Suggested fix:** Move the timeout decision into the interval callback rather than a separate effect. Inside the `setInterval`, when `r <= 1`, call `onConfirm(mode === "yolo")` directly, then return 0 and clear interval. Drop the auto-resolve effect entirely. This eliminates the cross-effect closure race.

---

## 5. Resource cleanup: tool sub-pipe ignores AbortSignal — child processes keep running

- **Severity:** high
- **File:line:** `src/agent/toolSubpipe.ts:36-131` (no `signal` parameter), `src/agent/pipeline.ts:281-287` (caller doesn't pass signal), `src/tools/shell.ts:25-56`, `src/tools/grep.ts:28-59`
- **Description:** `runToolSubpipe` accepts no `AbortSignal` and has no signal check inside its `for (const tc of turn.tool_calls)` loop. When the user hits Ctrl+C during a multi-tool round, the App aborts the controller, but the tool loop continues iterating and `await`ing each `registry.execute()`. Shell and grep tools spawn child processes via `child_process.spawn` and resolve only on `close` (or after the 30-second shell timeout — grep has no timeout at all). Once the loop finishes, pipeline.ts:302 detects `signal.aborted` and synthesizes "Interrupted" results — but the tools have already executed, files written, shell side-effects committed, and the child processes ran to completion against the user's wishes.
- **Impact:**
  - User cannot actually interrupt long-running shell or grep commands; ^C ends the TUI flow but the child processes keep going (and grep can run unbounded).
  - The conversation history records "Interrupted" while the file system shows the side-effects were applied — a misleading/dangerous mismatch.
  - If the second tool in a 2-tool batch is `shell rm -rf foo`, abort after first tool does NOT stop the second from executing.
- **Suggested fix:**
  - Plumb the `AbortSignal` through `runToolSubpipe` and check `signal.aborted` at the top of the loop (and after each await). When aborted, stop processing remaining tools and synthesize "not executed" results for them.
  - In `shell.ts` and `grep.ts`, accept an optional signal and call `proc.kill("SIGTERM")` (or SIGKILL) on `signal.abort` event. Also add a default timeout to grep (currently unbounded).

---

## 6. Logic: resumeSession discards persisted role, tags every event as "user"

- **Severity:** medium
- **File:line:** `src/session/resume.ts:29-38`
- **Description:** The session store correctly persists and returns `role` (sessionStore.ts:103-115 reads `role` from the row). But `resumeSession` ignores it and hardcodes `role: "user"` on every replayed turn, with the note "events don't store role, infer from position" — outdated since round 1's role-persistence fix. Path-of-evidence: every turn becomes a user message in the cache, so when the next `pipeline.turn()` calls `this.cache.read()` and rebuilds the conversation, the model sees a sequence like `user, user, user, …, user(new prompt)` instead of the alternating `user/assistant/user(tool_result)/assistant…` structure.
- **Impact:** Resumed sessions feed an invalid message sequence to providers. Anthropic in particular requires alternating roles when tool_use blocks are involved (every `tool_use` must be matched by a `tool_result` from the next user turn). With everything tagged user, prior tool_use blocks become orphans → API may reject the request, or model produces wrong output (it sees its own prior responses as if the user said them).
- **Suggested fix:** Use `event.role ?? "user"` in `resumeSession`. The PerceivedEvent type already has `role?: ...` (types.ts:51) and the read path populates it.

---

## 7. UX: missing Ctrl+L (clear screen), Up/Down (history), Shift+Enter (newline) keybindings

- **Severity:** low (each — but cumulative)
- **File:line:** `src/app/components/Composer.tsx:104-190` (no upArrow/downArrow/shift-enter cases), `src/app/App.tsx:76-124` (no Ctrl+L)
- **Description:** Spec items 15, 24, 29-32 mandate Shift+Enter inserts newline, Ctrl+L clears terminal screen with session preserved, Up/Down navigate prompt history (preserved across restarts), and partial input is preserved when navigating. None of these are wired. Composer's `useInput` only handles return (submit unconditionally), arrows for cursor-x movement, and standard editing. There is no history store at all (`SessionStore` persists messages but no input-history concept), so even adding the keybinding requires backing storage.
- **Impact:** Users coming from Claude Code / aider / readline-based shells have broken muscle memory: Shift+Enter submits instead of inserting newline (forcing them to use bracketed paste workarounds for multiline), Ctrl+L can't clear the terminal, and there's no way to recall a prior prompt.
- **Suggested fix:**
  - Composer: detect Shift+Enter (Ink exposes `key.shift && key.return`) and insert `"\n"` instead of submitting. Mind that some terminals send Shift+Enter as `\x1b\r` or similar — may need raw byte handling like bracketed paste.
  - App: handle `key.ctrl && _ch === "l"` by writing `"\x1b[2J\x1b[H"` to stdout (clear+home), preserving turns in state.
  - Add a prompt-history slot (e.g. `~/.config/petricode/history` JSON) and Up/Down handling in Composer that scrolls through it. Preserve in-progress input when navigating.

---

## 8. Persistence: skill frontmatter round-trip is lossy (write JSON-encoded, read raw)

- **Severity:** low
- **File:line:** `src/remember/skillStore.ts:19-31` (`serializeSkill`) vs `src/perceive/skillDiscovery.ts:54-75` (`parseFrontmatter`)
- **Description:** When a consolidated skill is written to disk, `serializeSkill` encodes every non-`name`/non-`trigger` frontmatter value via `JSON.stringify` (e.g. `confidence: 0.5` → `confidence: 0.5`, `generated: true` → `generated: true`, `source_sessions: ["abc","def"]` → `source_sessions: ["abc","def"]`). When the same file is read by the loader, `discoverSkills` → `parseFrontmatter` (skillDiscovery.ts:71) takes the raw post-colon text as a string, with no JSON parsing. So `confidence` becomes the string `"0.5"`, `generated` becomes the string `"true"`, and `source_sessions` becomes the literal string `'["abc","def"]'`. Note that `skillStore.parseSkill` (line 50-54) DOES try `JSON.parse` and is therefore consistent with its own writer — but the actual loader path used at startup (`loadSkills` → `discoverSkills`) bypasses `SkillStore.parseSkill` entirely.
- **Impact:** Any consumer that reads numeric/boolean/array frontmatter via `skill.frontmatter[...]` after the loader path gets the wrong type. Today only `frontmatter.description` (string) and `frontmatter.paths` (string) are read via `activation.matchAutoTriggers`, so it's latent. The `/skills` listing also only looks at `description`. As soon as confidence or source_sessions is read, it'll be wrong.
- **Suggested fix:** Either: (a) make `skillDiscovery.parseFrontmatter` use the same try-JSON-parse approach as `skillStore.parseSkill`, or (b) consolidate to a single parser shared by both. (a) is the smaller diff and matches the writer.

---

## 9. UX: ToolConfirmation 60s auto-decide contradicts spec ("waits indefinitely")

- **Severity:** low
- **File:line:** `src/app/components/ToolConfirmation.tsx:7` (`TIMEOUT_SECONDS = 60`), `95-100` (auto-resolve)
- **Description:** The spec at item 67 reads "Confirmation waits indefinitely (no timeout)". The TUI auto-decides after 60 seconds: in cautious mode it auto-denies; in yolo mode it auto-allows. A user who steps away for a phone call comes back to either silently-failed tool calls (cautious) or silently-approved destructive operations (yolo). The yolo branch is the dangerous one — a write/shell tool gets executed without explicit consent because nobody was at the keyboard.
- **Impact:** Yolo mode + auto-allow + AFK = unauthorized tool execution. Cautious mode + auto-deny = confusing "denied" results without the user ever seeing the prompt, leading the model to either give up or retry with worse arguments.
- **Suggested fix:** Drop the timer entirely (match the spec). If a timeout is desired, at minimum the cautious mode should auto-deny and yolo mode should ALSO auto-deny (never auto-approve a destructive action without user presence). Better: degrade to a "press y/n to decide" indicator and never auto-resolve.

---

## 10. Logic: pipeline finally-block awaits remember.append serially; partial persistence on error

- **Severity:** low
- **File:line:** `src/agent/pipeline.ts:117-128`
- **Description:** The persist loop in `turn()`'s finally block awaits each `remember.append` in sequence. If one append throws (disk full, sqlite locked, blob write fails) mid-loop, subsequent turns aren't persisted. Worse, the throw inside `finally` will replace the original try-block error (e.g., AbortError or network error) with the persistence error, so the App's catch loses the original cause. The loop also doesn't catch — a single failure aborts persistence of any remaining turns even though they're independent.
- **Impact:** Inconsistent on-disk session state after rare errors. Diagnostic noise: original error is masked by persistence error in the TUI.
- **Suggested fix:** Wrap each iteration in try/catch — log the persistence failure to crash.log and continue. If the original try-block already threw, re-raise the original after the finally (preserve via a `let suppressed` pattern or use Node's `Error.cause`).

---

## 11. Path safety: SkillStore writes filenames from untrusted-name without validation

- **Severity:** low
- **File:line:** `src/remember/skillStore.ts:15-17` (`skillPath`), `src/remember/skillStore.ts:65-67` (`write`)
- **Description:** `skillPath(name)` returns `join(skillsDir, name + ".md")`. `name` originates from `consolidate/consolidator.ts:75` (`topWords.join("-")`) which is derived from session content tokenized by whitespace. There is no sanitization. If a session contains words with `/` or `..` (e.g., extracted from a file path mention), the resulting candidate skill name like `"src..foo"` or `"a/b/c"` will write to `skillsDir/src..foo.md` or `skillsDir/a/b/c.md` — the latter throws ENOENT, the former (`..` only meaningful with separator) is a literal filename so probably fine on most fs. But `name = "../../etc/foo"` is possible if the consolidator ever surfaces such tokens, and would escape `skillsDir`.
- **Impact:** Marginal today (tokenization filters short words and pulls from session text), but a theoretical write-outside-skills-dir vulnerability if the consolidator ever sees adversarial session content.
- **Suggested fix:** In `skillPath`, validate `name` against a whitelist regex (e.g. `/^[a-zA-Z0-9_-]+$/`) and throw on mismatch. Or use `path.basename(name)` defensively before joining.

---

## 12. Composer: stale Composer Ctrl+D inserts no forward-delete when at end of input

- **Severity:** low
- **File:line:** `src/app/components/Composer.tsx:170-175`
- **Description:** Branch is `if (prev.input.length === 0) return prev; if (prev.cursor < prev.input.length) { delete forward }`. When the input is non-empty AND the cursor is at the END of input (cursor === input.length), the function falls through with no mutation but DOES NOT `return prev` early — it returns `{input: nextInput, cursor: nextCursor}` from below where both are set to the unchanged values. So no visible change. BUT App's Ctrl+D handler (App.tsx:117) ALSO fires and EXITS the app. So at end-of-input with non-empty input, Ctrl+D quits. Combined with bug #3 above.
- **Impact:** Subset of bug #3. Documented separately because the fix is local: Composer should swallow Ctrl+D (return early) any time input is non-empty, regardless of cursor position, so App's Ctrl+D never fires.
- **Suggested fix:** Change line 171 from `if (prev.input.length === 0) return prev;` to a structure where Ctrl+D returns prev when input is non-empty AND cursor is at end (meaning "swallow but don't delete"). Or wire a Composer→App empty-state signal as in bug #3.

---

## 13. Pipeline: dead AbortError catch in toolSubpipe call site

- **Severity:** low (cleanliness)
- **File:line:** `src/agent/pipeline.ts:288-296`
- **Description:** The catch block specifically handles `DOMException("AbortError")` with synthesis + rethrow, but `runToolSubpipe` doesn't throw AbortError anywhere — it has no signal awareness (see bug #5) and `onConfirm` rejecting is the only async wait, which `App.tsx:84` resolves with `false` rather than rejecting. So the special-case branch at line 291-294 is unreachable. The bare `throw err;` at 295 makes the entire try/catch a no-op pass-through.
- **Impact:** Misleading code — implies abort handling that doesn't exist. Whoever fixes bug #5 should be aware this branch needs real wiring.
- **Suggested fix:** Either remove the try/catch entirely (until bug #5 is fixed), or — better — actually plumb the signal into `runToolSubpipe` so the catch becomes load-bearing.

---

## 14. Race: contextSummary setState after unmount

- **Severity:** low
- **File:line:** `src/app/App.tsx:55-64`
- **Description:** `pipeline.contextSummary().then(...)` schedules an async setState. If the App component unmounts (e.g., user double-Ctrl+C exits while the `discoverContext` walk is in progress on a large project), the resolved promise will call `setContextSummary` on an unmounted component. React 18+ logs a warning and the closure may also keep the pipeline / perceiver references alive longer than necessary.
- **Impact:** Console warning and a small memory leak window between unmount and promise resolution. No user-facing breakage.
- **Suggested fix:** Use a cancellation flag in the effect: `let cancelled = false; pipeline.contextSummary().then(r => { if (!cancelled) setContextSummary(...) }).catch(...); return () => { cancelled = true; };`

---

## Summary

14 bugs found, all new (cross-checked against round 1–7 fixes).

- 2 high severity: file-ref data exfiltration (#1), abort doesn't actually abort tool execution (#5)
- 6 medium: text/tool reordering (#2), Ctrl+D quits with text (#3), confirmation auto-decide race (#4), resume role loss (#6), Ctrl+D variant (#12 — subset of #3)
- 6 low: missing keybindings (#7), skill frontmatter type loss (#8), 60s confirmation timeout vs spec (#9), persistence partial failure (#10), skill path safety (#11), dead catch (#13), unmount setState (#14)

Highest-leverage fixes:
1. **#5** (signal in toolSubpipe + child kill) — closest thing to a P0; users can't cancel running tools.
2. **#1** (file-ref path validation) — silent data leak, easy fix.
3. **#2** (assembleTurn flush ordering) — corrupts multi-tool transcripts.
