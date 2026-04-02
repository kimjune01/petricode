// ── /skills command ─────────────────────────────────────────────

import type { Skill } from "../core/types.js";
import type { CommandResult } from "./index.js";

/**
 * Format the /skills listing output.
 */
export function listSkills(skills: Skill[]): CommandResult {
  if (skills.length === 0) {
    return { output: "No skills loaded." };
  }

  const lines = ["Available skills:"];
  for (const s of skills) {
    const prefix = s.trigger === "slash_command" ? `/${s.name}` : `${s.name} [${s.trigger}]`;
    const desc = typeof s.frontmatter.description === "string"
      ? ` — ${s.frontmatter.description}`
      : "";
    lines.push(`  ${prefix}${desc}`);
  }

  return { output: lines.join("\n") };
}
