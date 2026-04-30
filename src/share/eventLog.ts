import type { ShareEvent, ShareEventDraft } from "./events.js";
import type { Turn } from "../core/types.js";
import { padId } from "./events.js";
import { projectTurn } from "./adapter.js";

export class ShareEventLog {
  private events: ShareEvent[] = [];
  private nextSeq = 0;
  private readonly runId: string;
  private projectedTurnIds = new Set<string>();
  private listeners: Array<(event: ShareEvent) => void> = [];

  constructor() {
    this.runId = crypto.randomUUID().slice(0, 8);
  }

  private assignId(draft: ShareEventDraft): ShareEvent {
    const id = `${this.runId}-${padId(this.nextSeq++)}`;
    return { ...draft, id };
  }

  projectHistory(turns: Turn[]): void {
    for (const turn of turns) {
      if (this.projectedTurnIds.has(turn.id)) continue;
      this.projectedTurnIds.add(turn.id);

      const drafts = projectTurn(turn);
      for (const draft of drafts) {
        this.events.push(this.assignId(draft));
      }
    }
  }

  replayCompacted(): ShareEvent[] {
    const compacted: ShareEvent[] = [];
    let chunkBuf: { text: string; firstEvent: ShareEvent } | null = null;

    for (const event of this.events) {
      if (event.type === "message.chunk") {
        if (chunkBuf) {
          chunkBuf.text += (event.payload as { text: string }).text;
        } else {
          chunkBuf = {
            text: (event.payload as { text: string }).text,
            firstEvent: event,
          };
        }
      } else {
        if (chunkBuf) {
          if (event.type === "message.assistant") {
            const assistantText = (event.payload as { text: string }).text;
            compacted.push({
              ...event,
              payload: { text: chunkBuf.text + assistantText },
            });
            chunkBuf = null;
            continue;
          }
          if (event.type === "turn.complete") {
            compacted.push({
              ...chunkBuf.firstEvent,
              type: "message.assistant",
              payload: { text: chunkBuf.text },
            });
            chunkBuf = null;
          }
          // Do NOT flush on other event types (e.g. message.queued mid-stream).
          // Keep accumulating chunks — the interleaved event passes through
          // without breaking the stream.
        }
        compacted.push(event);
      }
    }

    // Trailing chunks (in-flight turn) — fold into a single partial
    // message.assistant so late joiners get accumulated text without
    // replaying thousands of individual chunks.
    if (chunkBuf) {
      compacted.push({
        ...chunkBuf.firstEvent,
        type: "message.assistant",
        payload: { text: chunkBuf.text, partial: true },
      });
    }

    return compacted;
  }

  append(draft: ShareEventDraft): ShareEvent {
    if (draft.type === "turn.complete") {
      const turnId = (draft.payload as { turn_id?: string }).turn_id;
      if (turnId) this.projectedTurnIds.add(turnId);
    }
    const event = this.assignId(draft);
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  markTurnProjected(turnId: string): void {
    this.projectedTurnIds.add(turnId);
  }

  isTurnProjected(turnId: string): boolean {
    return this.projectedTurnIds.has(turnId);
  }

  replay(afterId?: string): ShareEvent[] {
    if (!afterId) return [...this.events];

    const idx = this.events.findIndex((e) => e.id === afterId);
    if (idx === -1) {
      return [...this.events];
    }
    return this.events.slice(idx + 1);
  }

  onEvent(listener: (event: ShareEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  size(): number {
    return this.events.length;
  }

  lastId(): string | undefined {
    return this.events[this.events.length - 1]?.id;
  }
}
