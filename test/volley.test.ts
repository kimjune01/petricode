import { describe, test, expect } from "bun:test";
import { volley } from "../src/convergence/volley.js";
import type { Provider } from "../src/providers/provider.js";
import type { Message, StreamChunk } from "../src/core/types.js";
import type { ModelConfig } from "../src/providers/provider.js";

// ── Mock provider factory ──────────────────────────────────────

function mockProvider(
  responses: string[],
  id: string = "mock",
): Provider {
  let callIndex = 0;
  return {
    model_id: () => id,
    token_limit: () => 100_000,
    supports_tools: () => false,
    async *generate(
      _prompt: Message[],
      _config: ModelConfig,
    ): AsyncGenerator<StreamChunk> {
      const text = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      yield { type: "content_delta", text };
      yield { type: "done" };
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("Volley input validation", () => {
  test("empty artifact throws", () => {
    const p = mockProvider([], "primary");
    const r = mockProvider([], "reviewer");
    expect(() => volley("", p, r)).toThrow(/empty/i);
  });

  test("whitespace-only artifact throws", () => {
    const p = mockProvider([], "primary");
    const r = mockProvider([], "reviewer");
    expect(() => volley("   \n\t  ", p, r)).toThrow(/empty/i);
  });

  test("same model_id for primary and reviewer throws", () => {
    const p = mockProvider([], "same-model");
    const r = mockProvider([], "same-model");
    expect(() => volley("valid artifact", p, r)).toThrow(/self-review/i);
  });

  test("valid inputs do not throw", async () => {
    const p = mockProvider(["revised"], "model-a");
    const r = mockProvider(["NO_ISSUES"], "model-b");
    const result = await volley("valid artifact", p, r);
    expect(result.converged).toBe(true);
  });
});

describe("Volley", () => {
  test("clean artifact converges in round 1", async () => {
    const primary = mockProvider(["artifact text"], "primary");
    const reviewer = mockProvider(["NO_ISSUES"], "reviewer");

    const result = await volley("clean artifact", primary, reviewer);
    expect(result.converged).toBe(true);
    expect(result.rounds).toBe(1);
    expect(result.content).toBe("clean artifact");
  });

  test("flawed artifact converges by round 2", async () => {
    const primary = mockProvider(["revised artifact"], "primary");
    const reviewer = mockProvider([
      "Issue: missing error handling", // round 1: finds issue
      "NO_ISSUES",                      // round 2: satisfied
    ], "reviewer");

    const result = await volley("flawed artifact", primary, reviewer);
    expect(result.converged).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.content).toBe("revised artifact");
    expect(result.reviewer_findings).toHaveLength(2);
    expect(result.reviewer_findings[0]).toContain("error handling");
  });

  test("max 5 rounds hard stop", async () => {
    // Reviewer never satisfied
    const primary = mockProvider(["attempt"], "primary");
    const reviewer = mockProvider(["still broken"], "reviewer");

    const result = await volley("bad artifact", primary, reviewer);
    expect(result.converged).toBe(false);
    expect(result.rounds).toBe(5);
    expect(result.reviewer_findings).toHaveLength(5);
  });

  test("returns reviewer findings from each round", async () => {
    const primary = mockProvider(["v2", "v3"], "primary");
    const reviewer = mockProvider([
      "finding A",
      "finding B",
      "NO_ISSUES",
    ], "reviewer");

    const result = await volley("v1", primary, reviewer);
    expect(result.converged).toBe(true);
    expect(result.rounds).toBe(3);
    expect(result.reviewer_findings[0]).toBe("finding A");
    expect(result.reviewer_findings[1]).toBe("finding B");
    expect(result.reviewer_findings[2]).toBe("NO_ISSUES");
  });
});
