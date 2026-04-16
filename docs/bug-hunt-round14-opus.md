# Bug Hunt Round 14 (opus)

Adversarial IV&V findings on petricode. Round 1–13 fixes excluded. Tests: 212/212 pass; typecheck clean.

---

## 1. `assembleTurn` flushes the active tool prematurely on the next `tool_use_start`, dropping later deltas for the prior tool

- **Severity:** medium
- **File:line:**
  - `src/agent/turn.ts:54-72` (`tool_use_start` case in `assembleTurn`)
  - `src/providers/openai.ts:166-194` (OpenAI per-chunk delta loop)
- **Description:** When the model emits parallel tool calls, OpenAI's `chat.completions.create(stream:true)` may interleave argument deltas across multiple `tc.index` values within a single SSE chunk and across consecutive chunks. The provider faithfully forwards each fragment as a `tool_use_delta { index }`. `assembleTurn`'s `tool_use_start` handler, however, **flushes _every_ in-flight tool and then `toolMap.clear()`s** before installing the new entry:

  ```ts
  case "tool_use_start": {
    const idx = chunk.index ?? 0;
    for (const existingIdx of [...toolMap.keys()].sort(...)) {
      flushTool(toolMap.get(existingIdx)!, content, toolCalls);
    }
    toolMap.clear();
    ...
    toolMap.set(idx, { id: chunk.id, name: chunk.name, jsonBuf: "" });
  }
  ```

  Concrete failing trace (parallel tool call, OpenAI streaming):

  | chunk | OpenAI delta payload | provider yields | assembleTurn state |
  |---|---|---|---|
  | 1 | `tc[0]` id=`call_a` name=`grep` | `tool_use_start{idx:0,id:call_a,name:grep}` | toolMap = {0} |
  | 2 | `tc[0]` arguments=`{"pattern":"foo` | `tool_use_delta{idx:0, "{"pattern":"foo"}` | toolMap[0].jsonBuf grows |
  | 3 | `tc[1]` id=`call_b` name=`glob` | `tool_use_start{idx:1,id:call_b,name:glob}` | **flushes idx 0 with truncated `{"pattern":"foo`, JSON.parse fails → args={}**, toolMap = {1} |
  | 4 | `tc[0]` arguments=`"}` | `tool_use_delta{idx:0, "}` | **toolMap.get(0) is undefined → silently dropped** (`if (tool) tool.jsonBuf += …`) |
  | 5 | `tc[1]` arguments=`{"pattern":"bar"}` | `tool_use_delta{idx:1, ...}` | toolMap[1].jsonBuf grows normally |
  | 6 | finish_reason=`tool_calls` | `done` | flush idx 1, push `[malformed tool JSON: {"pattern":"foo]` placeholder for idx 0 |

  Result: tool_call at index 0 is recorded with `args = {}` (or worse, succeeds with partial JSON if the truncation happens to land on a closing brace), and the conversation gains a garbage `[malformed tool JSON: …]` text block. The user sees a tool invocation that runs grep with no arguments, or with corrupted args.

  Anthropic's wire format is immune (one block at a time), but OpenAI explicitly supports interleaved parallel tool deltas, and Google in this codebase yields a single complete delta per call (also fine). The bug window is OpenAI parallel tool calls with arguments split across chunks. With long argument payloads (e.g., `edit` with multi-line `new_string`) this is reachable.

- **Impact:** Silent corruption of OpenAI parallel tool-call arguments. The model intends to run `grep("error")` and `glob("**/*.ts")`; the agent instead runs `grep()` with empty args and `glob("**/*.ts")`. Failure surface depends on the tool — `edit` with empty args throws "missing required argument", `shell` with empty command throws likewise. In the worst case (a tool with no required args), the wrong action is silently executed.

- **Suggested fix:** Don't flush other tools when a new `tool_use_start` arrives. Each tool's lifecycle should end at `done` (or at the safety-flush after the loop), not on the next sibling's start. The "flush text before new tool" comment applies to `textBuffer`, not to other in-flight tools. Either:
  - Keep `toolMap` keyed by index across the entire stream; only flush at `done` / end-of-stream. Maintain an `order` array if positional output matters.
  - Or, if intermediate flush is desired for memory reasons, only flush tools whose index is `< idx` AND whose `jsonBuf` is known to be JSON-complete (e.g., balanced braces) — much harder to get right.

  A regression test should yield interleaved deltas:
  ```ts
  yield { type: "tool_use_start", id: "a", name: "grep", index: 0 };
  yield { type: "tool_use_delta", input_json: '{"pattern":"foo', index: 0 };
  yield { type: "tool_use_start", id: "b", name: "glob", index: 1 };
  yield { type: "tool_use_delta", input_json: '"}', index: 0 };
  yield { type: "tool_use_delta", input_json: '{"pattern":"bar"}', index: 1 };
  yield { type: "done" };
  // expect tool_calls[0].args.pattern === "foo"
  ```

---

## 2. `Pipeline.turn` serialization breaks under multiple concurrent callers — the `await prior` chain only synchronizes one caller deep

