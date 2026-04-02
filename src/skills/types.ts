// ── Skill activation types ──────────────────────────────────────

import type { Skill } from "../core/types.js";

export interface ActivatedSkill {
  skill: Skill;
  arguments: string;
  /** How the skill was activated */
  via: "slash_command" | "auto_trigger" | "manual";
}
