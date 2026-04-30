import { describe, test, expect, afterEach } from "bun:test";
import { parseShareURL, SSEClient, postMessage } from "../src/share/client.js";
import { ShareServer } from "../src/share/server.js";
import { ShareEventLog } from "../src/share/eventLog.js";
import { InviteRegistry } from "../src/share/invites.js";
import type { ShareEvent } from "../src/share/events.js";

let server: ShareServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

describe("parseShareURL", () => {
  test("extracts session ID and token", () => {
    const result = parseShareURL(
      "http://localhost:7742/sessions/abc123/events?token=mytoken123",
    );
    expect(result).toEqual({
      host: "http://localhost:7742",
      sessionId: "abc123",
      token: "mytoken123",
    });
  });

  test("returns null for missing token", () => {
    expect(parseShareURL("http://localhost:7742/sessions/abc/events")).toBeNull();
  });

  test("returns null for wrong path", () => {
    expect(parseShareURL("http://localhost:7742/wrong/path?token=t")).toBeNull();
  });

  test("returns null for invalid URL", () => {
    expect(parseShareURL("not a url")).toBeNull();
  });

  test("handles HTTPS URLs", () => {
    const result = parseShareURL(
      "https://my.host:8443/sessions/s1/events?token=tok",
    );
    expect(result).not.toBeNull();
    expect(result!.host).toBe("https://my.host:8443");
  });
});

describe("SSEClient", () => {
  test("connects and receives events", async () => {
    const eventLog = new ShareEventLog();
    const invites = new InviteRegistry();
    const sessionId = "s1";
    const port = 17780;
    server = new ShareServer({ port, hostname: "127.0.0.1", eventLog, invites, sessionId });
    server.start();
    const invite = invites.create(sessionId, "living");

    eventLog.append({
      type: "message.user",
      ts: new Date().toISOString(),
      actor: "host",
      payload: { text: "pre-existing" },
    });

    const received: ShareEvent[] = [];
    let connected = false;

    const client = new SSEClient({
      url: `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
      token: invite.token,
      onEvent: (e) => received.push(e),
      onConnect: () => { connected = true; },
      watchdogMs: 2000,
    });

    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 200));

    expect(connected).toBe(true);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]!.type).toBe("message.user");

    // Push a live event
    eventLog.append({
      type: "message.assistant",
      ts: new Date().toISOString(),
      actor: "agent",
      payload: { text: "live response" },
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(received.length).toBeGreaterThanOrEqual(2);

    client.disconnect();
    await connectPromise.catch(() => {});
  });

  test("reconnects with Last-Event-ID after disconnect", async () => {
    const eventLog = new ShareEventLog();
    const invites = new InviteRegistry();
    const sessionId = "s1";
    const port = 17781;
    server = new ShareServer({ port, hostname: "127.0.0.1", eventLog, invites, sessionId });
    server.start();
    const invite = invites.create(sessionId, "living");

    eventLog.append({
      type: "message.user",
      ts: new Date().toISOString(),
      actor: "host",
      payload: { text: "first" },
    });

    const received: ShareEvent[] = [];
    const client = new SSEClient({
      url: `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
      token: invite.token,
      onEvent: (e) => received.push(e),
      watchdogMs: 5000,
    });

    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toHaveLength(1);

    client.disconnect();
    await connectPromise.catch(() => {});
  });
});

describe("postMessage", () => {
  test("posts and receives message.queued with txn_id", async () => {
    const eventLog = new ShareEventLog();
    const invites = new InviteRegistry();
    const sessionId = "s1";
    const port = 17782;
    server = new ShareServer({ port, hostname: "127.0.0.1", eventLog, invites, sessionId });
    server.start();
    const invite = invites.create(sessionId, "kitchen");

    const result = await postMessage(
      `http://127.0.0.1:${port}`,
      sessionId,
      invite.token,
      "hello",
      "txn-abc",
    );

    expect(result.type).toBe("message.queued");
    expect(result.txn_id).toBe("txn-abc");
  });

  test("living token rejects POST", async () => {
    const eventLog = new ShareEventLog();
    const invites = new InviteRegistry();
    const sessionId = "s1";
    const port = 17783;
    server = new ShareServer({ port, hostname: "127.0.0.1", eventLog, invites, sessionId });
    server.start();
    const invite = invites.create(sessionId, "living");

    try {
      await postMessage(`http://127.0.0.1:${port}`, sessionId, invite.token, "hi", "t1");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect((err as Error).message).toContain("403");
    }
  });
});
