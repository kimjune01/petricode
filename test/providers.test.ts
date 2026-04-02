import { describe, test, expect } from "bun:test";
import type { Content, StreamChunk } from "../src/core/types.js";
import type { Provider } from "../src/providers/provider.js";
import type { ModelConfig } from "../src/providers/provider.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { TierRouter } from "../src/providers/router.js";
import type { TiersConfig } from "../src/config/models.js";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ── Mock provider ────────────────────────────────────────────────

class MockProvider implements Provider {
  private _model: string;
  private _vendor: string;
  private _tokenLimit: number;
  private chunks: StreamChunk[];

  constructor(vendor: string, model: string, opts?: { chunks?: StreamChunk[]; tokenLimit?: number }) {
    this._vendor = vendor;
    this._model = model;
    this._tokenLimit = opts?.tokenLimit ?? 128_000;
    this.chunks = opts?.chunks ?? [
      { type: "content_delta", text: "hello" },
      { type: "content_delta", text: " world" },
      { type: "done" },
    ];
  }

  async *generate(
    _prompt: Content[][],
    _config?: ModelConfig,
  ): AsyncGenerator<StreamChunk> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  model_id(): string {
    return this._model;
  }

  token_limit(): number {
    return this._tokenLimit;
  }

  supports_tools(): boolean {
    return true;
  }

  vendor(): string {
    return this._vendor;
  }
}

// ── Helper to collect stream ─────────────────────────────────────

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = [];
  for await (const chunk of gen) {
    result.push(chunk);
  }
  return result;
}

// ── Mock factory for TierRouter ──────────────────────────────────

function mockFactory(providerName: string, model: string): Provider {
  const tokenLimit = providerName === "anthropic" ? 200_000 : 128_000;
  return new MockProvider(providerName, model, { tokenLimit });
}

// ── Tests ────────────────────────────────────────────────────────

describe("adapter shape", () => {
  test("AnthropicProvider implements Provider interface", () => {
    // Pass a dummy client to avoid needing a real API key
    const dummyClient = new Anthropic({ apiKey: "test-key" });
    const adapter = new AnthropicProvider("claude-sonnet-4-20250514", dummyClient);
    expect(typeof adapter.generate).toBe("function");
    expect(typeof adapter.model_id).toBe("function");
    expect(typeof adapter.token_limit).toBe("function");
    expect(typeof adapter.supports_tools).toBe("function");
    expect(adapter.model_id()).toBe("claude-sonnet-4-20250514");
    expect(adapter.token_limit()).toBe(200_000);
    expect(adapter.supports_tools()).toBe(true);
  });

  test("OpenAIProvider implements Provider interface", () => {
    // Pass a dummy client to avoid needing a real API key
    const dummyClient = new OpenAI({ apiKey: "test-key" });
    const adapter = new OpenAIProvider("gpt-4o", dummyClient);
    expect(typeof adapter.generate).toBe("function");
    expect(typeof adapter.model_id).toBe("function");
    expect(typeof adapter.token_limit).toBe("function");
    expect(typeof adapter.supports_tools).toBe("function");
    expect(adapter.model_id()).toBe("gpt-4o");
    expect(adapter.token_limit()).toBe(128_000);
    expect(adapter.supports_tools()).toBe(true);
  });
});

describe("tier resolution", () => {
  test("config resolves all three tiers to correct providers", () => {
    const config: TiersConfig = {
      tiers: {
        primary: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        reviewer: { provider: "openai", model: "gpt-4o" },
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    };

    const router = new TierRouter(config, mockFactory);

    expect(router.get("primary").model_id()).toBe("claude-sonnet-4-20250514");
    expect(router.get("reviewer").model_id()).toBe("gpt-4o");
    expect(router.get("fast").model_id()).toBe("claude-haiku-4-5-20251001");
  });

  test("primary and reviewer resolve to different vendors", () => {
    const config: TiersConfig = {
      tiers: {
        primary: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        reviewer: { provider: "openai", model: "gpt-4o" },
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    };

    const router = new TierRouter(config, mockFactory);
    // Primary is anthropic, reviewer is openai — different vendors
    expect(router.get("primary").model_id()).toContain("claude");
    expect(router.get("reviewer").model_id()).toContain("gpt");
  });
});

describe("mocked stream", () => {
  test("mock provider produces stream from mocked data", async () => {
    const chunks: StreamChunk[] = [
      { type: "content_delta", text: "test " },
      { type: "content_delta", text: "output" },
      { type: "done" },
    ];
    const provider = new MockProvider("anthropic", "test-model", { chunks });
    const prompt: Content[][] = [[{ type: "text", text: "hello" }]];

    const result = await collect(provider.generate(prompt));

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "content_delta", text: "test " });
    expect(result[1]).toEqual({ type: "content_delta", text: "output" });
    expect(result[2]).toEqual({ type: "done" });
  });

  test("mock provider streams tool_use chunks", async () => {
    const chunks: StreamChunk[] = [
      { type: "tool_use_start", id: "t1", name: "read_file" },
      { type: "tool_use_delta", input_json: '{"path":"/tmp"}' },
      { type: "done" },
    ];
    const provider = new MockProvider("openai", "test-model", { chunks });
    const prompt: Content[][] = [[{ type: "text", text: "read a file" }]];

    const result = await collect(provider.generate(prompt));

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "tool_use_start", id: "t1", name: "read_file" });
  });
});

describe("startup validation", () => {
  test("fails if any tier is unwired", () => {
    const partial = {
      tiers: {
        primary: { provider: "anthropic" as const, model: "claude-sonnet-4-20250514" },
        reviewer: { provider: "openai" as const, model: "gpt-4o" },
        // fast is missing
      },
    };

    expect(() => new TierRouter(partial as unknown as TiersConfig, mockFactory)).toThrow(/unwired/i);
  });

  test("fails if primary and reviewer use same vendor", () => {
    const sameVendor: TiersConfig = {
      tiers: {
        primary: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        reviewer: { provider: "anthropic", model: "claude-opus-4-20250514" },
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    };

    expect(() => new TierRouter(sameVendor, mockFactory)).toThrow(/different vendors|same/i);
  });
});

describe("fast tier routing", () => {
  test("fast tier is callable and routed correctly", () => {
    const config: TiersConfig = {
      tiers: {
        primary: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        reviewer: { provider: "openai", model: "gpt-4o" },
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    };

    const router = new TierRouter(config, mockFactory);
    const fast = router.get("fast");

    expect(fast).toBeDefined();
    expect(fast.model_id()).toBe("claude-haiku-4-5-20251001");
    expect(fast.token_limit()).toBe(200_000);
  });
});
