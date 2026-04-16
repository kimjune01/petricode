# Bug Hunt Round 11 (opus)

Adversarial IV&V findings on petricode. Round 1–10 fixes excluded. Tests: 206/206 pass.

---

## 1. Security/Logic: file_read / file_write / edit tools resolve relative paths against `process.cwd()`, not `projectDir`

- **Severity:** high
- **File:line:**
  - `src/tools/readFile.ts:18` (`fsReadFile(path, "utf-8")`)
  - `src/tools/writeFile.ts:23-24` (`mkdir(dirname(path), …)` + `fsWriteFile(path, …)`)
  - `src/tools/edit.ts:30` (`readFile(path, "utf-8")`) and `:67` (`writeFile(path, updated, …)`)
- **Description:** Round 9 plumbed `opts.cwd` (= projectDir) into `glob`/`grep`/`shell`, and round 10 fixed the same hazard in `perceive/fileRefs.ts`. The three filesystem tools were missed. Each accepts `args.path` and hands it straight to `fs/promises.readFile` / `writeFile` / `mkdir`, which resolve relative paths against **process.cwd()**, not against `opts.cwd`.

  `validateFilePath` (called from `toolSubpipe.ts:54` via `validateToolArgs`) confirms that `path.resolve(projectDir, path)` falls inside `projectDir` — so a relative path like `path: "src/foo.ts"` validates whenever `<projectDir>/src/foo.ts` exists. But the actual read then runs `readFile("src/foo.ts")`, which is `<process.cwd()>/src/foo.ts`.

  Today `bootstrap.ts:64` defaults `projectDir = opts.projectDir ?? process.cwd()`, so the public `bootstrap()` API explicitly allows the two to differ (and round-10's fileRefs commit message acknowledges this is a real launch mode). When they diverge, the validator green-lights the path under one base and the IO runs under another.

- **Impact:**
  - **Wrong file read.** `file_read({path: "README.md"})` returns whatever `<process.cwd()>/README.md` happens to contain, while displaying it as the project's README in the model context.
  - **Wrong file overwritten.** `file_write({path: "src/foo.ts", content: "…"})` creates / overwrites `<process.cwd()>/src/foo.ts`, potentially clobbering an unrelated file in a sibling project.
  - **Symlink protection bypass.** `validateFilePath` walks symlinks under `projectDir` to confirm they don't escape. The IO call then bypasses that check entirely because it reads from a different base whose symlink layout was never inspected.
  - **Edit silently no-ops or hits the wrong file.** `edit` reads/writes via the same path twice; both use the wrong base. The model is told "Replaced 1 occurrence in src/foo.ts" but the project's `src/foo.ts` is unchanged.

- **Suggested fix:** In all three tools, accept `opts.cwd` and resolve before IO, mirroring the round-10 fileRefs fix:

  ```ts
  import { isAbsolute, resolve } from "path";
  // ...
  const resolved = isAbsolute(path) ? path : resolve(opts?.cwd ?? process.cwd(), path);
  await fsReadFile(resolved, "utf-8");
  ```

  Add tests that change `process.cwd()` away from `projectDir`, then call each of the three tools with a relative `path` arg, and assert the IO targets `<projectDir>/<path>`.

---

## 2. Security/Logic: `glob` tool uses `args.path` as `cwd` without resolving against `projectRoot`

- **Severity:** medium
- **File:line:** `src/tools/glob.ts:24,35` (`const cwd = (args.path as string) ?? projectRoot;` then `glob.scan({ cwd, dot: false })`)
- **Description:** The round-9 fix made `projectRoot = opts?.cwd ?? process.cwd()`, but the LLM-supplied `args.path` is then used verbatim as the scanner's `cwd`. `BunGlob.scan({ cwd: "src" })` resolves relative `cwd` against **process.cwd()**, not `projectRoot`. So `glob({ pattern: "**/*.ts", path: "src" })` validated through `validateSearchPath(projectDir, "src")` (which confirms `<projectDir>/src` is inside `projectDir`) actually scans `<process.cwd()>/src`.

  Same divergence window as bug #1.

- **Impact:** When projectDir != process.cwd() and the LLM passes a relative `path`, `glob` walks an unrelated subtree. Combined with the validator giving a green light, the model is fed file paths it couldn't otherwise see. The gitignore predicate is rooted at `projectRoot` and so cannot mask `.env` files in the wrongly-scanned tree.

- **Suggested fix:**

  ```ts
  const rawPath = (args.path as string | undefined);
  const cwd = rawPath
    ? (isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath))
    : projectRoot;
  ```

  Apply the same to `grep.ts:33` (`searchPath = (args.path as string) ?? "."`) — `grep` already passes `cwd: projectRoot` to `spawn`, so the relative `searchPath` argument is then resolved correctly by grep itself, but the lookup base is opaque. Resolving explicitly avoids surprise if the search path semantics change.

---

## 3. UX: `RetryProvider` ignores the abort signal during exponential-backoff sleep

- **Severity:** medium
- **File:line:** `src/providers/retry.ts:66-68` (`sleep`) + `:104-105` (`await sleep(delay)`)
- **Description:** When the inner provider throws a transient error (429/500/502/503/529), `RetryProvider` waits `jitteredDelay(attempt, config)` — up to `maxDelayMs = 30_000` per attempt — before the next retry. The sleep is implemented as a bare `setTimeout` Promise with no signal handling.

  If the user hits Ctrl+C during the backoff, `config.signal` aborts but `sleep()` keeps ticking. After the sleep finally resolves, the retry tries `inner.generate(prompt, config)`, which immediately throws `AbortError` from the provider's signal check — but only AFTER up to 30 s of dead time. With `maxRetries = 3`, the cumulative dead time can reach ~90 s of "stuck" UX between Ctrl+C and the pipeline actually unwinding.

- **Impact:** Ctrl+C feels broken when a tier is rate-limited. The TUI shows "Interrupted." (App.tsx:87 fires synchronously) but the next user submit blocks because `inFlight` (pipeline.ts:112-113) is still awaiting the prior turn, which is sleeping. The user sees a frozen prompt for tens of seconds with no indication anything is happening.

- **Suggested fix:** Make `sleep` signal-aware:

  ```ts
  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  // …
  await sleep(delay, config.signal);
  ```

  Also add an early `if (config.signal?.aborted) throw new DOMException(...)` at the top of each retry iteration to skip the next attempt's setup work.

---

## 4. Logic: `TfIdfIndex.recompute_idf` uses `documents.length` (includes tombstones) for corpus size

- **Severity:** medium (subtle correctness — round-10 fix is incomplete)
- **File:line:** `src/cache/tfidf.ts:60` (`const n = this.documents.length;`)
- **Description:** Round 10 added `remove_document(index)` that tombstones an evicted document by setting `this.documents[index] = []`, and the `enforce_cap` path now calls it on cluster eviction. But `recompute_idf` still uses **`this.documents.length`** as the corpus size `n`. Tombstones (empty arrays) still count toward `n`, even though they contribute zero to `doc_freq` (the inner `new Set(doc)` over an empty array yields an empty set).

  Concrete: after evicting K of N total documents, `n = N` but the live corpus is `N - K`. The IDF formula `log((n + 1) / (df + 1)) + 1` therefore over-weights `n` relative to `df`, inflating IDF for every term. As K grows over a long session, every term gets a larger and larger weight, and term-vs-term differentiation degrades.

  The vectorize fallback at line 85 (`Math.log((this.documents.length + 1) / 1) + 1`) for unseen terms has the same bug.

  The `live_document_count()` helper exists (line 49-55) but is unused.

- **Impact:** In a multi-hour session with frequent cluster evictions, IDF weights drift upward. `cosine_similarity` for `nearest_root` shifts toward terms that happen to appear in many evicted documents (their `df` is now stale relative to `n`). Merge decisions in `graduate()` start picking the wrong cluster; the cold zone's clustering quality degrades over time exactly when good clustering matters most.

  This is a subtler version of round 10 #2: the fix prevented memory leak but not the IDF-skew aspect that motivated half the original report.

- **Suggested fix:** Use `live_document_count()` for the denominator, and skip tombstones in the doc-freq scan:

  ```ts
  private recompute_idf(): void {
    if (!this.dirty) return;
    this.idf_cache.clear();

    const doc_freq = new Map<string, number>();
    let n = 0;
    for (const doc of this.documents) {
      if (doc.length === 0) continue;       // skip tombstone
      n++;
      const seen = new Set(doc);
      for (const term of seen) {
        doc_freq.set(term, (doc_freq.get(term) ?? 0) + 1);
      }
    }
    if (n === 0) return;

    for (const [term, df] of doc_freq) {
      this.idf_cache.set(term, Math.log((n + 1) / (df + 1)) + 1);
    }
    this.dirty = false;
  }
  ```

  Also fix the vectorize fallback denominator.

---

## 5. Logic: `cold_summaries()` order is non-deterministic — clusters are returned in Map-insertion order, not by timestamp

- **Severity:** low / medium (gradual model-context corruption)
- **File:line:** `src/cache/cache.ts:127-139` (`cold_summaries`) consumed at `:72` (`return [...cold_summaries, ...hot_turns];`)
- **Description:** `cold_summaries` returns `this.forest.roots().map(...)` with no sort. `forest.roots()` iterates `Map.values()` and yields nodes in insertion order. After several union operations, the surviving root's position in the iteration is its **original** insertion timestamp, not its most-recently-touched timestamp. Each cold cluster carries `timestamp = max(member.timestamp)`, but that timestamp is computed but never used for sorting.

  Pipeline then prepends the cold summaries before the hot turns:
  ```
  [system: cluster A (oldest member 10:00, newest member 14:30),
   system: cluster B (oldest 10:15, newest 11:00),
   system: cluster C (oldest 13:00),
   ... hot turns ordered by timestamp ...]
  ```
  So the model can see cluster summaries in arbitrary order, with newer cold information appearing before older cold information, then suddenly time-ordered hot turns. There's no signal to the model about which cluster summary is "earlier" — the conversation has lost its arrow of time across the cold zone.

- **Impact:**
  - Model-context coherence: when an evicted cluster about a different sub-task gets summarized between two related cluster summaries, the model has to disentangle them with no temporal hint.
  - Anthropic provider: not a correctness bug (system messages are all concatenated into the `system` parameter).
  - OpenAI / Google: system messages stay positionally in the messages array. If a cold summary references "the file we edited above," the referent in the live conversation may be 5 messages later in real time but appear before the cluster summary in the sequence.

- **Suggested fix:** Sort cold summaries by `timestamp` ascending in `cold_summaries()` before returning. Alternatively, surface the cluster's timestamp in the summary text itself (e.g., `[cluster from 14:30] …`) so the model can reason about ordering.

---

## 6. UX: `ConsolidateReview` reads `current` from stale closure — rapid keypresses double-decide

- **Severity:** low
- **File:line:** `src/app/components/ConsolidateReview.tsx:26-41`
- **Description:** Round 9 #19 reported a related symptom but the round-10 fix didn't land here — `decide()` still closes over `current` (line 26: `const current = candidates[index];`) and `decisions` (line 23 setState) at render time. When the user presses 'a' twice in the same React commit phase (e.g., autorepeat or two terminal-buffered key events), `useInput` fires the callback twice; both calls see the same `current`, the same `index`, and the same `decisions` snapshot. The first call sets `decisions = [...decisions, {candidate:current!, action}]` and `index+1`; the second call does the same with the SAME `current` and the SAME starting `decisions`, overwriting the first commit.

  Net effect: candidate N gets two decisions appended (the second call's setState wins), and candidate N+1 is skipped — its decision row is the second 'a' for N, and `index` jumps from N → N+1 → N+1 (the second setIndex sets to N+1 again because both callbacks closed over the original N).

  Actually since both callbacks call `setIndex(index + 1)` with the SAME `index`, the resulting `index` is N+1 (idempotent). But `setDecisions([...decisions, {…}])` from each callback uses the SAME `decisions` snapshot — so the FINAL state after React processes both updates is `[...decisions, {…second call}]`. The first call's decision is dropped, the second call's decision is recorded against `current` (still the candidate at N), and N+1 is silently advanced past.

- **Impact:** Reviewing a long candidate list with quick approvals can desynchronize. User mashes 'a' four times intending to approve A, B, C, D — gets A double-recorded, B/C/D advanced silently. Worse with `onComplete` triggered when `index + 1 >= candidates.length` — a too-fast last keystroke can call `onComplete(next)` with the wrong final list.

- **Suggested fix:** Use a ref for `index` and the functional setState form for `decisions`:

  ```ts
  const indexRef = useRef(0);
  // ...
  const decide = (action: ReviewDecision["action"]) => {
    const i = indexRef.current;
    if (i >= candidates.length) return;
    const cand = candidates[i]!;
    indexRef.current = i + 1;
    setIndex(i + 1);
    setDecisions(prev => {
      const next = [...prev, { candidate: cand, action }];
      if (i + 1 >= candidates.length) onComplete(next);
      return next;
    });
  };
  ```

---

## 7. Logic: `App.handleSubmit` adds the user turn to local `turns` state but `Pipeline.turn()` separately appends it to the cache — duplicated user message in the next prompt

- **Severity:** low
- **File:line:** `src/app/App.tsx:165-176` (App adds `userTurn` to `state.turns` for display) + `src/agent/pipeline.ts:192-223` (Pipeline builds its OWN `userTurn` and `commitTurn(userTurn)` after the response)
- **Description:** App.tsx maintains `state.turns` for the TUI rendering, and Pipeline maintains its own `cache` for the model-prompt assembly. These are independent — App never reads the cache, and the cache never reads App's state. So a single user input results in:
  - One App `userTurn` in `state.turns` (for display)
  - One Pipeline `userTurn` in `this.cache` (for the next prompt)

  The display shows the user message ONCE, and the model sees the user message ONCE. So far OK. But there's a subtle mismatch: when `pipeline.turn()` returns `currentTurn` (the assistant), App appends ONLY the assistant turn to `state.turns` (line 207). Then on the next user input, App appends a new user turn locally, calls `pipeline.turn(input2)`, and Pipeline:
  1. Reads `this.cache.read()` which contains [previous user turn, …intermediate tool-result turns…, previous assistant turn]
  2. Builds a fresh `userTurn` for input2 and adds it to the prompt
  3. Eventually commits the new userTurn to cache

  The persisted history thus has the user message exactly once. This is correct — but with one footgun: if `pipeline.turn()` throws BEFORE `commitTurn(userTurn)` (e.g., perceive fails before line 217 commit-on-error path fires), the user's prompt is lost from the cache while still visible in `state.turns`. The next turn's prompt won't include it, and the model sees a missing turn from its perspective.

  Looking at `pipeline.ts:158`: `const perceived = await this.perceiver.perceive(input);` — if this throws, the catch at App.tsx:211 fires, but `commitTurn(userTurn)` was never called because `userTurn` is constructed AFTER perceive. So the user's input never enters the cache. The local `turns` shows it; the cache doesn't.

- **Impact:** On perceive failure (rare — only file-read errors via expandFileRefs, which are now silently swallowed), user input vanishes from the model's history but stays on screen. User retries the same question, model has no record of the original attempt. Mild confusion.

- **Suggested fix:** Construct `userTurn` from the raw input (no perceive expansion needed) and `commitTurn(userTurn)` at the very top of `_turn`, before perceive. Then perceive feeds the model with the expanded version, but the cache record uses the un-expanded text. Or wrap perceive in its own try and commit a placeholder user turn on failure.

---

## 8. Logic: `app/Composer` enables bracketed-paste mode on every render of an enabled composer — unmount/remount writes the escape sequence redundantly, and the cleanup writes the disable sequence even when the app is still running

- **Severity:** low
- **File:line:** `src/app/components/Composer.tsx:47-52`
- **Description:** The mount effect writes `\x1b[?2004h` unconditionally, and cleanup writes `\x1b[?2004l`. Composer is rendered with `disabled={!isComposing}`, but the component itself stays mounted across all phases — so the effect runs once per mount. Fine. BUT in `App.tsx` the Composer is unmounted only when the App unmounts.

  The issue: `cli.ts` ALSO registers `process.on("exit", disableBracketedPaste)` AND a SIGINT handler. When the user double-Ctrl+C exits, the SIGINT handler runs, then `process.exit(130)`, then React's `useEffect` cleanup runs… wait, with `process.exit` the cleanup never runs (process dies first). So the SIGINT handler covers that path correctly.

  But on a normal `useApp().exit()` (the 'q' command at App.tsx:120 or `/exit` slash command), Ink unmounts → Composer's cleanup writes the disable sequence → THEN the exit handler in cli.ts ALSO writes the disable sequence. Redundant but harmless.

  Real bug: if Composer is REMOUNTED (e.g., a future feature that conditionally renders it), the mount effect writes ENABLE again. If the terminal already had bracketed paste enabled from a prior parent (e.g., the user's shell), the unmount writes DISABLE — clobbering the parent terminal's setting. petricode shouldn't disable bracketed paste on exit if the parent terminal had it enabled.

  Today there's no parent context that uses bracketed paste, so latent.

- **Impact:** Latent. If petricode is ever embedded in another TUI (e.g., a shell that uses bracketed paste itself), exiting petricode kills the parent's bracketed paste mode.

- **Suggested fix:** Save and restore the prior state. Query the terminal mode on mount (DECRQM) and only write disable on cleanup if petricode enabled it. Or just don't disable at all and let the parent terminal manage its own state.

---

## 9. Persistence: `resumeSession` discards persisted message IDs, breaking `cache.find(message_id)` for resumed sessions

- **Severity:** low
- **File:line:** `src/session/resume.ts:30-35` (`id: crypto.randomUUID()`)
- **Description:** `SessionStore.read(sessionId)` returns `PerceivedEvent[]` without the message ID (the type doesn't include `id`). `resumeSession` then synthesizes `id: crypto.randomUUID()` for each replayed turn. After resume, the cache contains turns with FRESH IDs while any persisted reference (e.g., a future "expand cluster N" feature, decision records via `subject_ref`) that points to the original message ID will no longer resolve via `cache.find()`.

  Today `cache.find()` has only one external caller (none in `src/`; it's exposed for potential UI use). So latent. But `forest.find_turn()` is used internally by `expand()` whose tests pass turn IDs directly — those will not work for resumed sessions.

  Also: `tool_calls` are persisted in a separate `tool_calls` table keyed by `message_id`, but `SessionStore.read()` doesn't load them. So a resumed session loses tool_call.result data. The content blocks (tool_use, tool_result) ARE preserved via `internalizeContent`, so the conversation rebuilds correctly for the model. But the `Turn.tool_calls` array is not reconstructed — meaning UI renderers like `MessageList`'s `ToolGroup` won't show prior tool calls in resumed sessions.

- **Impact:**
  - Resumed sessions lose the rendered `[tool] toolname args... result...` cards in the message list. Conversation continues to work (model sees the tool_result blocks in content), but the user can't scroll back and see what the prior session did at the tool level.
  - Decision records and any future feature that resolves a turn by stored ID will fail for resumed sessions.

- **Suggested fix:** Extend `SessionStore.read()` (or add a parallel `readTurns()`) that returns `Turn[]` with the original `id` and `tool_calls` populated, then have `resumeSession` use that.

---

## 10. Resource: `Pipeline.contextSummary()` pre-walk in `App.tsx` runs the full file-system walk on EVERY remount, with no caching

- **Severity:** low
- **File:line:** `src/app/App.tsx:55-64` (`pipeline.contextSummary()`) + `src/perceive/contextDiscovery.ts:12-58` (`discoverContext` walks subdirectories every call)
- **Description:** `contextSummary()` is called from a `useEffect([pipeline])`. It calls `discoverContext`, which walks the project root, all instruction files, the `.agents/` dir, and every subdirectory's `.agents/`. For a project with hundreds of subdirectories, this is non-trivial IO.

  Worse: `Pipeline._turn` ALSO calls `discoverContext` every turn (via `this.perceiver.perceive(input)` → `discoverContext(this.projectDir, ...)`). So:
  - Once on App mount (for the summary)
  - Once on every user submit (for actual context inclusion)

  None of these results are cached. A 100-file project re-walks 100 files on every turn. An open editor that triggers many auto-completions or rapid back-and-forth turns serializes against this IO.

- **Impact:** Latency spike on first turn after launch (especially in large monorepos). Repeated identical work. `gitignore` is also re-loaded on every glob/grep tool call (`loadIgnorePredicate` parses `.gitignore` from disk each time).

- **Suggested fix:** Cache `discoverContext` results in `Perceiver` keyed by projectDir, with TTL or file-mtime invalidation. Cache `loadIgnorePredicate` similarly.

---

## Summary

10 new bugs found, distinct from rounds 1–10. **Tests: 206/206 pass.**

- **1 high:** file_read/file_write/edit ignore opts.cwd → relative paths read/write the wrong file (#1)
- **3 medium:** glob path arg uses raw cwd (#2), RetryProvider sleep ignores abort signal (#3), TfIdfIndex IDF still includes tombstones in n (#4)
- **6 low:** cold cluster ordering non-deterministic (#5), ConsolidateReview keystroke race (#6), user turn lost on perceive failure (#7), bracketed-paste mode unilaterally disabled on exit (#8), resume drops tool_calls + IDs (#9), no caching of context discovery / gitignore (#10)

Highest-leverage fixes:
1. **#1** — closes the symmetric tool-cwd hijack that round 9 fixed for glob/grep/shell and round 10 fixed for fileRefs. Same root cause; finishes the job.
2. **#3** — Ctrl+C feels broken under rate-limit storms; up to 90 s of ghost wait.
3. **#4** — completes round 10's TfIdf eviction fix; otherwise IDF still drifts.
