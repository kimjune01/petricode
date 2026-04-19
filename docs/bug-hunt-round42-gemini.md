# Bug Hunt Round 42

Found 4 new high-severity functional bugs across tools, shell filtering, and skill parsing.

## Triage outcome

- **#1 (grep --null -r broken on macOS)** — REJECTED as false positive. Verified empirically: `grep --null -rnE pattern dir/` on macOS BSD grep emits NUL-separated `path\0lineno:text` records, exits 0 on match, and recurses correctly. Gemini hallucinated the BSD incompatibility. The `--null` flag has been the portable long form across BSD and GNU grep since BSD adopted GNU-compatible long options; the conflict gemini cited would only apply to `-Z`, which means decompress on BSD.
- **#2 (rm regex bypass)** — FIXED in `src/filter/shellDanger.ts`. Broadened the rm regex with `(?:[^;&|\n]*\s)?` to allow intervening tokens before the dangerous flag, mirroring the `git push` pattern.
- **#3 (skill parser drops Claude skills without frontmatter)** — DEFERRED. Premise is wrong: Claude custom skills DO carry YAML frontmatter (see Anthropic's published skill format with `name`/`description` fields). The current parseFrontmatter contract is correct — a file with no frontmatter has no name or description, so we can't index it. Severity downgraded to low and not actionable.
- **#4 (skiller glob `?` and `**` mishandled)** — FIXED in `src/skiller/filter.ts`. Added `?` to the escape class with conversion to `[^/]`; replaced `**` substitution with the sentinel-based gitignore-style expansion so `/**/` becomes `(/.*?)?/` and direct children match.

## 1. `grep` tool recursive search silently fails on macOS (BSD grep)
**File:** `src/tools/grep.ts`
**Line:** ~64 (the `--null` argument in `grepArgs`)
**Severity:** High
**Description:** The `grep` tool uses the `--null` flag alongside `-rnE` to output a NUL byte after the filename, noting in a comment that `--null` is "portable across BSD grep (macOS) and GNU grep". However, on macOS (BSD grep), combining `--null` with `-r` (recursive) is fundamentally broken and silently suppresses *all* output (exit code 1) when searching directories. Consequently, the agent's `grep` tool always silently returns `(no matches)` for any recursive directory search on macOS.
**Impact:** The agent completely loses the ability to recursively search for code on macOS, consistently hallucinating that patterns do not exist in the project.
**Suggested Fix:** Avoid using `--null` with `-r` on macOS. Either use `find . -type f -exec grep -HnE ... {} +` under the hood, or revert to parsing colons but with a more robust regex to handle colons in filenames (e.g. `^(.+?):(\d+):(.*)$`).

## 2. Dangerous shell guard `rm` regex bypassed by interleaved flags
**File:** `src/filter/shellDanger.ts`
**Line:** ~24 (the `rm` regex pattern)
**Severity:** High
**Description:** The dangerous shell pattern for recursive removal is `\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*|--(?:recursive|force))\b`. This pattern strictly requires the dangerous flag (`-r`, `-f`, `--force`) to be the *very first* argument immediately following `rm `. If the LLM generates a command with an interleaved target or harmless flag first (e.g., `rm build/ -rf`, `rm -i -r`, `rm * -f`), the regex fails to match. 
**Impact:** Destructive file deletions bypass the safety prompt in permissive mode and execute automatically, defeating the gating mechanism.
**Suggested Fix:** Update the regex to allow intervening arguments similar to the `git push` pattern, or simply check for the flag anywhere in the command after `rm` without bounding it immediately to the command.

## 3. Existing Claude skills silently dropped due to strict frontmatter requirement
**File:** `src/skiller/perceive.ts`
**Line:** ~74 (`parseFrontmatter` function)
**Severity:** Medium
**Description:** The `parseFrontmatter` function requires a skill file to start with a YAML `---` fence; otherwise, it returns `null`. This causes `readSkillFile` to silently drop the skill entirely. The comments explicitly state the intent to support "Claude per-skill layout" where "Claude skills don't carry triggers". However, because standard Claude custom skills (`CLAUDE.md` or MCP skills) typically do not contain *any* YAML frontmatter, they are completely ignored by the petricode agent upon discovery.
**Impact:** Users cannot use their existing Claude skills unless they manually edit every single one to add empty `---` frontmatter fences.
**Suggested Fix:** If the frontmatter regex does not match, `parseFrontmatter` should gracefully return `{ frontmatter: {}, body: raw }` instead of `null`, allowing frontmatter-less skills to load with default attributes.

## 4. Auto-trigger glob parser misinterprets `?` and mishandles `**` paths
**File:** `src/skiller/filter.ts`
**Line:** ~64 (`matchesGlob` string replacement logic)
**Severity:** High
**Description:** The custom glob-to-regex converter (`matchesGlob`) fails to escape the `?` regex metacharacter (it only escapes `[.+^${}()|[\]\\*]`). Consequently, a glob like `src/foo?.ts` incorrectly treats `?` as a regex quantifier, matching `src/fo.ts` but failing to match `src/foox.ts`. Additionally, the simplistic replacement of `**` with `.*` causes patterns like `src/**/*.ts` to compile to a regex requiring at least two slashes (`src/.*/[^/]*\.ts`), incorrectly failing to match direct children like `src/foo.ts`.
**Impact:** Auto-trigger skills using `?` or `**` in their paths will fail to activate on legitimate file paths or activate on unintended paths.
**Suggested Fix:** Add `?` to the escape character class and properly map glob `?` to `[^/]`. For `**`, adjust the regex to make the intermediate slash optional, or better yet, use a standard library like `minimatch` for robust glob conversion.
