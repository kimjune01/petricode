export type RoomScope = "living" | "kitchen";

export interface Invite {
  id: string;
  token: string;
  sessionId: string;
  scope: RoomScope;
  createdAt: string;
  actor: string;
}

function randomBase64url(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(buf).toString("base64url");
}

function shortId(): string {
  return randomBase64url(6);
}

export class InviteRegistry {
  private byToken = new Map<string, Invite>();
  private byId = new Map<string, Invite>();

  create(sessionId: string, scope: RoomScope): Invite {
    const id = shortId();
    const invite: Invite = {
      id,
      token: randomBase64url(32),
      sessionId,
      scope,
      createdAt: new Date().toISOString(),
      actor: `guest:${id}`,
    };
    this.byToken.set(invite.token, invite);
    this.byId.set(invite.id, invite);
    return invite;
  }

  validate(token: string): Invite | null {
    return this.byToken.get(token) ?? null;
  }

  revoke(inviteId: string): boolean {
    const invite = this.byId.get(inviteId);
    if (!invite) return false;
    this.byId.delete(inviteId);
    this.byToken.delete(invite.token);
    return true;
  }

  list(): Invite[] {
    return [...this.byId.values()];
  }

  canPost(invite: Invite): boolean {
    return invite.scope === "kitchen";
  }
}
