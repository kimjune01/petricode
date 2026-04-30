import { describe, test, expect, afterEach } from "bun:test";
import { ShareServer } from "../src/share/server.js";
import { ShareEventLog } from "../src/share/eventLog.js";
import { InviteRegistry } from "../src/share/invites.js";
import { parseSSE } from "../src/share/events.js";

let server: ShareServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

function setup(port = 17742) {
  const eventLog = new ShareEventLog();
  const invites = new InviteRegistry();
  const sessionId = "test-session";
  server = new ShareServer({ port, hostname: "127.0.0.1", eventLog, invites, sessionId });
  server.start();
  return { eventLog, invites, sessionId, port };
}

async function readSSE(
  port: number,
  path: string,
  opts: { token?: string; lastEventId?: string; maxEvents?: number; timeoutMs?: number } = {},
): Promise<string> {
  const url = `http://127.0.0.1:${port}${path}${opts.token ? `?token=${opts.token}` : ""}`;
  const headers: Record<string, string> = {};
  if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 500);

  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let eventCount = 0;
    const maxEvents = opts.maxEvents ?? 10;

    while (eventCount < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
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

describe("ShareServer", () => {
  test("connect with valid token receives replayed events", async () => {
    const { eventLog, invites, sessionId, port } = setup(17742);
    const invite = invites.create(sessionId, "living");

    eventLog.append({
      type: "message.user",
      ts: new Date().toISOString(),
      actor: "host",
      payload: { text: "hello" },
    });

    const text = await readSSE(port, `/sessions/${sessionId}/events`, {
      token: invite.token,
      maxEvents: 1,
    });

    const events = parseSSE(text);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("message.user");
  });

  test("invalid token returns 401", async () => {
    const { sessionId, port } = setup(17743);

    const resp = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/events?token=bogus`,
    );
    expect(resp.status).toBe(401);
  });

  test("wrong session ID returns 403", async () => {
    const { invites, sessionId, port } = setup(17744);
    const invite = invites.create(sessionId, "living");

    const resp = await fetch(
      `http://127.0.0.1:${port}/sessions/wrong-session/events?token=${invite.token}`,
    );
    expect(resp.status).toBe(403);
  });

  test("no token returns 401", async () => {
    const { sessionId, port } = setup(17745);

    const resp = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
    );
    expect(resp.status).toBe(401);
  });

  test("live event fans out to connected client", async () => {
    const { eventLog, invites, sessionId, port } = setup(17746);
    const invite = invites.create(sessionId, "living");

    // Start reading SSE (will wait for events)
    const readPromise = readSSE(port, `/sessions/${sessionId}/events`, {
      token: invite.token,
      maxEvents: 1,
      timeoutMs: 2000,
    });

    // Small delay to let connection establish
    await new Promise((r) => setTimeout(r, 50));

    eventLog.append({
      type: "message.user",
      ts: new Date().toISOString(),
      actor: "host",
      payload: { text: "live event" },
    });

    const text = await readPromise;
    const events = parseSSE(text);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((events[0]!.payload as { text: string }).text).toBe("live event");
  });

  test("reconnect with Last-Event-ID replays only missed events", async () => {
    const { eventLog, invites, sessionId, port } = setup(17747);
    const invite = invites.create(sessionId, "living");

    const e1 = eventLog.append({
      type: "message.user",
      ts: new Date().toISOString(),
      actor: "host",
      payload: { text: "first" },
    });
    eventLog.append({
      type: "message.user",
      ts: new Date().toISOString(),
      actor: "host",
      payload: { text: "second" },
    });

    const text = await readSSE(port, `/sessions/${sessionId}/events`, {
      token: invite.token,
      lastEventId: e1.id,
      maxEvents: 1,
    });

    const events = parseSSE(text);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((events[0]!.payload as { text: string }).text).toBe("second");
  });

  test("revoke invite closes connection", async () => {
    const { invites, sessionId, port } = setup(17748);
    const invite = invites.create(sessionId, "living");

    // Connect
    const readPromise = readSSE(port, `/sessions/${sessionId}/events`, {
      token: invite.token,
      maxEvents: 100,
      timeoutMs: 1000,
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(server!.connectionCount()).toBe(1);

    server!.revokeInvite(invite.id);
    await readPromise;

    expect(server!.connectionCount()).toBe(0);
  });

  test("bearer token in Authorization header works", async () => {
    const { eventLog, invites, sessionId, port } = setup(17749);
    const invite = invites.create(sessionId, "living");

    eventLog.append({
      type: "message.user",
      ts: new Date().toISOString(),
      actor: "host",
      payload: { text: "via header" },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);

    try {
      const resp = await fetch(
        `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
        {
          headers: { Authorization: `Bearer ${invite.token}` },
          signal: controller.signal,
        },
      );
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/event-stream");
    } finally {
      clearTimeout(timeout);
    }
  });
});
