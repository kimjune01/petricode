import type { Server } from "bun";
type BunServer = Server<unknown>;
import type { ShareEvent } from "./events.js";
import { serializeSSE, HEARTBEAT } from "./events.js";
import { ShareEventLog } from "./eventLog.js";
import { InviteRegistry, type Invite } from "./invites.js";
import { GuestMessageQueue } from "./queue.js";
import { viewerHTML } from "./viewer.js";

interface SSEConnection {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  invite: Invite;
  controller: AbortController;
}

export interface ShareServerOptions {
  port: number;
  hostname?: string;
  eventLog: ShareEventLog;
  invites: InviteRegistry;
  sessionId: string;
  queue?: GuestMessageQueue;
}

export class ShareServer {
  private server: BunServer | null = null;
  private connections = new Set<SSEConnection>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  readonly port: number;
  readonly hostname: string;
  private readonly eventLog: ShareEventLog;
  private readonly invites: InviteRegistry;
  private readonly sessionId: string;
  readonly queue: GuestMessageQueue;

  constructor(opts: ShareServerOptions) {
    this.port = opts.port;
    this.hostname = opts.hostname ?? "localhost";
    this.eventLog = opts.eventLog;
    this.invites = opts.invites;
    this.sessionId = opts.sessionId;
    this.queue = opts.queue ?? new GuestMessageQueue();
  }

  start(): void {
    if (this.server) return;

    const self = this;

    this.server = Bun.serve({
      port: this.port,
      hostname: this.hostname,
      fetch(req) {
        return self.handleRequest(req);
      },
    });

    this.unsubscribe = this.eventLog.onEvent((event) => {
      self.fanOut(event);
    });

    this.heartbeatInterval = setInterval(() => {
      self.sendHeartbeat();
    }, 15_000);
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    for (const conn of this.connections) {
      conn.controller.abort();
      conn.writer.close().catch(() => {});
    }
    this.connections.clear();
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }

  revokeInvite(inviteId: string): void {
    this.invites.revoke(inviteId);
    for (const conn of this.connections) {
      if (conn.invite.id === inviteId) {
        conn.controller.abort();
        conn.writer.close().catch(() => {});
        this.connections.delete(conn);
      }
    }
  }

  connectionCount(): number {
    return this.connections.size;
  }

  private handleRequest(req: Request): Response | Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    const sessionMatch = path.match(/^\/sessions\/([^/]+)\/events$/);
    if (sessionMatch && req.method === "GET") {
      return this.handleSSE(req, url, sessionMatch[1]!);
    }

    const messageMatch = path.match(/^\/sessions\/([^/]+)\/messages$/);
    if (messageMatch && req.method === "POST") {
      return this.handlePost(req, messageMatch[1]!);
    }

    return new Response("Not Found", { status: 404 });
  }

  private handleSSE(req: Request, url: URL, requestSessionId: string): Response {
    const token = url.searchParams.get("token")
      ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

    if (!token) {
      return new Response("Unauthorized", { status: 401 });
    }

    const invite = this.invites.validate(token);
    if (!invite) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (invite.sessionId !== requestSessionId) {
      return new Response("Forbidden", { status: 403 });
    }

    // Content negotiation: browser gets the viewer page, SSE clients get the stream
    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("text/html") && !accept.includes("text/event-stream")) {
      const sseUrl = url.toString();
      return new Response(viewerHTML(sseUrl), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    const lastEventId = req.headers.get("last-event-id") ?? undefined;
    const encoder = new TextEncoder();

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const controller = new AbortController();

    const conn: SSEConnection = { writer, invite, controller };

    // Replay first, buffer live events during replay, then subscribe.
    // This prevents live fanout from racing ahead of replayed history.
    // Key invariant: the buffer subscription stays active until we
    // synchronously swap to live fanout (unsub + add to connections
    // with no await between them). Events arriving during the drain
    // loop are still captured by the buffer.
    (async () => {
      const pendingDuringReplay: ShareEvent[] = [];
      const bufferLive = (event: ShareEvent) => {
        pendingDuringReplay.push(event);
      };
      const unsub = this.eventLog.onEvent(bufferLive);

      try {
        const replay = lastEventId
          ? this.eventLog.replay(lastEventId)
          : this.eventLog.replayCompacted();
        const sentIds = new Set<string>();
        for (const event of replay) {
          if (controller.signal.aborted) break;
          sentIds.add(event.id);
          await writer.write(encoder.encode(serializeSSE(event)));
        }

        // Drain buffered events. Use index loop because new events
        // may arrive during each await, growing the array.
        let drainIdx = 0;
        while (drainIdx < pendingDuringReplay.length) {
          if (controller.signal.aborted) break;
          const event = pendingDuringReplay[drainIdx]!;
          drainIdx++;
          if (!sentIds.has(event.id)) {
            sentIds.add(event.id);
            await writer.write(encoder.encode(serializeSSE(event)));
          }
        }

        // Synchronous swap: unsub buffer, add to live fanout.
        // No await between these two lines — no event can be lost.
        unsub();
        if (!controller.signal.aborted) {
          this.connections.add(conn);
        }
      } catch {
        unsub();
        writer.close().catch(() => {});
      }
    })();

    controller.signal.addEventListener("abort", () => {
      this.connections.delete(conn);
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  async handlePost(req: Request, requestSessionId: string): Promise<Response> {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) {
      return new Response("Unauthorized", { status: 401 });
    }

    const invite = this.invites.validate(token);
    if (!invite) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (invite.sessionId !== requestSessionId) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!this.invites.canPost(invite)) {
      return new Response("Forbidden: living scope cannot post", { status: 403 });
    }

    let body: { text?: string; txn_id?: string };
    try {
      body = (await req.json()) as { text?: string; txn_id?: string };
    } catch {
      return new Response("Bad Request: invalid JSON", { status: 400 });
    }

    if (!body.text || typeof body.text !== "string") {
      return new Response("Bad Request: missing text", { status: 400 });
    }

    const txn_id = body.txn_id ?? crypto.randomUUID();

    const queuedEvent = this.eventLog.append({
      type: "message.queued",
      ts: new Date().toISOString(),
      actor: invite.actor,
      payload: { text: body.text },
      txn_id,
    });

    this.queue.enqueue({ text: body.text, actor: invite.actor, txn_id });

    return new Response(JSON.stringify(queuedEvent), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }

  private fanOut(event: ShareEvent): void {
    const encoder = new TextEncoder();
    const data = encoder.encode(serializeSSE(event));

    for (const conn of this.connections) {
      if (conn.controller.signal.aborted) {
        this.connections.delete(conn);
        continue;
      }
      conn.writer.write(data).catch(() => {
        this.connections.delete(conn);
      });
    }
  }

  private sendHeartbeat(): void {
    const encoder = new TextEncoder();
    const data = encoder.encode(HEARTBEAT);

    for (const conn of this.connections) {
      if (conn.controller.signal.aborted) {
        this.connections.delete(conn);
        continue;
      }
      conn.writer.write(data).catch(() => {
        this.connections.delete(conn);
      });
    }
  }
}
