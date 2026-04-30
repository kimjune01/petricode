import { describe, test, expect, afterEach } from "bun:test";
import { ShareServer } from "../src/share/server.js";
import { ShareEventLog } from "../src/share/eventLog.js";
import { InviteRegistry } from "../src/share/invites.js";
import { GuestMessageQueue } from "../src/share/queue.js";
import { ShareBridge } from "../src/share/bridge.js";
import { SSEClient, postMessage } from "../src/share/client.js";
import type { Turn } from "../src/core/types.js";
import type { ShareEvent } from "../src/share/events.js";

const PORT = 17810;
const HOST = "127.0.0.1";
const SESSION_ID = "guest-integ";

let server: ShareServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

function makeTurn(id: string, role: "user" | "assistant", text: string): Turn {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("guest integration", () => {
  test("full guest lifecycle: replay, live events, postMessage, reconnect", async () => {
    // ── 1. Set up full host stack ──
    const eventLog = new ShareEventLog();
    const invites = new InviteRegistry();
    const queue = new GuestMessageQueue();

    server = new ShareServer({
      port: PORT,
      hostname: HOST,
      eventLog,
      invites,
      sessionId: SESSION_ID,
      queue,
    });
    server.start();

    const bridge = new ShareBridge(eventLog, queue);

    // ── 2. Create a kitchen invite ──
    const kitchenInvite = invites.create(SESSION_ID, "kitchen");

    // ── 3. Pre-populate event log with history ──
    const userTurn = makeTurn("u-prepop", "user", "What is gravity?");
    bridge.emitUserTurn(userTurn);

    const assistantTurn = makeTurn("a-prepop", "assistant", "Gravity is a fundamental force.");
    bridge.emitAssistantTurn(assistantTurn);

    // At this point we have: message.user, message.assistant, turn.complete
    const preCount = eventLog.size();
    expect(preCount).toBe(3);

    // ── 4. Create SSEClient pointing at server ──
    const received: ShareEvent[] = [];
    let connected = false;

    const client = new SSEClient({
      url: `http://${HOST}:${PORT}/sessions/${SESSION_ID}/events`,
      token: kitchenInvite.token,
      onEvent: (e) => received.push(e),
      onConnect: () => { connected = true; },
      watchdogMs: 5000,
    });

    // ── 5. Connect and collect events ──
    const connectPromise = client.connect();
    await wait(200);

    // ── 6. Verify replayed history ──
    expect(connected).toBe(true);
    // replayCompacted folds chunks into assistant messages; our pre-populated
    // events have no chunks, so we get the 3 events as-is.
    expect(received.length).toBeGreaterThanOrEqual(3);
    expect(received[0]!.type).toBe("message.user");
    expect(received[0]!.payload.text).toBe("What is gravity?");
    expect(received[1]!.type).toBe("message.assistant");
    expect(received[1]!.payload.text).toBe("Gravity is a fundamental force.");
    expect(received[2]!.type).toBe("turn.complete");

    // ── 7. Push a live event through the bridge ──
    const liveTurn = makeTurn("u-live", "user", "What about dark matter?");
    bridge.emitUserTurn(liveTurn);
    await wait(100);

    const liveEvent = received.find(
      (e) => e.type === "message.user" && e.payload.text === "What about dark matter?",
    );
    expect(liveEvent).toBeDefined();
    expect(liveEvent!.actor).toBe("host");

    // ── 8. postMessage: guest submits a message ──
    const postResult = await postMessage(
      `http://${HOST}:${PORT}`,
      SESSION_ID,
      kitchenInvite.token,
      "Can you explain quantum tunneling?",
      "txn-guest-1",
    );

    // 8a. POST returns 201 with message.queued
    expect(postResult.type).toBe("message.queued");
    expect(postResult.txn_id).toBe("txn-guest-1");

    await wait(100);

    // 8b. SSE stream receives message.queued
    const queuedSSE = received.find(
      (e) => e.type === "message.queued" && e.txn_id === "txn-guest-1",
    );
    expect(queuedSSE).toBeDefined();
    expect(queuedSSE!.payload.text).toBe("Can you explain quantum tunneling?");

    // 8c. Drain queue and emit guest message via bridge
    expect(bridge.hasPendingMessages()).toBe(true);
    const pending = bridge.drainQueue();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.txn_id).toBe("txn-guest-1");

    bridge.emitGuestMessage(pending[0]!);
    await wait(100);

    // 8d. SSE stream receives message.user with same txn_id
    const guestUserSSE = received.find(
      (e) => e.type === "message.user" && e.txn_id === "txn-guest-1",
    );
    expect(guestUserSSE).toBeDefined();
    expect(guestUserSSE!.actor).toContain("guest:");
    expect(guestUserSSE!.payload.text).toBe("Can you explain quantum tunneling?");

    // ── 9. Living-scope invite: POST returns 403 ──
    const livingInvite = invites.create(SESSION_ID, "living");
    try {
      await postMessage(
        `http://${HOST}:${PORT}`,
        SESSION_ID,
        livingInvite.token,
        "should fail",
        "txn-living-1",
      );
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect((err as Error).message).toContain("403");
    }

    // ── 10. Reconnect: only missed events ──

    // Record event count before disconnect
    const countBeforeDisconnect = received.length;
    const lastId = received[received.length - 1]!.id;

    // Disconnect
    client.disconnect();
    await connectPromise.catch(() => {});

    // Add a new event while disconnected
    const missedTurn = makeTurn("a-missed", "assistant", "Quantum tunneling is...");
    bridge.emitAssistantTurn(missedTurn);

    // Reconnect with a fresh client that collects into a separate array
    const reconnectReceived: ShareEvent[] = [];
    let reconnected = false;

    const client2 = new SSEClient({
      url: `http://${HOST}:${PORT}/sessions/${SESSION_ID}/events`,
      token: kitchenInvite.token,
      onEvent: (e) => reconnectReceived.push(e),
      onConnect: () => { reconnected = true; },
      watchdogMs: 5000,
    });

    // Manually set last-event-id by connecting with the URL + Last-Event-ID header.
    // SSEClient tracks lastEventId internally from the previous session, but since
    // we create a new client, we need to simulate reconnect by fetching with
    // Last-Event-ID. The SSEClient doesn't expose a setter, so we make a raw
    // request to verify the server's replay-after behavior, then connect normally.

    // Verify server-side replay-after via raw fetch.
    // SSE is a long-lived stream, so we read chunks with a manual abort.
    const rawController = new AbortController();
    const rawResp = await fetch(
      `http://${HOST}:${PORT}/sessions/${SESSION_ID}/events?token=${kitchenInvite.token}`,
      {
        headers: {
          Accept: "text/event-stream",
          "Last-Event-ID": lastId,
        },
        signal: rawController.signal,
      },
    );
    expect(rawResp.ok).toBe(true);

    // Read whatever the server has replayed so far
    const reader = rawResp.body!.getReader();
    const decoder = new TextDecoder();
    let rawText = "";
    const readWithTimeout = async () => {
      const timeoutId = setTimeout(() => rawController.abort(), 300);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          rawText += decoder.decode(value, { stream: true });
        }
      } catch {
        // AbortError expected
      } finally {
        clearTimeout(timeoutId);
      }
    };
    await readWithTimeout();

    // The missed events are: message.assistant (missed turn) + turn.complete
    // Should NOT contain the pre-populated events
    expect(rawText).not.toContain("What is gravity?");
    expect(rawText).toContain("Quantum tunneling is...");

    // Also do a full reconnect via SSEClient to verify it works end-to-end
    const connect2 = client2.connect();
    await wait(200);

    expect(reconnected).toBe(true);
    // A fresh client (no lastEventId) gets full compacted replay
    // Verify it contains the missed event
    const missedInReconnect = reconnectReceived.find(
      (e) => e.type === "message.assistant" && e.payload.text === "Quantum tunneling is...",
    );
    expect(missedInReconnect).toBeDefined();

    client2.disconnect();
    await connect2.catch(() => {});
  });
});
