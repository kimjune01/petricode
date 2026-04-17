# Bug Hunt Round 16 — Opus

**Tests:** 215 pass / 0 fail (942ms).
**Typecheck:** clean (`tsc --noEmit`).

Five NEW bugs found. After fifteen prior rounds, the heavily-traveled provider/cache/cwd surface is quiet — the hunt now turns up smaller functional defects (config silently ignored, dead code, missing resource caps) and one dataloss path in the consolidation flow.

---

## Bug 1 — `mode: "yolo"` configuration is silently ignored

**Severity:** medium
**Location:** `src/session/bootstrap.ts:129`, `src/agent/pipeline.ts:65`, `src/filter/policy.ts:19-30`, `src/app/components/ToolConfirmation.tsx:60`

**What happens:**

`bootstrap()` parses `mode` from `petricode.config.json` and returns it (line 129). `cli.ts` passes it to `<App mode={mode} />`. `App.tsx` forwards it to `<ToolConfirmation mode={_mode} />` — and `ToolConfirmation` destructures it as `_mode = "cautious"` (note the leading underscore — TypeScript's "intentionally unused" convention) and never reads it again.

More critically, `bootstrap()` never builds any `policyRules` from the mode. `pipeline.init({ policyRules: ... })` is never called with a yolo-derived ruleset, so `evaluatePolicy` always falls through to the default policy: read tools ALLOW, everything else (file_write, edit, shell) ASK_USER. The user who set `"mode": "yolo"` to skip prompts is still prompted for every write/shell call.

**Impact:** Functional regression for power users who explicitly opted out of confirmations. Worse, it's invisible — the mode parses cleanly, the TUI stores the value, the prompts still happen. There is no "your config did nothing" warning.

**Suggested fix (do not apply yet):**

In `bootstrap()`, when `mode === "yolo"`, prepend a `{ tool: "*", outcome: "ALLOW" }` rule to `pipelineOpts.policyRules` (or thread the mode all the way down to `evaluatePolicy`). Keep the prop on `ToolConfirmation` only if you intend to render a "yolo mode active — auto-allow" banner; otherwise drop the dead prop to make the contract honest.

---

## Bug 2 — `groupToCandidate` can mint duplicate skill names; `writeApproved` silently overwrites the loser

**Severity:** medium
**Location:** `src/consolidate/consolidator.ts:63-101` (name derivation), `src/commands/consolidate.ts:46-57` (write loop), `src/remember/skillStore.ts:87-89` (`write` is unconditional `writeFileSync`)

**What happens:**

`groupToCandidate` derives the skill name from the three most common ≥4-character words in the group's problem texts. Two pathological cases collide:

1. **No qualifying words** — e.g. the group's problems are all very short ("CSS bug", "API hang"). `topWords` ends up empty, name falls back to the literal string `"extracted-skill"`. If two groups both fall through, both get the same name.
2. **Same top-3 words by chance** — two unrelated problem clusters about, say, "test failure config" yield the same `test-failure-config` name even when their bodies differ.

`writeApproved` (commands/consolidate.ts:46) iterates approved candidates and calls `remember.write_skill({...})` for each. `SkillStore.write` does `writeFileSync(this.skillPath(skill.name), this.serializeSkill(skill))` — no existence check, no rename-on-collision, no error. The second write silently clobbers the first; the user sees "Wrote N skills" and believes everything persisted. Reload reveals only the last writer's body.

**Impact:** Silent data loss in the consolidation/review flow. The user spent time approving a candidate skill and the persisted state doesn't reflect it. Additionally, since `extracted-skill` is the no-words fallback for the very first cluster too, repeated `/consolidate` invocations on different sessions can keep overwriting that one slot.

**Suggested fix (do not apply yet):**

Either:
- In `groupToCandidate`, suffix the name with a stable hash of the body (or the source-session ids) when `topWords.length === 0` or whenever conflict resolution is needed.
- Or in `SkillStore.write` (or `writeApproved`), detect existing files with the same name and either error out, append `-2`/`-3` to disambiguate, or surface a "skill already exists — overwrite?" prompt back through the TUI.

The single-step fix that loses the least information is to disambiguate at write time and report the new names back in `writeApproved`'s return string.

---

## Bug 3 — `ShellTool` has no output cap; long-running commands can OOM the agent

**Severity:** medium
**Location:** `src/tools/shell.ts:35-39`

**What happens:**

`grep.ts:5` defines `MAX_OUTPUT_BYTES = 1_048_576` and refuses to accumulate past 1 MB of stdout/stderr (lines 56-67). `shell.ts` has no equivalent cap — its data handlers are bare:

```ts
proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
```

A model-issued `cat /dev/urandom`, `yes`, `find / -type f`, `journalctl -f`, or any unbounded log/dump command will accumulate string heap until the Node process OOMs (or hits V8's `--max-old-space-size`). The 30-second default `DEFAULT_TIMEOUT` only helps if the OOM doesn't happen first; on machines with fast disks or unbounded `yes`, the process dies in seconds.

There's also a downstream amplifier: even when the command stays under the OOM limit, oversized output then goes through `maskToolOutput` (`runToolSubpipe` line 112) which replaces it with a `[masked]` placeholder — but only AFTER the entire string has been buffered in memory. So masking does not protect the agent from its own shell tool here.

**Impact:** Trivial DoS surface. A confused (or adversarially-prompted) model can hang or crash the TUI by issuing one unbounded command. Recovery requires `kill` from another terminal because the crash handler may not finish writing before the OOM.

**Suggested fix (do not apply yet):**

Mirror grep.ts's cap pattern in shell.ts: track `outputBytes`, set `truncated = true` and `proc.kill("SIGTERM")` once over the threshold, append a `"[output truncated — exceeded NMB]"` suffix on resolve. 1 MB feels right since downstream masking will replace anything bigger with a placeholder anyway.

---

## Bug 4 — `ReadFileTool` has no size cap; large files explode the prompt and waste tokens

**Severity:** low–medium
**Location:** `src/tools/readFile.ts:24-25`

**What happens:**

`file_read` does `await fsReadFile(resolved, "utf-8")` and returns the entire file content. There is no streaming, no size check, no head/tail limit, no truncation. A 50 MB log file or a binary file (which UTF-8-decodes to mojibake but still loads into memory) is read fully into the Node string heap.

Two concrete failure modes:
1. **OOM / GC pressure** — same shape as Bug 3 but easier to trigger because the model only needs to know a path. Calling `file_read` on `/var/log/system.log` or `node_modules/.cache/...` is plausible model behavior.
2. **Token amplification** — even when the file fits in memory, `maskToolOutput`'s 10K-token threshold replaces anything over ~40 KB with a `[masked — N tokens]` stub. The model gets *no signal* about what it asked for; it can't even fall back to head/tail. So a 100 KB README is read into memory, masked, and the model is told "[masked — 25000 tokens]" — the read was lossy AND wasted IO.

**Impact:** Memory pressure on long sessions plus a degraded UX where curious "look at this file" requests return nothing usable. Combined with the model's tendency to retry larger reads when masked, this can also burn through `maxToolRounds` quickly.

**Suggested fix (do not apply yet):**

Add a `head_limit` / `tail_limit` arg (numeric, lines or bytes) to `file_read`'s schema and default to streaming the first N KB (e.g. 256 KB / 4096 lines) when omitted, with a `[truncated — file is N MB total, showing first 4096 lines]` suffix. This keeps token cost predictable and gives the model a useful response instead of a `[masked]` opaque blob.

---

## Bug 5 — `q` quick-quit is dead code: `phase === "idle"` is unreachable

**Severity:** low (UX confusion)
**Location:** `src/app/App.tsx:120-122`, `src/app/state.ts:5,18`

**What happens:**

`AppPhase` is declared as `"idle" | "composing" | "running" | "confirming"`. `initialState()` returns `phase: "composing"`. Searching the entire `src/` tree (`grep -rn 'phase.*idle\|"idle"' src/`) finds exactly one reference outside the type/state files: the `q`-to-quit handler at App.tsx:120, which is gated on `state.phase === "idle"`.

No code path ever sets phase to `"idle"`. The `setState((prev) => ({ ...prev, phase: "composing"|"running"|"confirming"|"composing" ... }))` calls in App.tsx exhaust the other three values. So the `q`-quit shortcut never fires.

The `StatusBar` even advertises `"q quit"` in `PHASE_HINTS.idle` (StatusBar.tsx:55) and the help text in `commands/index.ts:33` says `"q             — quit when input is empty"`. Both promises are unfulfilled — the user types `q`, it gets inserted as a literal `q` in the Composer, and they have to either hit Backspace or learn that the documented shortcut is fake.

**Impact:** Cosmetic + UX trust hit. User reads the hint, tries the keystroke, types a `q` into their next prompt, gets confused.

**Suggested fix (do not apply yet):**

Pick one of:
1. **Remove** — drop the `idle` phase from the type, the App handler, the StatusBar hint, and the help-text line. Smallest surgery.
2. **Implement** — relax the gate to `(state.phase === "composing" || state.phase === "idle") && composerInputIsEmpty`. Requires plumbing emptiness from Composer up to App (it currently lives in Composer's local state). Composer already exits on Ctrl+D-with-empty via `onEofExit`, so the cleanest port is "q-with-empty also calls `onEofExit`" inside Composer itself.

---

## Notes — checked-clean surfaces

Verified the previously-fixed surfaces are still sound:

- TfIdfIndex `live_n` bookkeeping (round 11) — still consistent across `add_document` / `remove_document` / `recompute_idf`.
- `Pipeline.turn` `while (this.inFlight)` serialization (round 14) and `.finally` cleanup compare against the wrapped promise (round 12) — both intact.
- `assembleTurn` interleaved-tool flushing (round 14) — no premature flushes; safety-flush at end-of-stream still covers no-`done` cases.
- `expandFileRefs` cwd resolution (round 10) and trailing-punctuation reattachment (round 13) — intact; verified `@README.md, @LICENSE?` still preserves the comma + question mark.
- All file-tool cwd hijack defenses (round 11) — `file_read` / `file_write` / `edit` / `glob` all use `opts?.cwd` for relative-path resolution.
- OpenAI `tool_use_start` synthesis on truncated streams (round 13) and `done`-on-any-finish_reason (round 12) — both intact.
- Pipeline tool-use / tool-result orphan prevention via atomic graduate (round 9 + round 11) — `cache.append` still pulls the next matching `tool_result` turn alongside its `tool_use` turn when graduating.
- `LoopDetector` canonical key-sorted JSON (existing) — collisions across `{a,b}` vs `{b,a}` correctly detected.
- `validateContent`, `validateFilePath`, `assembleContext`'s system/user routing (round 12) — all still gating correctly.
- ConsolidateReview ref-based double-fire guard (rounds 11, 12) — `completedRef` plus per-decision-keypress dispatch holds.
- `ToolConfirmation` resolved-flag reset on new toolCall (existing) — the `useEffect([toolCall.id])` reset still fires.

The cold-summary system-role-folding behavior across providers (Anthropic + Google merge into the system prompt; OpenAI keeps positional system messages) is unchanged from round 15's note — long-standing structural design, not a new bug.

`Perceiver`'s `discoverSkills(dir)` loop is still dead code in TUI usage (Pipeline never passes `skillDirs`); the live skill path runs through `loadSkills` in `pipeline.init`. Harmless dead code, not a bug.
