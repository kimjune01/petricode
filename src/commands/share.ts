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
  scope: RoomScope,
): string {
  const url = `${baseUrl}/sessions/${sessionId}/events?token=${token}`;
  const label = scope === "kitchen" ? "Kitchen invite (read + submit)" : "Living room invite (read-only)";

  const shareBlock = [
    `Join my petricode session (${scope === "kitchen" ? "you can chat" : "read-only"}):`,
    ``,
    `Watch in browser: ${url}`,
    ``,
    `Join from terminal:`,
    `  curl -fsSL https://bun.sh/install | bash`,
    `  git clone https://github.com/kimjune01/petricode.git && cd petricode && bun install`,
    `  bun run src/cli.ts attach "${url}"`,
  ].join("\n");

  return [
    `${label}`,
    "",
    "--- copy below ---",
    shareBlock,
    "--- copy above ---",
    "",
    `/revoke ${inviteId} to revoke`,
  ].join("\n");
}

export function makeShareHandler(ctx: ShareCommandContext): (args: string) => CommandResult {
  let tunnelAttempted = false;
  let serverStarted = false;

  return (args: string): CommandResult => {
    const scope: RoomScope = args.trim() === "kitchen" ? "kitchen" : "living";

    if (!serverStarted) {
      ctx.server.start();
      serverStarted = true;
    }

    const invite = ctx.invites.create(ctx.sessionId, scope);

    if (ctx.shareHost) {
      return {
        output: formatShareOutput(
          `http://${ctx.shareHost}`, ctx.sessionId, invite.token, invite.id, scope,
        ),
      };
    }

    const tunnelUrl = getTunnelUrl();
    if (tunnelUrl) {
      return {
        output: formatShareOutput(
          tunnelUrl, ctx.sessionId, invite.token, invite.id, scope,
        ),
      };
    }

    const localBase = `http://localhost:${ctx.server.port}`;

    if (!tunnelAttempted) {
      tunnelAttempted = true;
      startTunnel(ctx.server.port).then((url) => {
        if (url) {
          console.log(`Tunnel ready. Run /share again for a remote link.`);
        }
      }).catch(() => {});

      return {
        output: [
          formatShareOutput(localBase, ctx.sessionId, invite.token, invite.id, scope),
          "",
          "Starting tunnel for remote access... /share again in a few seconds.",
          "Or: cargo install bore-cli (no signup needed)",
        ].join("\n"),
      };
    }

    return {
      output: [
        formatShareOutput(localBase, ctx.sessionId, invite.token, invite.id, scope),
        "",
        "Local only — for remote: cargo install bore-cli (no signup)",
        "Or: --share-host <host:port> with a manual tunnel",
      ].join("\n"),
    };
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
