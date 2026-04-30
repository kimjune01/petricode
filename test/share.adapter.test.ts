import { describe, test, expect } from "bun:test";
import type { Turn, PerceivedEvent } from "../src/core/types.js";
import {
  projectTurn,
  projectPerceivedEvent,
  projectStreamChunk,
  projectUserTurn,
  projectAssistantTurn,
  projectTurnComplete,
} from "../src/share/adapter.js";

const ts = Date.now();

describe("projectUserTurn", () => {
  test("maps user turn to message.user draft", () => {
    const turn: Turn = {
      id: "t1",
      role: "user",
      content: [{ type: "text", text: "hello world" }],
      timestamp: ts,
    };
    const drafts = projectUserTurn(turn);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.type).toBe("message.user");
    expect(drafts[0]!.actor).toBe("host");
    expect(drafts[0]!.payload).toEqual({ text: "hello world" });
    expect("id" in drafts[0]!).toBe(false);
  });
});

describe("projectAssistantTurn", () => {
  test("maps text-only assistant turn to message.assistant", () => {
    const turn: Turn = {
      id: "t2",
      role: "assistant",
      content: [{ type: "text", text: "I'll help" }],
      timestamp: ts,
    };
    const drafts = projectAssistantTurn(turn);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.type).toBe("message.assistant");
    expect(drafts[0]!.actor).toBe("agent");
  });

  test("maps tool calls to tool.request + tool.result", () => {
    const turn: Turn = {
      id: "t3",
      role: "assistant",
      content: [
        { type: "tool_use", id: "tc1", name: "shell", input: { command: "ls" } },
        { type: "tool_result", tool_use_id: "tc1", content: "file.ts" },
        { type: "text", text: "done" },
      ],
      tool_calls: [
        { id: "tc1", name: "shell", args: { command: "ls" }, result: "file.ts" },
      ],
      timestamp: ts,
    };
    const drafts = projectAssistantTurn(turn);
    expect(drafts[0]!.type).toBe("tool.request");
    expect(drafts[0]!.payload).toEqual({
      tool_id: "tc1",
      name: "shell",
      args: { command: "ls" },
    });
    expect(drafts[1]!.type).toBe("tool.result");
    expect(drafts[1]!.payload).toEqual({
      tool_id: "tc1",
      name: "shell",
      result: "file.ts",
    });
    expect(drafts[2]!.type).toBe("message.assistant");
    expect(drafts[2]!.payload).toEqual({ text: "done" });
  });
});

describe("projectTurn", () => {
  test("user turn produces message.user only (no turn.complete)", () => {
    const turn: Turn = {
      id: "t1",
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: ts,
    };
    const drafts = projectTurn(turn);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.type).toBe("message.user");
  });

  test("assistant turn ends with turn.complete", () => {
    const turn: Turn = {
      id: "t2",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      timestamp: ts,
    };
    const drafts = projectTurn(turn);
    const last = drafts[drafts.length - 1]!;
    expect(last.type).toBe("turn.complete");
    expect(last.payload).toEqual({ turn_id: "t2" });
  });

  test("ordering: user before assistant, tool.request before tool.result, turn.complete last", () => {
    const userTurn: Turn = {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "do it" }],
      timestamp: ts,
    };
    const assistantTurn: Turn = {
      id: "a1",
      role: "assistant",
      content: [
        { type: "tool_use", id: "tc1", name: "shell", input: {} },
        { type: "text", text: "done" },
      ],
      tool_calls: [{ id: "tc1", name: "shell", args: {}, result: "ok" }],
      timestamp: ts + 1,
    };

    const userDrafts = projectTurn(userTurn);
    const assistantDrafts = projectTurn(assistantTurn);
    const all = [...userDrafts, ...assistantDrafts];
    const types = all.map((d) => d.type);

    expect(types.indexOf("message.user")).toBeLessThan(types.indexOf("tool.request"));
    expect(types.indexOf("tool.request")).toBeLessThan(types.indexOf("tool.result"));
    expect(types.indexOf("tool.result")).toBeLessThan(types.indexOf("turn.complete"));
    expect(types[types.length - 1]).toBe("turn.complete");
  });

  test("no id field on any draft", () => {
    const turn: Turn = {
      id: "t1",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      timestamp: ts,
    };
    for (const draft of projectTurn(turn)) {
      expect("id" in draft).toBe(false);
    }
  });
});

describe("projectPerceivedEvent", () => {
  test("maps to message.user draft", () => {
    const event: PerceivedEvent = {
      kind: "perceived",
      source: "terminal",
      content: [{ type: "text", text: "hello" }],
      timestamp: ts,
    };
    const drafts = projectPerceivedEvent(event);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.type).toBe("message.user");
    expect(drafts[0]!.actor).toBe("host");
  });
});

describe("projectStreamChunk", () => {
  test("produces message.chunk draft", () => {
    const draft = projectStreamChunk("partial text");
    expect(draft.type).toBe("message.chunk");
    expect(draft.actor).toBe("agent");
    expect(draft.payload).toEqual({ text: "partial text" });
    expect("id" in draft).toBe(false);
  });
});
