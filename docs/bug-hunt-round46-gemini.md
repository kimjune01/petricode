# Bug Hunt Round 46

Four new bugs found. All verified against source. None overlap with the previously-fixed list.

> Reviewer: `claude --model sonnet` (gemini still throws on Vertex
> serialization, codex still unauthenticated).

## Triage outcome

- **#1 (post-truncation hang on SIGTERM-immune children)** — FIXED in `src/tools/shell.ts` and `src/tools/grep.ts`. Round 44's clearTimeout removed the SIGKILL fallback, so processes that trap SIGTERM hang forever. Now schedule a 2s grace SIGKILL on truncation; the close handler still resolves with the truncated body.
- **#2 (false truncation on exact-multiple-of-256KB files)** — FIXED in `src/tools/readFile.ts`. Added `stats.size > 0 && stats.size <= MAX_READ_BYTES` guard so a fully-read file doesn't get the truncation marker just because it filled the buffer exactly.
- **#3 (duplicate `trigger:` key in serialized skills)** — FIXED in `src/skiller/transmit.ts:51`. Added `trigger` to the skip set in the frontmatter loop alongside `name`.
- **#4 (BOM-prefixed skill files silently dropped)** — FIXED in `src/skiller/perceive.ts:96`. Strip a leading `\uFEFF` before the `^---` regex match so Windows-edited skill files load.

---

## #1 — shell.ts + grep.ts: post-truncation hang if process ignores SIGTERM

**Files:** `src/tools/shell.ts:71`, `src/tools/grep.ts:176`

**Description:** When output exceeds `MAX_OUTPUT_BYTES`, both tools call `clearTimeout(timer)` (to prevent the prior race where the timer would SIGKILL and reject the promise before the partial-output resolve path could run) and then send `SIGTERM`. This fix was correct for the race, but it introduced a new failure mode: if the spawned process ignores SIGTERM — common for shell scripts that `trap '' SIGTERM` — there is now no follow-up SIGKILL and no timer left to enforce one. The `close` event never fires, the Promise never settles, and the tool hangs the agent indefinitely.

Before the round-40 fix, SIGTERM-immune processes were still killed eventually by the timeout SIGKILL. After the fix, they hang forever.

**User-visible impact:** A shell command or grep invocation that produces >1 MB of output and ignores SIGTERM causes the agent to hang until the user kills the process externally.

**Suggested fix:** After sending SIGTERM, start a short grace-period timer (e.g. `setTimeout(() => proc.kill("SIGKILL"), 2000)`) rather than clearing the timer entirely. The promise resolve path should clear this grace timer on `close`. The existing race is still avoided because the truncation resolve is the _first_ thing to call `resolve()` (the grace timer's SIGKILL only triggers `close`, which then calls `resolve` with the truncated body — idempotent since Promise.resolve ignores duplicate calls).

**Severity:** LOW — SIGTERM-immune processes are uncommon, but the consequence when it hits is an unrecoverable infinite hang.

---

## #2 — readFile.ts: false truncation message for files exactly MAX_READ_BYTES in size

**File:** `src/tools/readFile.ts:58`

```typescript
if (bytesRead < MAX_READ_BYTES) return body;
return `${body}\n[truncated — file is ${stats.size || "≥"+MAX_READ_BYTES} bytes, ...]`;
```

**Description:** The condition `bytesRead < MAX_READ_BYTES` is false when the file is _exactly_ 262 144 bytes. A 256 KB file reads into the buffer completely (`bytesRead === MAX_READ_BYTES`) but `fh.read` stops at the buffer boundary — it does not tell you whether more bytes exist beyond it. The code treats `bytesRead === MAX_READ_BYTES` as "definitely truncated" and returns the truncation message, even though the file was read in full.

Compare with `fileRefs.ts`, which has the same logic but is correct because it uses `TextDecoder` with `stream: true` and documents the same edge case — it just means the marker occasionally appears unnecessarily, not that content is lost.

**User-visible impact:** The model is told a complete 256 KB file was truncated. It may attempt to read it in chunks, wasting context and producing incorrect reasoning about the file's completeness.

**Suggested fix:** After `fh.read`, check whether the file is actually larger by reading one more byte, or compare `stats.size` when it's reliable: `if (bytesRead < MAX_READ_BYTES || (stats.size > 0 && stats.size <= MAX_READ_BYTES)) return body;`. The fileRefs.ts version's `truncated = bytesRead >= MAX_READ_BYTES` flag is correct in its context because it uses `stats.size > 0` to choose the message. Apply the same `stats.size` guard in readFile.ts.

**Severity:** LOW — affects only files whose size is an exact multiple of 256 KB.

---

## #3 — skiller/transmit.ts: duplicate `trigger:` key written when serializing skills

**File:** `src/skiller/transmit.ts:50-55`

```typescript
for (const [key, value] of Object.entries(skill.frontmatter)) {
  if (key === "name") continue;   // skips name
  lines.push(`${key}: ${JSON.stringify(value)}`);
}
lines.push(`trigger: ${skill.trigger}`);  // always appended
```

**Description:** `serializeSkill` skips the `name` key in the frontmatter loop to avoid duplication, but does not skip `trigger`. Skills loaded via `discoverSkills` → `readSkillFile` → `parseFrontmatter` retain `trigger` in their `frontmatter` dict (the simple YAML parser in `perceive.ts` stores ALL key-value pairs verbatim). When such a skill is passed to `SkillStore.write`, the loop emits `trigger: "slash_command"` (JSON-quoted, from frontmatter), and then the explicit line below emits `trigger: slash_command` (unquoted, from `skill.trigger`). The resulting file has a duplicate key.

`SkillStore.parseSkill` processes both lines and the last one wins, so functional behavior is preserved. But the file is malformed YAML and confusing to users who inspect it.

**User-visible impact:** Consolidated skills written to disk have a duplicate `trigger:` line in the frontmatter. Users reading the file see it as malformed.

**Suggested fix:** Add `trigger` to the skip set in the frontmatter loop:

```typescript
if (key === "name" || key === "trigger") continue;
```

**Severity:** LOW — no functional breakage; cosmetic but confusing to users.

---

## #4 — skiller/perceive.ts: skills with BOM prefix silently fail to load

**File:** `src/skiller/perceive.ts:96`

```typescript
const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
if (!match) return null;
```

**Description:** The regex anchors on `^---` at the very start of the string. Files saved by Windows editors (Notepad, VS Code on Windows with certain settings, many cross-platform editors) often prepend a UTF-8 Byte Order Mark (`\uFEFF`) before any content. A BOM-prefixed skill file starts with `\uFEFF---` instead of `---`, so `match` returns `null` and `readSkillFile` returns `null` — the skill is silently dropped.

There is no error message, no warning, and no indication in `loadSkills` that a skill file was skipped. The user sees an empty available-skills list or a subset of what they wrote.

**User-visible impact:** Any skill file created by a Windows editor with BOM encoding does not load. The failure is completely silent — `discoverSkills` returns fewer skills than the directory contains.

**Suggested fix:** Strip a leading BOM before the regex match:

```typescript
const stripped = raw.replace(/^\uFEFF/, "");
const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
```

**Severity:** LOW — Windows-only, but completely silent; users have no path to debugging it.
