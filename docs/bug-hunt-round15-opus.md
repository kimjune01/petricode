# Bug Hunt Round 15 — Opus

**Tests:** 213 pass / 0 fail (1.4s).
**Typecheck:** clean (`tsc --noEmit`).

Two NEW bugs found. Both are functional/UX defects affecting the skill subsystem — well outside the heavily-sanded provider/cache/cwd surface that prior rounds exhausted.

---

## Bug 1 — Slash-command skills are unreachable from the TUI

**Location:** `src/app/App.tsx:141-159`, `src/commands/index.ts:48-63`, `src/agent/pipeline.ts:189`

**What happens:**

1. User loads a skill with `trigger: slash_command` and `name: tighten` (e.g. `.petricode/skills/tighten.md`).
2. User types `/tighten foo.ts` in the TUI.
3. `App.tsx` `handleSubmit` calls `tryCommand(input)` first (line 141).
4. `tryCommand` checks the built-in `commands` registry — `tighten` is not registered.
5. `tryCommand` returns `{ output: "Unknown command: /tighten. Type /help for a list." }` (commands/index.ts line 78-80).
6. App displays this as a system turn and `return`s (App.tsx line 154-158).
7. `pipeline.turn(input, ...)` is **never invoked** — the slash-skill activation logic in `pipeline.ts:189-207` (which calls `matchSlashCommand`) is dead code from the TUI's perspective.

The plumbing is all there: `pipeline.loadedSkills()` is exposed (pipeline.ts:444), `commands/index.ts` exports `registerCommands` and `overrideCommand`, and `matchSlashCommand` works correctly when called directly (verified by `test/skills.test.ts:53`). Nothing wires them together.

**Impact:** Functional regression — every slash-command skill the user authors is silently unreachable. The user's `/foo args` is intercepted as "Unknown command" and the skill body never reaches the LLM. Worse, `tryCommand` returning "Unknown command" makes the user think their skill failed to load when in fact the TUI never even tried to activate it.

`registerCommands` is exported but `grep -r registerCommands src/` shows zero callers. `overrideCommand` likewise. `pipeline.loadedSkills()` is exposed but unused.

**Suggested fix (do not apply yet):**

In `cli.ts` (or `App.tsx`'s mount effect), iterate `pipeline.loadedSkills()` and for each skill with `trigger === "slash_command"`, register a passthrough handler that forwards to `pipeline.turn`:

```ts
import { registerCommands } from "./commands/index.js";
const slashSkills = pipeline.loadedSkills().filter(s => s.trigger === "slash_command");
const handlers: Record<string, CommandHandler> = {};
for (const skill of slashSkills) {
  handlers[skill.name] = () => null; // sentinel — fall through to pipeline
}
// or have App.tsx check `pipeline.loadedSkills()` BEFORE calling tryCommand
// and skip tryCommand for names that match a slash_command skill.
```

The cleanest fix is to teach `tryCommand` (or App.tsx) about loaded skills so a `/foo` matching a slash-command skill falls through to `pipeline.turn` instead of getting the "Unknown command" rejection. Either solution is fine.

---

## Bug 2 — `matchesGlob` never expands `*` / `**` wildcards in auto-trigger paths

**Location:** `src/skills/activation.ts:78-107`

**What happens:**

The two-step glob → regex conversion is broken:

```ts
const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");      // step 1
const regexStr = escaped
  .replace(/\\\*\\\*/g, "{{DOUBLESTAR}}")                       // step 2a
  .replace(/\\\*/g, "[^/]*")                                    // step 2b
  .replace(/\{\{DOUBLESTAR\}\}/g, ".*");                        // step 2c
```

Step 1's character class `[.+^${}()|[\]\\]` does **not include `*`**. So `*` is never escaped to `\*`. Step 2 then looks for the escaped form `\*\*` and `\*` — which never appears in `escaped`. The wildcard substitutions are no-ops; the literal `*` characters survive into the final regex.

Verified empirically (`node` REPL):

| glob       | escaped      | regexStr     | final pattern        | result                             |
|------------|--------------|--------------|----------------------|------------------------------------|
| `**/*.ts`  | `**/*\.ts`   | `**/*\.ts`   | `^**/*\.ts$`         | **Invalid regex** → `catch` returns `false` for ALL inputs |
| `*.ts`     | `*\.ts`      | `*\.ts`      | `(?:^|/)*\.ts$`      | Valid regex but `(?:^|/)*` is a degenerate "0-or-more" quantifier — matches by accident because `\.ts$` literal works |
| `src/*.json` | `src/*\.json` | `src/*\.json` | `^src/*\.json$`    | "src" then 0+ `/` then `.json` — matches `src.json`, `src/.json`, `src///.json` (wrong: should match `src/foo.json`) |

**Impact:**

- Any auto-trigger skill with `paths: "**/*.ext"` is permanently dead — the regex throws and the catch branch returns `false` for every input.
- Skills with `paths: "*.ext"` work by accident only because the literal `.ext$` substring matches at the end. The `*` does no actual wildcard expansion.
- Skills with `paths: "src/*.ts"` won't match `src/foo.ts` (since `*` becomes `0+ /` not `non-slash chars`); they'd match `src.ts` or `src/.ts` instead.

The accompanying comment on line 91-94 even documents the intent — *"they were escaped to `\*` in step 1, so we look for the escaped form"* — but the escape character class actually omits `*`. Comment and code disagree.

`?` is similarly omitted from the escape class but its handler `replace(/\?/g, "[^/]")` looks for the literal `?` so it works correctly. Only `*` and `**` are broken.

**Suggested fix (do not apply yet):**

Either add `*` to the escape class so step 2's `\*` lookups find it, or change step 2 to look for the literal unescaped `*`:

```ts
// Option A: escape * in step 1 too, then step 2's \* lookups work as documented
const escaped = glob.replace(/[.+^${}()|[\]\\*]/g, "\\$&");

// Option B: change step 2 to match literal *
const regexStr = escaped
  .replace(/\*\*/g, "{{DOUBLESTAR}}")
  .replace(/\*/g, "[^/]*")
  .replace(/\{\{DOUBLESTAR\}\}/g, ".*");
```

Option A is closer to the comment's stated design.

The existing test `test/skills.test.ts:97-104` (with `paths: "*.test.ts"` against `"please fix src/cache.test.ts"`) passes only because of the accidental literal-substring match. After the fix the test will still pass (correctly this time), but additional coverage for `**/*.ts` and `src/*.ts` would catch this class of bug in the future.

---

## Notes

Verified the surface is otherwise quiet:
- TfIdfIndex live_n bookkeeping (round 11) holds.
- Pipeline serialization `while (this.inFlight)` (round 14) holds for N>2 callers.
- `assembleTurn` interleaved-tool flushing (round 14) holds.
- `expandFileRefs` cwd / trailing-punctuation behavior (rounds 10, 13) intact.
- All file-tool cwd hijack defenses (round 11) intact.
- OpenAI `tool_use_start` synthesis on truncated stream (round 13) intact.
- `validateContent`, `validatePathArgs`, `loopDetection` canonical-stringify (existing) all sound.
- Cold-summary system messages get folded into Anthropic/Google's global system prompt while OpenAI keeps positional — this is a long-standing structural design choice across providers, not a new bug.
- `Perceiver`'s `discoverSkills(dir)` loop is dead code in TUI usage (Pipeline never passes `skillDirs`), but the actual skill metadata path runs through `loadSkills` in `pipeline.init` — so harmless dead code, not a bug.
