export type ShareEventType =
  | "message.user"
  | "message.queued"
  | "message.assistant"
  | "message.chunk"
  | "tool.request"
  | "tool.result"
  | "turn.complete";

export interface ShareEvent {
  id: string;
  type: ShareEventType;
  ts: string;
  actor: string;
  payload: Record<string, unknown>;
  txn_id?: string;
}

export type ShareEventDraft = Omit<ShareEvent, "id">;

const ID_PAD = 15;

export function padId(n: number): string {
  return String(n).padStart(ID_PAD, "0");
}

export function serializeSSE(event: ShareEvent): string {
  const data = JSON.stringify({
    ts: event.ts,
    actor: event.actor,
    ...event.payload,
    ...(event.txn_id ? { txn_id: event.txn_id } : {}),
  });
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

export function parseSSE(text: string): ShareEvent[] {
  const events: ShareEvent[] = [];
  const frames = text.split("\n\n").filter((f) => f.trim() && !f.startsWith(":"));

  for (const frame of frames) {
    let id = "";
    let type = "" as ShareEventType;
    let data = "";

    for (const line of frame.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) type = line.slice(7) as ShareEventType;
      else if (line.startsWith("data: ")) data = line.slice(6);
    }

    if (!id || !type || !data) continue;

    const parsed = JSON.parse(data) as Record<string, unknown>;
    const ts = (parsed.ts as string) ?? new Date().toISOString();
    const actor = (parsed.actor as string) ?? "";
    const txn_id = parsed.txn_id as string | undefined;
    delete parsed.ts;
    delete parsed.actor;
    delete parsed.txn_id;

    events.push({
      id,
      type,
      ts,
      actor,
      payload: parsed,
      ...(txn_id ? { txn_id } : {}),
    });
  }

  return events;
}

export const HEARTBEAT = ":keepalive\n\n";
