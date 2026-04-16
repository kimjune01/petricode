import { render } from "ink";
import React from "react";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import App from "./app/App.js";

// ── Crash log ────────────────────────────────────────────────────
const logDir = join(process.cwd(), ".petricode");
const crashLog = join(logDir, "crash.log");

function writeCrash(err: unknown): void {
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const msg = err instanceof Error
      ? `${err.message}\n${err.stack}`
      : String(err);
    appendFileSync(crashLog, `\n--- ${ts} ---\n${msg}\n`);
  } catch {
    // Last resort — don't crash the crash handler
  }
}

process.on("uncaughtException", (err) => {
  writeCrash(err);
  console.error(`\nCrash logged to ${crashLog}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  writeCrash(reason);
  console.error(`\nCrash logged to ${crashLog}`);
  process.exit(1);
});

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`petricode

Usage:
  petricode [options]

Options:
  --help, -h            Show this help message
  --version             Show version
  --resume <session-id> Resume a previous session
  --list                List recent sessions

Run without arguments to open the TUI.`);
  process.exit(0);
}

if (args.includes("--version")) {
  console.log("petricode 0.1.0");
  process.exit(0);
}

if (args.includes("--list")) {
  // List sessions requires async — handled here before TUI
  const { createSqliteRemember } = await import("./remember/sqlite.js");
  const { listSessions } = await import("./session/resume.js");
  const { join } = await import("path");
  const dataDir = join(process.cwd(), ".petricode", "data");
  const remember = createSqliteRemember({ dataDir });
  const sessions = await listSessions(remember, 20);
  if (sessions.length === 0) {
    console.log("No sessions found.");
  } else {
    console.log("Recent sessions:");
    for (const s of sessions) {
      const created = new Date(
        (s.metadata.created_at as number) ?? 0,
      ).toLocaleString();
      console.log(`  ${s.id}  ${created}`);
    }
  }
  process.exit(0);
}

// Parse --resume flag
let resumeSessionId: string | undefined;
const resumeIdx = args.indexOf("--resume");
if (resumeIdx !== -1) {
  resumeSessionId = args[resumeIdx + 1];
  if (!resumeSessionId) {
    console.error("--resume requires a session ID. Use --list to see sessions.");
    process.exit(1);
  }
}

// Bootstrap the pipeline
const { bootstrap } = await import("./session/bootstrap.js");
const { pipeline, sessionId, resumed, mode } = await bootstrap({
  projectDir: process.cwd(),
  resumeSessionId,
  // onConfirm wired by App.tsx after mount
});

if (resumed) {
  console.log(`Resumed session ${sessionId}`);
}

// Workaround for Bun stdin bug with Ink's useInput
process.stdin.resume();

const { waitUntilExit } = render(
  React.createElement(App, { pipeline, resumeSessionId, mode }),
);
await waitUntilExit();
