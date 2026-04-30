import { describe, test, expect, afterEach } from "bun:test";
import { ShareServer } from "../src/share/server.js";
import { ShareEventLog } from "../src/share/eventLog.js";
import { InviteRegistry } from "../src/share/invites.js";
import { GuestMessageQueue } from "../src/share/queue.js";
import { parseSSE } from "../src/share/events.js";

let server: ShareServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

function setup(port: number) {
  const eventLog = new ShareEventLog();
  const invites = new InviteRegistry();
  const queue = new GuestMessageQueue();
  const sessionId = "test-session";
  server = new ShareServer({ port, hostname: "127.0.0.1", eventLog, invites, sessionId, queue });
  server.start();
  return { eventLog, invites, queue, sessionId, port };
}

async function readSSE(
  port: number,
  path: string,
  token: string,
  opts: { maxEvents?: number; timeoutMs?: number } = {},
): Promise<string> {
  const url = `http://127.0.0.1:${port}${path}?token=${token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let eventCount = 0;
    const maxEvents = opts.maxEvents ?? 10;
    while (eventCount < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      eventCount = text.split("\n\n").filter((f) => f.trim() && f.includes("id: ")).length;
    }
    reader.cancel();
    return text;
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

describe("POST /messages", () => {
  test("kitchen token → 201, message.queued appears on SSE", async () => {
    const { invites, sessionId, port } = setup(17760);
    const kitchenInvite = invites.create(sessionId, "kitchen");
    const livingInvite = invites.create(sessionId, "living");

    // Connect SSE reader
    const ssePromise = readSSE(port, `/sessions/${sessionId}/events`, livingInvite.token, {
      maxEvents: 1,
      timeoutMs: 2000,
    });
    await new Promise((r) => setTimeout(r, 50));

    // POST message
    const resp = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${kitchenInvite.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hello from guest", txn_id: "txn-1" }),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.type).toBe("message.queued");
    expect(body.txn_id).toBe("txn-1");

    const sseText = await ssePromise;
    const events = parseSSE(sseText);
    expect(events.some((e) => e.type === "message.queued" && e.txn_id === "txn-1")).toBe(true);
  });

  test("living token → 403", async () => {
    const { invites, sessionId, port } = setup(17761);
    const invite = invites.create(sessionId, "living");

    const resp = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${invite.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "nope" }),
    });

    expect(resp.status).toBe(403);
  });

  test("invalid token → 401", async () => {
    const { sessionId, port } = setup(17762);

    const resp = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer bogus",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "nope" }),
    });

    expect(resp.status).toBe(401);
  });

  test("missing text → 400", async () => {
    const { invites, sessionId, port } = setup(17763);
    const invite = invites.create(sessionId, "kitchen");

    const resp = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${invite.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(resp.status).toBe(400);
  });

  test("actor is server-derived, not client-supplied", async () => {
    const { invites, sessionId, port } = setup(17764);
    const invite = invites.create(sessionId, "kitchen");

    const resp = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${invite.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", actor: "host" }),
    });

    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.actor).toBe(invite.actor);
    expect(body.actor).not.toBe("host");
  });

  test("message enqueued in guest queue", async () => {
    const { invites, sessionId, port, queue } = setup(17765);
    const invite = invites.create(sessionId, "kitchen");

    await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${invite.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "queued msg", txn_id: "txn-2" }),
    });

    expect(queue.size()).toBe(1);
    const drained = queue.drain();
    expect(drained[0]!.text).toBe("queued msg");
    expect(drained[0]!.txn_id).toBe("txn-2");
    expect(drained[0]!.actor).toBe(invite.actor);
  });
});

describe("GuestMessageQueue", () => {
  test("drain returns all messages and empties queue", () => {
    const q = new GuestMessageQueue();
    q.enqueue({ text: "a", actor: "guest:1", txn_id: "t1" });
    q.enqueue({ text: "b", actor: "guest:2", txn_id: "t2" });

    const drained = q.drain();
    expect(drained).toHaveLength(2);
    expect(q.size()).toBe(0);
  });

  test("FIFO ordering", () => {
    const q = new GuestMessageQueue();
    q.enqueue({ text: "first", actor: "guest:1", txn_id: "t1" });
    q.enqueue({ text: "second", actor: "guest:1", txn_id: "t2" });

    const drained = q.drain();
    expect(drained[0]!.text).toBe("first");
    expect(drained[1]!.text).toBe("second");
  });
});
