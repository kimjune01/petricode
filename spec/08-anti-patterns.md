# 08 — Anti-patterns

Diagnosed failures from real systems. Each anti-pattern maps to a missing or broken role at a specific tower level.

## 1. Flat cache (Cache @ top)

**Symptom:** All discovered context loaded into a single flat string. Token usage grows O(n) with project size. Stale context rots relevance.

**Root cause:** No tree structure for context. No progressive disclosure. No per-level token budget.

**Consequence:** Context fills fast → hits overflow threshold → message rejected before compression triggers.

**Fix:** Tree-shaped context with geometric token decay (see 02-cache.md).

## 2. No automatic eviction (Filter @ Transmit)

**Symptom:** Session logs grow without bound. Multi-GB disk usage. OOM on startup from indexing all sessions.

**Root cause:** Transmit stores everything. Filter @ Transmit is absent — no automatic eviction policy.

**Consequence:** Crash. Or: vendor ships heap size increase (band-aid) instead of eviction policy (fix).

**Fix:** Automatic eviction by age × size score with safety floor (see 03-filter.md).

## 3. Model-version-gated retry (Filter @ streaming)

**Symptom:** Retry logic only fires for specific model name prefixes. New model versions return empty responses that aren't retried.

**Root cause:** Retry gate is a string match on model name, not a content check on response validity.

**Consequence:** Silent empty output. Non-interactive scripts exit 0 with no content.

**Fix:** Content-based retry gate. Retry when response has no non-thought text parts, regardless of model version (see 01-perceive.md).

## 4. No consolidation trigger (Consolidate @ top)

**Symptom:** Agent can create skills when asked. Never creates them unprompted. No learning between sessions.

**Root cause:** The capability exists but the trigger doesn't. No crontab.

**Consequence:** The agent is equally naive on session 1 and session 1000. Each conversation starts from zero.

**Fix:** Six-component backward pass with explicit trigger (see 06-consolidate.md).

## 5. Inline binary in session logs (Transmit @ top)

**Symptom:** Base64-encoded binary data stored inline in session JSON. 19MB per file attachment.

**Root cause:** Transmit serializes everything it receives, including binary parts, without a size gate.

**Consequence:** Session files bloat → feeds into anti-pattern #2 (unbounded growth).

**Fix:** Store binary in separate files, reference by pointer in session JSON.

## 6. Overflow check bypasses compression (Cache @ top)

**Symptom:** Context overflow check at 95% capacity returns early, rejecting the message. Compression exists but isn't invoked before the rejection.

**Root cause:** Ordering bug — overflow check runs before compression attempt.

**Consequence:** Premature session termination. User loses the conversation.

**Fix:** Invoke compression before overflow check. Reject only if compression fails to reclaim enough space.

## The meta-pattern

These anti-patterns persist across vendor implementations because the incentive structure does not reward fixing them. The fix is structural: build the pipe independently, under a license that prevents re-throttling (AGPL).
