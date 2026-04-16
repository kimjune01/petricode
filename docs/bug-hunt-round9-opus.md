# Bug Hunt Round 9 (opus)

Adversarial IV&V findings. Round 1–8 fixes excluded. Tests: 199/199 pass.

---

## 1. Security: glob/grep tools search wrong directory (process.cwd, not projectDir)

- **Severity:** high
- **File:line:** `src/tools/glob.ts:23-24` (and same pattern in `src/tools/grep.ts:25`, `src/tools/shell.ts:29`)
- **Description:** `GlobTool.execute` defaults `cwd = args.path ?? "."` and loads gitignore from `process.cwd()`, NOT from the pipeline's `projectDir`. `GrepTool` likewise defaults `searchPath = args.path ?? "."` and spawns `grep` without a `cwd` option, so it runs against `process.cwd()`. `ShellTool` also spawns `sh -c command` with no `cwd`, so commands run wherever the CLI was invoked. The path-validation layer in `src/agent/toolSubpipe.ts:53-64` only validates the `path` arg WHEN PROVIDED — when the LLM omits `path` (which it routinely does for "search the project"), validation is skipped and the tool runs against the process cwd. If a user `cd`'s out of the project dir between sessions or runs petricode from `~`, glob/grep can scan their entire home directory; `gitignore` exclusion is also wrong-rooted and may fail to mask `.env` files in unexpected locations.
- **Impact:** `grep "AWS_SECRET" .` (with default path) executed by an LLM scans whatever directory the user happened to launch from. Secrets in adjacent projects or the user's home dir leak into the model's context. Same risk for `glob`. Shell commands with relative paths affect the wrong directory.
- **Suggested fix:** Plumb `projectDir` into `ToolExecuteOptions` and pass it as `opts.cwd`. In each tool, default `searchPath = opts.cwd ?? "."` and pass `cwd: opts.cwd` to `spawn` / `glob.scan`. Also: when `path` is undefined, treat it as `projectDir` for path validation purposes (currently `validateToolArgs` only validates when the key is present).

---

## 2. Resource: GoogleProvider does not pass AbortSignal to HTTP request

- **Severity:** high
- **File:line:** `src/providers/google.ts:150-158`
- **Description:** `generateContentStream` is invoked WITHOUT a signal in its options. The only abort check is inside the `for await (const chunk of response)` loop at line 163, which can only fire if/when a chunk is emitted. If the model is slow to respond OR the request is hung waiting on Vertex/GenAI, abort cannot interrupt the underlying HTTP request. Compare to `anthropic.ts:112` (`{ signal: config.signal }`) and `openai.ts:130-133` which both forward `signal` into the SDK call.
- **Impact:** Ctrl+C during a Gemini call cannot cancel the in-flight HTTP request. The TUI returns control to the user, but the request keeps streaming in the background until the model finishes — wasting tokens (cost), holding network resources, and delaying process exit. On `--resume` or rapid-fire turns the orphan request can also race with a new turn.
- **Suggested fix:** Pass the signal into the `@google/genai` SDK call. The library accepts an `abortSignal` in `RequestOptions`. Either thread `config.signal` into a second argument of `generateContentStream` if supported, or use `fetch`-level interruption via the SDK's HTTP client config.

---

## 3. UX/Performance: RetryProvider buffers entire stream, defeating streaming

- **Severity:** high
- **File:line:** `src/providers/retry.ts:84-93`
- **Description:** Inside the retry attempt, the wrapper does `for await (const chunk of stream) { chunks.push(chunk); }` THEN yields the buffered chunks. This means the consumer sees ZERO chunks until the inner provider's stream completes. Since `RetryProvider` wraps every provider in `bootstrap.ts:62-87`, the entire pipeline is non-streaming in production. The TUI's "thinking…" indicator stays up until the full response arrives, regardless of how long the response is. This contradicts the streaming abstraction across providers (Anthropic/OpenAI/Google all support real streaming; the comment at line 85 about "partial data" is moot because the next attempt would re-stream from scratch anyway).
- **Impact:** No streaming UX. A 3,000-token response that takes 30s to generate shows nothing for 30s, then renders all at once. Defeats the entire reason providers stream. Also means the abort signal can't pre-empt early in a long response — abort takes effect only after the whole response is in the buffer.
- **Suggested fix:** Yield each chunk as it arrives. Move retry logic to wrap only the SDK call setup and the FIRST chunk's arrival; once the first chunk is yielded, subsequent failures should propagate (do not silently drop a partial response). If "all-or-nothing" semantics are mandatory, document the trade-off and gate the buffering behind a flag — but the default should stream.

