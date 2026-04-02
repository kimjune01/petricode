// ── Default tier configuration ──────────────────────────────────

import type { TiersConfig } from "./models.js";
import { DEFAULT_TIERS } from "./models.js";

export { DEFAULT_TIERS };

export const DEFAULT_TIER_CONFIG: TiersConfig = DEFAULT_TIERS;

export const DEFAULT_MAX_TOOL_ROUNDS = 10;
export const DEFAULT_HOT_CAPACITY = 10;
export const DEFAULT_MAX_CLUSTERS = 20;
export const DEFAULT_SESSION_DIR = ".petricode";
