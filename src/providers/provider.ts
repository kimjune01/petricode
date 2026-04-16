import type { Message, StreamChunk } from "../core/types.js";

export interface ModelConfig {
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Provider {
  generate(
    prompt: Message[],
    config: ModelConfig,
  ): AsyncGenerator<StreamChunk>;
  model_id(): string;
  token_limit(): number;
  supports_tools(): boolean;
}
