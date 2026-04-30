import type { CommandResult } from "./index.js";
import type { ShareServer } from "../share/server.js";
import type { InviteRegistry, RoomScope } from "../share/invites.js";

export interface ShareCommandContext {
  server: ShareServer;
  invites: InviteRegistry;
  sessionId: string;
  shareHost?: string;
}

export function makeShareHandler(ctx: ShareCommandContext): (args: string) => CommandResult {
  return (args: string): CommandResult => {
    const scope: RoomScope = args.trim() === "kitchen" ? "kitchen" : "living";
    const invite = ctx.invites.create(ctx.sessionId, scope);

    const host = ctx.shareHost ?? `localhost:${ctx.server.port}`;
    const url = `http://${host}/sessions/${ctx.sessionId}/events?token=${invite.token}`;

    const label = scope === "kitchen" ? "Kitchen invite (read + submit)" : "Living room invite (read-only)";

    return {
      output: [
        `${label}:`,
        `  ${url}`,
        `  Revoke with /revoke ${invite.id}`,
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
