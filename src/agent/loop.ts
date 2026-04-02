import type { Content, Message, Turn } from "../core/types.js";
import type { Provider, ModelConfig } from "../providers/provider.js";
import { assembleTurn } from "./turn.js";

export type ToolExecutor = (name: string, args: unknown) => Promise<string>;

export interface LoopOptions {
  provider: Provider;
  config?: ModelConfig;
  toolExecutor?: ToolExecutor;
  maxIterations?: number;
}

/**
 * Run the agent loop: send prompt to provider, assemble turn,
 * execute any tool calls, inject results, repeat until no tools remain.
 */
export async function runLoop(
  prompt: string,
  options: LoopOptions,
): Promise<Turn[]> {
  const {
    provider,
    config = {},
    toolExecutor,
    maxIterations = 10,
  } = options;

  // Build initial conversation: a single user message
  const conversation: Message[] = [
    { role: "user", content: [{ type: "text", text: prompt }] },
  ];

  const turns: Turn[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const stream = provider.generate(conversation, config);
    const turn = await assembleTurn(stream);
    turns.push(turn);

    // Append assistant turn to conversation
    conversation.push({ role: "assistant", content: turn.content });

    // No tool calls → done
    if (!turn.tool_calls || turn.tool_calls.length === 0) {
      break;
    }

    // Execute tools and build a tool_result message
    const toolResults: Content[] = [];
    for (const tc of turn.tool_calls) {
      const result = toolExecutor
        ? await toolExecutor(tc.name, tc.args)
        : `No executor for tool: ${tc.name}`;

      tc.result = result;
      toolResults.push({
        type: "tool_result",
        tool_use_id: tc.id,
        content: result,
      });
    }

    // Append tool results as a new conversation turn
    conversation.push({ role: "user", content: toolResults });
  }

  return turns;
}
