import type { CommandResult } from "./index.js";
import type { ShareServer } from "../share/server.js";
import type { InviteRegistry, RoomScope } from "../share/invites.js";
import { startTunnel, checkTunnel, getTunnelUrl } from "../share/tunnel.js";

export interface ShareCommandContext {
  server: ShareServer;
  invites: InviteRegistry;
  sessionId: string;
  shareHost?: string;
}

function formatShareOutput(
  baseUrl: string,
  sessionId: string,
  token: string,
  inviteId: string,
): string {
  const url = `${baseUrl}/sessions/${sessionId}/events?token=${token}`;

  return [
    "Shared session",
    "",
    "--- copy below ---",
    `${url}`,
    "",
    `Terminal (read-only):  curl -sN "${url}&format=ansi"`,
    `Terminal (read-write): petricode attach "${url}"`,
    "",
    `https://github.com/kimjune01/petricode`,
    "--- copy above ---",
    "",
    `/revoke ${inviteId} to revoke`,
  ].join("\n");
}

export function makeShareHandler(ctx: ShareCommandContext): (args: string) => CommandResult | Promise<CommandResult> {
  let serverStarted = false;

  return (args: string): CommandResult | Promise<CommandResult> => {
    if (!serverStarted) {
      ctx.server.start();
      serverStarted = true;
    }

    const invite = ctx.invites.create(ctx.sessionId, "kitchen");

    // Manually configured host: synchronous, no tunnel involvement.
    if (ctx.shareHost) {
      return {
        output: formatShareOutput(
          `http://${ctx.shareHost}`, ctx.sessionId, invite.token, invite.id,
        ),
      };
    }

    // No tunnel has ever been started in this process: nothing to ping.
    // Go straight to startTunnel (which handles "bore not installed").
    if (getTunnelUrl() === null) {
      return startTunnel(ctx.server.port).then((url) =>
        finalize(url, ctx.server.port, ctx.sessionId, invite.token, invite.id),
      );
    }

    // We have a cached tunnel URL. Probe it — bore.pub may have dropped us
    // (restart, NAT timeout, network blip) while our local subprocess is
    // still happily running. checkTunnel() declares dead tunnels dead.
    return checkTunnel().then((liveUrl) => {
      if (liveUrl) {
        return {
          output: formatShareOutput(liveUrl, ctx.sessionId, invite.token, invite.id),
        };
      }
      // Dead — try once more.
      return startTunnel(ctx.server.port).then((url) =>
        finalize(url, ctx.server.port, ctx.sessionId, invite.token, invite.id),
      );
    });
  };
}

function finalize(
  url: string | null,
  port: number,
  sessionId: string,
  token: string,
  inviteId: string,
): CommandResult {
  if (url) {
    return { output: formatShareOutput(url, sessionId, token, inviteId) };
  }
  const localBase = `http://localhost:${port}`;
  return {
    output: [
      formatShareOutput(localBase, sessionId, token, inviteId),
      "",
      "Local only — for remote: cargo install bore-cli (no signup)",
      "Or: --share-host <host:port> with a manual tunnel",
    ].join("\n"),
  };
}

export function makeRevokeHandler(ctx: ShareCommandContext): (args: string) => CommandResult {
  return (args: string): CommandResult => {
    const inviteId = args.trim();

    if (!inviteId) {
      const active = ctx.invites.list();
      if (active.length === 0) {
        return { output: "No active invites." };
      }
      const lines = active.map((i) => {
        return `  ${i.id}  ${i.scope.padEnd(7)}  ${i.createdAt}`;
      });
      return { output: ["Active invites:", ...lines].join("\n") };
    }

    const exists = ctx.invites.list().some((i) => i.id === inviteId);
    if (!exists) {
      return { output: `No active invite with ID: ${inviteId}` };
    }
    ctx.server.revokeInvite(inviteId);
    return { output: `Revoked invite ${inviteId}.` };
  };
}
