import { describe, test, expect } from "bun:test";
import { tryCommand, overrideCommand, type CommandResult } from "../src/commands/index.js";

function trySync(input: string): CommandResult | null {
  const r = tryCommand(input);
  return r instanceof Promise ? null : r;
}

describe("slash commands", () => {
  test("/exit returns exit flag", () => {
    const result = trySync("/exit");
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
  });

  test("/quit returns exit flag", () => {
    const result = trySync("/quit");
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
  });

  test("/help returns help text", () => {
    const result = trySync("/help");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("/exit");
    expect(result!.exit).toBeUndefined();
  });

  test("/help does not advertise unimplemented /consolidate", () => {
    const result = trySync("/help");
    expect(result!.output).not.toContain("/consolidate");
  });

  test("overrideCommand replaces /compact with real handler", () => {
    overrideCommand("compact", () => ({ output: "Compacted: 100 → 40 tokens" }));
    const result = trySync("/compact");
    expect(result!.output).toContain("Compacted");
    // Restore stub so subsequent tests aren't polluted
    overrideCommand("compact", () => ({ output: "Compaction not yet implemented." }));
  });

  test("/compact returns stub message", () => {
    const result = trySync("/compact");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("not yet");
  });

  test("/skills returns stub message", () => {
    const result = trySync("/skills");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("No skills");
  });

  test("unknown command returns error message", () => {
    const result = trySync("/bogus");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("Unknown command");
  });

  test("non-slash input returns null", () => {
    const result = trySync("hello world");
    expect(result).toBeNull();
  });
});

describe("state", () => {
  test("initialState returns composing phase", async () => {
    const { initialState } = await import("../src/app/state.js");
    const state = initialState();
    expect(state.phase).toBe("composing");
    expect(state.turns).toEqual([]);
    expect(state.pendingToolCall).toBeNull();
    expect(state.tokenCount).toBe(0);
  });
});
