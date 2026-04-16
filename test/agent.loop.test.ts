import { describe, test, expect } from "bun:test";
import type { Message, StreamChunk } from "../src/core/types.js";
import type { Provider, ModelConfig } from "../src/providers/provider.js";
import { assembleTurn } from "../src/agent/turn.js";
import { runLoop } from "../src/agent/loop.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeProvider(
  ...calls: StreamChunk[][]
): Provider {
  let callIndex = 0;
  return {
    generate(_prompt: Message[], _config: ModelConfig) {
      const chunks = calls[callIndex++] ?? [];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
    model_id: () => "mock",
    token_limit: () => 100_000,
    supports_tools: () => true,
  };
}

// ── Turn assembly ────────────────────────────────────────────────

describe("assembleTurn", () => {
  test("concatenates text deltas into a single text content block", async () => {
    async function* stream(): AsyncGenerator<StreamChunk> {
      yield { type: "content_delta", text: "Hello " };
      yield { type: "content_delta", text: "world" };
      yield { type: "done" };
    }
    const turn = await assembleTurn(stream());
    expect(turn.role).toBe("assistant");
    expect(turn.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(turn.tool_calls).toBeUndefined();
  });

  test("parses tool_use blocks from stream chunks", async () => {
    async function* stream(): AsyncGenerator<StreamChunk> {
      yield { type: "content_delta", text: "Let me check." };
      yield { type: "tool_use_start", id: "t1", name: "read_file" };
      yield { type: "tool_use_delta", input_json: '{"path":' };
      yield { type: "tool_use_delta", input_json: '"/foo.ts"}' };
      yield { type: "done" };
    }
    const turn = await assembleTurn(stream());

    expect(turn.content).toHaveLength(2);
    expect(turn.content[0]).toEqual({ type: "text", text: "Let me check." });
    expect(turn.content[1]).toEqual({
      type: "tool_use",
      id: "t1",
      name: "read_file",
      input: { path: "/foo.ts" },
    });
    expect(turn.tool_calls).toHaveLength(1);
    expect(turn.tool_calls![0]!.id).toBe("t1");
    expect(turn.tool_calls![0]!.name).toBe("read_file");
    expect(turn.tool_calls![0]!.args).toEqual({ path: "/foo.ts" });
  });

  test("preserves text/tool/text/tool order across multi-tool streams", async () => {
    // Model intent: text0, tool1, text1, tool2 — common when model narrates
    // between calls ("First I'll read the file… now let me edit it…").
    async function* stream(): AsyncGenerator<StreamChunk> {
      yield { type: "content_delta", text: "first " };
      yield { type: "tool_use_start", id: "t1", name: "read_file", index: 0 };
      yield { type: "tool_use_delta", input_json: '{"path":"/a"}', index: 0 };
      yield { type: "content_delta", text: "then " };
      yield { type: "tool_use_start", id: "t2", name: "edit", index: 1 };
      yield { type: "tool_use_delta", input_json: '{"path":"/b"}', index: 1 };
      yield { type: "done" };
    }
    const turn = await assembleTurn(stream());
    expect(turn.content.map((c) => c.type)).toEqual([
      "text",
      "tool_use",
      "text",
      "tool_use",
    ]);
    expect((turn.content[0] as { text: string }).text).toBe("first ");
    expect((turn.content[1] as { id: string }).id).toBe("t1");
    expect((turn.content[2] as { text: string }).text).toBe("then ");
    expect((turn.content[3] as { id: string }).id).toBe("t2");
  });
});

// ── Agent loop ───────────────────────────────────────────────────

describe("runLoop", () => {
  test("no tool calls → loop runs once, returns one turn", async () => {
    const provider = makeProvider([
      { type: "content_delta", text: "Just text." },
      { type: "done" },
    ]);

    const turns = await runLoop("hello", { provider });
    expect(turns).toHaveLength(1);
    const t0 = turns[0]!;
    expect(t0.content).toEqual([{ type: "text", text: "Just text." }]);
    expect(t0.tool_calls).toBeUndefined();
  });

  test("tool call then no tool call → loop runs twice with tool results injected", async () => {
    const provider = makeProvider(
      // First call: model uses a tool
      [
        { type: "tool_use_start", id: "t1", name: "bash" },
        { type: "tool_use_delta", input_json: '{"cmd":"ls"}' },
        { type: "done" },
      ],
      // Second call: model responds with text only
      [
        { type: "content_delta", text: "Done." },
        { type: "done" },
      ],
    );

    const executor = async (name: string, args: unknown) => {
      if (name === "bash") return "file1.ts\nfile2.ts";
      return "unknown";
    };

    const turns = await runLoop("list files", {
      provider,
      toolExecutor: executor,
    });

    expect(turns).toHaveLength(2);

    // First turn has tool call
    const first = turns[0]!;
    expect(first.tool_calls).toHaveLength(1);
    expect(first.tool_calls![0]!.name).toBe("bash");
    expect(first.tool_calls![0]!.result).toBe("file1.ts\nfile2.ts");

    // Second turn is text-only
    const second = turns[1]!;
    expect(second.content).toEqual([{ type: "text", text: "Done." }]);
    expect(second.tool_calls).toBeUndefined();
  });

  test("maxIterations prevents infinite loops", async () => {
    // Provider always returns a tool call
    const infiniteToolCalls: StreamChunk[] = [
      { type: "tool_use_start", id: "t1", name: "loop_tool" },
      { type: "tool_use_delta", input_json: '{}' },
      { type: "done" },
    ];
    const provider = makeProvider(
      infiniteToolCalls,
      infiniteToolCalls,
      infiniteToolCalls,
    );

    const turns = await runLoop("go", {
      provider,
      toolExecutor: async () => "ok",
      maxIterations: 3,
    });

    expect(turns).toHaveLength(3);
  });
});
