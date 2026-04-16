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

// Bracketed paste mode is enabled by Composer's mount effect. On a normal
// React unmount the cleanup effect disables it, but uncaught exceptions
// and signals skip cleanup — leaving the user's terminal echoing literal
// ESC[200~/ESC[201~ around any paste in subsequent shell sessions.
function disableBracketedPaste(): void {
  try {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l");
  } catch {
    // Stdout may already be closed.
  }
}
process.on("exit", disableBracketedPaste);
process.on("SIGINT", () => { disableBracketedPaste(); process.exit(130); });
process.on("SIGTERM", () => { disableBracketedPaste(); process.exit(143); });

process.on("uncaughtException", (err) => {
  writeCrash(err);
  disableBracketedPaste();
  console.error(`\nCrash logged to ${crashLog}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  writeCrash(reason);
  disableBracketedPaste();
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
