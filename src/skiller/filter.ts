// ── Skiller / Filter ────────────────────────────────────────────
// Predicate filter over the indexed skill registry. Two predicates,
// each producing ActivatedSkill envelopes:
//   - matchSlashCommand: single_best (one slash → at most one skill)
//   - matchAutoTriggers: top_k_slate (path globs → all that match)
// Manual-trigger skills are not selected here — the LLM picks them
// itself via the Skill tool.

import type { Skill } from "../core/types.js";
import type { ActivatedSkill } from "./types.js";

/**
 * Try to match input against a slash-command skill.
 * Input like "/greet Alice" matches skill named "greet".
 * Returns null if no match.
 */
export function matchSlashCommand(
  input: string,
  skills: Skill[],
): ActivatedSkill | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  const commandName = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  const skill = skills.find(
    (s) => s.trigger === "slash_command" && s.name === commandName,
  );
  if (!skill) return null;

  return {
    skill,
    arguments: args,
    via: "slash_command",
  };
}

/**
 * Find auto-trigger skills that match the given input.
 * Auto skills have a `paths` frontmatter field; if any file path in the input
 * matches the glob pattern, the skill activates.
 */
export function matchAutoTriggers(
  input: string,
  skills: Skill[],
): ActivatedSkill[] {
  const autoSkills = skills.filter((s) => s.trigger === "auto");
  const activated: ActivatedSkill[] = [];

  for (const skill of autoSkills) {
    const rawPaths = skill.frontmatter.paths;
    if (typeof rawPaths !== "string") continue;
    // Strip surrounding quotes from YAML value (simple parser keeps them)
    const paths = rawPaths.replace(/^["']|["']$/g, "");

    if (matchesGlob(input, paths)) {
      activated.push({
        skill,
        arguments: input,
        via: "auto_trigger",
      });
    }
  }

  return activated;
}

/**
 * Simple glob matching against input text.
 * Checks if any path-like token in input matches the glob pattern.
 * Supports single-star and double-star wildcards, anchored at end.
 */
function matchesGlob(input: string, glob: string): boolean {
  // Extract path-like tokens from input. The dot check used to be a
  // bare `t.includes(".")`, which silently auto-triggered skills on
  // version strings (`v1.2.3`), domain names (`example.com`), and IP
  // addresses (`192.168.1.1`). A skill with `paths: "*.3"` would then
  // fire on "upgrade to v1.2.3" with no indication to the user.
  //
  // Tighten to either:
  //   - tokens containing `/` (definitely a path)
  //   - bare filename shape: identifier-style stem + single dot +
  //     alpha-leading extension. Catches `foo.ts`, `MyClass.tsx`,
  //     `archive.7z` (well, no — dropped, but rare in skill globs);
  //     filters `v1.2.3`, `192.168.1.1`, `2.0.1-rc`.
  const tokens = input.split(/\s+/).filter(
    (t) => t.includes("/") || /^[A-Za-z_][\w-]*\.[A-Za-z]\w*$/.test(t),
  );

  // Convert glob to regex.
  // Step 1: escape ALL regex metacharacters so a skill author writing
  //   paths: "src/(foo|bar)/**.ts"
  // doesn't end up with live alternation (or worse, an invalid regex
  // that throws and breaks auto-trigger for ALL skills).
  // Step 2: re-introduce wildcard meaning for *, **, and ? (they were
  // escaped to \*, \? in step 1, so we look for the escaped form).
  const hasSlash = glob.includes("/");
  // Include `*` and `?` in the escape class so step 2's `\*\*` / `\*` /
  // `\?` lookups actually find their targets — without `*`, patterns
  // like `**/*.ts` either threw or matched the wrong shape; without `?`,
  // `?` survived as a regex quantifier and a glob like `src/foo?.ts`
  // matched `src/fo.ts` (zero chars) instead of `src/fooX.ts` (one char).
  const escaped = glob.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
  const regexStr = escaped
    // Glob `?` → exactly one non-slash char. Done first so the globstar
    // expansions below (which emit literal `?` regex quantifiers) aren't
    // mangled by a later pass.
    .replace(/\\\?/g, "[^/]")
    // Globstar handled with sentinels so each pass doesn't trample the
    // next. Mirrors the gitignore globstar logic (filter/gitignore.ts):
    //   `/**/` → `(/.*?)?/`  — slash-optional so `src/**/*.ts` matches
    //                          BOTH `src/foo.ts` (direct child) AND
    //                          `src/sub/foo.ts`. Without this, the prior
    //                          `.*` form forced a slash and silently
    //                          dropped direct-child matches.
    //   `**/`  → `(.*?/)?`   — leading globstar
    //   `**`   → `.*?`       — solo globstar
    .replace(/\/\\\*\\\*\//g, "{{SLASHGLOBSTAR}}")
    .replace(/\\\*\\\*\//g, "{{LEADGLOBSTAR}}")
    .replace(/\\\*\\\*/g, "{{GLOBSTAR}}")
    .replace(/\\\*/g, "[^/]*")
    .replace(/\{\{SLASHGLOBSTAR\}\}/g, "(/.*?)?/")
    .replace(/\{\{LEADGLOBSTAR\}\}/g, "(.*?/)?")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*?");
  // Basename globs like *.ts match any path ending with that pattern
  const pattern = hasSlash ? `^${regexStr}$` : `(?:^|/)${regexStr}$`;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    // Should be impossible after escaping, but a single bad pattern
    // mustn't take out auto-trigger for the whole skill registry.
    return false;
  }

  return tokens.some((token) => regex.test(token));
}
