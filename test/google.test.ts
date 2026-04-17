import { describe, test, expect } from "bun:test";
import type { TiersConfig } from "../src/config/models.js";
import { validateTiers, getModelInfo, DEFAULT_TIERS } from "../src/config/models.js";
import { TierRouter } from "../src/providers/router.js";
import type { Provider, ModelConfig } from "../src/providers/provider.js";
import type { Message, StreamChunk } from "../src/core/types.js";

// ── Config validation with Google ────────────────────────────────

describe("Google provider config", () => {
  test("validateTiers accepts google as provider", () => {
    const config = {
      tiers: {
        primary: { provider: "google", model: "gemini-2.5-pro" },
        reviewer: { provider: "anthropic", model: "claude-sonnet-4-5" },
        fast: { provider: "google", model: "gemini-2.0-flash" },
      },
    };
    const validated = validateTiers(config);
    expect(validated.tiers.primary.provider).toBe("google");
  });

  test("getModelInfo returns info for gemini models", () => {
    const info = getModelInfo("gemini-2.5-pro");
    expect(info.token_limit).toBe(1_048_576);
    expect(info.supports_tools).toBe(true);
  });

  test("getModelInfo returns default for unknown gemini model", () => {
    const info = getModelInfo("gemini-99-ultra");
    expect(info.token_limit).toBe(128_000);
  });

  test("google+anthropic is a valid primary+reviewer combo", () => {
    const mockProvider: Provider = {
      async *generate() {
        yield { type: "content_delta" as const, text: "ok" };
        yield { type: "done" as const };
      },
      model_id: () => "mock",
      token_limit: () => 200_000,
      supports_tools: () => true,
    };

    const config: TiersConfig = {
      tiers: {
        primary: { provider: "google", model: "gemini-2.5-pro" },
        reviewer: { provider: "anthropic", model: "claude-sonnet-4-5" },
        fast: { provider: "google", model: "gemini-2.0-flash" },
      },
    };

    // Should not throw — different vendors
    const router = new TierRouter(config, () => mockProvider);
    expect(router.get("primary")).toBeDefined();
  });

  test("google+google primary+reviewer throws", () => {
    const mockProvider: Provider = {
      async *generate() {
        yield { type: "done" as const };
      },
      model_id: () => "mock",
      token_limit: () => 200_000,
      supports_tools: () => true,
    };

    const config: TiersConfig = {
      tiers: {
        primary: { provider: "google", model: "gemini-2.5-pro" },
        reviewer: { provider: "google", model: "gemini-2.5-flash" },
        fast: { provider: "google", model: "gemini-2.0-flash" },
      },
    };

    expect(() => new TierRouter(config, () => mockProvider)).toThrow(
      "Primary and reviewer must use different vendors",
    );
  });
});
