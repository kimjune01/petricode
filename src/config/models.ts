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

/**
 * Optional fast-LLM tool-call triage classifier. When enabled, sits
 * between static policy and the user prompt: refines ASK_USER → ALLOW
 * (auto-run) / DENY (surface to LLM) / ASK_USER (fall through).
 * Requires Vertex creds (GOOGLE_CLOUD_PROJECT or ADC); fail-open on
 * any error so the user always stays in the loop.
 */
export interface ClassifierConfig {
  enabled: boolean;
  model?: string;
  timeout_ms?: number;
}

export interface TiersConfig {
  tiers: Record<TierName, TierConfig>;
  mode?: ConfirmMode;
  classifier?: ClassifierConfig;
}

// ── Model metadata ───────────────────────────────────────────────

export interface ModelInfo {
  token_limit: number;
  supports_tools: boolean;
}

// Anthropic model IDs follow Vertex AI's Model Garden naming
// (`claude-<family>-<version>`, no date suffix; bare names map to the
// `@default` published version). Direct-Anthropic-API users want the
// dated form (e.g. `claude-sonnet-4-20250514`) — add those as additional
// keys here if you wire AnthropicProvider against api.anthropic.com.
const MODEL_INFO: Record<string, ModelInfo> = {
  // Anthropic (Vertex)
  "claude-haiku-4-5": { token_limit: 200_000, supports_tools: true },
  "claude-opus-4-1": { token_limit: 200_000, supports_tools: true },
  "claude-opus-4-5": { token_limit: 200_000, supports_tools: true },
  "claude-opus-4-6": { token_limit: 200_000, supports_tools: true },
  "claude-opus-4-7": { token_limit: 200_000, supports_tools: true },
  "claude-sonnet-4-5": { token_limit: 200_000, supports_tools: true },
  "claude-sonnet-4-6": { token_limit: 200_000, supports_tools: true },
  // OpenAI
  "gpt-4o": { token_limit: 128_000, supports_tools: true },
  "gpt-4o-mini": { token_limit: 128_000, supports_tools: true },
  "gpt-4.1": { token_limit: 1_047_576, supports_tools: true },
  "gpt-4.1-mini": { token_limit: 1_047_576, supports_tools: true },
  // Google (Vertex)
  "gemini-2.5-pro": { token_limit: 1_048_576, supports_tools: true },
  "gemini-2.5-flash": { token_limit: 1_048_576, supports_tools: true },
  "gemini-3.1-pro-preview": { token_limit: 1_048_576, supports_tools: true },
  "gemini-2.0-flash": { token_limit: 1_048_576, supports_tools: true },
};

const DEFAULT_MODEL_INFO: ModelInfo = { token_limit: 128_000, supports_tools: true };

export function getModelInfo(model: string): ModelInfo {
  return MODEL_INFO[model] ?? DEFAULT_MODEL_INFO;
}

export function listKnownModels(): string[] {
  return Object.keys(MODEL_INFO);
}

/**
 * Map a model ID to its vendor by name prefix. Returns null if the
 * vendor can't be inferred — caller must specify provider explicitly.
 */
export function inferProviderFromModel(modelId: string): ProviderName | null {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (
    modelId.startsWith("gpt-") ||
    modelId.startsWith("o1") ||
    modelId.startsWith("o3")
  ) return "openai";
  if (modelId.startsWith("gemini-")) return "google";
  return null;
}

// ── Tier defaults & validation ──────────────────────────────────

export const DEFAULT_TIERS: TiersConfig = {
  tiers: {
    primary: { provider: "anthropic", model: "claude-opus-4-7" },
    reviewer: { provider: "openai", model: "gpt-4o" },
    fast: { provider: "anthropic", model: "claude-haiku-4-5" },
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
