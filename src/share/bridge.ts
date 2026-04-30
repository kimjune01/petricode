import type { Turn } from "../core/types.js";
import type { ShareEventDraft } from "./events.js";
import type { ShareEventLog } from "./eventLog.js";
import type { GuestMessageQueue, QueuedMessage } from "./queue.js";
import {
  projectUserTurn,
  projectAssistantTurn,
  projectTurnComplete,
  projectStreamChunk,
} from "./adapter.js";

export class ShareBridge {
  constructor(
    private readonly eventLog: ShareEventLog,
    private readonly queue: GuestMessageQueue,
  ) {}

  emitUserTurn(turn: Turn): void {
    if (this.eventLog.isTurnProjected(turn.id)) return;
    this.eventLog.markTurnProjected(turn.id);
    for (const draft of projectUserTurn(turn)) {
      this.eventLog.append(draft);
    }
  }

  emitStreamChunk(delta: string): void {
    this.eventLog.append(projectStreamChunk(delta));
  }

  emitAssistantTurn(turn: Turn): void {
    if (this.eventLog.isTurnProjected(turn.id)) return;
    this.eventLog.markTurnProjected(turn.id);
    for (const draft of projectAssistantTurn(turn)) {
      this.eventLog.append(draft);
    }
    this.eventLog.append(projectTurnComplete(turn));
  }

  emitGuestMessage(msg: QueuedMessage): void {
    this.eventLog.append({
      type: "message.user",
      ts: new Date().toISOString(),
      actor: msg.actor,
      payload: { text: msg.text },
      txn_id: msg.txn_id,
    });
  }

  drainQueue(): QueuedMessage[] {
    return this.queue.drain();
  }

  hasPendingMessages(): boolean {
    return this.queue.size() > 0;
  }
}
