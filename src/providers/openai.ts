import OpenAI from "openai";
import type { Content, Message, StreamChunk } from "../core/types.js";
import type { Provider, ModelConfig } from "./provider.js";

const MODEL_TOKEN_LIMITS: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
};

const DEFAULT_TOKEN_LIMIT = 128_000;

function toOpenAIMessages(
  prompt: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const msg of prompt) {
    const turn = msg.content;
    const role = msg.role;

    if (role === "system") {
      const text = turn
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n");
      messages.push({ role: "system", content: text });
      continue;
    }

    // Check if turn has tool_result blocks — those become tool messages
    const toolResults = turn.filter((b) => b.type === "tool_result");
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        if (tr.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: tr.content,
          });
        }
      }
      // Also include any non-tool-result content in the turn
      const rest = turn.filter((b) => b.type !== "tool_result");
      if (rest.length > 0) {
        messages.push({
          role: role as "user",
          content: rest.map((b) => {
            if (b.type === "text") return { type: "text" as const, text: b.text };
            return { type: "text" as const, text: JSON.stringify(b) };
          }),
        });
      }
      continue;
    }

    if (role === "assistant") {
      // Check for tool_use blocks
      const toolUses = turn.filter((b) => b.type === "tool_use");
      const textBlocks = turn.filter((b) => b.type === "text");
      const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: textBlocks.length > 0
          ? textBlocks.map((b) => b.type === "text" ? b.text : "").join("")
          : null,
      };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((b) => {
          if (b.type !== "tool_use") throw new Error("unreachable");
          return {
            id: b.id,
            type: "function" as const,
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input),
            },
          };
        });
      }
      messages.push(msg);
    } else {
      messages.push({
        role: "user",
        content: turn.map((b) => {
          if (b.type === "text") return { type: "text" as const, text: b.text };
          return { type: "text" as const, text: JSON.stringify(b) };
        }),
      });
    }
  }
  return messages;
}

export class OpenAIProvider implements Provider {
  private client: OpenAI;
  private model: string;

  constructor(model: string, client?: OpenAI) {
    this.model = model;
    this.client = client ?? new OpenAI();
  }

  async *generate(
    prompt: Message[],
    config: ModelConfig,
  ): AsyncGenerator<StreamChunk> {
    const messages = toOpenAIMessages(prompt);

    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages,
      max_tokens: config.max_tokens ?? 4096,
      stream: true,
    };

    if (config.temperature !== undefined) {
      params.temperature = config.temperature;
    }

    if (config.tools?.length) {
      params.tools = config.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    const stream = await this.client.chat.completions.create(
      params,
      config.signal ? { signal: config.signal } : undefined,
    );

    // OpenAI may split a single tool call's id, name, and arguments across
    // multiple chunks. Buffer per index so we only emit `tool_use_start`
    // once BOTH id and name are known, and queue arg fragments until then.
    const pending = new Map<number, { id?: string; name?: string; argsBuffer: string; started: boolean }>();

    // stream is an async iterable of ChatCompletionChunk
    for await (const chunk of stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>) {
      if (config.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      if (delta.content) {
        yield { type: "content_delta", text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          let entry = pending.get(idx);
          if (!entry) {
            entry = { argsBuffer: "", started: false };
            pending.set(idx, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;

          if (!entry.started && entry.id && entry.name) {
            yield { type: "tool_use_start", id: entry.id, name: entry.name, index: idx };
            entry.started = true;
            // Flush any args that arrived before id/name completed
            if (entry.argsBuffer) {
              yield { type: "tool_use_delta", input_json: entry.argsBuffer, index: idx };
              entry.argsBuffer = "";
            }
          }

          if (tc.function?.arguments) {
            if (entry.started) {
              yield { type: "tool_use_delta", input_json: tc.function.arguments, index: idx };
            } else {
              entry.argsBuffer += tc.function.arguments;
            }
          }
        }
      }

      // Emit done on ANY terminal finish_reason. Anthropic and Google
      // providers emit done unconditionally; consumers like assembleTurn
      // and any UI awaiting "done" must not hang on length / content_filter
      // / function_call truncation.
      if (choice.finish_reason) {
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
