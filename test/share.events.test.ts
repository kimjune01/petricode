import { describe, test, expect } from "bun:test";
import {
  type ShareEvent,
  serializeSSE,
  parseSSE,
  padId,
  HEARTBEAT,
} from "../src/share/events.js";

describe("padId", () => {
  test("zero-pads to 15 digits", () => {
    expect(padId(42)).toBe("000000000000042");
    expect(padId(0)).toBe("000000000000000");
    expect(padId(999999999999999)).toBe("999999999999999");
  });
});

describe("SSE round-trip", () => {
  const event: ShareEvent = {
    id: "000000000000042",
    type: "message.user",
    ts: "2026-04-30T18:22:01Z",
    actor: "guest:abc123",
    payload: { text: "try the failing test again" },
  };

  test("serialize → parse round-trips", () => {
    const sse = serializeSSE(event);
    const parsed = parseSSE(sse);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(event);
  });

  test("txn_id round-trips", () => {
    const withTxn: ShareEvent = { ...event, txn_id: "a1b2c3d4" };
    const sse = serializeSSE(withTxn);
    const parsed = parseSSE(sse);
    expect(parsed[0]!.txn_id).toBe("a1b2c3d4");
  });

  test("event without txn_id has no txn_id field", () => {
    const sse = serializeSSE(event);
    const parsed = parseSSE(sse);
    expect("txn_id" in parsed[0]!).toBe(false);
  });

  test("newlines in payload text are escaped in data line", () => {
    const e: ShareEvent = {
      ...event,
      payload: { text: "line1\nline2\nline3" },
    };
    const sse = serializeSSE(e);
    const dataLine = sse.split("\n").find((l) => l.startsWith("data: "))!;
    expect(dataLine).not.toContain("\nline2");
    expect(dataLine).toContain("\\n");
    const parsed = parseSSE(sse);
    expect((parsed[0]!.payload as { text: string }).text).toBe("line1\nline2\nline3");
  });

  test("multi-event stream parsing", () => {
    const e1: ShareEvent = { ...event, id: "000000000000001" };
    const e2: ShareEvent = {
      ...event,
      id: "000000000000002",
      type: "message.chunk",
      payload: { text: "partial" },
    };
    const stream = serializeSSE(e1) + serializeSSE(e2);
    const parsed = parseSSE(stream);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.id).toBe("000000000000001");
    expect(parsed[1]!.id).toBe("000000000000002");
    expect(parsed[1]!.type).toBe("message.chunk");
  });

  test("heartbeat frames are ignored by parser", () => {
    const stream = HEARTBEAT + serializeSSE(event) + HEARTBEAT;
    const parsed = parseSSE(stream);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe(event.id);
  });

  test("message.queued type serializes and parses", () => {
    const queued: ShareEvent = {
      ...event,
      type: "message.queued",
      txn_id: "txn-123",
    };
    const sse = serializeSSE(queued);
    const parsed = parseSSE(sse);
    expect(parsed[0]!.type).toBe("message.queued");
    expect(parsed[0]!.txn_id).toBe("txn-123");
  });
});