- **Severity:** medium
- **File:line:** `src/agent/pipeline.ts:118-129` (`Pipeline.turn`)
- **Description:** The `inFlight` lock was added (round 12) to serialize turns so a second submit can't interleave cache writes with the first turn's `finally` persistence. The implementation:

  ```ts
  const prior = this.inFlight;
  if (prior) await prior.catch(() => {});

  const promise = this._runTurn(input, options);
  const wrapped: Promise<unknown> = promise.finally(() => {
    if (this.inFlight === wrapped) this.inFlight = null;
  });
  this.inFlight = wrapped;
  return promise;
  ```

  This serializes two callers but breaks down with three or more queued in parallel. Trace with three concurrent `pipeline.turn(...)` calls when an earlier `T0` is in flight:

  1. T0 is running; `this.inFlight === wrapped_T0`.
  2. Caller A enters `turn()`, reads `prior = wrapped_T0`, awaits it.
  3. Caller B enters `turn()`, also reads `prior = wrapped_T0`, awaits it.
  4. Caller C enters `turn()`, also reads `prior = wrapped_T0`, awaits it.
  5. `wrapped_T0` settles. The microtask queue wakes A, then B, then C, all in the same synchronous run.
  6. A executes `const promise = this._runTurn(input_A);` — this is `async`, so it runs synchronously until its first `await` (`await this.perceiver.perceive(input)`). A then yields. A also synchronously sets `this.inFlight = wrapped_A`.
  7. B's microtask runs next. B does **not** re-check `this.inFlight`; it goes straight to `const promise = this._runTurn(input_B);`. B's `_runTurn` runs synchronously until its first `await`. B sets `this.inFlight = wrapped_B`.
  8. C similarly starts `_runTurn(input_C)` and overwrites `this.inFlight = wrapped_C`.

  Now `_runTurn(A)`, `_runTurn(B)`, and `_runTurn(C)` are all in flight concurrently:
  - All three call `this.cache.append(userTurn)` interleaved → cache history reorders.
  - All three call `this.router.get("primary").generate(...)` against the same Anthropic client → the Anthropic SDK is fine with parallel streams, but the resulting tool-result turns are committed to a shared `this.cache` in arrival order, so a tool_use from A may be followed by a tool_result from B (different `tool_use_id`).
  - Anthropic rejects the next prompt with `tool_use ids must be matched by tool_result blocks in the next user message` because the cache is now structurally invalid.
  - Persistence in `finally` interleaves three `pendingPersist` lists into the SQLite store with overlapping timestamps; resume order is non-deterministic.

  In the TUI, `App.tsx` has `if (abortRef.current) return;` (line 138) which usually prevents queueing two in-flight turns. But:
  - Headless callers (tests, programmatic embedders, the upcoming `--exec` mode) have no such guard. The `Pipeline` class is the public boundary; callers reasonably expect it to serialize.
  - Even in the TUI, `abortRef` is cleared the instant Ctrl+C fires (App.tsx:81), so a user who hits Ctrl+C and then immediately re-submits while the prior pipeline call is still draining its `finally` block can queue a second caller behind a not-yet-cleared `inFlight`.

- **Impact:** Cache corruption (out-of-order tool_use/tool_result), Anthropic 400 on the next turn, non-deterministic session persistence. Hard to reproduce intentionally but would silently break headless test fleets and any future API/server wrapping of Pipeline.

- **Suggested fix:** Re-check after the await, in a loop:

  ```ts
  async turn(input: string, options?): Promise<Turn> {
    if (!input || input.trim().length === 0) {
      throw new Error("Pipeline.turn: input is empty");
    }
    // Drain whatever is currently in flight, even if a new prior appears
    // while we wait — common when many callers queue on the same prior.
    while (this.inFlight) {
      await this.inFlight.catch(() => {});
    }
    const promise = this._runTurn(input, options);
    const wrapped = promise.finally(() => {
      if (this.inFlight === wrapped) this.inFlight = null;
    });
    this.inFlight = wrapped;
    return promise;
  }
  ```

  The `while` loop guarantees that when we proceed past it, `this.inFlight` is `null`, so we are the unambiguous successor. This still has a tiny scheduling window between the `null` check and the `this.inFlight = wrapped` assignment, but in single-threaded JS those two statements run synchronously with no `await` between them, so they are atomic relative to other queued microtasks.

---

## Summary

Two new bugs. Both are integration-seam issues:
- **#1** is a Provider→assembleTurn data-shape mismatch: OpenAI's interleaved parallel tool deltas violate assembleTurn's "one tool at a time" assumption.
- **#2** is a synchronization regression in the `inFlight` serialization that protects Pipeline state against concurrent turns; the protection only works for two-deep concurrency.

Areas re-examined and cleared (no new bugs found):
- Anthropic provider stream events, message_delta truncation handling
- Google provider tool-call wrapping, abort propagation
- TfIdfIndex eviction & live_n bookkeeping
- UnionFindCache tool_use/tool_result pairing during overflow
- Loop detector canonical JSON, threshold counting
- Path validation, symlink walks, search-path containment
- File tools (read/write/edit/glob/grep/shell) cwd resolution and abort cleanup
- Composer bracketed-paste handling, useInput stale closures
- ConsolidateReview double-fire guard
- Skill activation glob escaping, $ARGUMENTS substitution
- SkillStore name validation
- SessionStore blob externalization, BLOB_PREFIX collision
- Volley convergence detection, self-review check
- Retry sleep abort listener cleanup
- toolSubpipe abort propagation, max-tool-rounds guard
- expandFileRefs trailing punctuation reattachment

The hunt is converging — both findings are deep edge cases requiring specific provider behavior or unusual call patterns to trigger.
