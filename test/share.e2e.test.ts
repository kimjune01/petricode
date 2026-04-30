import { describe, test, expect, afterEach } from "bun:test";
import { ShareServer } from "../src/share/server.js";
import { ShareEventLog } from "../src/share/eventLog.js";
import { InviteRegistry } from "../src/share/invites.js";
import { GuestMessageQueue } from "../src/share/queue.js";
import { ShareBridge } from "../src/share/bridge.js";
import { SSEClient, postMessage } from "../src/share/client.js";
import { makeShareHandler } from "../src/commands/share.js";
import type { Turn } from "../src/core/types.js";
import type { ShareEvent } from "../src/share/events.js";

let server: ShareServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

describe("share e2e", () => {
  test("full flow: host → /share → guest connects → host turn → guest POST → same sequence", async () => {
    // 1. Set up host session
    const eventLog = new ShareEventLog();
    const invites = new InviteRegistry();
    const queue = new GuestMessageQueue();
    const sessionId = "e2e-session";
    const port = 17790;

    server = new ShareServer({ port, hostname: "127.0.0.1", eventLog, invites, sessionId, queue });
    server.start();

    const bridge = new ShareBridge(eventLog, queue);

    // 2. /share (use shareHost to keep test sync)
    const share = makeShareHandler({ server, invites, sessionId, shareHost: `127.0.0.1:${port}` });
    const shareResult = share("") as { output: string };
    expect(shareResult.output).toContain("Shared session");

    // Extract token from URL
    const tokenMatch = shareResult.output.match(/token=([^\s"]+)/);
    const kitchenToken = tokenMatch![1]!;

    // 3. Connect guest SSE client
    const guestEvents: ShareEvent[] = [];
    const client = new SSEClient({
      url: `http://127.0.0.1:${port}/sessions/${sessionId}/events`,
      token: kitchenToken,
      onEvent: (e) => guestEvents.push(e),
      watchdogMs: 5000,
    });
    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 100));

    // 4. Host submits a prompt → agent responds
    const userTurn: Turn = {
      id: "u1",
      role: "user",
      content: [{ type: "text", text: "what is 2+2?" }],
      timestamp: Date.now(),
    };
    bridge.emitUserTurn(userTurn);

    // Simulate streaming
    bridge.emitStreamChunk("The answer");
    bridge.emitStreamChunk(" is 4.");

    const assistantTurn: Turn = {
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "The answer is 4." }],
      timestamp: Date.now(),
    };
    bridge.emitAssistantTurn(assistantTurn);

    await new Promise((r) => setTimeout(r, 100));

    // 5. Guest POSTs a message
    const guestResponse = await postMessage(
      `http://127.0.0.1:${port}`,
      sessionId,
      kitchenToken,
      "what about 3+3?",
      "txn-e2e-1",
    );
    expect(guestResponse.type).toBe("message.queued");
    expect(guestResponse.txn_id).toBe("txn-e2e-1");

    await new Promise((r) => setTimeout(r, 100));

    // 6. Simulate agent draining queue
    expect(bridge.hasPendingMessages()).toBe(true);
    const pending = bridge.drainQueue();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.txn_id).toBe("txn-e2e-1");

    // Bridge emits message.user when agent processes the guest message
    bridge.emitGuestMessage(pending[0]!);

    // Simulate agent responding to guest
    const guestAssistant: Turn = {
      id: "a2",
      role: "assistant",
      content: [{ type: "text", text: "The answer is 6." }],
      timestamp: Date.now(),
    };
    bridge.emitAssistantTurn(guestAssistant);

    await new Promise((r) => setTimeout(r, 100));

    // 7. Assert: both host and guest see the same event sequence
    const hostEvents = eventLog.replay();
    const hostIds = hostEvents.map((e) => e.id);

    // Guest events should be a subset of host events (same IDs, same order)
    const guestIds = guestEvents.map((e) => e.id);
    expect(guestIds).toEqual(hostIds);

    // Sequence numbers should be monotonic (IDs are run-scoped: {runId}-{seq})
    const seqNums = hostIds.map((id) => parseInt(id.split("-").pop()!, 10));
    for (let i = 1; i < seqNums.length; i++) {
      expect(seqNums[i]!).toBeGreaterThan(seqNums[i - 1]!);
    }

    // Check event type sequence
    const types = hostEvents.map((e) => e.type);
    expect(types).toEqual([
      "message.user",       // host prompt
      "message.chunk",      // streaming
      "message.chunk",      // streaming
      "message.assistant",  // agent response
      "turn.complete",      // turn boundary
      "message.queued",     // guest message received
      "message.user",       // guest message enters context (txn_id matches)
      "message.assistant",  // agent response to guest
      "turn.complete",      // turn boundary
    ]);

    // Verify txn_id flows through queued → user
    const queuedEvent = hostEvents.find((e) => e.type === "message.queued")!;
    const guestUserEvent = hostEvents.find(
      (e) => e.type === "message.user" && e.txn_id === "txn-e2e-1",
    )!;
    expect(queuedEvent.txn_id).toBe("txn-e2e-1");
    expect(guestUserEvent.txn_id).toBe("txn-e2e-1");
    expect(guestUserEvent.actor).toContain("guest:");

    // Host message.user has no txn_id
    const hostUserEvent = hostEvents.find(
      (e) => e.type === "message.user" && e.actor === "host",
    )!;
    expect(hostUserEvent.txn_id).toBeUndefined();

    client.disconnect();
    await connectPromise.catch(() => {});
  });

  test("host message processed before guest when both queued", async () => {
    const eventLog = new ShareEventLog();
    const invites = new InviteRegistry();
    const queue = new GuestMessageQueue();
    const sessionId = "e2e-priority";
    const port = 17791;

    server = new ShareServer({ port, hostname: "127.0.0.1", eventLog, invites, sessionId, queue });
    server.start();

    const bridge = new ShareBridge(eventLog, queue);
    const invite = invites.create(sessionId, "kitchen");

    // Guest submits while agent is "busy"
    await postMessage(
      `http://127.0.0.1:${port}`,
      sessionId,
      invite.token,
      "guest first",
      "txn-g1",
    );

    // Host submits
    const hostTurn: Turn = {
      id: "hu1",
      role: "user",
      content: [{ type: "text", text: "host second" }],
      timestamp: Date.now(),
    };

    // Agent drains: host goes first
    bridge.emitUserTurn(hostTurn);
    const guestMessages = bridge.drainQueue();
    for (const msg of guestMessages) {
      bridge.emitGuestMessage(msg);
    }

    const events = eventLog.replay();
    const userEvents = events.filter((e) => e.type === "message.user");

    // Host's message.user appears before guest's message.user
    expect(userEvents[0]!.actor).toBe("host");
    expect(userEvents[1]!.actor).toContain("guest:");
  });

  test("no duplicate processing — guest echo does not re-enter agent", async () => {
    const eventLog = new ShareEventLog();
    const invites = new InviteRegistry();
    const queue = new GuestMessageQueue();
    const sessionId = "e2e-dedup";
    const port = 17792;

    server = new ShareServer({ port, hostname: "127.0.0.1", eventLog, invites, sessionId, queue });
    server.start();

    const bridge = new ShareBridge(eventLog, queue);
    const invite = invites.create(sessionId, "kitchen");

    // Guest POSTs
    await postMessage(
      `http://127.0.0.1:${port}`,
      sessionId,
      invite.token,
      "process me once",
      "txn-dedup",
    );

    // Drain and emit — should produce exactly one message.user
    const msgs = bridge.drainQueue();
    expect(msgs).toHaveLength(1);
    bridge.emitGuestMessage(msgs[0]!);

    // Second drain should be empty
    expect(bridge.drainQueue()).toHaveLength(0);

    const events = eventLog.replay();
    const userMsgs = events.filter(
      (e) => e.type === "message.user" && e.txn_id === "txn-dedup",
    );
    expect(userMsgs).toHaveLength(1);
  });
});
