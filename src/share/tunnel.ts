import { type Subprocess } from "bun";

let tunnelProcess: Subprocess | null = null;
let cachedUrl: string | null = null;
let pendingTunnel: Promise<string | null> | null = null;

export async function startTunnel(port: number): Promise<string | null> {
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

async function startBore(borePath: string, port: number): Promise<string | null> {
  const proc = Bun.spawn([borePath, "local", String(port), "--to", "bore.pub"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  tunnelProcess = proc;

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
  tunnelProcess = Bun.spawn([ngrokPath, "http", String(port), "--log", "stderr"], {
    stdout: "ignore",
    stderr: "ignore",
  });

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
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
  }
  cachedUrl = null;
}

export function getTunnelUrl(): string | null {
  return cachedUrl;
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
