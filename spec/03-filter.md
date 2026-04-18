# 03 — Filter

Gate: accept or reject. Every filter is a predicate that returns pass/fail. Filters do not rank, select, or transform — they reject.

## Gates

### Content validation

Validate model responses before adding to history.

- Response has candidates with content
- Parts are non-empty
- Non-thought text parts are non-empty strings
- Invalid responses trigger retry (via Perceive), not silent acceptance

### History curation

Before sending history to the model, remove invalid turns.

- Iterate history, reject model turns containing invalid content
- Only valid turns reach the next API call
- Prevents error propagation from one turn to the next

### Tool output masking

Redact sensitive or oversized tool output from history.

- Backward scan from most recent turn
- Accumulate tool output tokens
- Past threshold: replace output with "[masked — N tokens]"
- Exempt specific tools (e.g., user-facing output tools)

### Policy engine

Gate tool execution before scheduling.

- Rule matching: tool name (with wildcards), argument patterns, mode/subagent filters
- Three outcomes: ALLOW, DENY, ASK_USER
- Client-initiated tools bypass ASK_USER (the user already asked)
- Non-interactive mode: ASK_USER throws error (no human available)

### Loop detection

Detect repeated identical behavior and break the loop.

- **Tier 1:** Tool call repetition. Same tool + same args N times in a row → loop.
- **Tier 2:** Content hashing. Sliding window of output chunks, hash-based duplicate detection. Disable inside code blocks (repetitive code is not a loop).
- **Tier 3:** LLM-based. Sample recent history, query a cheap model: "is this conversation stuck?" Confidence threshold (e.g., 0.9) before declaring loop.
- Recovery: inject "you are looping" message, then abort if loop persists.

### Eviction (Filter @ Transmit)

Automatic eviction of old session data from persistent storage.

- **Trigger:** on startup (before indexing) and on session close (after writing)
- **Score:** `age_days × size_bytes` — oldest and largest die first
- **Threshold:** total disk usage (e.g., 500MB)
- **Safety floor:** preserve N most recent sessions unconditionally
- **Coordination:** lock file or PID check before eviction (no racing concurrent instances)

### Model fallback (circuit breaker)

On quota exhaustion, fall back to a lower-tier model.

- TerminalQuotaError → trigger fallback handler
- Reset retry counter on fallback
- This is a Filter (binary gate on availability), not Attend (no ranking among alternatives)

## Anti-patterns

- Gating retry on model version prefixes (see 01-perceive.md)
- No automatic eviction (session logs grow unbounded → OOM)
- Loop detection that fires inside code blocks (false positives on repetitive code)
