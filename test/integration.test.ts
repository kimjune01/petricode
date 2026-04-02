import { describe, test, expect } from "bun:test";
import type { Content, Message, StreamChunk, Turn } from "../src/core/types.js";
import type { Provider, ModelConfig } from "../src/providers/provider.js";
import type { TiersConfig } from "../src/config/models.js";
import { TierRouter } from "../src/providers/router.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Pipeline } from "../src/agent/pipeline.js";
import { assembleContext } from "../src/agent/context.js";
import {
  runToolSubpipe,
  toolResultsToContent,
} from "../src/agent/toolSubpipe.js";
import { LoopDetector } from "../src/filter/loopDetection.js";
import type { PerceivedEvent } from "../src/core/types.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeMockProvider(
  id: string,
  ...calls: StreamChunk[][]
): Provider {
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

function makeTierRouter(
  primaryChunks: StreamChunk[][],
  reviewerChunks?: StreamChunk[][],
): TierRouter {
  const primary = makeMockProvider("mock-primary", ...primaryChunks);
  const reviewer = makeMockProvider(
    "mock-reviewer",
    ...(reviewerChunks ?? [[
      { type: "content_delta" as const, text: "NO_ISSUES" },
      { type: "done" as const },
    ]]),
  );
  const fast = makeMockProvider("mock-fast");

  const config: TiersConfig = {
    tiers: {
      primary: { provider: "anthropic", model: "mock-primary" },
      reviewer: { provider: "openai", model: "mock-reviewer" },
      fast: { provider: "anthropic", model: "mock-fast" },
    },
  };

  const providerMap: Record<string, Provider> = {
    "anthropic:mock-primary": primary,
    "openai:mock-reviewer": reviewer,
    "anthropic:mock-fast": fast,
  };

  return new TierRouter(config, (providerName, model) => {
    const key = `${providerName}:${model}`;
    const p = providerMap[key];
    if (!p) throw new Error(`No mock for ${key}`);
    return p;
  });
}

// ── Context assembly ────────────────────────────────────────────

describe("assembleContext", () => {
  test("separates context blocks from user input", () => {
    const event: PerceivedEvent = {
      kind: "perceived",
      source: "test",
      content: [
        { type: "text", text: "Hello world" },
        { type: "text", text: '<context source="CLAUDE.md" relevance="1">\nSome instructions\n</context>' },
        { type: "text", text: '<skill name="test" trigger="manual" />' },
      ],
      timestamp: Date.now(),
    };

    const messages = assembleContext(event);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "Hello world" }] });
  });

  test("produces user message when no context", () => {
    const event: PerceivedEvent = {
      kind: "perceived",
      source: "test",
      content: [{ type: "text", text: "Just a question" }],
      timestamp: Date.now(),
    };

    const messages = assembleContext(event);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "Just a question" }] });
  });
});

// ── Tool sub-pipe ───────────────────────────────────────────────

describe("runToolSubpipe", () => {
  test("executes allowed tools", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "file_read",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (args) => `contents of ${(args as Record<string, unknown>).path}`,
    });

    const turn: Turn = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu1", name: "file_read", input: { path: "/foo.ts" } },
      ],
      tool_calls: [{ id: "tu1", name: "file_read", args: { path: "/foo.ts" } }],
      timestamp: Date.now(),
    };

    const results = await runToolSubpipe(turn, { registry });
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("ALLOW");
    expect(results[0]!.content).toBe("contents of /foo.ts");
  });

  test("denies tools by policy", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "shell",
      description: "Run shell",
      input_schema: { type: "object" },
      execute: async () => "executed",
    });

    const turn: Turn = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu1", name: "shell", input: {} },
      ],
      tool_calls: [{ id: "tu1", name: "shell", args: {} }],
      timestamp: Date.now(),
    };

    const results = await runToolSubpipe(turn, {
      registry,
      policyRules: [{ tool: "shell", outcome: "DENY" }],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("DENY");
    expect(results[0]!.content).toContain("Denied by policy");
  });

  test("ASK_USER with onConfirm denial", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "file_write",
      description: "Write a file",
      input_schema: { type: "object" },
      execute: async () => "written",
    });

    const turn: Turn = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu1", name: "file_write", input: {} },
      ],
      tool_calls: [{ id: "tu1", name: "file_write", args: {} }],
      timestamp: Date.now(),
    };

    const results = await runToolSubpipe(turn, {
      registry,
      onConfirm: async () => false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("DENY");
    expect(results[0]!.content).toContain("Denied by user");
  });

  test("loop detection denies repeated calls", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "file_read",
      description: "Read",
      input_schema: { type: "object" },
      execute: async () => "ok",
    });

    const loopDetector = new LoopDetector(2);

    const turn: Turn = {
      id: "t1",
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu1", name: "file_read", input: {} },
      ],
      tool_calls: [{ id: "tu1", name: "file_read", args: {} }],
      timestamp: Date.now(),
    };

    const r1 = await runToolSubpipe(turn, { registry, loopDetector });
    expect(r1[0]!.outcome).toBe("ALLOW");

    const r2 = await runToolSubpipe(turn, { registry, loopDetector });
    expect(r2[0]!.outcome).toBe("DENY");
    expect(r2[0]!.content).toContain("Loop detected");
  });

  test("toolResultsToContent converts results", () => {
    const results = [
      { toolUseId: "tu1", name: "file_read", outcome: "ALLOW" as const, content: "file data" },
    ];
    const content = toolResultsToContent(results);
    expect(content).toEqual([
      { type: "tool_result", tool_use_id: "tu1", content: "file data" },
    ]);
  });
});

