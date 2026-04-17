import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { Content, Message, StreamChunk } from "../core/types.js";
import type { Provider, ModelConfig } from "./provider.js";

// Vertex AI model IDs (bare names map to @default). For direct-Anthropic-API
// usage, add the dated form as additional keys (e.g. `claude-sonnet-4-20250514`).
const MODEL_TOKEN_LIMITS: Record<string, number> = {
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-1": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-7": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
};

const DEFAULT_TOKEN_LIMIT = 200_000;

function toAnthropicContent(
  blocks: Content[],
): Anthropic.MessageCreateParams["messages"][number]["content"] {
  return blocks.map((b) => {
    switch (b.type) {
      case "text":
        return { type: "text" as const, text: b.text };
      case "tool_use":
        return {
          type: "tool_use" as const,
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        };
      case "tool_result":
        return {
          type: "tool_result" as const,
          tool_use_id: b.tool_use_id,
          content: b.content,
        };
    }
  });
}

// Vertex quotas are per-region per-base-model. Newer Anthropic models
// (e.g. claude-opus-4-7) ship with quota allocated ONLY on `global` and
// zero in regional buckets — so picking `us-east5` as a default here
// caused first-message 429s while Claude Code (which uses `global`)
// worked fine on the same project.
//
// `global` is the right default for Anthropic-on-Vertex now. Per-model
// overrides honor the same env-var convention Claude Code uses, so a
// single shell config drives both tools.
//
// Resolution order:
//   1. VERTEX_REGION_<NORMALIZED_MODEL_ID>   (e.g. VERTEX_REGION_CLAUDE_OPUS_4_7)
//   2. ANTHROPIC_VERTEX_REGION                (global override)
//   3. global                                 (where current quota lives)
function resolveVertexRegion(model: string): string {
  const envKey = `VERTEX_REGION_${model.toUpperCase().replace(/-/g, "_")}`;
  return (
    process.env[envKey] ??
    process.env.ANTHROPIC_VERTEX_REGION ??
    "global"
  );
}

function createAnthropicClient(model: string): Anthropic {
  // Auto-detect Vertex AI from env vars (same ones Claude Code uses)
  if (
    process.env.CLAUDE_CODE_USE_VERTEX === "1" ||
    process.env.ANTHROPIC_VERTEX_PROJECT_ID
  ) {
    return new AnthropicVertex({
      projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
      region: resolveVertexRegion(model),
    }) as unknown as Anthropic;
  }
  return new Anthropic();
}

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private model: string;

  constructor(model: string, client?: Anthropic) {
    this.model = model;
    this.client = client ?? createAnthropicClient(model);
  }

  async *generate(
    prompt: Message[],
    config: ModelConfig,
  ): AsyncGenerator<StreamChunk> {
    // Extract system messages for the system param
    const systemBlocks: string[] = [];
    const nonSystemMessages: Message[] = [];
    for (const msg of prompt) {
      if (msg.role === "system") {
        const text = msg.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("\n");
        if (text) systemBlocks.push(text);
      } else {
        nonSystemMessages.push(msg);
      }
    }

    const messages = nonSystemMessages.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: toAnthropicContent(msg.content),
    }));

    const params: Anthropic.MessageCreateParams = {
      model: this.model,
      max_tokens: config.max_tokens ?? 4096,
      messages,
      stream: true,
    };

    if (systemBlocks.length > 0) {
      params.system = systemBlocks.join("\n\n");
    }

    if (config.temperature !== undefined) {
      params.temperature = config.temperature;
    }

    if (config.tools?.length) {
      params.tools = config.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool["input_schema"],
      }));
    }

    const stream = this.client.messages.stream(params, config.signal ? { signal: config.signal } : undefined);

    for await (const event of stream) {
      if (config.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          yield { type: "tool_use_start", id: block.id, name: block.name, index: event.index };
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          yield { type: "content_delta", text: delta.text };
        } else if (delta.type === "input_json_delta") {
          yield { type: "tool_use_delta", input_json: delta.partial_json, index: event.index };
        }
      } else if (event.type === "message_stop") {
        yield { type: "done" };
      }
    }
  }

  model_id(): string {
    return this.model;
  }

  token_limit(): number {
    return MODEL_TOKEN_LIMITS[this.model] ?? DEFAULT_TOKEN_LIMIT;
  }

  supports_tools(): boolean {
    return true;
  }
}
