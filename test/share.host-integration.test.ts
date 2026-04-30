import { describe, test, expect, afterEach } from "bun:test";
import { ShareServer } from "../src/share/server.js";
import { ShareEventLog } from "../src/share/eventLog.js";
import { InviteRegistry } from "../src/share/invites.js";
import { GuestMessageQueue } from "../src/share/queue.js";
import { ShareBridge } from "../src/share/bridge.js";
import { postMessage } from "../src/share/client.js";
import { Pipeline } from "../src/agent/pipeline.js";
import { TierRouter } from "../src/providers/router.js";
import { createGoldenProvider, type GoldenEnvelope } from "./harness/goldenProvider.js";
import { WorkspaceFixture } from "./harness/workspace.js";
import type { Turn } from "../src/core/types.js";
import type { TiersConfig } from "../src/config/models.js";
import type { Provider } from "../src/providers/provider.js";
import type { ShareEvent } from "../src/share/events.js";

let server: ShareServer | null = null;
let workspace: WorkspaceFixture | null = null;

afterEach(async () => {
  server?.stop();
  server = null;
  await workspace?.cleanup();
  workspace = null;
});

/** Build a Pipeline wired to a golden provider that returns `text` in a single turn. */
async function buildPipeline(text: string): Promise<Pipeline> {
  const envelope: GoldenEnvelope = {
    tier: "primary",
    model: "golden-primary",
    chunks: [
      { type: "content_delta", text },
      { type: "done" },
    ],
  };

  const defaultEnv: GoldenEnvelope = {
    tier: "reviewer",
    model: "golden-reviewer",
    chunks: [{ type: "content_delta", text: "ok" }, { type: "done" }],
  };

  const primaryProvider = createGoldenProvider([envelope]);
  const reviewerProvider = createGoldenProvider([defaultEnv]);
  const fastProvider = createGoldenProvider([
    { tier: "fast", model: "golden-fast", chunks: [{ type: "content_delta", text: "ok" }, { type: "done" }] },
  ]);

  const providerMap: Record<string, Provider> = {
    "golden-primary": primaryProvider,
    "golden-reviewer": reviewerProvider,
    "golden-fast": fastProvider,
  };

  const tiersConfig: TiersConfig = {
    tiers: {
      primary: { provider: "anthropic", model: "golden-primary" },
      reviewer: { provider: "openai", model: "golden-reviewer" },
      fast: { provider: "anthropic", model: "golden-fast" },
    },
  };

  const router = new TierRouter(tiersConfig, (_providerName, model) => {
    const provider = providerMap[model];
    if (!provider) throw new Error(`No golden provider for model '${model}'`);
    return provider;
  });

  workspace = new WorkspaceFixture("host-int");
  await workspace.setup({});

  const pipeline = new Pipeline();
  await pipeline.init({
    router,
    projectDir: workspace.testDir,
  });

  return pipeline;
}

/** Parse the sequence number from a run-scoped event ID ({runId}-{paddedSeq}). */
function seqOf(id: string): number {
  return parseInt(id.split("-").pop()!, 10);
}

