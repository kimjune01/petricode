import { describe, test, expect } from "bun:test";
import { Runtime } from "../src/core/runtime.js";
import { SlotNotRegisteredError } from "../src/core/errors.js";
import type {
  PerceiveSlot,
  CacheSlot,
  FilterSlot,
  TransmitSlot,
  ConsolidateSlot,
} from "../src/core/contracts.js";
import type {
  Turn,
  PerceivedEvent,
  Session,
} from "../src/core/types.js";

// ── Fixtures ─────────────────────────────────────────────────────

const stubTurn: Turn = {
  id: "t1",
  role: "user",
  content: [{ type: "text", text: "hello" }],
  timestamp: Date.now(),
};

const stubEvent: PerceivedEvent = {
  kind: "perceived",
  source: "stdin",
  content: [{ type: "text", text: "hello" }],
  timestamp: Date.now(),
};

const stubSession: Session = {
  id: "s1",
  turns: [stubTurn],
  metadata: {},
};

// ── Stubs ────────────────────────────────────────────────────────

const stubPerceive: PerceiveSlot = {
  async perceive(raw_input) {
    return {
      kind: "perceived",
      source: String(raw_input),
      content: [{ type: "text", text: String(raw_input) }],
      timestamp: Date.now(),
    };
  },
};

function makeCacheStub(): CacheSlot {
  const turns: Turn[] = [];
  return {
    append(turn) { turns.push(turn); },
    read() { return turns; },
    compact() {
      const before = turns.length * 10;
      turns.length = 0;
      return { removed_tokens: before, preserved_pct: before > 0 ? 0 : 1.0 };
    },
    token_count() { return turns.length * 10; },
  };
}

const stubFilter: FilterSlot = {
  async filter(_subject) {
    return { pass: true as const };
  },
};

const stubTransmit: TransmitSlot = {
  async append(_event) {},
  async read(session_id) {
    return session_id === "s1" ? [stubEvent] : [];
  },
  async list(_filter?) {
    return [stubSession];
  },
};

const stubConsolidate: ConsolidateSlot = {
  async run(sessions) {
    return sessions.map((s) => ({
      name: `skill-from-${s.id}`,
      body: "stub body",
      confidence: 0.5,
      source_sessions: [s.id],
    }));
  },
};

// ── Tests ────────────────────────────────────────────────────────

describe("runtime container", () => {
  test("registers and retrieves all five slots", () => {
    const rt = new Runtime();
    rt.register("perceive", stubPerceive);
    rt.register("cache", makeCacheStub());
    rt.register("filter", stubFilter);
    rt.register("transmit", stubTransmit);
    rt.register("consolidate", stubConsolidate);

    // All five retrievable without throwing
    rt.get("perceive");
    rt.get("cache");
    rt.get("filter");
    rt.get("transmit");
    rt.get("consolidate");
  });

  test("missing slot throws SlotNotRegisteredError", () => {
    const rt = new Runtime();
    expect(() => rt.get("perceive")).toThrow(SlotNotRegisteredError);
  });

  test("perceive returns PerceivedEvent", async () => {
    const rt = new Runtime();
    rt.register("perceive", stubPerceive);
    const result = await rt.get("perceive").perceive("test input");
    expect(result).toHaveProperty("kind", "perceived");
    if ("source" in result) {
      expect(result.source).toBe("test input");
    }
  });

  test("cache append / read / compact / token_count", () => {
    const rt = new Runtime();
    rt.register("cache", makeCacheStub());
    const cache = rt.get("cache");

    expect(cache.read()).toEqual([]);
    expect(cache.token_count()).toBe(0);

    cache.append(stubTurn);
    expect(cache.read()).toHaveLength(1);
    expect(cache.token_count()).toBe(10);

    cache.compact();
    expect(cache.read()).toEqual([]);
  });

  test("filter returns FilterResult", async () => {
    const rt = new Runtime();
    rt.register("filter", stubFilter);
    const result = await rt.get("filter").filter("anything");
    expect(result).toEqual({ pass: true });
  });

  test("transmit append / read / list", async () => {
    const rt = new Runtime();
    rt.register("transmit", stubTransmit);
    const mem = rt.get("transmit");

    await mem.append(stubEvent);
    const events = await mem.read("s1");
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("perceived");

    const empty = await mem.read("nonexistent");
    expect(empty).toHaveLength(0);

    const sessions = await mem.list();
    expect(sessions).toHaveLength(1);
  });

  test("consolidate returns CandidateSkill[]", async () => {
    const rt = new Runtime();
    rt.register("consolidate", stubConsolidate);
    const results = await rt.get("consolidate").run([stubSession]);
    expect(results).toHaveLength(1);
    expect(results[0]!).toHaveProperty("name", "skill-from-s1");
    expect(results[0]!).toHaveProperty("confidence", 0.5);
    expect(results[0]!.source_sessions).toEqual(["s1"]);
  });
});
