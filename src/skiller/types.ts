// ── Skiller / Types ─────────────────────────────────────────────
// Sub-pipeline-local types. Skill itself stays in core/types.ts —
// it's a public domain type referenced by the Skill tool, the slash
// commands listing, and persisted SQLite rows. ActivatedSkill is the
// matcher's output envelope and lives only inside the skiller pipe.

import type { Skill } from "../core/types.js";

export interface ActivatedSkill {
  skill: Skill;
  arguments: string;
  via: "slash_command" | "auto_trigger" | "manual";
}
