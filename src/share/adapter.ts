import type { Turn, PerceivedEvent, ToolCall, Content, StreamChunk } from "../core/types.js";
import type { ShareEventDraft, ShareEventType } from "./events.js";

function textFromContent(content: Content[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

export function projectUserTurn(turn: Turn): ShareEventDraft[] {
  const text = textFromContent(turn.content);
  return [
    {
      type: "message.user",
      ts: new Date(turn.timestamp).toISOString(),
      actor: "host",
      payload: { text },
    },
  ];
}

export function projectAssistantTurn(turn: Turn): ShareEventDraft[] {
  const drafts: ShareEventDraft[] = [];
  const ts = new Date(turn.timestamp).toISOString();

  if (turn.tool_calls) {
    for (const tc of turn.tool_calls) {
      drafts.push({
        type: "tool.request",
        ts,
        actor: "agent",
        payload: { tool_id: tc.id, name: tc.name, args: tc.args },
      });
      if (tc.result !== undefined) {
        drafts.push({
          type: "tool.result",
          ts,
          actor: "agent",
          payload: { tool_id: tc.id, name: tc.name, result: tc.result },
        });
      }
    }
  }

  const text = textFromContent(turn.content);
  if (text) {
    drafts.push({
      type: "message.assistant",
      ts,
      actor: "agent",
      payload: { text },
    });
  }

  return drafts;
}

export function projectTurnComplete(turn: Turn): ShareEventDraft {
  return {
    type: "turn.complete",
    ts: new Date(turn.timestamp).toISOString(),
    actor: "agent",
    payload: { turn_id: turn.id },
  };
}

export function projectTurn(turn: Turn): ShareEventDraft[] {
  const drafts: ShareEventDraft[] = [];
  if (turn.role === "user") {
    drafts.push(...projectUserTurn(turn));
  } else if (turn.role === "assistant") {
    drafts.push(...projectAssistantTurn(turn));
    drafts.push(projectTurnComplete(turn));
  }
  return drafts;
}

export function projectPerceivedEvent(event: PerceivedEvent): ShareEventDraft[] {
  const text = textFromContent(event.content);
  return [
    {
      type: "message.user",
      ts: new Date(event.timestamp).toISOString(),
      actor: "host",
      payload: { text },
    },
  ];
}

export function projectStreamChunk(delta: string): ShareEventDraft {
  return {
    type: "message.chunk",
    ts: new Date().toISOString(),
    actor: "agent",
    payload: { text: delta },
  };
}
