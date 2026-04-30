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

export function makeShareHandler(ctx: ShareCommandContext): (args: string) => CommandResult {
  let tunnelAttempted = false;
  let serverStarted = false;

  return (args: string): CommandResult => {
    const scope: RoomScope = args.trim() === "kitchen" ? "kitchen" : "living";

    // Start server lazily on first /share
    if (!serverStarted) {
      ctx.server.start();
      serverStarted = true;
    }

    const invite = ctx.invites.create(ctx.sessionId, scope);
    const label = scope === "kitchen" ? "Kitchen invite (read + submit)" : "Living room invite (read-only)";

    // If --share-host was provided, use it directly
    if (ctx.shareHost) {
      const url = `http://${ctx.shareHost}/sessions/${ctx.sessionId}/events?token=${invite.token}`;
      return {
        output: [
          `${label}:`,
          `  ${url}`,
          `  Revoke with /revoke ${invite.id}`,
        ].join("\n"),
      };
    }

    // Check if tunnel is already running
    const tunnelUrl = getTunnelUrl();
    if (tunnelUrl) {
      const url = `${tunnelUrl}/sessions/${ctx.sessionId}/events?token=${invite.token}`;
      return {
        output: [
          `${label}:`,
          `  ${url}`,
          `  Revoke with /revoke ${invite.id}`,
        ].join("\n"),
      };
    }

    // First share without tunnel — try to start one in background
    const localUrl = `http://localhost:${ctx.server.port}/sessions/${ctx.sessionId}/events?token=${invite.token}`;

    if (!tunnelAttempted) {
      tunnelAttempted = true;
      startTunnel(ctx.server.port).then((url) => {
        if (url) {
          console.log(`Tunnel ready: ${url}`);
          console.log("Run /share again to get a shareable remote link.");
        }
      }).catch(() => {});

      return {
        output: [
          `${label} (local):`,
          `  ${localUrl}`,
          `  Revoke with /revoke ${invite.id}`,
          "",
          "Starting tunnel for remote access... run /share again in a few seconds.",
          "Or install bore: cargo install bore-cli (no signup needed)",
        ].join("\n"),
      };
    }

    return {
      output: [
        `${label} (local only — no tunnel available):`,
        `  ${localUrl}`,
        `  Revoke with /revoke ${invite.id}`,
        "",
        "For remote sharing: cargo install bore-cli (no signup needed)",
        "Or pass --share-host <host:port> with a manual tunnel.",
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
