# Bug Hunt Round 49

Five new bugs found across tools, consolidate, skiller, and gitignore. None overlap with rounds 32–48 mechanisms.

## Triage outcome

- **#1 (toolSubpipe non-abort error → ALLOW)** — FIXED in `src/agent/toolSubpipe.ts:528`. Sibling of round 48 #3 — same DENY-filter hazard, parallel branch in the catch block.
- **#2 (extractor pipe in PROBLEM)** — FIXED in `src/consolidate/extractor.ts:59`. Switched `(.+?)` → `(.+)` in PROBLEM and APPROACH groups; APPROACH/OUTCOME keywords still anchor termination.
- **#3 (slash command leading whitespace)** — FIXED in `src/skiller/filter.ts:26`. `trimStart()` on the args slice.
- **#4 (auto-trigger no paths field is silent)** — FIXED in `src/skiller/filter.ts:53`. Module-level dedupe set + console.warn so the message fires once per skill name, not every turn.
- **#5 (gitignore `[a/b]` mis-parsed)** — FIXED in `src/filter/gitignore.ts:248`. Relaxed the body regex from `[^\]/]` to `[^\]]` so `/` can appear inside the class. Negated-class `/` exclusion below stays intact.

---

## Bug 1 — `toolSubpipe.ts`: Non-abort tool execution errors still return `outcome: "ALLOW"`

**File:** `src/agent/toolSubpipe.ts:523–530`

**Description:** When a tool throws a non-`AbortError` exception during execution, the catch block pushes a `ToolResult` with `outcome: "ALLOW"` and `content: "Error: <msg>"`. The interrupt path (AbortError) was fixed in round 44 to use `interruptedResult` which sets outcome to `"DENY"`, but the general error path was left unchanged.

```typescript
// lines 523–530 (current)
const errMsg = err instanceof Error ? err.message : String(err);
tc.result = `Error: ${errMsg}`;
results.push({
  toolUseId,
  name: tc.name,
  outcome: "ALLOW",          // wrong — tool did NOT succeed
  content: `Error: ${errMsg}`,
});
```

**User-visible impact:** Headless callers and CI pipelines that filter by `outcome === "ALLOW"` count crashed tool executions as successes. The failure summary in headless mode will not flag these, so a run that crashed every tool still reports all-green outcomes. The distinction "policy denied" vs "crashed" vs "succeeded" is entirely lost for the error case.

**Suggested fix:** Introduce `outcome: "ERROR"` as a new value (or reuse `"DENY"`) for this branch. Match the rationale pattern used by `interruptedResult`:

```typescript
results.push({
  toolUseId,
  name: tc.name,
  outcome: "DENY",
  content: `Error: ${errMsg}`,
});
```

**Severity:** Medium

---

## Bug 2 — `consolidate/extractor.ts`: Pipe characters in PROBLEM or APPROACH silently drop triples

**File:** `src/consolidate/extractor.ts:59`

**Description:** `parseTriples` uses a non-greedy `(.+?)` for the PROBLEM and APPROACH capture groups:

```typescript
const problemMatch = trimmed.match(
  /PROBLEM:\s*(.+?)\s*\|\s*APPROACH:\s*(.+?)\s*\|\s*OUTCOME:\s*(.+)/i
);
```

If the LLM emits a pipe character inside the PROBLEM or APPROACH text (e.g., `PROBLEM: handle X | Y | APPROACH: add retry | OUTCOME: stable`), the non-greedy group stops at the first `|`, consuming only `handle X`. The regex then expects `\s*APPROACH:` next but finds `Y |`, so the whole match fails and the line is silently skipped.

**User-visible impact:** Consolidation silently drops skill extraction triples when the LLM (following the prompt that asks for free-form descriptions) includes a pipe in its output. Users run `/consolidate`, get fewer candidates than expected, and have no signal about why.

**Suggested fix:** Change `.+?` to `.+` (greedy) in the PROBLEM and APPROACH groups, so the regex consumes the rightmost pair of `| APPROACH:` and `| OUTCOME:` delimiters. Or restructure the prompt to explicitly prohibit pipe characters.

