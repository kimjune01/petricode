import { describe, test, expect } from "bun:test";
import type { Message, StreamChunk, Turn } from "../src/core/types.js";
import type { Provider, ModelConfig } from "../src/providers/provider.js";
import type { TiersConfig } from "../src/config/models.js";
import { TierRouter } from "../src/providers/router.js";
import { Pipeline } from "../src/agent/pipeline.js";
import {
  formatHeadlessOutput,
  runHeadlessTurn,
  turnText,
} from "../src/headless.js";

// ── Mock router (mirrors test/integration.test.ts) ───────────────

function makeMockProvider(id: string, ...calls: StreamChunk[][]): Provider {
  let callIndex = 0;
  return {
    generate(_prompt: Message[], _config: ModelConfig) {
      const chunks = calls[callIndex++] ?? [
        { type: "content_delta" as const, text: "(exhausted)" },
        { type: "done" as const },
      ];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
    model_id: () => id,
    token_limit: () => 200_000,
    supports_tools: () => true,
  };
}

function makeRouter(primaryChunks: StreamChunk[][]): TierRouter {
  const primary = makeMockProvider("mock-primary", ...primaryChunks);
  const reviewer = makeMockProvider("mock-reviewer", [
    { type: "content_delta", text: "ok" },
    { type: "done" },
  ]);
  const fast = makeMockProvider("mock-fast");
  const config: TiersConfig = {
    tiers: {
      primary: { provider: "anthropic", model: "mock-primary" },
      reviewer: { provider: "openai", model: "mock-reviewer" },
      fast: { provider: "anthropic", model: "mock-fast" },
    },
  };
  const map: Record<string, Provider> = {
    "anthropic:mock-primary": primary,
    "openai:mock-reviewer": reviewer,
    "anthropic:mock-fast": fast,
  };
  return new TierRouter(config, (p, m) => {
    const v = map[`${p}:${m}`];
    if (!v) throw new Error(`No mock for ${p}:${m}`);
    return v;
  });
}

async function makePipeline(primaryChunks: StreamChunk[][]): Promise<Pipeline> {
  const pipeline = new Pipeline();
  await pipeline.init({
    router: makeRouter(primaryChunks),
    projectDir: "/tmp/petricode-headless-test",
  });
  return pipeline;
}

// ── turnText ─────────────────────────────────────────────────────

describe("turnText", () => {
  test("joins multiple text blocks", () => {
    const turn: Turn = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
      timestamp: 0,
    };
    expect(turnText(turn)).toBe("hello world");
  });

  test("ignores non-text content blocks", () => {
    const turn: Turn = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "text", text: "before " },
        { type: "tool_use", id: "tu1", name: "x", input: {} },
        { type: "text", text: "after" },
      ],
      timestamp: 0,
    };
    expect(turnText(turn)).toBe("before after");
  });
});

// ── formatHeadlessOutput ─────────────────────────────────────────

describe("formatHeadlessOutput", () => {
  const turn: Turn = {
    id: "t1",
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    timestamp: 1234,
  };

  test("text format ends with exactly one trailing newline", () => {
    expect(formatHeadlessOutput(turn, "text")).toBe("hi\n");
  });

  test("text format does not double-newline if the text already ends in one", () => {
    const t: Turn = { ...turn, content: [{ type: "text", text: "hi\n" }] };
    expect(formatHeadlessOutput(t, "text")).toBe("hi\n");
  });

  test("json format emits the full Turn shape", () => {
    const out = formatHeadlessOutput(turn, "json");
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe("t1");
    expect(parsed.role).toBe("assistant");
    expect(parsed.content).toEqual([{ type: "text", text: "hi" }]);
  });
});

// ── runHeadlessTurn (end-to-end with mock pipeline) ──────────────

describe("runHeadlessTurn", () => {
  test("happy path: returns assistant text on stdout, exit 0", async () => {
    const pipeline = await makePipeline([
      [
        { type: "content_delta", text: "Hello from headless." },
        { type: "done" },
      ],
    ]);

    const result = await runHeadlessTurn(pipeline, "hi");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello from headless.\n");
    expect(result.stderr).toBe("");
  });

  test("json format wraps the turn in JSON", async () => {
    const pipeline = await makePipeline([
      [
        { type: "content_delta", text: "json me" },
        { type: "done" },
      ],
    ]);

    const result = await runHeadlessTurn(pipeline, "hi", "json");

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.role).toBe("assistant");
    expect(parsed.content).toEqual([{ type: "text", text: "json me" }]);
  });

  test("pipeline error becomes exitCode 1 with stderr message", async () => {
    // Stub a pipeline whose turn() rejects — bypasses the mock provider
    // setup since we don't need to drive a real failure mode for this assertion.
    const stub = {
      async turn(): Promise<Turn> {
        throw new Error("boom");
      },
    } as unknown as Pipeline;

    const result = await runHeadlessTurn(stub, "anything");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("petricode: boom\n");
  });
});
