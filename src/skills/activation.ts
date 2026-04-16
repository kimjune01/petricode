// ── Skill activation ────────────────────────────────────────────
// Match slash commands, auto-trigger on file paths, $ARGUMENTS substitution.

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
 * Substitute $ARGUMENTS in skill body with the provided arguments string.
 */
export function substituteArguments(body: string, args: string): string {
  // Use split/join instead of replace to prevent $-token evaluation in args
  return body.split("$ARGUMENTS").join(args);
}

/**
 * Simple glob matching against input text.
 * Checks if any path-like token in input matches the glob pattern.
 * Supports single-star and double-star wildcards, anchored at end.
 */
function matchesGlob(input: string, glob: string): boolean {
  // Extract path-like tokens from input
  const tokens = input.split(/\s+/).filter((t) => t.includes("/") || t.includes("."));

  // Convert glob to regex.
  // Step 1: escape ALL regex metacharacters so a skill author writing
  //   paths: "src/(foo|bar)/**.ts"
  // doesn't end up with live alternation (or worse, an invalid regex
  // that throws and breaks auto-trigger for ALL skills).
  // Step 2: re-introduce wildcard meaning for * and ** (they were escaped
  // to \* in step 1, so we look for the escaped form).
  const hasSlash = glob.includes("/");
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped
    .replace(/\\\*\\\*/g, "{{DOUBLESTAR}}")
    .replace(/\\\*/g, "[^/]*")
    .replace(/\{\{DOUBLESTAR\}\}/g, ".*");
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
