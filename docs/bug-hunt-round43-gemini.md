# Bug Hunt Round 43

Four new bugs found: three in the soft-delete rewriter, one in the pipeline cleanup path.

> Reviewer note: gemini CLI hit a Vertex SDK serialization regression
> (`generateContentParametersToVertex`) on every invocation — even
> a "say hello" smoke test — across gemini-3.1-pro-preview,
> gemini-3-pro-preview, and gemini-2.5-pro. codex was simultaneously
> unauthenticated. Fell back to `claude --model sonnet` (zero-context,
> different model from the parent opus-4-7) — weaker N-version
> programming than the usual cross-vendor IV&V, but the best
> available reviewer. Filename kept as `…-gemini.md` for series
> continuity.

## Triage outcome

- **#1 (brace-expansion bypass)** — FIXED in `src/filter/shellRewrite.ts:40`. Added `{` and `}` to the metacharacter bailout class so `rm -rf {a,b}` falls back to the normal allow/deny prompt instead of the broken safe-rewrite.
- **#2 (`./` and `../` trailing-slash bypass)** — FIXED in `src/filter/shellRewrite.ts:97-103`. Strip trailing slashes from the target before the catastrophic-path guard, so `rm -rf ../` is now blocked from being silently rewritten to `mv '../' …` (which would have succeeded and relocated the parent dir).
- **#3 (dead `-r`/`-R` conditions in long-flag block)** — FIXED in `src/filter/shellRewrite.ts:63`. Removed the dead arms; short flags are still handled by the dedicated short-flag block at line 72.
- **#4 (max-rounds cleanup turn bypasses filter)** — DEFERRED. The current `validateContent` (the only filter the loop runs) only checks for empty content, which is already enforced inline at lines 398-403 of the cleanup block. The "filter grows stricter checks later" risk is speculative; not a current user-visible bug.

---

## Bug 1 — shellRewrite: brace-expansion targets bypass rewriter bailout (MEDIUM)

**File:** `src/filter/shellRewrite.ts:40`

**Description:**  
The metacharacter bailout regex `/[|;&<>`$()*?\n]/` does not include `{` or `}`. A command like `rm -rf {foo,bar}` passes the bailout, the tokenizer captures `{foo,bar}` as a single bare-word positional, and the rewriter offers:

```
mkdir -p '/tmp/petricode-trash/…' && mv '{foo,bar}' '/tmp/petricode-trash/…/'
```

When the shell executes this, `{foo,bar}` is inside single quotes, so brace expansion is suppressed — the shell looks for a literal file named `{foo,bar}`. If none exists (the common case), `mv` fails with "No such file or directory". The original `rm -rf {foo,bar}` would have correctly expanded and deleted `foo` and `bar`.

**User-visible impact:**  
In `--permissive` mode, the user clicks `[m]` (the "safe move" recommended option) and gets a cryptic runtime failure. The dangerous `rm` did NOT run (good), but the safe alternative also silently failed, so `foo` and `bar` still exist and the user is left confused about what happened.

**Suggested fix:**  
Add `{` to the bailout character class:
```typescript
if (/[|;&<>`$()*?{\n]/.test(cmd)) return null;
```
Brace expansion requires `{` anyway; single-target commands with `{` in the path can be forced through by quoting at the call site.

**Severity:** Medium

---

## Bug 2 — shellRewrite: catastrophic target check misses trailing-slash forms `./` and `../` (MEDIUM)

**File:** `src/filter/shellRewrite.ts:97-103`

**Description:**  
The catastrophic-path guard checks:
```typescript
if (target === "/" || target === "." || target === ".." || target === "~" || target === "") return null;
```

It catches `.` but not `./`, and `..` but not `../`. Both trailing-slash forms are semantically equivalent on POSIX. When the model emits `rm -rf ./` or `rm -rf ../`, the tokenizer yields `./` or `../` as the positional, the catastrophic check passes, and the rewriter produces:

```
# For rm -rf ./
mkdir -p '/tmp/…' && mv './' '/tmp/…/'

# For rm -rf ../
mkdir -p '/tmp/…' && mv '../' '/tmp/…/'
```

`mv './'` fails with "Invalid argument" on macOS and Linux (cannot relocate the CWD).  
`mv '../'` may **succeed** — it moves the parent directory to the petricode trash, displacing everything ABOVE the project directory, not just within it.

**User-visible impact:**  
- `./` case: user picks the "safe move" option and gets a confusing error; neither the rm nor the safe move ran.
- `../` case: user picks the "safe move" option; the parent directory is silently moved to `/tmp`. The impact is much wider than the user expects.

**Suggested fix:**  
Normalise the target or extend the guard:
```typescript
const normTarget = target.replace(/\/+$/, ""); // strip trailing slashes
if (normTarget === "/" || normTarget === "." || normTarget === ".." || normTarget === "~" || normTarget === "") return null;
```
`"/" → "/"`; `"./→ "."` → blocked; `"../" → ".."` → blocked.

**Severity:** Medium

---

## Bug 3 — shellRewrite: `-r`/`-R` conditions inside `startsWith("--")` block are dead code (LOW)

**File:** `src/filter/shellRewrite.ts:63`

**Description:**  
```typescript
if (t.startsWith("--")) {
  if (t === "--recursive" || t === "-r" || t === "-R") {  // ← dead conditions
    recursive = true;
    continue;
  }
  …
}
```

The outer guard already ensures `t.startsWith("--")`, so `t === "-r"` and `t === "-R"` can never be true here — short flags don't start with `--`. They are handled correctly by the separate block at lines 72-78. The dead conditions create a misleading read: a future maintainer may delete the second block believing the first handles short flags, which would break the rewriter silently.

**User-visible impact:**  
None today. Risk materialises on the next refactor of this function.

**Suggested fix:**  
Remove the dead conditions from line 63:
```typescript
if (t === "--recursive") {
  recursive = true;
  continue;
}
```

**Severity:** Low

---

## Bug 4 — pipeline: max-rounds cleanup turn bypasses content validation filter (LOW)

**File:** `src/agent/pipeline.ts:370-404`

**Description:**  
When the tool sub-pipe exhausts `maxToolRounds`, the code at line 370 synthesises error results, commits them, issues one final provider call (without `toolDefs`), and `break`s out of the loop at line 404. After the loop, line 525 commits the cleanup turn directly. The content validation filter (lines 506-521) runs only on turns produced by normal loop iterations; the cleanup turn skips it entirely.

In contrast, every other assistant turn — including the first response (lines 327-341) and every subsequent round response (lines 506-521) — passes through `this.filter.filter()`.

**User-visible impact:**  
Low in practice: the cleanup response can't contain tool calls (toolDefs were not passed) and has non-empty content enforced at lines 398-403. However, if `validateContent` grows stricter checks (e.g. PII redaction, policy words), the max-rounds path silently bypasses them. Inconsistency between cleanup turns and all other turns is also a testability gap.

**Suggested fix:**  
After the final `assembleTurn` call inside the max-rounds block (line 389), run the filter before `break`:
```typescript
currentTurn = await assembleTurn(…);
// Strip stray tool calls…
// Guard empty content…
const cleanupFilter = await this.filter.filter(currentTurn);
if (!cleanupFilter.pass) {
  currentTurn = {
    …currentTurn,
    content: [{ type: "text", text: `[filtered] ${cleanupFilter.reason}` }],
  };
}
break;
```

**Severity:** Low
