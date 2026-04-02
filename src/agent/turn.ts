import type { Content, StreamChunk, Turn, ToolCall } from "../core/types.js";

/**
 * Assemble a stream of chunks into a Turn.
 *
 * Concatenates content_delta text, parses tool_use_start + tool_use_delta
 * into ToolCall entries, and returns a complete assistant Turn.
 */
export async function assembleTurn(
  stream: AsyncGenerator<StreamChunk>,
): Promise<Turn> {
  const content: Content[] = [];
  const toolCalls: ToolCall[] = [];

  let textBuffer = "";
  let currentTool: { id: string; name: string; jsonBuf: string } | null = null;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case "content_delta":
        textBuffer += chunk.text;
        break;

      case "tool_use_start":
        // Flush any accumulated text before the tool block
        if (textBuffer) {
          content.push({ type: "text", text: textBuffer });
          textBuffer = "";
        }
        currentTool = { id: chunk.id, name: chunk.name, jsonBuf: "" };
        break;

      case "tool_use_delta":
        if (currentTool) {
          currentTool.jsonBuf += chunk.input_json;
        }
        break;

      case "done":
        // Flush any in-progress tool
        if (currentTool) {
          const args = currentTool.jsonBuf
            ? (JSON.parse(currentTool.jsonBuf) as Record<string, unknown>)
            : {};
          content.push({
            type: "tool_use",
            id: currentTool.id,
            name: currentTool.name,
            input: args,
          });
          toolCalls.push({ name: currentTool.name, args });
          currentTool = null;
        }
        // Flush trailing text
        if (textBuffer) {
          content.push({ type: "text", text: textBuffer });
          textBuffer = "";
        }
        break;
    }
  }

  // Safety: flush if stream ends without a done chunk
  if (currentTool) {
    const args = currentTool.jsonBuf
      ? (JSON.parse(currentTool.jsonBuf) as Record<string, unknown>)
      : {};
    content.push({
      type: "tool_use",
      id: currentTool.id,
      name: currentTool.name,
      input: args,
    });
    toolCalls.push({ name: currentTool.name, args });
  }
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
