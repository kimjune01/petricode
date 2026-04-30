import type { ShareEvent } from "./events.js";
import { parseSSE } from "./events.js";

export interface ParsedShareURL {
  host: string;
  sessionId: string;
  token: string;
}

export function parseShareURL(url: string): ParsedShareURL | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (!match) return null;
    const token = parsed.searchParams.get("token");
    if (!token) return null;
    return {
      host: parsed.origin,
      sessionId: match[1]!,
      token,
    };
  } catch {
    return null;
  }
}

export interface SSEClientOptions {
  url: string;
  token: string;
  onEvent: (event: ShareEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  watchdogMs?: number;
}

export class SSEClient {
  private controller: AbortController | null = null;
  private lastEventId: string | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  private readonly url: string;
  private readonly token: string;
  private readonly onEvent: (event: ShareEvent) => void;
  private readonly onConnect?: () => void;
  private readonly onDisconnect?: () => void;
  private readonly watchdogMs: number;

  constructor(opts: SSEClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.onEvent = opts.onEvent;
    this.onConnect = opts.onConnect;
    this.onDisconnect = opts.onDisconnect;
    this.watchdogMs = opts.watchdogMs ?? 20_000;
  }

  async connect(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.stream();
        // Clean EOF — server closed the connection. Back off before reconnecting.
        if (!this.running) break;
        this.onDisconnect?.();
        await new Promise((r) => setTimeout(r, 1000));
      } catch {
        if (!this.running) break;
        this.onDisconnect?.();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  disconnect(): void {
    this.running = false;
    this.clearWatchdog();
    this.controller?.abort();
    this.controller = null;
  }

  private async stream(): Promise<void> {
    this.controller = new AbortController();

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.lastEventId) {
      headers["Last-Event-ID"] = this.lastEventId;
    }

    this.resetWatchdog();

    const resp = await fetch(this.url, {
      headers,
      signal: this.controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`SSE connect failed: ${resp.status}`);
    }

    this.onConnect?.();
    this.resetWatchdog();

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (this.running) {
      const { done, value } = await reader.read();
      if (done) break;

      this.resetWatchdog();
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        if (!frame.trim()) continue;
        if (frame.startsWith(":")) continue;

        const events = parseSSE(frame + "\n\n");
        for (const event of events) {
          this.lastEventId = event.id;
          this.onEvent(event);
        }
      }
    }

    reader.cancel();
  }

  private resetWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.controller?.abort();
    }, this.watchdogMs);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}

export async function postMessage(
  host: string,
  sessionId: string,
  token: string,
  text: string,
  txn_id: string,
): Promise<ShareEvent> {
  const resp = await fetch(`${host}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, txn_id }),
  });

  if (!resp.ok) {
    throw new Error(`POST failed: ${resp.status}`);
  }

  return (await resp.json()) as ShareEvent;
}
