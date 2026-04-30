import { describe, test, expect } from "bun:test";
import type { Turn } from "../src/core/types.js";
import type { ShareEventDraft } from "../src/share/events.js";
import { ShareEventLog } from "../src/share/eventLog.js";

const ts = Date.now();

function userTurn(id: string, text: string): Turn {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    timestamp: ts,
  };
}

function assistantTurn(id: string, text: string, toolCalls?: Turn["tool_calls"]): Turn {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    tool_calls: toolCalls,
    timestamp: ts + 1,
  };
}

function seqNum(id: string): number {
  return parseInt(id.split("-").pop()!, 10);
}

describe("ShareEventLog", () => {
  describe("run-scoped IDs", () => {
    test("IDs contain a run prefix", () => {
      const log = new ShareEventLog();
      const event = log.append({
        type: "message.user",
        ts: new Date().toISOString(),
        actor: "host",
        payload: { text: "hi" },
      });
      expect(event.id).toMatch(/^[a-f0-9]+-\d{15}$/);
    });

    test("different log instances have different run prefixes", () => {
      const log1 = new ShareEventLog();
      const log2 = new ShareEventLog();
      const e1 = log1.append({ type: "message.user", ts: "", actor: "host", payload: { text: "a" } });
      const e2 = log2.append({ type: "message.user", ts: "", actor: "host", payload: { text: "b" } });
      const prefix1 = e1.id.split("-")[0];
      const prefix2 = e2.id.split("-")[0];
      expect(prefix1).not.toBe(prefix2);
    });

    test("cross-restart Last-Event-ID triggers full replay", () => {
      const log1 = new ShareEventLog();
      const e1 = log1.append({ type: "message.user", ts: "", actor: "host", payload: { text: "old" } });

      const log2 = new ShareEventLog();
      log2.append({ type: "message.user", ts: "", actor: "host", payload: { text: "new1" } });
      log2.append({ type: "message.user", ts: "", actor: "host", payload: { text: "new2" } });

      // Reconnecting with an ID from a different run → full replay
      const replayed = log2.replay(e1.id);
      expect(replayed).toHaveLength(2);
    });
  });

  describe("projectHistory", () => {
    test("projects turns into ShareEvents with monotonic IDs", () => {
      const log = new ShareEventLog();
      const turns = [
        userTurn("u1", "hello"),
        assistantTurn("a1", "hi there"),
      ];
      log.projectHistory(turns);

      expect(log.size()).toBe(3); // user + assistant + turn.complete
      const events = log.replay();
      expect(events[0]!.type).toBe("message.user");
      expect(events[1]!.type).toBe("message.assistant");
      expect(events[2]!.type).toBe("turn.complete");
      expect(seqNum(events[0]!.id)).toBeLessThan(seqNum(events[1]!.id));
      expect(seqNum(events[1]!.id)).toBeLessThan(seqNum(events[2]!.id));
    });

    test("same projection twice produces same IDs (dedup)", () => {
      const log = new ShareEventLog();
      const turns = [userTurn("u1", "hello")];
      log.projectHistory(turns);
      log.projectHistory(turns);
      expect(log.size()).toBe(1);
    });

    test("projects tool calls in correct order", () => {
      const log = new ShareEventLog();
      const turns = [
        assistantTurn("a1", "done", [
          { id: "tc1", name: "shell", args: { cmd: "ls" }, result: "file.ts" },
        ]),
      ];
      log.projectHistory(turns);
      const events = log.replay();
      const types = events.map((e) => e.type);
      expect(types).toEqual(["tool.request", "tool.result", "message.assistant", "turn.complete"]);
    });
  });

  describe("append", () => {
    test("assigns monotonic IDs continuing after projected history", () => {
      const log = new ShareEventLog();
      log.projectHistory([userTurn("u1", "hi")]);
      expect(log.size()).toBe(1);

      const event = log.append({
        type: "message.chunk",
        ts: new Date().toISOString(),
        actor: "agent",
        payload: { text: "partial" },
      });
      expect(seqNum(event.id)).toBe(1);
    });

    test("notifies listeners", () => {
      const log = new ShareEventLog();
      const received: string[] = [];
      log.onEvent((e) => received.push(e.id));

      log.append({
        type: "message.user",
        ts: new Date().toISOString(),
        actor: "host",
        payload: { text: "hello" },
      });

      expect(received).toHaveLength(1);
    });

    test("unsubscribe stops notifications", () => {
      const log = new ShareEventLog();
      const received: string[] = [];
      const unsub = log.onEvent((e) => received.push(e.id));

      log.append({ type: "message.user", ts: "", actor: "host", payload: { text: "a" } });
      unsub();
      log.append({ type: "message.user", ts: "", actor: "host", payload: { text: "b" } });

      expect(received).toHaveLength(1);
    });
  });

  describe("replay", () => {
    test("no afterId returns full log", () => {
      const log = new ShareEventLog();
      log.projectHistory([userTurn("u1", "hello"), assistantTurn("a1", "hi")]);
      expect(log.replay()).toHaveLength(log.size());
    });

    test("afterId returns only events after that ID", () => {
      const log = new ShareEventLog();
      log.projectHistory([userTurn("u1", "hello"), assistantTurn("a1", "hi")]);
      const events = log.replay();
      const after = log.replay(events[0]!.id);
      expect(after).toHaveLength(events.length - 1);
      expect(after[0]!.id).toBe(events[1]!.id);
    });

    test("unknown Last-Event-ID triggers full replay", () => {
      const log = new ShareEventLog();
      log.projectHistory([userTurn("u1", "hello")]);
      const full = log.replay("unknown-999999999999999");
      expect(full).toHaveLength(log.size());
    });
  });

  describe("deduplication", () => {
    test("live event for already-projected turn is skipped via markTurnProjected", () => {
      const log = new ShareEventLog();
      log.projectHistory([userTurn("u1", "hello")]);
      expect(log.isTurnProjected("u1")).toBe(true);
    });

    test("turn.complete marks turn as projected", () => {
      const log = new ShareEventLog();
      log.append({
        type: "turn.complete",
        ts: new Date().toISOString(),
        actor: "agent",
        payload: { turn_id: "t99" },
      });
      expect(log.isTurnProjected("t99")).toBe(true);
    });
  });

  describe("replayCompacted", () => {
    test("completed turn chunks folded into message.assistant", () => {
      const log = new ShareEventLog();
      const now = new Date().toISOString();

      log.append({ type: "message.user", ts: now, actor: "host", payload: { text: "hi" } });
      log.append({ type: "message.chunk", ts: now, actor: "agent", payload: { text: "hel" } });
      log.append({ type: "message.chunk", ts: now, actor: "agent", payload: { text: "lo" } });
      log.append({ type: "message.assistant", ts: now, actor: "agent", payload: { text: " world" } });
      log.append({ type: "turn.complete", ts: now, actor: "agent", payload: { turn_id: "t1" } });

      const events = log.replayCompacted();
      const types = events.map((e) => e.type);
      expect(types).toEqual(["message.user", "message.assistant", "turn.complete"]);
      expect((events[1]!.payload as { text: string }).text).toBe("hello world");
    });

    test("in-flight chunks folded into partial message.assistant", () => {
      const log = new ShareEventLog();
      const now = new Date().toISOString();

      log.append({ type: "message.user", ts: now, actor: "host", payload: { text: "hi" } });
      log.append({ type: "message.chunk", ts: now, actor: "agent", payload: { text: "par" } });
      log.append({ type: "message.chunk", ts: now, actor: "agent", payload: { text: "tial" } });

      const events = log.replayCompacted();
      const types = events.map((e) => e.type);
      expect(types).toEqual(["message.user", "message.assistant"]);
      expect((events[1]!.payload as { text: string }).text).toBe("partial");
      expect((events[1]!.payload as { partial?: boolean }).partial).toBe(true);
    });

    test("interleaved message.queued during streaming does not shred chunks", () => {
      const log = new ShareEventLog();
      const now = new Date().toISOString();

      log.append({ type: "message.chunk", ts: now, actor: "agent", payload: { text: "part1" } });
      log.append({ type: "message.queued", ts: now, actor: "guest:abc", payload: { text: "hi" }, txn_id: "t1" });
      log.append({ type: "message.chunk", ts: now, actor: "agent", payload: { text: "part2" } });
      log.append({ type: "message.assistant", ts: now, actor: "agent", payload: { text: "" } });
      log.append({ type: "turn.complete", ts: now, actor: "agent", payload: { turn_id: "t1" } });

      const events = log.replayCompacted();
      const types = events.map((e) => e.type);
      expect(types).toEqual(["message.queued", "message.assistant", "turn.complete"]);
      expect((events[1]!.payload as { text: string }).text).toBe("part1part2");
    });

    test("canonical log unchanged after replayCompacted", () => {
      const log = new ShareEventLog();
      const now = new Date().toISOString();

      log.append({ type: "message.chunk", ts: now, actor: "agent", payload: { text: "a" } });
      log.append({ type: "message.chunk", ts: now, actor: "agent", payload: { text: "b" } });
      log.append({ type: "turn.complete", ts: now, actor: "agent", payload: { turn_id: "t1" } });

      log.replayCompacted();
      expect(log.size()).toBe(3); // canonical log not mutated
    });
  });

  describe("lastId", () => {
    test("returns undefined for empty log", () => {
      const log = new ShareEventLog();
      expect(log.lastId()).toBeUndefined();
    });

    test("returns last event id", () => {
      const log = new ShareEventLog();
      const e = log.append({ type: "message.user", ts: "", actor: "host", payload: { text: "hi" } });
      expect(log.lastId()).toBe(e.id);
    });
  });
});