---

## 4. Race: User can submit a new turn while previous turn is still persisting in finally

- **Severity:** medium
- **File:line:** `src/app/App.tsx:79-89` (sets `abortRef.current = null` synchronously) + `src/agent/pipeline.ts:113-129` (finally block awaits remember.append serially) + App.tsx:138 (guard checks `abortRef.current`)
- **Description:** When Ctrl+C is pressed during `running`/`confirming`, App.tsx:81 sets `abortRef.current = null` IMMEDIATELY, then transitions phase to `composing`. The user can immediately type and submit a new prompt. The `if (abortRef.current) return;` guard at line 138 sees null and lets the new turn proceed. Meanwhile, the previous `pipeline.turn()` call is STILL running its `finally` block (pipeline.ts:115-129) which serially `await`s `remember.append(t)` for each pending turn. The new turn proceeds to call `pipeline.turn(input2)` which writes to `this.cache.append(...)` and reads from `this.cache.read()` while the old turn is still draining its `pendingPersist` to disk. Two concurrent invocations of `pipeline.turn()` mutate the same `cache` instance — there is no mutex. Cache hot-zone ring buffer can interleave appends from both turns; reads can return mixed state.
- **Impact:** Concurrent pipeline.turn() invocations corrupt cache ordering: turn N+1's user message can land between turn N's assistant message and turn N's tool_results. Provider then sees malformed conversation (orphan tool_use, mis-paired tool_result). Anthropic API can reject; OpenAI/Google may produce nonsense. Likelihood: medium (requires user to type AND hit enter within the persist window — typically <1s but unbounded under sqlite contention).
- **Suggested fix:** Track an in-flight promise on the pipeline (e.g. `private inFlight: Promise<unknown> | null`) and have `turn()` await any prior in-flight before starting. Or, in App.tsx, hold `abortRef.current` non-null until the pipeline.turn() promise resolves (don't null it synchronously in the Ctrl+C handler — let the catch block clear it after the throw fully unwinds).

---

## 5. Logic: assembleTurn drops tool_use_delta chunks when start chunk lacks id or name

- **Severity:** medium
- **File:line:** `src/providers/openai.ts:147-156` + `src/agent/turn.ts:74-81`
- **Description:** OpenAI's streaming protocol can split a tool call's metadata across multiple chunks. The current code at openai.ts:149 emits `tool_use_start` ONLY when BOTH `tc.id` AND `tc.function?.name` are present in the same delta. If a chunk arrives with only `id` (or only `name`), no `tool_use_start` is emitted but the `index` is now claimed by an unfinished tool. Subsequent `tool_use_delta` chunks (line 152-153) reference that `index`, but assembleTurn's `toolMap.get(idx)` returns undefined (turn.ts:76), and the JSON arguments are silently dropped. The tool then either gets a `tool_use` entry with empty args OR no entry at all — depending on whether the FIRST chunk had both id+name. Because OpenAI allows splitting metadata across multiple chunks (especially under tool-streaming with high concurrency), this is reachable in practice.
- **Impact:** Tool calls get malformed args (empty `{}` instead of `{path: "...", content: "..."}`). The tool then fails inside the registry's required-field check, the model sees "missing required argument" tool_results, and recovers — but loses a turn. Worst case: `file_write` runs with no `path`, errors out, and the model retries with hallucinated args.
- **Suggested fix:** Buffer per-`index` until BOTH `id` and `name` are known, then emit `tool_use_start`. Or, in assembleTurn, allow `tool_use_delta` to bootstrap a tool entry with placeholder id/name that gets filled by a later `tool_use_start`.

---

## 6. Logic: Cache cluster summaries strip tool_use blocks → orphan tool_results

- **Severity:** medium
- **File:line:** `src/cache/compaction.ts:16-21` (`turn_text` ignores tool_use/tool_result content) + `src/cache/cache.ts:108-130` (`cold_summaries` re-emits as text-only `system` role)
- **Description:** When an assistant turn containing `tool_use` blocks gets graduated from hot to cold, the cluster summary is built only from text content (`turn_text` filters to `c.type === "text"`). The summary is then emitted as a SYSTEM-role turn (cache.ts:111). The corresponding `user` turn containing the matching `tool_result` may still be in hot. So the rebuilt conversation has: `[system: cluster summary, ...other hot turns..., user: tool_result with tool_use_id=X]` — but no `tool_use` block with `id=X` exists anywhere in the conversation. Anthropic strictly requires every `tool_result.tool_use_id` to reference a prior assistant `tool_use.id` in the same conversation. The API will reject with `400 Each `tool_result` block must reference a preceding `tool_use` block`.
- **Impact:** When the `hot_capacity` (default 10) overflows mid-conversation, the next provider call breaks. Failure mode is silent until you have >10 turns AND a tool was called near the boundary. Most testing sessions are short, so this doesn't surface in tests but will hit any long real-world session.
- **Suggested fix:** Either (a) graduate adjacent assistant+tool_result pairs together so they leave hot atomically, (b) preserve tool_use blocks in cluster summaries verbatim, or (c) when emitting cold summaries, scrub `tool_result` blocks from hot whose matching `tool_use` is now in a graduated cluster.

---

## 7. Logic: LoopDetector key non-deterministic across arg key orderings

- **Severity:** medium
- **File:line:** `src/filter/loopDetection.ts:23`
- **Description:** `JSON.stringify({ name, args })` does not sort object keys. If the model emits the same logical tool call with different key insertion orders — e.g. `{path: "a", content: "x"}` vs `{content: "x", path: "a"}` — they hash to different strings, defeating the loop detector. Models do reorder kwargs across attempts, especially after a failed tool call where they retry with the same args but rebuild the JSON.
- **Impact:** Loop detection misses real loops. The threshold of 5 consecutive identical calls becomes "5 consecutive calls with identical key ordering AND identical values" — easy to miss. Combined with the unbounded grep/file_read, a stuck model can spam retries for the entire `maxToolRounds` budget.
- **Suggested fix:** Use a stable JSON serializer (e.g. canonical JSON: sort keys recursively before stringify). Cheap impl: `JSON.stringify(v, Object.keys(v).sort())` for shallow objects, or write a 10-line recursive sorter.

---

## 8. Logic: bootstrap silently swallows malformed config + missing 'tiers' key

- **Severity:** medium
- **File:line:** `src/session/bootstrap.ts:38-48`
- **Description:** `loadTiersConfig` walks project then global config paths. For each, it tries `JSON.parse` — but the `try { ... } catch {}` swallows ALL parse errors and falls through to the next path. Worse, even on successful parse, `if (raw.tiers)` skips files without that key with no warning. End result: a typo'd config file silently uses defaults, and the user has no idea why their model selection isn't honored. There's also no warning printed and no entry written to `crash.log`.
- **Impact:** Misconfiguration is invisible. User edits `petricode.config.json`, makes a JSON syntax error, and the TUI silently uses Claude Sonnet 4 from defaults. They wonder why the new model never gets called. Same hazard if they put the tier config under a different key name.
- **Suggested fix:** Distinguish "file not found" (silent fall-through OK) from "file present but invalid" (log to stderr or crash.log, optionally fail-fast). At minimum, print a one-liner: `Warning: petricode.config.json failed to parse: <err>; using defaults`.

---

## 9. Logic: validateTiers does not validate the `mode` field

- **Severity:** low
- **File:line:** `src/config/models.ts:67-95` (validateTiers) + `src/session/bootstrap.ts:123` (consumer)
- **Description:** `validateTiers` checks `tiers.{primary,reviewer,fast}.{provider,model}` but ignores `c.mode`. A user who writes `"mode": "automatic"` (typo for "yolo") gets through validation. Bootstrap then does `tiersConfig.mode ?? "cautious"` → returns `"automatic"` (truthy). App.tsx passes this string into `ToolConfirmation` as the `mode` prop. The component types it as `ConfirmMode = "yolo" | "cautious"` and the `mode === "yolo"` branches all evaluate false, so behavior degrades to cautious — but the type system claims otherwise.
- **Impact:** Silent demotion to cautious mode when user expected yolo (or vice versa if a future mode is added). Type lies to downstream code. Could flow into other places that check `mode === "..." `.
- **Suggested fix:** Add a guard: `if (c.mode !== undefined && c.mode !== "yolo" && c.mode !== "cautious") throw new Error(...)`. Or strip unknown modes to undefined and let the default apply.

---

## 10. Logic: cli.ts --resume accepts a flag as the session ID

- **Severity:** low
- **File:line:** `src/cli.ts:83-90`
- **Description:** `args[resumeIdx + 1]` is taken as the session ID with no validation. So `petricode --resume --list` parses `"--list"` as the session ID — fails to list, then bootstraps with that fake session ID (which won't be found in the DB, but the error happens INSIDE resumeSession at runtime, not at CLI parse time). Same hazard for `petricode --resume` (no arg after) — the early-return at line 86-89 catches `undefined`, but `petricode --resume -h` passes `-h` as the session ID.
- **Impact:** Confusing UX. `--resume --list` does nothing useful — neither lists nor resumes. Worse, since `--list` exits early at line 78 if it appears in args, but `args.includes("--list")` doesn't account for whether `--list` was meant as a value vs a flag, the `--list` branch fires FIRST, lists sessions, exits — and the `--resume` is silently ignored. Subtle precedence bug.
- **Suggested fix:** Reject session IDs that start with `-`. Or use a real arg parser (mri / minimist).

---

## 11. Resource: shell.ts timeout path leaves abort listener attached

- **Severity:** low
- **File:line:** `src/tools/shell.ts:39-49`
- **Description:** When the `setTimeout` fires (line 39-42), it calls `proc.kill("SIGKILL")` and `reject(...)`. It does NOT remove the abort listener registered at line 49 (`signal?.addEventListener("abort", onAbort, { once: true })`). The `{ once: true }` option means the listener auto-removes only if the event fires. But the listener still holds a reference to `proc` (already killed) and the (already-rejected) `reject` function. If the signal aborts later (e.g., user hits Ctrl+C after the timeout), `onAbort` fires, calls `proc.kill("SIGTERM")` on a dead process (no-op), `clearTimeout(timer)` on an expired timer (no-op), and `reject(new DOMException(...))` on an already-settled promise (no-op). No crash but the listener leaks until the AbortController is GC'd.
- **Impact:** Minor memory pressure across many timed-out shell calls in a long session. Mostly cosmetic.
- **Suggested fix:** Move the `signal?.removeEventListener("abort", onAbort)` call into the timeout branch as well. Cleanest: factor cleanup into a single `cleanup()` function called from all three paths (close, timeout, abort, error).

---

## 12. Logic: grep tool has no timeout and no signal handoff in test environments

- **Severity:** low
- **File:line:** `src/tools/grep.ts:31-71`
- **Description:** Unlike `shell.ts` which has a 30s default timeout, grep has NO timeout. A pathological pattern (catastrophic backtracking) or grepping a huge directory can run unbounded. Combined with bug #1 (no `cwd` set, so it runs in process.cwd which may be `~`), `grep -rn ".*" .` in a home directory can chew through millions of files for minutes. Abort works (signal is plumbed), but only if the user notices and hits Ctrl+C.
- **Impact:** Runaway grep can eat the entire `maxToolRounds` budget and block the conversation. Memory grows unbounded as `output` accumulates.
- **Suggested fix:** Add a default timeout (e.g. 30s) matching shell.ts. Add a max output size cap (e.g. 1MB) — truncate stdout buffer when exceeded.

---

## 13. Logic: edit tool's $-token replacer protection only applies to new_string, not to old_string parsing

- **Severity:** low
- **File:line:** `src/tools/edit.ts:62-65`
- **Description:** `content.replace(oldStr, () => newStr)` correctly uses a function replacer to dodge `$&`/`$1` token expansion in `newStr`. But `oldStr` is passed as a string (not a regex), so it's literal — that part is fine. The actual subtle bug: `content.split(oldStr).length - 1` (line 47) is used to count occurrences. If `oldStr === ""` (empty string), split produces `[content]` with length 1, count is 0, throws "not found". OK guarded. But for unicode: split treats string boundaries as code units, not grapheme clusters. So `oldStr = "👨‍👩‍👧"` (a grapheme cluster spanning multiple code units) compared against content with the same visual but different normalization (NFC vs NFD) produces 0 matches. Edit fails confusingly with "old_string not found" even though the file shows the same characters.
- **Impact:** Unicode edit failures on files written by other tools/editors that normalize differently. Rare, but bad UX when it happens.
- **Suggested fix:** Document that edit requires byte-exact match (current behavior). Or normalize both content and old_string to NFC before comparing (with a flag to disable for binary edits).

---

## 14. Persistence: SessionStore.read throws on missing/corrupted blob

- **Severity:** low
- **File:line:** `src/remember/sessionStore.ts:55-63` (`internalizeContent`) + `:38-41` (`readBlob`)
- **Description:** `internalizeContent` calls `this.readBlob(hash)` synchronously inside a `.map`. If the blob file is missing (manual cleanup, partial backup restore, fs corruption) or unreadable (permission flip), `readFileSync` throws ENOENT and the entire `read(sessionId)` call throws. `--resume` for that session then fails entirely — even if only ONE message references a missing blob, the user can't recover any of the session's messages.
- **Impact:** A single corrupt blob makes the entire session unrecoverable. No graceful degradation.
- **Suggested fix:** Wrap `readBlob` in try/catch inside `internalizeContent`. On failure, return the content with a `[blob missing: <hash>]` placeholder string. Log to crash.log. Allow the rest of the session to load.

---

## 15. Logic: matchesGlob does not escape regex metacharacters in skill paths frontmatter

- **Severity:** low
- **File:line:** `src/skills/activation.ts:78-95`
- **Description:** `matchesGlob` builds a regex from a glob pattern by escaping `.` and converting `*` / `**` — but does NOT escape `(`, `)`, `[`, `]`, `{`, `}`, `+`, `^`, `$`, `|`, `\`. A skill author who writes `paths: "src/(foo|bar)/**.ts"` (intending literal parens) ends up with a regex containing live alternation. Worst case: `paths: "test/[a-z]+.ts"` compiles to a regex with character class — this matches differently than the user expected and may even throw (e.g. `paths: "(["`) → `new RegExp(...)` throws SyntaxError, crashing skill activation for that input.
- **Impact:** Skill auto-trigger silently mis-fires for paths-with-parens, OR the trigger throws and breaks `matchAutoTriggers`, which has no try/catch around the regex construction (line 92). One bad skill kills auto-trigger for ALL skills on every input.
- **Suggested fix:** Escape ALL regex metacharacters before the wildcard substitution. Standard pattern: `glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")` BEFORE handling `*` / `**`. Wrap `new RegExp(...)` in try/catch and skip skills whose `paths` doesn't compile.

---

## 16. Spec violation: CircuitBreaker is implemented but never wired

- **Severity:** low
- **File:line:** `src/filter/circuitBreaker.ts` (implementation, ~140 lines) — only consumer is `test/circuitBreaker.test.ts`
- **Description:** `spec/03-filter.md:61-67` mandates a model-fallback circuit breaker as part of the Filter slot: "On quota exhaustion, fall back to a lower-tier model. TerminalQuotaError → trigger fallback handler. Reset retry counter on fallback. This is a Filter…". The `CircuitBreaker` class implements this fully, but `grep` shows it has zero call sites in `src/`. `RetryProvider` does not consult it; `Pipeline.turn` does not consult it. When a tier hits its quota, `RetryProvider` retries 3 times with exponential backoff and then throws — no fallback to a lower tier ever happens.
- **Impact:** Spec requirement not met. A primary-tier outage takes the whole pipeline down rather than degrading to reviewer/fast. Test coverage of the unwired component creates false confidence.
- **Suggested fix:** Either wire `CircuitBreaker` into the `RetryProvider` (or a new `FailoverProvider` wrapping the router) and have `pipeline.turn` route through it; OR delete the dead code and remove the spec section. The spec says it's required, so the wire-it path is correct.

---

## 17. Logic: maskToolOutput drops large outputs entirely with no recovery path

- **Severity:** low
- **File:line:** `src/filter/toolMasking.ts:12-24`
- **Description:** When tool output exceeds 10K-token threshold (~40KB), it's REPLACED with `[masked — N tokens]`. The actual output goes to `tc.result` (set in `toolSubpipe.ts:113`) and is persisted via SessionStore's blob mechanism — but the model NEVER sees it. There's no truncation alternative, no head/tail snippet, no offer-to-expand. The model is told "10000 tokens of output" and must guess what was there. For `file_read` of a 50KB file, the model gets nothing — it can't even attempt to summarize.
- **Impact:** Large file reads, broad grep results, and verbose shell commands become useless to the model. The user's mental model is "it ran" but the model has no information. Workaround for the user: ask the model to use a smaller scope, but the model can't know to do this preemptively.
- **Suggested fix:** Replace masked content with a head/tail snippet plus a hint: `[output truncated; first 500 chars: "..."; last 500 chars: "..."; full output saved to blob <hash>; ask user to expand if needed]`. Optionally add an `expand_output` tool that retrieves the blob.

---

## 18. UX: MessageList uses array index as React key for tool calls

- **Severity:** low
- **File:line:** `src/app/components/MessageList.tsx:38-40`
- **Description:** `turn.tool_calls?.map((tc, i) => <ToolGroup key={i} toolCall={tc} />)`. Using `i` as the key means React reconciliation breaks if the tool_calls array is mutated mid-render (e.g., when results come back and `tc.result` is set on the existing object, React diffs by index — fine if order is stable, but if a new tool is inserted or one is removed, all subsequent ToolGroups misalign). Each ToolCall has a stable `id` field — should use that.
- **Impact:** Possible visual glitches when tool calls update. Today probably benign because tool_calls order is set once at assembly time, but fragile.
- **Suggested fix:** `<ToolGroup key={tc.id} ... />`.

---

## 19. UX: ConsolidateReview can double-record decisions on rapid keystrokes

- **Severity:** low
- **File:line:** `src/app/components/ConsolidateReview.tsx:32-41`
- **Description:** `decide(action)` reads `current` and `index` from closure, then `setDecisions([...decisions, ...])` and `setIndex(index + 1)`. If the user mashes 'a' twice in the same render tick, the second `useInput` callback fires before React re-renders, so `current` and `index` still point to the SAME candidate. Result: candidate N gets two decisions appended and candidate N+1 is skipped entirely (its decision row is the second `a` recorded against N).
- **Impact:** Reviewing a long candidate list with quick approvals can desynchronize. User intends to approve A, A, B, A — gets A approved twice and B skipped silently.
- **Suggested fix:** Use a ref to track current index, OR use the functional setState form: `setDecisions(prev => [...prev, {candidate: candidates[prev.length], action}])` and derive `index` from `decisions.length`.

---

## 20. Logic: Markdown renderer uses module-level RegExp with /g flag

- **Severity:** low
- **File:line:** `src/app/components/Markdown.tsx:15`
- **Description:** `INLINE_RE` is declared once at module scope with the `g` flag. The function resets `INLINE_RE.lastIndex = 0` at line 23 before each use. Under React's concurrent rendering mode (or any future async render path), two `MarkdownLine` components rendering simultaneously can race on `lastIndex` — the second invocation's reset clobbers the first's iteration position.
- **Impact:** Today benign because Ink renders synchronously. Becomes a bug if React 19+ concurrent features are enabled or if `MarkdownLine` is ever rendered in parallel via `Suspense`.
- **Suggested fix:** Construct the regex inside `MarkdownLine` (cheap to build) OR use a non-global regex with `String.prototype.matchAll`.

---

## 21. Persistence: bracketed paste mode escape not restored on abnormal exit

- **Severity:** low
- **File:line:** `src/app/components/Composer.tsx:47-52`
- **Description:** `useEffect` enables bracketed paste with `\x1b[?2004h` on mount and disables with `\x1b[?2004l` on unmount. But if the process exits abnormally (uncaught exception → crash log → `process.exit(1)` in cli.ts:27, or SIGTERM/SIGKILL), the cleanup never runs. The user's terminal is left in bracketed-paste mode — subsequent shell commands in the same terminal show literal `^[[200~...^[[201~` around pasted text.
- **Impact:** Users who hit a petricode crash now have a "broken" shell until they manually run `printf '\e[?2004l'` or restart the terminal. Confusing because the symptom appears unrelated to petricode.
- **Suggested fix:** Register a `process.on("exit", ...)` handler in cli.ts (or in Composer's effect setup) that writes `\x1b[?2004l` on any exit path. Also handle `SIGINT` / `SIGTERM` to do the same before exiting.

---

## Summary

21 new bugs found, distinct from rounds 1–8.

- **3 high:** glob/grep/shell wrong cwd (#1), Google provider no signal in HTTP (#2), RetryProvider buffers entire stream (#3)
- **4 medium:** concurrent turn race after Ctrl+C (#4), assembleTurn drops split tool_use_start chunks (#5), cluster summaries strip tool_use → orphan tool_results (#6), loop detector key non-deterministic (#7)
- **14 low:** silent config swallow (#8), unvalidated mode (#9), --resume eats flags (#10), shell timeout listener leak (#11), grep no timeout (#12), edit unicode normalization (#13), blob missing throws (#14), glob regex escape (#15), CircuitBreaker dead code = spec violation (#16), maskToolOutput unrecoverable (#17), MessageList array-index keys (#18), ConsolidateReview double-decision race (#19), Markdown regex /g race (#20), bracketed-paste leak on crash (#21)

Highest-leverage fixes:
1. **#3** RetryProvider streaming — defeats the whole streaming UX in production
2. **#1** tool-cwd hijack — searches user's home directory by default
3. **#6** cluster summaries break Anthropic API — silently ticks any session past hot_capacity

**Test status: 199/199 pass.**
