# Bug Hunt Round 13 (opus)

Adversarial IV&V findings on petricode. Round 1–12 fixes excluded. Tests: 212/212 pass.

---

## 1. Security: `SkillStore.write/delete` accepts unsanitized skill names — path traversal writes/unlinks outside the skills directory

- **Severity:** medium-high
- **File:line:**
  - `src/remember/skillStore.ts:15-17` (`skillPath(name)`)
  - `src/remember/skillStore.ts:65-67` (`write` → `writeFileSync(skillPath(name), …)`)
  - `src/remember/skillStore.ts:79-84` (`delete` → `unlinkSync(skillPath(name))`)
- **Description:** `skillPath(name)` is `join(this.skillsDir, "${name}.md")` with no validation that the result stays inside `skillsDir`. Node's `path.join` resolves `".."` segments, so a name like `"../foo"` produces `<parent of skillsDir>/foo.md`.

  Verified locally:
  ```
  join("/tmp/skills", "../foo")          → /tmp/foo
  join("/tmp/skills", "../../etc/x")     → /etc/x
  join("/tmp/skills", "/etc/passwd")     → /tmp/skills/etc/passwd  (less dangerous)
  ```

  The full attack path for `write`:
  1. Model emits problem text containing a token like `"../../../tmp/evil"` (length > 3, no whitespace, so it survives the tokenizer at `consolidator.ts:67`).
  2. If that token ranks in the top-3 most-common words, `consolidator.ts:75` builds `name = topWords.join("-")` → `"../../../tmp/evil-foo-bar"`.
  3. Candidate is shown to the user in `ConsolidateReview`. A user who hits `[a]` without scrutinizing the name approves it.
  4. `commands/consolidate.ts:writeApproved` calls `remember.write_skill({name, …})` → `SkillStore.write` → `writeFileSync("<parent>/.../tmp/evil-foo-bar.md", body)`.

  `delete_skill(name)` is the symmetric attack: `unlinkSync(skillPath("../something"))` removes a file outside the skills directory. Today nothing in `src/` calls `delete_skill` with attacker-influenced input, but the `RememberSlot.delete_skill?(name)` contract is exposed and any future caller (or third-party plugin) inherits the hole.

  Note that the dot-traversal also bypasses the `.md` extension constraint when joined to a path that already has a different extension via the name itself — e.g. `name = "../etc/cron.d/job"` → `"../etc/cron.d/job.md"`, still arbitrary file write under `/etc/cron.d/`.

- **Impact:**
  - **Arbitrary file write** to any location reachable from the user running petricode (`<parent>/anywhere.md`), gated only by a one-keystroke human review that defaults to displaying just the name + 3-line body excerpt.
  - **Arbitrary file deletion** via `delete_skill` for any future caller that takes its `name` from untrusted input.
  - The skills directory is conventionally `<projectDir>/.petricode/skills` (`bootstrap.ts:100`); `..` escapes into `<projectDir>/.petricode/`, then `<projectDir>/`, then anywhere on disk.
  - Combined with round-12 #1 (the prompt-injection surface that pushes attacker text into the system role), an attacker could plausibly steer the consolidator's word ranking to include path-traversal tokens.

- **Suggested fix:** Validate the name in `SkillStore` before joining:

  ```ts
  private skillPath(name: string): string {
    if (!/^[A-Za-z0-9_\-]+$/.test(name)) {
      throw new Error(`SkillStore: invalid skill name '${name}' — must match /^[A-Za-z0-9_\\-]+$/`);
    }
    const resolved = resolve(this.skillsDir, `${name}.md`);
    const root = resolve(this.skillsDir);
    if (!resolved.startsWith(root + sep)) {
      throw new Error(`SkillStore: name '${name}' escapes skills directory`);
    }
    return resolved;
  }
  ```

  Mirror the same check in `consolidator.ts:75` (sanitize tokens to `[a-z0-9-]` before joining) so a malicious-but-not-yet-stored candidate never reaches the review UI with a path-bearing name.

---

## 2. Logic/Persistence: `Pipeline._runTurn` finally-block bails on first persist error AND replaces the original return/throw — user sees a SQLite error instead of their assistant turn

