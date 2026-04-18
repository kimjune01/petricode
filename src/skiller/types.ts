// ── Skiller / Types ─────────────────────────────────────────────
// Sub-pipeline-local types. Skill itself stays in core/types.ts —
// it crosses sub-pipeline boundaries (perceive/discovery, transmit/
// skillStore, the Skill tool). ActivatedSkill is the matcher's output
// envelope and lives only inside the skiller sub-pipeline.

import type { Skill } from "../core/types.js";

export interface ActivatedSkill {
  skill: Skill;
  arguments: string;
  via: "slash_command" | "auto_trigger" | "manual";
}
