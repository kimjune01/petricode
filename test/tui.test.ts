import { describe, test, expect } from "bun:test";
import { tryCommand } from "../src/commands/index.js";

describe("slash commands", () => {
  test("/exit returns exit flag", () => {
    const result = tryCommand("/exit");
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
  });

  test("/quit returns exit flag", () => {
    const result = tryCommand("/quit");
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
  });

  test("/help returns help text", () => {
    const result = tryCommand("/help");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("/exit");
    expect(result!.exit).toBeUndefined();
  });

  test("/compact returns stub message", () => {
    const result = tryCommand("/compact");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("not yet");
  });

  test("/skills returns stub message", () => {
    const result = tryCommand("/skills");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("No skills");
  });

  test("unknown command returns error message", () => {
    const result = tryCommand("/bogus");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("Unknown command");
  });

  test("non-slash input returns null", () => {
    const result = tryCommand("hello world");
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
