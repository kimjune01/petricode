import { type Subprocess } from "bun";

let tunnelProcess: Subprocess | null = null;
let cachedUrl: string | null = null;

export async function startTunnel(port: number): Promise<string | null> {
  if (cachedUrl) return cachedUrl;

  const ngrokPath = await findNgrok();
  if (!ngrokPath) return null;

  tunnelProcess = Bun.spawn([ngrokPath, "http", String(port), "--log", "stderr"], {
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait for ngrok to start and expose the API
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

async function findNgrok(): Promise<string | null> {
  for (const name of ["ngrok"]) {
    try {
      const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      const path = text.trim();
      if (path) return path;
    } catch {
      // not found
    }
  }
  return null;
}
