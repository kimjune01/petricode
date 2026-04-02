import { describe, test, expect } from "bun:test";
import { validateContent } from "../src/filter/contentValidation.js";
import { maskToolOutput } from "../src/filter/toolMasking.js";
import { evaluatePolicy } from "../src/filter/policy.js";
import { LoopDetector } from "../src/filter/loopDetection.js";
import { createFilterChain } from "../src/filter/filter.js";
import type { Turn, ToolCall } from "../src/core/types.js";

// ── Helpers ────────────────────────────────────────────────────

function makeTurn(text: string): Turn {
  return {
    id: "t1",
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    timestamp: Date.now(),
  };
}

// ── Content validation ─────────────────────────────────────────

describe("Content validation", () => {
  test("rejects turn with no content", () => {
    const result = validateContent(makeTurn(""));
    expect(result.pass).toBe(false);
  });

  test("rejects whitespace-only turn", () => {
    const result = validateContent(makeTurn("   \n\t  "));
    expect(result.pass).toBe(false);
  });

  test("passes turn with text", () => {
    const result = validateContent(makeTurn("hello world"));
    expect(result.pass).toBe(true);
  });
});

// ── Tool output masking ────────────────────────────────────────

describe("Tool output masking", () => {
  test("masks oversized output", () => {
    // 10001 tokens ≈ 40004 chars
    const big = "x".repeat(40_004);
    const result = maskToolOutput(big);
    expect(result.masked).toBe(true);
    expect(result.content).toContain("[masked");
    expect(result.content).toContain("tokens");
  });

  test("passes small output through", () => {
    const small = "hello";
    const result = maskToolOutput(small);
    expect(result.masked).toBe(false);
    expect(result.content).toBe("hello");
  });

  test("respects custom threshold", () => {
    const output = "x".repeat(100); // 25 tokens
    const result = maskToolOutput(output, 20);
    expect(result.masked).toBe(true);
  });
});

// ── Policy engine ──────────────────────────────────────────────

describe("Policy engine", () => {
  test("read tools default to ALLOW", () => {
    expect(evaluatePolicy("file_read")).toBe("ALLOW");
    expect(evaluatePolicy("glob")).toBe("ALLOW");
    expect(evaluatePolicy("grep")).toBe("ALLOW");
  });

  test("write tools default to ASK_USER", () => {
    expect(evaluatePolicy("file_write")).toBe("ASK_USER");
  });

  test("shell defaults to ASK_USER", () => {
    expect(evaluatePolicy("shell")).toBe("ASK_USER");
  });

  test("explicit rule overrides default", () => {
    const rules = [{ tool: "file_write", outcome: "ALLOW" as const }];
    expect(evaluatePolicy("file_write", rules)).toBe("ALLOW");
  });

  test("wildcard rule matches everything", () => {
    const rules = [{ tool: "*", outcome: "DENY" as const }];
    expect(evaluatePolicy("file_read", rules)).toBe("DENY");
    expect(evaluatePolicy("shell", rules)).toBe("DENY");
  });

  test("first matching rule wins", () => {
    const rules = [
      { tool: "shell", outcome: "DENY" as const },
      { tool: "*", outcome: "ALLOW" as const },
    ];
    expect(evaluatePolicy("shell", rules)).toBe("DENY");
    expect(evaluatePolicy("file_write", rules)).toBe("ALLOW");
  });
});

// ── Loop detection ─────────────────────────────────────────────

describe("Loop detection", () => {
  test("allows calls below threshold", () => {
    const detector = new LoopDetector(5);
    const call: ToolCall = { id: "tc1", name: "file_read", args: { path: "/tmp/x" } };
    for (let i = 0; i < 4; i++) {
      expect(detector.check(call).pass).toBe(true);
    }
  });

  test("rejects on 5th identical call", () => {
    const detector = new LoopDetector(5);
    const call: ToolCall = { id: "tc1", name: "file_read", args: { path: "/tmp/x" } };
    for (let i = 0; i < 4; i++) {
      detector.check(call);
    }
    const result = detector.check(call);
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.reason).toContain("Loop detected");
    }
  });

  test("different calls reset the streak", () => {
    const detector = new LoopDetector(3);
    const callA: ToolCall = { id: "tcA", name: "file_read", args: { path: "/a" } };
    const callB: ToolCall = { id: "tcB", name: "file_read", args: { path: "/b" } };

    detector.check(callA);
    detector.check(callA);
    detector.check(callB); // breaks the streak
    const result = detector.check(callA);
    expect(result.pass).toBe(true); // only 1 consecutive A
  });

  test("reset clears history", () => {
    const detector = new LoopDetector(2);
    const call: ToolCall = { id: "tc2", name: "shell", args: { command: "ls" } };
    detector.check(call);
    detector.reset();
    expect(detector.check(call).pass).toBe(true);
  });
});

// ── Filter chain ───────────────────────────────────────────────

describe("Filter chain", () => {
  test("passes when all gates pass", async () => {
    const chain = createFilterChain([
      () => ({ pass: true }),
      () => ({ pass: true }),
    ]);
    const result = await chain.filter("anything");
    expect(result.pass).toBe(true);
  });

  test("stops at first rejection", async () => {
    let secondCalled = false;
    const chain = createFilterChain([
      () => ({ pass: false, reason: "blocked" }),
      () => {
        secondCalled = true;
        return { pass: true };
      },
    ]);
    const result = await chain.filter("anything");
    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("blocked");
    expect(secondCalled).toBe(false);
  });

  test("handles async gates", async () => {
    const chain = createFilterChain([
      async () => ({ pass: true }),
      async () => ({ pass: false, reason: "async reject" }),
    ]);
    const result = await chain.filter("anything");
    expect(result.pass).toBe(false);
  });
});
