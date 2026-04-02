import Anthropic from "@anthropic-ai/sdk";
import type { Content, StreamChunk } from "../core/types.js";
import type { Provider, ModelConfig } from "./provider.js";

const MODEL_TOKEN_LIMITS: Record<string, number> = {
  "claude-sonnet-4-20250514": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-opus-4-20250514": 200_000,
};

const DEFAULT_TOKEN_LIMIT = 200_000;

function toAnthropicRole(
  turnIndex: number,
): "user" | "assistant" {
  // Alternating user/assistant; first turn is user
  return turnIndex % 2 === 0 ? "user" : "assistant";
}

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

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private model: string;

  constructor(model: string, client?: Anthropic) {
    this.model = model;
    this.client = client ?? new Anthropic();
  }

  async *generate(
    prompt: Content[][],
    config: ModelConfig,
  ): AsyncGenerator<StreamChunk> {
    const messages = prompt.map((turn, i) => ({
      role: toAnthropicRole(i),
      content: toAnthropicContent(turn),
    }));

    const params: Anthropic.MessageCreateParams = {
      model: this.model,
      max_tokens: config.max_tokens ?? 4096,
      messages,
      stream: true,
    };

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

    const stream = this.client.messages.stream(params);

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          yield { type: "tool_use_start", id: block.id, name: block.name };
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          yield { type: "content_delta", text: delta.text };
        } else if (delta.type === "input_json_delta") {
          yield { type: "tool_use_delta", input_json: delta.partial_json };
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
