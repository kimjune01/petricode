import { type Subprocess } from "bun";

let tunnelProcess: Subprocess | null = null;
let cachedUrl: string | null = null;
let pendingTunnel: Promise<string | null> | null = null;

// --- heartbeat state ---------------------------------------------------------
// We probe the cached tunnel URL every HEARTBEAT_INTERVAL_MS while a tunnel is
// active. After HEARTBEAT_DEAD_THRESHOLD consecutive failed pings we declare
// the tunnel dead, tear it down, and notify a listener (typically the TUI).
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_DEAD_THRESHOLD = 2;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatMisses = 0;
let onTunnelDead: ((url: string) => void) | null = null;

/**
 * Register a callback fired when the heartbeat declares the tunnel dead
 * (HEARTBEAT_DEAD_THRESHOLD consecutive missed pings). The callback receives
 * the URL that was just torn down — useful for surfacing a notice in the TUI.
 *
 * Pass null to clear. Only one listener is supported (last registration wins).
 */
export function setTunnelDeadCallback(cb: ((url: string) => void) | null): void {
  onTunnelDead = cb;
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatMisses = 0;
  heartbeatTimer = setInterval(() => {
    void heartbeatTick();
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for the heartbeat — when the user
  // exits, we don't want a zombie 30s timer holding the process open.
  heartbeatTimer.unref?.();
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatMisses = 0;
}

async function heartbeatTick(): Promise<void> {
  const url = cachedUrl;
  if (!url) {
    stopHeartbeat();
    return;
  }
  const alive = await pingTunnel(url);
  if (alive) {
    heartbeatMisses = 0;
    return;
  }
  heartbeatMisses += 1;
  if (heartbeatMisses >= HEARTBEAT_DEAD_THRESHOLD) {
    const deadUrl = url;
    stopTunnel(); // also stops the heartbeat
    try {
      onTunnelDead?.(deadUrl);
    } catch {
      // Listener errors must not poison the tunnel module.
    }
  }
}

function tunnelDead(): boolean {
  return tunnelProcess !== null && tunnelProcess.exitCode !== null;
}

function clearDeadTunnel(): void {
  if (tunnelDead()) {
    cachedUrl = null;
    tunnelProcess = null;
    stopHeartbeat();
  }
}

export async function startTunnel(port: number): Promise<string | null> {
  // If the cached URL points at a subprocess that has since exited, drop it
  // so we restart instead of handing back a dead bore.pub:port.
  clearDeadTunnel();

  if (cachedUrl) return cachedUrl;
  if (pendingTunnel) return pendingTunnel;

  pendingTunnel = _startTunnel(port);
  const result = await pendingTunnel;
  pendingTunnel = null;
  return result;
}

async function _startTunnel(port: number): Promise<string | null> {

  // Try bore first (no signup, free public relay)
  const borePath = await findBinary("bore");
  if (borePath) {
    const url = await startBore(borePath, port);
    if (url) return url;
  }

  // Fall back to ngrok (requires signup + auth token)
  const ngrokPath = await findBinary("ngrok");
  if (ngrokPath) {
    return startNgrok(ngrokPath, port);
  }

  return null;
}

function watchExit(proc: Subprocess): void {
  proc.exited.then(() => {
    if (tunnelProcess === proc) {
      tunnelProcess = null;
      cachedUrl = null;
    }
  });
}

async function startBore(borePath: string, port: number): Promise<string | null> {
  const proc = Bun.spawn([borePath, "local", String(port), "--to", "bore.pub"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  tunnelProcess = proc;
  watchExit(proc);

  // bore writes to stdout when piped (not stderr)
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // Overall timeout — kill bore if it doesn't connect in 10s
  const timeout = setTimeout(() => {
    reader.cancel().catch(() => {});
    stopTunnel();
  }, 10_000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // Strip ANSI escape sequences (bore uses tracing with color codes)
      const clean = buf.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
      const match = clean.match(/listening at\s+bore\.pub:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        cachedUrl = `http://bore.pub:${match[1]}`;
        startHeartbeat();
        return cachedUrl;
      }
    }
  } catch {
    // reader cancelled by timeout or process killed
  } finally {
    clearTimeout(timeout);
  }

  stopTunnel();
  return null;
}

async function startNgrok(ngrokPath: string, port: number): Promise<string | null> {
  const proc = Bun.spawn([ngrokPath, "http", String(port), "--log", "stderr"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  tunnelProcess = proc;
  watchExit(proc);

  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const resp = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        tunnels: Array<{ public_url: string; proto: string }>;
      };
      const https = data.tunnels.find((t) => t.proto === "https");
      const tunnel = https ?? data.tunnels[0];
      if (tunnel) {
        cachedUrl = tunnel.public_url;
        startHeartbeat();
        return cachedUrl;
      }
    } catch {
      // ngrok API not ready yet
    }
  }

  stopTunnel();
  return null;
}

export function stopTunnel(): void {
  stopHeartbeat();
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
  }
  cachedUrl = null;
}

export function getTunnelUrl(): string | null {
  // Never hand back a URL that points at a subprocess that has died.
  clearDeadTunnel();
  return cachedUrl;
}

/**
 * Probe a tunnel URL to confirm the remote relay still forwards to us.
 *
 * Sends a quick GET to `/` (which our ShareServer answers with 404).
 * Any HTTP response — including 404 — proves the path
 * `client → bore.pub:port → local bore → our server` is intact.
 *
 * Returns false on connection refused, DNS failure, TLS error, or timeout.
 * The local subprocess can still be running while the relay has dropped us
 * (bore.pub restart, NAT timeout, network blip), so a process-alive check
 * is not sufficient.
 */
export async function pingTunnel(url: string, timeoutMs = 2_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url + "/", {
      method: "GET",
      signal: controller.signal,
      // Don't keep the connection open — we just want to know it answered.
      headers: { "connection": "close" },
    });
    // Drain so the socket can close cleanly.
    await resp.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ping the cached tunnel; if it doesn't answer, kill the local bore
 * subprocess and clear cache so the next /share starts a fresh tunnel.
 *
 * Returns the live URL, or null if there was no cached tunnel or it was dead.
 */
export async function checkTunnel(timeoutMs = 2_000): Promise<string | null> {
  clearDeadTunnel();
  const url = cachedUrl;
  if (!url) return null;
  const alive = await pingTunnel(url, timeoutMs);
  if (alive) return url;
  stopTunnel();
  return null;
}

async function findBinary(name: string): Promise<string | null> {
  // Check PATH first
  try {
    const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    const path = text.trim();
    if (path) return path;
  } catch {}

  // Check common locations not always in PATH
  const { existsSync } = await import("fs");
  const { join } = await import("path");
  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, "bin", name),
    join(home, ".local", "bin", name),
    `/usr/local/bin/${name}`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  return null;
}
