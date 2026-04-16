// ── Model configuration types ────────────────────────────────────

export interface ModelConfig {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

export type ProviderName = "anthropic" | "openai" | "google";

export interface TierConfig {
  provider: ProviderName;
  model: string;
}

export type TierName = "primary" | "reviewer" | "fast";

export type ConfirmMode = "yolo" | "cautious";

export interface TiersConfig {
  tiers: Record<TierName, TierConfig>;
  mode?: ConfirmMode;
}

// ── Model metadata ───────────────────────────────────────────────

export interface ModelInfo {
  token_limit: number;
  supports_tools: boolean;
}

const MODEL_INFO: Record<string, ModelInfo> = {
  // Anthropic
  "claude-sonnet-4-20250514": { token_limit: 200_000, supports_tools: true },
  "claude-haiku-4-5-20251001": { token_limit: 200_000, supports_tools: true },
  "claude-opus-4-20250514": { token_limit: 200_000, supports_tools: true },
  "claude-opus-4-6-20260205": { token_limit: 200_000, supports_tools: true },
  // OpenAI
  "gpt-4o": { token_limit: 128_000, supports_tools: true },
  "gpt-4o-mini": { token_limit: 128_000, supports_tools: true },
  "gpt-4.1": { token_limit: 1_047_576, supports_tools: true },
  "gpt-4.1-mini": { token_limit: 1_047_576, supports_tools: true },
  // Google
  "gemini-2.5-pro": { token_limit: 1_048_576, supports_tools: true },
  "gemini-2.5-flash": { token_limit: 1_048_576, supports_tools: true },
  "gemini-3.1-pro-preview": { token_limit: 1_048_576, supports_tools: true },
  "gemini-2.0-flash": { token_limit: 1_048_576, supports_tools: true },
};

const DEFAULT_MODEL_INFO: ModelInfo = { token_limit: 128_000, supports_tools: true };

export function getModelInfo(model: string): ModelInfo {
  return MODEL_INFO[model] ?? DEFAULT_MODEL_INFO;
}

// ── Tier defaults & validation ──────────────────────────────────

export const DEFAULT_TIERS: TiersConfig = {
  tiers: {
    primary: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    reviewer: { provider: "openai", model: "gpt-4o" },
    fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  },
};

export function validateTiers(config: unknown): TiersConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Missing tiers configuration");
  }

  const c = config as Record<string, unknown>;
  if (!c.tiers || typeof c.tiers !== "object") {
    throw new Error("Missing 'tiers' key in configuration");
  }

  const tiers = c.tiers as Record<string, unknown>;
  const required: TierName[] = ["primary", "reviewer", "fast"];

  for (const tier of required) {
    if (!tiers[tier]) {
      throw new Error(`Tier '${tier}' is not configured`);
    }
    const t = tiers[tier] as Record<string, unknown>;
    if (!t.provider || !["anthropic", "openai", "google"].includes(t.provider as string)) {
      throw new Error(
        `Tier '${tier}' has invalid provider: ${String(t.provider)}`,
      );
    }
    if (!t.model || typeof t.model !== "string") {
      throw new Error(`Tier '${tier}' has invalid model`);
    }
  }

  return c as unknown as TiersConfig;
}
