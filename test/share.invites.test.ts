import { describe, test, expect } from "bun:test";
import { InviteRegistry } from "../src/share/invites.js";

describe("InviteRegistry", () => {
  test("create returns invite with correct fields", () => {
    const reg = new InviteRegistry();
    const invite = reg.create("session-1", "kitchen");
    expect(invite.sessionId).toBe("session-1");
    expect(invite.scope).toBe("kitchen");
    expect(invite.token).toBeTruthy();
    expect(invite.id).toBeTruthy();
    expect(invite.actor).toBe(`guest:${invite.id}`);
    expect(invite.createdAt).toBeTruthy();
  });

  test("validate returns invite for valid token", () => {
    const reg = new InviteRegistry();
    const invite = reg.create("session-1", "living");
    const found = reg.validate(invite.token);
    expect(found).toEqual(invite);
  });

  test("validate returns null for unknown token", () => {
    const reg = new InviteRegistry();
    expect(reg.validate("bogus")).toBeNull();
  });

  test("revoke removes invite", () => {
    const reg = new InviteRegistry();
    const invite = reg.create("session-1", "kitchen");
    expect(reg.revoke(invite.id)).toBe(true);
    expect(reg.validate(invite.token)).toBeNull();
  });

  test("revoke returns false for unknown id", () => {
    const reg = new InviteRegistry();
    expect(reg.revoke("nope")).toBe(false);
  });

  test("living scope rejects POST check", () => {
    const reg = new InviteRegistry();
    const invite = reg.create("session-1", "living");
    expect(reg.canPost(invite)).toBe(false);
  });

  test("kitchen scope accepts POST check", () => {
    const reg = new InviteRegistry();
    const invite = reg.create("session-1", "kitchen");
    expect(reg.canPost(invite)).toBe(true);
  });

  test("list returns all active invites", () => {
    const reg = new InviteRegistry();
    const a = reg.create("s1", "living");
    const b = reg.create("s1", "kitchen");
    const all = reg.list();
    expect(all).toHaveLength(2);
    expect(all.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("list excludes revoked invites", () => {
    const reg = new InviteRegistry();
    const a = reg.create("s1", "living");
    reg.create("s1", "kitchen");
    reg.revoke(a.id);
    expect(reg.list()).toHaveLength(1);
  });

  test("tokens are unique", () => {
    const reg = new InviteRegistry();
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(reg.create("s1", "living").token);
    }
    expect(tokens.size).toBe(100);
  });
});
