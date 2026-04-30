export interface QueuedMessage {
  text: string;
  actor: string;
  txn_id: string;
}

export class GuestMessageQueue {
  private queue: QueuedMessage[] = [];

  enqueue(msg: QueuedMessage): void {
    this.queue.push(msg);
  }

  drain(): QueuedMessage[] {
    const messages = this.queue.splice(0);
    return messages;
  }

  peek(): QueuedMessage[] {
    return [...this.queue];
  }

  size(): number {
    return this.queue.length;
  }
}
