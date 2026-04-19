import type { Content, StreamChunk, Turn, ToolCall } from "../core/types.js";

/**
 * Flush a single tool entry from the tools map into content + toolCalls arrays.
 */
function flushTool(
  tool: { id: string; name: string; jsonBuf: string; signature?: string },
  content: Content[],
  toolCalls: ToolCall[],
): void {
  let args: Record<string, unknown>;
  try {
    args = tool.jsonBuf
      ? (JSON.parse(tool.jsonBuf) as Record<string, unknown>)
      : {};
  } catch {
    args = {};
    content.push({ type: "text", text: `[malformed tool JSON: ${tool.jsonBuf}]` });
  }
  content.push({
    type: "tool_use",
    id: tool.id,
    name: tool.name,
    input: args,
    ...(tool.signature ? { signature: tool.signature } : {}),
  });
  toolCalls.push({ id: tool.id, name: tool.name, args });
}

/**
 * Assemble a stream of chunks into a Turn.
 *
 * Concatenates content_delta text, parses tool_use_start + tool_use_delta
 * into ToolCall entries, and returns a complete assistant Turn.
 *
 * Tracks multiple concurrent tools by index (required for OpenAI multi-tool streaming).
 */
export async function assembleTurn(
  stream: AsyncGenerator<StreamChunk>,
  signal?: AbortSignal,
  onText?: (delta: string) => void,
): Promise<Turn> {
  const content: Content[] = [];
  const toolCalls: ToolCall[] = [];

  let textBuffer = "";
  const toolMap = new Map<number, { id: string; name: string; jsonBuf: string; signature?: string }>();

  for await (const chunk of stream) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    switch (chunk.type) {
      case "content_delta":
        textBuffer += chunk.text;
        onText?.(chunk.text);
        break;

      case "tool_use_start": {
        const idx = chunk.index ?? 0;
        // If text accumulated between the prior tool(s) and this one,
        // those earlier tools are complete (text can only follow a
        // closed block), so flush them first to preserve ordering.
        // Otherwise this is a sibling tool in a parallel batch — keep
        // every in-flight tool open until `done`, because OpenAI may
        // interleave argument deltas across indices and a premature
        // flush would drop the rest of the prior tool's args.
        if (textBuffer) {
          for (const existingIdx of [...toolMap.keys()].sort((a, b) => a - b)) {
            flushTool(toolMap.get(existingIdx)!, content, toolCalls);
          }
          toolMap.clear();
          content.push({ type: "text", text: textBuffer });
          textBuffer = "";
        }
        toolMap.set(idx, {
          id: chunk.id,
          name: chunk.name,
          jsonBuf: "",
          ...(chunk.signature ? { signature: chunk.signature } : {}),
        });
        break;
      }

      case "tool_use_delta": {
        const idx = chunk.index ?? 0;
        const tool = toolMap.get(idx);
        if (tool) {
          tool.jsonBuf += chunk.input_json;
        }
        break;
      }

      case "done":
        // Flush all in-progress tools (sorted by index for deterministic order)
        for (const idx of [...toolMap.keys()].sort((a, b) => a - b)) {
          flushTool(toolMap.get(idx)!, content, toolCalls);
        }
        toolMap.clear();
        // Flush trailing text
        if (textBuffer) {
          content.push({ type: "text", text: textBuffer });
          textBuffer = "";
        }
        break;
    }
  }

  // Safety: flush if stream ends without a done chunk
  for (const idx of [...toolMap.keys()].sort((a, b) => a - b)) {
    flushTool(toolMap.get(idx)!, content, toolCalls);
  }
  toolMap.clear();
  if (textBuffer) {
    content.push({ type: "text", text: textBuffer });
  }

  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    timestamp: Date.now(),
  };
}
