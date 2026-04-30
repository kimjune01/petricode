import { describe, test, expect, afterEach } from "bun:test";
import { ShareServer } from "../src/share/server.js";
import { ShareEventLog } from "../src/share/eventLog.js";
import { InviteRegistry } from "../src/share/invites.js";
import { makeShareHandler, makeRevokeHandler } from "../src/commands/share.js";

let server: ShareServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

function setup(port: number) {
  const eventLog = new ShareEventLog();
  const invites = new InviteRegistry();
  const sessionId = "test-session";
  server = new ShareServer({ port, hostname: "127.0.0.1", eventLog, invites, sessionId });
  server.start();
  const ctx = { server, invites, sessionId };
  const share = makeShareHandler(ctx);
  const revoke = makeRevokeHandler(ctx);
  return { eventLog, invites, sessionId, port, share, revoke };
}

describe("/share command", () => {
  test("default produces living room URL", () => {
    const { share } = setup(17770);
    const result = share("");
    expect(result.output).toContain("Living room invite");
    expect(result.output).toContain("token=");
  });

  test("/share kitchen produces kitchen URL", () => {
    const { share } = setup(17771);
    const result = share("kitchen");
    expect(result.output).toContain("Kitchen invite");
  });

  test("URL contains valid token", async () => {
    const { share, invites, port } = setup(17772);
    const result = share("");
    const match = result.output.match(/token=([^\s]+)/);
    expect(match).not.toBeNull();
    const token = match![1]!;
    const invite = invites.validate(token);
    expect(invite).not.toBeNull();
    expect(invite!.scope).toBe("living");
  });

  test("second /share reuses running server", () => {
    const { share } = setup(17773);
    const r1 = share("");
    const r2 = share("kitchen");
    expect(r1.output).toContain("17773");
    expect(r2.output).toContain("17773");
  });

  test("--share-host overrides URL host", () => {
    const eventLog = new ShareEventLog();
    const invites = new InviteRegistry();
    const sessionId = "s1";
    server = new ShareServer({ port: 17774, hostname: "127.0.0.1", eventLog, invites, sessionId });
    server.start();
    const share = makeShareHandler({ server, invites, sessionId, shareHost: "192.168.1.100:7742" });
    const result = share("");
    expect(result.output).toContain("192.168.1.100:7742");
  });
});

describe("/revoke command", () => {
  test("no args lists active invites", () => {
    const { share, revoke } = setup(17775);
    share("");
    share("kitchen");
    const result = revoke("");
    expect(result.output).toContain("Active invites:");
    expect(result.output.split("\n").filter((l) => l.trim().startsWith("g") || l.includes("living") || l.includes("kitchen")).length).toBeGreaterThanOrEqual(2);
  });

  test("revoke by ID removes invite", () => {
    const { share, revoke, invites } = setup(17776);
    share("");
    const invite = invites.list()[0]!;
    const result = revoke(invite.id);
    expect(result.output).toContain("Revoked");
    expect(invites.validate(invite.token)).toBeNull();
  });

  test("revoke unknown ID reports error", () => {
    const { revoke } = setup(17777);
    const result = revoke("nonexistent");
    expect(result.output).toContain("No active invite");
  });

  test("revoke closes SSE connections", async () => {
    const { share, revoke, invites, sessionId, port } = setup(17778);
    share("living");
    const invite = invites.list()[0]!;

    // Connect SSE
    const controller = new AbortController();
    fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/events?token=${invite.token}`, {
      signal: controller.signal,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(server!.connectionCount()).toBe(1);

    revoke(invite.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(server!.connectionCount()).toBe(0);
    controller.abort();
  });
});