describe("share host-integration", () => {
  test("bridge wired into real pipeline turn produces correct event sequence", async () => {
    // ── 1. Set up share infrastructure ──
    const eventLog = new ShareEventLog();
    const invites = new InviteRegistry();
    const queue = new GuestMessageQueue();
    const sessionId = "host-int-session";
    const port = 17800;

    server = new ShareServer({
      port,
      hostname: "127.0.0.1",
      eventLog,
      invites,
      sessionId,
      queue,
    });
    server.start();

    const bridge = new ShareBridge(eventLog, queue);

    // ── 2. Create kitchen invite ──
    const invite = invites.create(sessionId, "kitchen");
    expect(invite.scope).toBe("kitchen");

    // ── 3. Build pipeline with golden provider ──
    const cannedResponse = "The answer to life is 42.";
    const pipeline = await buildPipeline(cannedResponse);

    // ── 4. Run a pipeline turn, hooking bridge into onText for streaming ──
    const streamedChunks: string[] = [];
    const userInput = "What is the answer to life?";

    const resultTurn = await pipeline.turn(userInput, {
      onText: (delta) => {
        streamedChunks.push(delta);
        bridge.emitStreamChunk(delta);
      },
    });

    // Verify pipeline produced the expected response
    const responseText = resultTurn.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(responseText).toBe(cannedResponse);

    // ── 5. Emit user and assistant turns through the bridge ──
    const userTurn: Turn = {
      id: "host-u1",
      role: "user",
      content: [{ type: "text", text: userInput }],
      timestamp: Date.now(),
    };
    bridge.emitUserTurn(userTurn);
    bridge.emitAssistantTurn(resultTurn);

    // ── 6. Verify event log has correct sequence ──
    const events = eventLog.replay();
    const types = events.map((e) => e.type);

    // Streaming chunks come first (emitted during onText), then user turn,
    // then assistant turn + turn.complete
    const chunkCount = streamedChunks.length;
    expect(chunkCount).toBeGreaterThan(0);

    // Expected: message.chunk(s) → message.user → message.assistant → turn.complete
    const expectedTypes = [
      ...Array(chunkCount).fill("message.chunk"),
      "message.user",
      "message.assistant",
      "turn.complete",
    ];
    expect(types).toEqual(expectedTypes);

    // Verify monotonic sequence numbers
    const seqNums = events.map((e) => seqOf(e.id));
    for (let i = 1; i < seqNums.length; i++) {
      expect(seqNums[i]!).toBeGreaterThan(seqNums[i - 1]!);
    }

    // Verify the user event has actor=host and correct text
    const userEvent = events.find((e) => e.type === "message.user")!;
    expect(userEvent.actor).toBe("host");
    expect((userEvent.payload as { text: string }).text).toBe(userInput);

    // Verify assistant event text matches pipeline output
    const assistantEvent = events.find((e) => e.type === "message.assistant")!;
    expect((assistantEvent.payload as { text: string }).text).toBe(cannedResponse);

    // ── 7. POST a guest message to the server ──
    const guestTxnId = "txn-host-int-1";
    const guestResponse = await postMessage(
      `http://127.0.0.1:${port}`,
      sessionId,
      invite.token,
      "What about the universe?",
      guestTxnId,
    );
    expect(guestResponse.type).toBe("message.queued");
    expect(guestResponse.txn_id).toBe(guestTxnId);

    // ── 8. Drain queue and emit guest message ──
    expect(bridge.hasPendingMessages()).toBe(true);
    const pending = bridge.drainQueue();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.txn_id).toBe(guestTxnId);
    expect(pending[0]!.text).toBe("What about the universe?");

    bridge.emitGuestMessage(pending[0]!);

    // ── 9. Verify full sequence including guest flow ──
    const allEvents = eventLog.replay();
    const allTypes = allEvents.map((e) => e.type);

    const expectedFullTypes = [
      ...Array(chunkCount).fill("message.chunk"),
      "message.user",         // host prompt
      "message.assistant",    // agent response
      "turn.complete",        // turn boundary
      "message.queued",       // guest message received by server
      "message.user",         // guest message emitted by bridge
    ];
    expect(allTypes).toEqual(expectedFullTypes);

    // Verify all IDs are monotonically increasing
    const allSeqNums = allEvents.map((e) => seqOf(e.id));
    for (let i = 1; i < allSeqNums.length; i++) {
      expect(allSeqNums[i]!).toBeGreaterThan(allSeqNums[i - 1]!);
    }

    // Verify txn_id flows through queued → user
    const queuedEvent = allEvents.find((e) => e.type === "message.queued")!;
    expect(queuedEvent.txn_id).toBe(guestTxnId);

    const guestUserEvent = allEvents.find(
      (e) => e.type === "message.user" && e.txn_id === guestTxnId,
    )!;
    expect(guestUserEvent).toBeDefined();
    expect(guestUserEvent.txn_id).toBe(guestTxnId);
    expect(guestUserEvent.actor).toContain("guest:");

    // Host message.user has no txn_id
    const hostUserEvent = allEvents.find(
      (e) => e.type === "message.user" && e.actor === "host",
    )!;
    expect(hostUserEvent.txn_id).toBeUndefined();
  });

  test("dedup: emitUserTurn with same turn ID is idempotent", async () => {
    const eventLog = new ShareEventLog();
    const queue = new GuestMessageQueue();
    const bridge = new ShareBridge(eventLog, queue);

    const userTurn: Turn = {
      id: "dedup-u1",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    };

    bridge.emitUserTurn(userTurn);
    bridge.emitUserTurn(userTurn); // second call should be a no-op

    const events = eventLog.replay();
    const userEvents = events.filter((e) => e.type === "message.user");
    expect(userEvents).toHaveLength(1);
  });

  test("dedup: emitAssistantTurn with same turn ID is idempotent", async () => {
    const eventLog = new ShareEventLog();
    const queue = new GuestMessageQueue();
    const bridge = new ShareBridge(eventLog, queue);

    const assistantTurn: Turn = {
      id: "dedup-a1",
      role: "assistant",
      content: [{ type: "text", text: "response" }],
      timestamp: Date.now(),
    };

    bridge.emitAssistantTurn(assistantTurn);
    bridge.emitAssistantTurn(assistantTurn); // second call should be a no-op

    const events = eventLog.replay();
    const assistantEvents = events.filter((e) => e.type === "message.assistant");
    expect(assistantEvents).toHaveLength(1);
    const completeEvents = events.filter((e) => e.type === "turn.complete");
    expect(completeEvents).toHaveLength(1);
  });
});
