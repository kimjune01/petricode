# Bug Hunt Round 18

Zero new bugs found. Hunt converged.

## Verification

- `bun test` — 216 pass, 0 fail (517 expect calls)
- `bun run typecheck` (`tsc --noEmit`) — clean

## Scope reviewed

Walked every file touched by recent fixes (rounds 13-17) plus the broader
forward-pipe surface to confirm convergence:

- `src/tools/{readFile,writeFile,edit,shell,grep,glob,registry}.ts`
- `src/agent/{pipeline,turn,context,toolSubpipe,loop}.ts`
- `src/app/App.tsx` and components (Composer, ConsolidateReview,
  StatusBar, MessageList, ToolConfirmation, Markdown)
- `src/providers/{anthropic,openai,google,retry,router}.ts`
- `src/perceive/{fileRefs,perceiver,contextDiscovery,skillDiscovery}.ts`
- `src/skills/{loader,activation}.ts`
- `src/remember/{sqlite,sessionStore,skillStore}.ts`
- `src/session/{bootstrap,resume}.ts`
- `src/commands/{index,consolidate}.ts`
- `src/cache/{cache,unionFind,tfidf,compaction}.ts`
- `src/filter/{policy,gitignore,pathValidation,toolMasking,loopDetection,contentValidation,filter,circuitBreaker}.ts`
- `src/cli.ts`, `src/core/{runtime,types,contracts}.ts`, `src/convergence/volley.ts`

## Candidates considered and ruled out

Tracked carefully so no finding was manufactured:

1. **`/consolidate` not wired in TUI registry.** `commands/index.ts` advertises
   `/consolidate` in `/help` but no handler is registered; `runConsolidate`
   and `ConsolidateReview` are reachable only from tests. Predates the bug
   hunt (introduced in `322d161 item 13`); not a regression from any
   recent fix. Round 17's hydration fix made the function correct *if*
   ever called, but the wire-up has been missing since the feature shipped.
   Logged here for completeness; per the hunt rules ("intentional
   architecture / longstanding gaps are not bugs"), not reported.

2. **OpenAI provider may emit `done` more than once on multi-finish-reason
   streams.** Walked `assembleTurn`: a second `done` is a no-op
   (textBuffer empty, toolMap cleared by the first). Benign.

3. **`runToolSubpipe` discards already-completed tool results when an
   abort fires mid-loop**, then `commitInterruptedToolCalls` synthesizes
   "Interrupted" results for the entire batch including the ones that
   actually executed. This is a known semantic limit of synchronous
   serial execution and matches the existing fix from earlier rounds
   for parallel-tool abort. Side effects (e.g., a write that landed)
   stay on disk; the conversation just doesn't reflect them. Not a
   regression and not a bug per the hunt definition.

4. **`TfIdfIndex.recompute_idf` early-returns at `n === 0` after
   clearing `idf_cache` but without resetting `live_n`**, so the
   fallback IDF in `vectorize` uses stale `live_n` until a recompute
   finds at least one live doc. Numerical drift only; cluster
   similarity ranking unaffected (all unseen terms get the same
   inflated weight). Not a correctness bug.

5. **`StatusBar.useElapsed` calls `setStart(now)` but never reads
   `start`.** Dead state, cosmetic.

6. **`SessionStore.append` discards turn IDs** — already deferred
   (Round 12 #5).

7. **`<context source="…">` and `<file path="…">` injection via crafted
   filenames or content containing `</context>`** — known limitation
   of XML-tagged context routing; routing-by-source-field already
   prevents the user-input escalation attack (Round 12 #1).

## Conclusion

Trajectory across rounds: 21, 2, 10, 6, 8, 2, 2, 5, 1, 0. The codebase
is converged for the surface area touched by recent fixes and the
broader forward pipe. Future bug hunts should probably refresh focus
to areas not yet exercised (e.g., new feature work) rather than
re-walking the same paths.
