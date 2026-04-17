# Bug Hunt Round 17 — Opus

**Date:** 2026-04-16
**Scope:** New bugs only. Rounds 1–16 already fixed 60 bugs; their findings lists were excluded.
**Repo state:** `bun test` → 215 pass / 0 fail (1.28s). `bun run typecheck` → clean.

## Findings

### Bug 1 — `/consolidate` operates on empty session transcripts

**Severity:** medium (silent functional regression — feature ships and runs without errors but produces no useful output in production)

**Location:**
- `src/remember/sessionStore.ts:150-154` — `list()` returns each session with `turns: []` hardcoded
- `src/consolidate/extractor.ts:38-46` — `sessionToTranscript(session)` iterates `session.turns`
- `src/consolidate/consolidator.ts:116-122` — calls `extractTriples(session, fast, …)` per session
- `src/commands/consolidate.ts:19-24` — `runConsolidate` feeds `remember.list()` straight into `consolidator.run`

**Trace:**

`sessionStore.list()`:
```ts
return sessions.map((s) => ({
  id: s.id,
  turns: [],                                     // ← always empty
  metadata: { ...JSON.parse(s.metadata_json), created_at: s.created_at },
}));
```

`extractor.ts → sessionToTranscript`:
```ts
function sessionToTranscript(session: Session): string {
  return session.turns                           // ← reads what list() never populated
    .map((t) => { … })
    .join("\n");
}
```

So `extractTriples` always sends the fast model an extraction prompt with an **empty** transcript body (just the boilerplate header `Transcript:\n`), regardless of how rich the recorded sessions actually were. With a real LLM this yields zero triples → zero groups → zero candidate skills, and the user sees `"No candidate skills extracted from sessions."` even though their session DB is full.

**Why tests don't catch it:** `test/consolidate.test.ts` uses a `mockProvider` whose `generate(_prompt)` ignores the prompt entirely and returns canned `PROBLEM:|APPROACH:|OUTCOME:` lines. The empty transcript is invisible to the test assertion because the mock would emit the same triples for any input.

**Why decision records can't save it:** the `decisions` enrichment block in `extractTriples` is *appended* to the transcript, but if there are zero `DecisionRecord`s for a session (the default — nothing in petricode currently calls `listDecisions`), the model still gets `Transcript:\n` followed by nothing.

**Suggested fix (pick one):**
1. **Recommended — make `list()` lazy at the call site.** In `consolidator.run`, replace the loop body with a `remember.read(session.id)` call and rebuild a `Turn[]` from the returned `PerceivedEvent[]` (or expose `readFull` through the `RememberSlot` contract and call it). This keeps `list()` cheap for cases that genuinely only want session metadata (e.g. a future `/sessions` listing).
2. **Quick fix — populate `turns` in `list()`** by calling `this.readFull(s.id)!.turns` per row. Simpler but does an N+1 read on every call to `list()`; acceptable given consolidation is a manual user action and current session counts are small, but be aware that `messages` can grow large per session and this materializes every blob.

Either way, also strengthen `test/consolidate.test.ts` so the mock asserts that `prompt[0].content[0].text` actually contains a non-empty transcript — otherwise the regression will silently re-land.

---

## Convergence assessment

After three full passes through the 71 source files plus the test suite, this is the only new functional bug I can substantiate. Nothing else surfaced that wasn't already in rounds 1–16's "do NOT re-report" list or already documented as an intentional design tradeoff (e.g., `nearest_root` IDF mismatch, `LoopDetector` permanent rejection, `weighted_average` clamping behavior, `appendTurn`/`readFull`/`CircuitBreaker`/`loadConfig` being dead-but-harmless, the slash-skill name vs frontmatter discrepancy that doesn't affect activation matching).

I'd call the codebase **converged** for now. The next productive bug-hunt vector is probably **integration testing with a real provider** (or a mock that asserts on prompt content rather than canned responses) — which is exactly where this round's bug hid.
