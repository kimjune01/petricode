import { describe, test, expect } from "bun:test";
import type { Turn } from "../src/core/types.js";
import { ShareEventLog } from "../src/share/eventLog.js";
import { GuestMessageQueue } from "../src/share/queue.js";
import { ShareBridge } from "../src/share/bridge.js";

const ts = Date.now();

function userTurn(id: string, text: string): Turn {
  return { id, role: "user", content: [{ type: "text", text }], timestamp: ts };
}

function assistantTurn(id: string, text: string, toolCalls?: Turn["tool_calls"]): Turn {
  return { id, role: "assistant", content: [{ type: "text", text }], tool_calls: toolCalls, timestamp: ts + 1 };
}

describe("ShareBridge", () => {
  test("emitUserTurn appends message.user to event log", () => {
    const log = new ShareEventLog();
    const bridge = new ShareBridge(log, new GuestMessageQueue());

    bridge.emitUserTurn(userTurn("u1", "hello"));

    const events = log.replay();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("message.user");
    expect(events[0]!.actor).toBe("host");
    expect((events[0]!.payload as { text: string }).text).toBe("hello");
  });

  test("emitAssistantTurn appends assistant events + turn.complete", () => {
    const log = new ShareEventLog();
    const bridge = new ShareBridge(log, new GuestMessageQueue());

    bridge.emitAssistantTurn(assistantTurn("a1", "sure thing"));

    const events = log.replay();
    const types = events.map((e) => e.type);
    expect(types).toEqual(["message.assistant", "turn.complete"]);
  });

  test("emitAssistantTurn with tools produces correct ordering", () => {
    const log = new ShareEventLog();
    const bridge = new ShareBridge(log, new GuestMessageQueue());

    bridge.emitAssistantTurn(
      assistantTurn("a1", "done", [
        { id: "tc1", name: "shell", args: { cmd: "ls" }, result: "file.ts" },
      ]),
    );

    const events = log.replay();
    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool.request", "tool.result", "message.assistant", "turn.complete"]);
  });

  test("emitStreamChunk appends message.chunk", () => {
    const log = new ShareEventLog();
    const bridge = new ShareBridge(log, new GuestMessageQueue());

    bridge.emitStreamChunk("par");
    bridge.emitStreamChunk("tial");

    const events = log.replay();
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("message.chunk");
    expect((events[0]!.payload as { text: string }).text).toBe("par");
  });

  test("emitUserTurn skips already-projected turns", () => {
    const log = new ShareEventLog();
    const bridge = new ShareBridge(log, new GuestMessageQueue());

    bridge.emitUserTurn(userTurn("u1", "hello"));
    bridge.emitUserTurn(userTurn("u1", "hello")); // duplicate

    expect(log.replay()).toHaveLength(1);
  });

  test("emitAssistantTurn skips already-projected turns", () => {
    const log = new ShareEventLog();
    const bridge = new ShareBridge(log, new GuestMessageQueue());

    bridge.emitAssistantTurn(assistantTurn("a1", "ok"));
    bridge.emitAssistantTurn(assistantTurn("a1", "ok")); // duplicate

    const events = log.replay();
    expect(events.filter((e) => e.type === "message.assistant")).toHaveLength(1);
  });

  test("emitGuestMessage appends message.user with txn_id", () => {
    const log = new ShareEventLog();
    const bridge = new ShareBridge(log, new GuestMessageQueue());

    bridge.emitGuestMessage({ text: "guest says hi", actor: "guest:abc", txn_id: "txn-1" });

    const events = log.replay();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("message.user");
    expect(events[0]!.actor).toBe("guest:abc");
    expect(events[0]!.txn_id).toBe("txn-1");
  });

  test("drainQueue returns and clears pending guest messages", () => {
    const queue = new GuestMessageQueue();
    const bridge = new ShareBridge(new ShareEventLog(), queue);

    queue.enqueue({ text: "a", actor: "guest:1", txn_id: "t1" });
    queue.enqueue({ text: "b", actor: "guest:2", txn_id: "t2" });

    expect(bridge.hasPendingMessages()).toBe(true);
    const drained = bridge.drainQueue();
    expect(drained).toHaveLength(2);
    expect(bridge.hasPendingMessages()).toBe(false);
  });

  test("IDs are monotonic across user + assistant + chunk events", () => {
    const log = new ShareEventLog();
    const bridge = new ShareBridge(log, new GuestMessageQueue());

    bridge.emitUserTurn(userTurn("u1", "hi"));
    bridge.emitStreamChunk("hel");
    bridge.emitStreamChunk("lo");
    bridge.emitAssistantTurn(assistantTurn("a1", "hello"));

    const events = log.replay();
    const seqs = events.map((e) => parseInt(e.id.split("-").pop()!, 10));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  test("guest message echo does not duplicate — bridge emits, dedup prevents double", () => {
    const log = new ShareEventLog();
    const queue = new GuestMessageQueue();
    const bridge = new ShareBridge(log, queue);

    // Simulate: POST enqueues + emits message.queued (server does this)
    // Then bridge.emitGuestMessage emits message.user (when agent drains)
    // These are different event types, both should appear
    log.append({
      type: "message.queued",
      ts: new Date().toISOString(),
      actor: "guest:abc",
      payload: { text: "hi" },
      txn_id: "txn-1",
    });
    bridge.emitGuestMessage({ text: "hi", actor: "guest:abc", txn_id: "txn-1" });

    const events = log.replay();
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("message.queued");
    expect(events[1]!.type).toBe("message.user");
    expect(events[0]!.txn_id).toBe("txn-1");
    expect(events[1]!.txn_id).toBe("txn-1");
  });
});
