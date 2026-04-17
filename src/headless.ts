// ── Headless (non-TUI) entry point ───────────────────────────────
// Runs one pipeline turn against the given prompt, writes the assistant's
// final text to stdout, exits. Skips Ink entirely so the binary can be
// driven from scripts, agents, or `petricode -p "..."` one-shots.
//
// Tool calls auto-allow: runToolSubpipe falls through to execute when
// onConfirm is absent (see toolSubpipe.ts:106). This matches gemini-cli's
// eval policy of `approvalMode: 'yolo'` for non-interactive runs — there
// is no human to ask, so blocking on a confirmation would deadlock.

import type { Turn, Content } from "./core/types.js";

export interface HeadlessOptions {
  prompt: string;
  projectDir: string;
  resumeSessionId?: string;
  /** Output mode. "text" = plain assistant text. "json" = full final turn. */
  format?: "text" | "json";
}

function turnText(turn: Turn): string {
  return turn.content
    .filter((c: Content): c is Extract<Content, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const { bootstrap } = await import("./session/bootstrap.js");
  const { pipeline } = await bootstrap({
    projectDir: opts.projectDir,
    resumeSessionId: opts.resumeSessionId,
    // No onConfirm — tools requiring confirmation auto-allow.
  });

  try {
    const turn = await pipeline.turn(opts.prompt);
    if (opts.format === "json") {
      process.stdout.write(JSON.stringify(turn) + "\n");
    } else {
      const text = turnText(turn);
      process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`petricode: ${msg}\n`);
    return 1;
  }
}