```typescript
const problemMatch = trimmed.match(
  /PROBLEM:\s*(.+)\s*\|\s*APPROACH:\s*(.+)\s*\|\s*OUTCOME:\s*(.+)/i
);
```

Note: greedy matching still terminates correctly because APPROACH and OUTCOME are anchored keywords.

**Severity:** Low (consolidation quality, not core pipeline)

---

## Bug 3 — `skiller/filter.ts:26`: Slash command arguments preserve leading whitespace

**File:** `src/skiller/filter.ts:26`

**Description:** When matching a slash command, the arguments are extracted as everything after the first space:

```typescript
const spaceIdx = trimmed.indexOf(" ");
const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
```

If the user types `/greet  Alice` (two spaces), `spaceIdx` points to the first space, and `args` becomes `" Alice"` (leading space preserved). Skill bodies that use `$ARGUMENTS` substitution receive the extra whitespace literally.

**User-visible impact:** Skill prompt injection like `Greet $ARGUMENTS!` renders as `Greet  Alice!` with a double space. Subtle and confusing for users who accidentally type an extra space.

**Suggested fix:**

```typescript
const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trimStart();
```

**Severity:** Low

---

## Bug 4 — `skiller/filter.ts:53–54`: Auto-trigger skill missing `paths` field is silently discarded

**File:** `src/skiller/filter.ts:53–54`

**Description:** `matchAutoTriggers` skips any auto-trigger skill whose `paths` frontmatter field is absent or not a string:

```typescript
const rawPaths = skill.frontmatter.paths;
if (typeof rawPaths !== "string") continue;
```

No warning is emitted. A user who writes:

```yaml
---
name: my-lint-hook
trigger: auto
description: Should fire on TypeScript files
---
Run the linter.
```

(forgetting `paths: "**/*.ts"`) will find the skill is discovered, listed by `/skills`, but never fires — with zero diagnostic output explaining why.

**User-visible impact:** Users spend time debugging why an auto-trigger skill is inert. The skill appears healthy in `/skills` but is unreachable.

**Suggested fix:** Emit a `console.warn` (matching the pattern used elsewhere in the codebase) when an auto-trigger skill has no valid `paths` field:

```typescript
if (typeof rawPaths !== "string") {
  console.warn(`skiller: auto-trigger skill '${skill.name}' has no 'paths' field — it will never fire`);
  continue;
}
```

**Severity:** Low/Medium (silent UX failure)

---

## Bug 5 — `filter/gitignore.ts:248`: Character-class body regex excludes `/`, misparses `[a/b]` patterns

**File:** `src/filter/gitignore.ts:248`

**Description:** The regex that extracts character-class bodies from gitignore patterns is:

```typescript
regex = regex.replace(/\[((?:\\.|[^\]/])+)\]/g, (_m, body: string) => {
```

The `[^\]/]` character class means "any char that is not `]` or `/`". This prevents `/` from appearing inside a character-class body. If a gitignore pattern contains `[a/b]` (valid per the gitignore spec — matches `a`, `/`, or `b` within a single path component), the regex fails to match it as a character class. The `[` and `]` then fall through to the metachar-escaping step at line 260 which converts them to `\[` and `\]`, making the final regex match the literal string `[a/b]` instead of any of the three single characters.

**User-visible impact:** A `.gitignore` entry like `log[0-9/]` or `[Mm]ake[Ff]ile` containing `/` in the class silently becomes a literal-string matcher that never matches real paths. Files that should be ignored are traversed.

**Suggested fix:** Allow `/` in the character-class body parse and handle the exclusion semantically (it already is excluded from negated classes at line 254 by appending `/` to the `^` group; positive classes don't need it because gitignore semantics don't let any wildcard match `/` across segments):

```typescript
regex = regex.replace(/\[((?:\\.|[^\]])+)\]/g, (_m, body: string) => {
```

Change `[^\]/]` → `[^\]]` (exclude only the closing bracket from the body scan).

**Severity:** Low (rare pattern, but silently wrong when hit)