// ── Pipeline integration ────────────────────────────────────────

describe("Pipeline", () => {
  test("simple text turn flows through perceive -> cache -> provider -> filter", async () => {
    const router = makeTierRouter([
      [
        { type: "content_delta", text: "Hello from the model!" },
        { type: "done" },
      ],
    ]);

    const pipeline = new Pipeline();
    await pipeline.init({
      router,
      projectDir: "/tmp/petricode-test",
    });

    const result = await pipeline.turn("Hi there");
    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([
      { type: "text", text: "Hello from the model!" },
    ]);
    expect(result.tool_calls).toBeUndefined();
    expect(pipeline.tokenCount()).toBeGreaterThan(0);
  });

  test("tool calls go through policy and execute", async () => {
    const router = makeTierRouter([
      [
        { type: "tool_use_start", id: "t1", name: "file_read" },
        { type: "tool_use_delta", input_json: '{"path":"/test.ts"}' },
        { type: "done" },
      ],
      [
        { type: "content_delta", text: "I read the file." },
        { type: "done" },
      ],
    ]);

    const registry = new ToolRegistry();
    registry.register({
      name: "file_read",
      description: "Read a file",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: async (args) =>
        `content of ${(args as Record<string, unknown>).path}`,
    });

    const pipeline = new Pipeline();
    await pipeline.init({
      router,
      projectDir: "/tmp/petricode-test",
      registry,
    });

    const result = await pipeline.turn("Read /test.ts");
    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([
      { type: "text", text: "I read the file." },
    ]);
  });

  test("sessionId is stable across turns", async () => {
    const router = makeTierRouter([
      [{ type: "content_delta", text: "One" }, { type: "done" }],
      [{ type: "content_delta", text: "Two" }, { type: "done" }],
    ]);

    const pipeline = new Pipeline();
    await pipeline.init({
      router,
      projectDir: "/tmp/petricode-test",
      sessionId: "test-session-42",
    });

    expect(pipeline.sessionId()).toBe("test-session-42");
    await pipeline.turn("First");
    await pipeline.turn("Second");
    expect(pipeline.sessionId()).toBe("test-session-42");
  });

  test("token count increases with each turn", async () => {
    const router = makeTierRouter([
      [{ type: "content_delta", text: "Response one" }, { type: "done" }],
      [{ type: "content_delta", text: "Response two" }, { type: "done" }],
    ]);

    const pipeline = new Pipeline();
    await pipeline.init({
      router,
      projectDir: "/tmp/petricode-test",
    });

    await pipeline.turn("Hello");
    const count1 = pipeline.tokenCount();
    expect(count1).toBeGreaterThan(0);

    await pipeline.turn("World");
    const count2 = pipeline.tokenCount();
    expect(count2).toBeGreaterThan(count1);
  });

  test("filter rejects empty assistant responses", async () => {
    const router = makeTierRouter([
      [{ type: "content_delta", text: "   " }, { type: "done" }],
    ]);

    const pipeline = new Pipeline();
    await pipeline.init({
      router,
      projectDir: "/tmp/petricode-test",
    });

    const result = await pipeline.turn("Test");
    expect(result.content[0]!.type).toBe("text");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("[filtered]");
  });

  test("denied tool calls produce rejection then continue", async () => {
    const router = makeTierRouter([
      [
        { type: "tool_use_start", id: "t1", name: "shell" },
        { type: "tool_use_delta", input_json: '{"cmd":"echo hello"}' },
        { type: "done" },
      ],
      [
        { type: "content_delta", text: "Okay, skipped that." },
        { type: "done" },
      ],
    ]);

    const registry = new ToolRegistry();
    registry.register({
      name: "shell",
      description: "Shell",
      input_schema: { type: "object" },
      execute: async () => "executed",
    });

    const pipeline = new Pipeline();
    await pipeline.init({
      router,
      projectDir: "/tmp/petricode-test",
      registry,
      policyRules: [{ tool: "shell", outcome: "DENY" }],
    });

    const result = await pipeline.turn("Run a command");
    expect(result.role).toBe("assistant");
  });
});