- **Severity:** medium
- **File:line:** `src/agent/pipeline.ts:139-153`
- **Description:**
  ```ts
  } finally {
    if (this.remember && pendingPersist.length > 0) {
      for (const t of pendingPersist) {
        await this.remember.append({
          kind: "perceived",
          source: this._sessionId,
          content: t.content,
          timestamp: t.timestamp,
          role: t.role,
        });
      }
    }
  }
  ```

  Two related defects in the same block:

  1. **No try/catch around `remember.append`.** If sqlite is locked, the WAL is full, the disk is full, FK enforcement fails, or the JSON serializes to something `INSERT` rejects, the loop throws on the failing turn. Subsequent turns in `pendingPersist` are never persisted — the cache and the persisted history diverge silently from this point.
  2. **`finally` overrides return.** Per ECMAScript semantics, a `throw` in a `finally` block replaces the pending normal completion (or pending throw) of the protected block. So even though `_turn` returned a perfectly good `currentTurn`, the caller (`pipeline.turn` → `App.handleSubmit`) catches the SQLite error and renders `[error] SQLITE_BUSY: database is locked` in place of the assistant's actual response. The user sees a hard failure for what was actually a successful generation.

  Also note: an interrupted partial persist leaves the `messages` table in an inconsistent state — the `tool_calls` table is never populated by `append` anyway (covered in round 12 #5), and now even the message rows themselves are missing for late entries. A subsequent `--resume` will load an incomplete tail and the model will see a turn graph with orphaned tool_use entries (no matching tool_result).

- **Impact:** Single sqlite hiccup → user-visible loss of an entire successful turn AND a confusing error toast that points at storage rather than the actual generation. After multiple such hiccups, the persisted session can no longer be resumed cleanly because tool_use/tool_result pairs get split across the persistence boundary.

- **Suggested fix:** Catch per-turn, log, and don't let persist errors mask the protected block's outcome:

  ```ts
  } finally {
    if (this.remember && pendingPersist.length > 0) {
      for (const t of pendingPersist) {
        try {
          await this.remember.append({ … });
        } catch (persistErr) {
          // Best-effort log; never let persistence override the turn's own outcome.
          console.error(`pipeline: failed to persist turn ${t.id}:`, persistErr);
        }
      }
    }
  }
  ```

  Better still: surface a soft "persist failed for N of M turns" diagnostic via a separate channel (status bar warning) so silent divergence is visible.

---

## 3. Logic: `OpenAIProvider` drops a tool_call entirely when `id` and `name` arrive separately and the stream ends before both are present

- **Severity:** low-medium
- **File:line:** `src/providers/openai.ts:152-189`
- **Description:** The per-index `pending` map buffers `tc.function.arguments` whenever the call hasn't yet been "started" (i.e., neither id nor name has arrived). `tool_use_start` is gated on BOTH `entry.id` AND `entry.name` being set:

  ```ts
  if (!entry.started && entry.id && entry.name) {
    yield { type: "tool_use_start", … };
    entry.started = true;
    if (entry.argsBuffer) {
      yield { type: "tool_use_delta", input_json: entry.argsBuffer, index: idx };
      entry.argsBuffer = "";
    }
  }
  ```

  If the upstream stream finishes (terminates the `for await`, regardless of `finish_reason`) while one of the two is still missing, the buffered args AND the entire tool call are silently discarded. `assembleTurn` never sees a `tool_use_start` for that index, so neither `content` nor `tool_calls` reflects it. The assistant turn is committed without the tool call the model attempted.

  How it happens in practice:
  - OpenAI delivers chunks in [name + partial-args, partial-args, partial-args, …, finish_reason=length]. The id arrives in a later chunk that gets cut off by truncation. `entry.id` stays undefined; the call is dropped.
  - Inverse case: id-first then name-truncated.
  - Both cases are observed under `finish_reason === "length"`. Round 12 #4 was fixed to emit `done` on any terminal finish_reason, but `done` doesn't recover dropped tool calls — it only signals completion to the consumer.

  Comparison: the corresponding case in Anthropic (`anthropic.ts:117-119`) emits `tool_use_start` with id+name from the single `content_block_start` event, which is atomic — so the same failure mode doesn't exist there. Google (`google.ts:179-194`) emits both at once. OpenAI is the only provider with this multi-chunk start hazard.

- **Impact:** Models that get truncated mid-tool-call have their tool intent silently lost. The assistant turn looks incomplete (text-only, no follow-through), and the model can't see in subsequent rounds that the tool call was attempted. Hard to diagnose without logging.

- **Suggested fix:** At end-of-stream (when `for await` exits), iterate `pending` and either:
  1. Emit a malformed-call warning chunk (e.g., an extra `content_delta` with `[warning: incomplete tool call dropped]`), OR
  2. If at least `entry.name` is present, synthesize a placeholder id and emit `tool_use_start` + the buffered args, so the call is preserved (assembleTurn already handles malformed JSON gracefully via `[malformed tool JSON: …]`).

  The second option mirrors what Anthropic does implicitly via its single-event tool_use_start.

---

## 4. Logic: `OpenAIProvider.toOpenAIMessages` produces `{ role: "assistant", content: null, no tool_calls }` for empty assistant turns — OpenAI rejects with 400

- **Severity:** low
- **File:line:** `src/providers/openai.ts:56-79`
- **Description:**
  ```ts
  if (role === "assistant") {
    const toolUses = turn.filter((b) => b.type === "tool_use");
    const textBlocks = turn.filter((b) => b.type === "text");
    const msg = {
      role: "assistant",
      content: textBlocks.length > 0
        ? textBlocks.map(...).join("")
        : null,
    };
    if (toolUses.length > 0) {
      msg.tool_calls = toolUses.map(...);
    }
    messages.push(msg);
  }
  ```

  When `textBlocks.length === 0` AND `toolUses.length === 0`, the resulting message has `content: null` and no `tool_calls` field. OpenAI's API requires at least one of them; the request fails with `400 Invalid 'messages[N]': must contain content or tool_calls`.

  How a turn can reach this state:
  - `commitInterruptedToolCalls` (`pipeline.ts:426-450`) commits the assistant turn AS-IS. If `assembleTurn` was interrupted before any text or tool_use_start landed, the turn has `content: []`. The next user submit pulls this turn from cache and hands it to the OpenAI provider → 400.
  - `commitInterruptedToolCalls` is called when `signal.aborted` is detected post-stream (`pipeline.ts:235-243`) AND when the loop's abort guard fires (`pipeline.ts:303, 321, 332`). Each of those takes `currentTurn` directly from the prior iteration; `currentTurn.content` could legitimately be `[]` if the stream was cut off before any content block opened.
  - Resume loads the empty turn back into cache via `cache.append`, perpetuating the problem across sessions.

  Anthropic (`anthropic.ts:84-87`) maps `Content[]` directly via `toAnthropicContent`, which produces an empty array — Anthropic rejects empty `content` arrays similarly but with a different error.

- **Impact:** A single interrupted turn poisons the next request to OpenAI. The user types a follow-up, sees `[error] 400 …`, has no obvious way to clean the cache, and can only recover via `/clear` or restart. Cross-provider consistency hazard: the same cached turn might work fine on Anthropic and fail on OpenAI.

- **Suggested fix:** Guard against null/empty assistant messages in `toOpenAIMessages`:

  ```ts
  if (textBlocks.length === 0 && toolUses.length === 0) {
    // Drop the empty assistant message entirely — it carries no information
    // and OpenAI rejects the request.
    continue;
  }
  ```

  Also: `commitInterruptedToolCalls` should refuse to commit a turn with no content AND no tool_calls (early-return) so empty assistant turns never enter the cache in the first place.

---

## 5. Logic: end-of-max-rounds final-response can still emit tool_use, and that turn is committed with orphaned tool_use blocks

- **Severity:** low
- **File:line:** `src/agent/pipeline.ts:276-296` and `:389`
- **Description:** When `round === maxToolRounds - 1`, the pipeline:
  1. Commits `currentTurn` (the round-N-1 assistant turn that still has tool_calls).
  2. Commits `syntheticTurn` with `[max tool rounds exceeded]` tool_results.
  3. Calls `assembleTurn(primary.generate(finalConvo, ...))` for a final cleanup response.
  4. Breaks out of the loop.

  The final cleanup `currentTurn` is committed at line 389 unconditionally. But the model is free to emit MORE tool_use blocks in this final response — and the prompt that produced it included the toolDefs (the `finalConvo` is a fresh `primary.generate` call, but `toolDefs` was set per-call earlier; here at line 295 NO `tools:` is passed, so the model SHOULDN'T see them and shouldn't emit tool_use):

  ```ts
  currentTurn = await assembleTurn(primary.generate(finalConvo, { signal }), signal);
  ```

  Note: `{ signal }` only — `tools: toolDefs` is omitted. So in practice the model can't emit tool calls. **But**: some providers (notably Google) treat `tools` as session-scoped or accept tool calls regardless of declaration; an Anthropic model that previously had tools described might still emit a `tool_use` block in pathological cases (the Anthropic API docs say tools must be declared per-request, but sandbox/Vertex behavior has varied). And: if the cleanup response produces an empty turn (no text, no tools) — also possible — then `commitTurn(currentTurn)` at line 389 commits an empty assistant turn, hitting bug #4 on the next user submit.

  The defensive thing is to enforce structural validity here:
  - If `currentTurn.tool_calls?.length > 0`, synthesize tool_results immediately (or strip the tool_calls and rewrite as text).
  - If `currentTurn.content` is empty, replace with an explanatory `[max tool rounds reached without final response]` text block.

- **Impact:** Latent. Today no provider should emit unsolicited tool_use. But a future provider, prompt-cached prior turn, or vendor SDK quirk could create an orphaned tool_use that breaks the next turn's prompt assembly.

- **Suggested fix:**
  ```ts
  currentTurn = await assembleTurn(primary.generate(finalConvo, { signal }), signal);
  // Defensive: the cleanup turn must have no tool_calls (we passed no tools)
  // and must have non-empty content (otherwise providers reject the next
  // request). Sanitize before committing.
  if (currentTurn.tool_calls && currentTurn.tool_calls.length > 0) {
    currentTurn = { ...currentTurn, tool_calls: undefined };
  }
  if (currentTurn.content.length === 0) {
    currentTurn = {
      ...currentTurn,
      content: [{ type: "text", text: "[max tool rounds reached]" }],
    };
  }
  break;
  ```

---

## 6. UX/Logic: `expandFileRefs` consumes trailing punctuation that it stripped from the path

- **Severity:** low
- **File:line:** `src/perceive/fileRefs.ts:21-42`
- **Description:** The flow:
  1. Match `@([^\s]+)` — captures `@foo,` (full match) with `rawPath = "foo,"`.
  2. Strip trailing punctuation: `filePath = "foo"`.
  3. Validate, read, store `replacements.set("@foo,", "<file path=\"foo\">…</file>")`.
  4. `input.replace(FILE_REF_PATTERN, fullMatch => replacements.get(fullMatch) ?? fullMatch)` — the full match `@foo,` is replaced wholesale with the file content. **The comma the user wrote is silently consumed.**

  Reproduction: input `"What does @README.md, @LICENSE say?"` becomes `"What does <file>…</file> <file>…</file> say?"` — the comma between the two refs vanishes, so the final prose reads slightly wrong to the model.

- **Impact:** Mild prose corruption in user prompts containing `@file,` or `@file.` patterns. Worse case: `@file.` (period) — a sentence-ending period is gone, two sentences get merged. Probably not a major model degradation but noticeably wrong if the user reviews the assembled prompt.

- **Suggested fix:** Track the stripped suffix per match and reattach it during replacement:

  ```ts
  const replacements = new Map<string, string>();
  for (const match of matches) {
    const fullMatch = match[0]!;
    if (replacements.has(fullMatch)) continue;
    const rawPath = match[1]!;
    const trailingMatch = rawPath.match(/[.,;:!?]+$/);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const filePath = trailing ? rawPath.slice(0, -trailing.length) : rawPath;
    if (validateFilePath(filePath, projectDir)) continue;
    const absPath = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
    try {
      const contents = await readFile(absPath, "utf-8");
      replacements.set(
        fullMatch,
        `\n<file path="${filePath}">\n${contents}\n</file>${trailing}`,
      );
    } catch {}
  }
  ```

---

## 7. Logic: `assembleContext` returns an empty-text user message when both system_content and content are empty — providers may reject

- **Severity:** low
- **File:line:** `src/agent/context.ts:29-34`
- **Description:**
  ```ts
  if (userParts.length > 0) {
    messages.push({ role: "user", content: userParts });
  } else {
    // Fallback: at minimum produce an empty user message
    messages.push({ role: "user", content: [{ type: "text", text: "" }] });
  }
  ```

  An empty user input combined with no perceived context (no `CLAUDE.md`, no `.agents/`, no skills) produces this fallback. Anthropic's API rejects content blocks with `text: ""`:
  > `messages.0.content.0.text: Field required and must not be empty.`

  OpenAI and Google are more lenient but the empty user message still pollutes the conversation history. The fallback was added presumably to avoid the "no messages at all" failure mode, but the cure (an empty text block) and the disease (zero messages) both produce 400s on Anthropic.

  When does this trigger?
  - User input is empty/whitespace-only after trim. The pipeline's `Composer.tsx:122-126` trims and only submits non-empty input — so the TUI shouldn't hit this.
  - But: `Pipeline.turn(input)` is also called by tests, scripts, or an auto-trigger pipeline that doesn't go through the TUI. Empty `input` reaches `Perceiver.perceive` which produces `content: [{type:"text",text:""}]`. `assembleContext` finds userParts.length > 0 (one block, even if empty text). So it pushes that block, NOT the fallback. Either way, an empty-text user message goes to the provider.

- **Impact:** Headless / scripted callers that pass empty input get a confusing provider error rather than a clean `Error("input is empty")`. Real but narrow.

- **Suggested fix:** Either:
  1. Have `Pipeline.turn` validate non-empty `input` up front and throw a clear error.
  2. Have `assembleContext` filter out empty-text blocks from `userParts` and use the fallback only when ALL non-empty parts are absent.

  Option 1 also closes a class of similar issues throughout the pipeline (cache appends, persistence, etc.).

---

## 8. Logic: `OpenAIProvider.toOpenAIMessages` reorders text blocks past tool_result blocks within the same turn

- **Severity:** low (latent — Pipeline doesn't currently mix them in one turn)
- **File:line:** `src/providers/openai.ts:30-54`
- **Description:** When a turn has both `tool_result` blocks and `text` blocks, ALL tool_results are emitted as `tool` messages first, then the residual text becomes a separate `user` message:

  ```ts
  const toolResults = turn.filter((b) => b.type === "tool_result");
  if (toolResults.length > 0) {
    for (const tr of toolResults) {
      messages.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.content });
    }
    const rest = turn.filter((b) => b.type !== "tool_result");
    if (rest.length > 0) {
      messages.push({ role: role as "user", content: rest.map(...) });
    }
    continue;
  }
  ```

  If the original turn was `[text("hello"), tool_result(…)]`, the OpenAI mapping becomes `[tool_msg, user_msg("hello")]` — the text is **moved after** the tool_result, inverting the original order.

  Today the pipeline always commits text and tool_results in separate turns (`pipeline.ts:339-345` makes a dedicated user turn for tool_results). So the bug is latent for the pipeline. But:
  - Direct callers of `OpenAIProvider.generate` (e.g., `consolidate/extractor.ts` collect path, `convergence/volley.ts`) build their own messages — though these don't mix text and tool_result either.
  - Resume ingests persisted turns directly. If a future feature merges adjacent same-role turns (a reasonable optimization), this reordering would activate.
  - A custom plugin or third-party caller that builds richer turns will hit it.

  The cross-provider asymmetry is the more concerning part: Anthropic preserves order via `toAnthropicContent`; OpenAI silently reorders. A test that passes on Anthropic and fails on OpenAI's API will fingerprint as a vendor bug, not a petricode bug.

- **Impact:** Latent. Could surface as silent semantic corruption when a multi-block turn flows through OpenAI.

- **Suggested fix:** Walk content blocks in order and emit messages in the same order:

  ```ts
  // Emit tool messages and user/assistant messages in original order
  const buf: typeof messages = [];
  let restAcc: Content[] = [];
  const flushRest = () => {
    if (restAcc.length === 0) return;
    buf.push({ role: role as "user", content: restAcc.map(b => /* … */) });
    restAcc = [];
  };
  for (const b of turn) {
    if (b.type === "tool_result") {
      flushRest();
      buf.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
    } else {
      restAcc.push(b);
    }
  }
  flushRest();
  messages.push(...buf);
  ```

---

## Summary

8 new bugs found, distinct from rounds 1–12. **Tests: 212/212 pass.**

- **0 high**
- **2 medium:** SkillStore name path traversal (#1), Pipeline persist-error masks turn outcome (#2)
- **6 low:** OpenAI multi-chunk tool_call drop (#3), OpenAI null/empty assistant rejection (#4), max-rounds final-turn structural validation (#5), expandFileRefs eats trailing punctuation (#6), empty-input fallback hits provider 400 (#7), OpenAI tool_result/text reorder (#8)

Highest-leverage fix: **#1** — closes a real arbitrary-file-write surface gated only by single-keystroke human review. Fix is one regex check in `SkillStore.skillPath` plus name sanitization in `consolidator.ts:75`. The same shape (path traversal via attacker-supplied filename component joined to a base directory) appears in many TUI agents and is exactly the class of bug avionics IV&V calls "trust-boundary leakage at the persistence seam."

This round leans hard on integration seams between layers added in rounds 9–12: the prompt-injection fix in round 12 #1 closes one channel for attacker text, but the consolidator's name pipeline (#1 above) and the OpenAI provider's tool_call assembly (#3, #4, #8) remain undefended. The hunt is approaching but has not yet reached convergence — at least #1, #2, and #4 are real and reachable today.
