import type { CommandResult } from "./index.js";
import type { ShareServer } from "../share/server.js";
import type { InviteRegistry, RoomScope } from "../share/invites.js";
import { startTunnel, getTunnelUrl } from "../share/tunnel.js";

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
    url,
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

    if (ctx.shareHost) {
      return {
        output: formatShareOutput(
          `http://${ctx.shareHost}`, ctx.sessionId, invite.token, invite.id,
        ),
      };
    }

    const tunnelUrl = getTunnelUrl();
    if (tunnelUrl) {
      return {
        output: formatShareOutput(tunnelUrl, ctx.sessionId, invite.token, invite.id),
      };
    }

    // Start tunnel and wait for it (up to ~5s)
    return startTunnel(ctx.server.port).then((url) => {
      if (url) {
        return {
          output: formatShareOutput(url, ctx.sessionId, invite.token, invite.id),
        };
      }

      const localBase = `http://localhost:${ctx.server.port}`;
      return {
        output: [
          formatShareOutput(localBase, ctx.sessionId, invite.token, invite.id),
          "",
          "Local only — for remote: cargo install bore-cli (no signup)",
          "Or: --share-host <host:port> with a manual tunnel",
        ].join("\n"),
      };
    });
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
