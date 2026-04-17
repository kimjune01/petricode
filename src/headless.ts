// ── Headless (non-TUI) entry point ───────────────────────────────
// Runs one pipeline turn against the given prompt, returns the result
// for cli.ts to write to stdout/stderr. Skips Ink entirely so the binary
// can be driven from scripts, agents, or `petricode -p "..."` one-shots.
//
// Tool calls auto-allow: runToolSubpipe falls through to execute when
// onConfirm is absent (see toolSubpipe.ts:106). This matches gemini-cli's
// eval policy of `approvalMode: 'yolo'` for non-interactive runs — there
// is no human to ask, so blocking on a confirmation would deadlock.

import type { Turn, Content } from "./core/types.js";
import type { Pipeline } from "./agent/pipeline.js";

export type HeadlessFormat = "text" | "json";

export interface HeadlessOptions {
  prompt: string;
  projectDir: string;
  resumeSessionId?: string;
  format?: HeadlessFormat;
}

export interface HeadlessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Pure: extract the assistant's plain text from a Turn. */
export function turnText(turn: Turn): string {
  return turn.content
    .filter((c: Content): c is Extract<Content, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** Pure: format a final Turn for headless output. */
export function formatHeadlessOutput(turn: Turn, format: HeadlessFormat): string {
  if (format === "json") return JSON.stringify(turn) + "\n";
  const text = turnText(turn);
  return text + (text.endsWith("\n") ? "" : "\n");
}

/**
 * Run one turn against an already-built pipeline. Split out from
 * runHeadless so tests can inject a mock pipeline without touching
 * the bootstrap (which does file I/O + provider construction).
 */
export async function runHeadlessTurn(
  pipeline: Pipeline,
  prompt: string,
  format: HeadlessFormat = "text",
): Promise<HeadlessResult> {
  try {
    const turn = await pipeline.turn(prompt);
    return { exitCode: 0, stdout: formatHeadlessOutput(turn, format), stderr: "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: "", stderr: `petricode: ${msg}\n` };
  }
}

/** Bootstrap a pipeline from disk config and run one turn against it. */
export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const { bootstrap } = await import("./session/bootstrap.js");
  const { pipeline } = await bootstrap({
    projectDir: opts.projectDir,
    resumeSessionId: opts.resumeSessionId,
    // No onConfirm — tools requiring confirmation auto-allow.
  });
  return runHeadlessTurn(pipeline, opts.prompt, opts.format ?? "text");
}
