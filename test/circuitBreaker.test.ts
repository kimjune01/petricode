import { describe, test, expect } from "bun:test";
import { CircuitBreaker } from "../src/filter/circuitBreaker.js";

describe("CircuitBreaker (isolated)", () => {
  // The e2e.test.ts covers basic open/close/half-open.
  // These tests cover the thundering herd fix and edge cases.

  test("half-open allows probe then transitions to open", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });

    // Open the circuit
    cb.recordFailure("primary", 1000);
    expect(cb.getState("primary")).toBe("open");

    // Before cooldown — blocked
    expect(cb.isAvailable("primary", 1500)).toBe(false);

    // After cooldown, first call transitions to half-open and returns true
    expect(cb.isAvailable("primary", 2100)).toBe(true);
    expect(cb.getState("primary")).toBe("half-open");

    // Second concurrent call: half-open blocks — only one probe allowed
    const secondResult = cb.isAvailable("primary", 2100);
    expect(secondResult).toBe(false);
    expect(cb.getState("primary")).toBe("half-open");

    // Probe fails — transitions back to open
    cb.recordFailure("primary", 2100);
    expect(cb.getState("primary")).toBe("open");

    // Now blocked until cooldown from new failure time
    expect(cb.isAvailable("primary", 2200)).toBe(false);
    expect(cb.isAvailable("primary", 3200)).toBe(true); // after cooldown
  });

  test("probe failure re-opens circuit", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 500 });

    cb.recordFailure("primary", 100);
    cb.recordFailure("primary", 200);
    expect(cb.getState("primary")).toBe("open");

    // Transition to half-open
    cb.isAvailable("primary", 800);
    expect(cb.getState("primary")).toBe("half-open");

    // Probe fails
    cb.recordFailure("primary", 810);
    expect(cb.getState("primary")).toBe("open");

    // Still blocked
    expect(cb.isAvailable("primary", 810)).toBe(false);
  });

  test("probe success closes circuit and resets failures", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });

    cb.recordFailure("primary", 10);
    expect(cb.getState("primary")).toBe("open");

    cb.isAvailable("primary", 200); // half-open
    cb.recordSuccess("primary");
    expect(cb.getState("primary")).toBe("closed");

    // New failures need full threshold again
    const status = cb.status().find(s => s.tier === "primary")!;
    expect(status.failures).toBe(0);
    expect(status.lastFailure).toBeNull();
  });

  test("resolve skips open tiers in fallback chain", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });

    cb.recordFailure("primary", 1000);
    expect(cb.resolve("primary", 1000)).toBe("reviewer");

    cb.recordFailure("reviewer", 1000);
    expect(cb.resolve("primary", 1000)).toBe("fast");

    cb.recordFailure("fast", 1000);
    expect(cb.resolve("primary", 1000)).toBeNull();
  });

  test("failures below threshold keep circuit closed", () => {
    const cb = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 });

    for (let i = 0; i < 4; i++) {
      cb.recordFailure("primary", i * 100);
    }
    expect(cb.getState("primary")).toBe("closed");
    expect(cb.isAvailable("primary")).toBe(true);
  });

  test("unknown tier returns false for isAvailable", () => {
    const cb = new CircuitBreaker();
    expect(cb.isAvailable("nonexistent" as any)).toBe(false);
  });

  test("success on closed circuit is a no-op", () => {
    const changes: string[] = [];
    const cb = new CircuitBreaker(
      { failureThreshold: 3, cooldownMs: 1000 },
      (tier, state) => changes.push(`${tier}:${state}`),
    );

    cb.recordSuccess("primary");
    // No state change notification — was already closed
    expect(changes).toHaveLength(0);
    expect(cb.getState("primary")).toBe("closed");
  });
});
