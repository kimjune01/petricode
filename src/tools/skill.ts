// ── Skill tool ──────────────────────────────────────────────────
// Lets the model invoke a loaded skill by name. Mirrors Claude Code's
// Skill tool: the model picks a name from the available-skills system
// listing, the tool returns the skill body (with $ARGUMENTS substituted)
// as the tool result. The model then follows the skill's instructions.

import type { Tool } from "./tool.js";
import type { Skill } from "../core/types.js";
import { substituteArguments } from "../consolidate/skillSubstitution.js";

/**
 * Build a Skill tool bound to the given skill set. Pass an array (not a
 * function) — skills are loaded once at pipeline init and don't change
 * during a session.
 */
export function createSkillTool(skills: Skill[]): Tool {
  const byName = new Map<string, Skill>();
  for (const s of skills) byName.set(s.name, s);

  return {
    name: "Skill",
    description:
      "Invoke a loaded skill by name. The skill body is returned as the tool result; follow its instructions. See the <available_skills> system block for names and descriptions.",
    input_schema: {
      properties: {
        name: { type: "string", description: "Exact skill name from <available_skills>" },
        arguments: {
          type: "string",
          description: "Optional argument string substituted into $ARGUMENTS in the skill body",
        },
      },
      required: ["name"],
    },

    async execute(args) {
      const name = args.name as string;
      if (!name) throw new Error("Skill: missing required argument 'name'");
      const skill = byName.get(name);
      if (!skill) {
        const available = Array.from(byName.keys()).sort().join(", ") || "(none)";
        return `Error: unknown skill "${name}". Available: ${available}`;
      }
      const argString = typeof args.arguments === "string" ? args.arguments : "";
      return substituteArguments(skill.body, argString);
    },
  };
}
