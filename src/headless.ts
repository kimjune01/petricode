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
import { ClassifierEscalation } from "./agent/toolSubpipe.js";

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
  // Resolved session ID — present when bootstrap succeeded. cli.ts uses
  // this to write the sticky-session token back to --session-file.
  sessionId?: string;
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
    // Classifier escalated to human review but we have no human (headless).
    // Exit 2 with the rationale so callers can distinguish "needs review"
    // from a generic error and route accordingly (e.g. CI re-runs in TUI).
    if (err instanceof ClassifierEscalation) {
      // Surface the assistant's prose on stdout so callers piping output
      // still see the model's reasoning. Rationale + tool name go to
      // stderr alongside exit 2 so scripts can distinguish "needs human"
      // from "real error" without parsing stdout.
      // Honor --format json so machine-readable callers still get
      // structured output instead of a hardcoded plaintext stream.
      const assistant = err.assistantText ?? "";
      // Include partial_results in JSON so machine callers can tell
      // which tools in the batch already executed before the escalation.
      // Without this, a CI runner gets the escalation signal but is
      // blind to mutations the earlier tools already made.
      const stdout = format === "json"
        ? JSON.stringify({
            kind: "classifier_escalation",
            tool: err.toolName,
            rationale: err.rationale,
            assistant_text: assistant,
            partial_results: err.partialResults,
          }) + "\n"
        : (assistant ? assistant + (assistant.endsWith("\n") ? "" : "\n") : "");
      // Surface DENY-outcome partials on stderr too — those represent
      // tools whose execution failed (the result is the error message).
      // In plaintext mode the operator would otherwise miss them
      // entirely, then wonder why the next turn references state that
      // never landed.
      const failed = err.partialResults.filter((r) => r.outcome === "DENY");
      const failureNote = failed.length > 0
        ? failed.map((r) => `petricode: tool ${r.name} failed before escalation: ${r.content}\n`).join("")
        : "";
      return {
        exitCode: 2,
        stdout,
        stderr: failureNote + `petricode: classifier requested human review of ${err.toolName}: ${err.rationale}\n`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: "", stderr: `petricode: ${msg}\n` };
  }
}

/**
 * Promise wrapper around stream.write so callers can `await` before
 * `process.exit`. Without this, `process.exit` cuts the pipe before the
 * kernel finishes draining stdout — large `--format json` payloads get
 * truncated when piped into a downstream process.
 */
export function writeAndDrain(
  stream: NodeJS.WriteStream,
  chunk: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/** Bootstrap a pipeline from disk config and run one turn against it. */
export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  // Bootstrap can throw on bad config, missing creds, or an invalid
  // --resume session ID. Surface those as a clean stderr message + exit
  // 1, not as an unhandledRejection that hits cli.ts's crash logger and
  // tells the user "Crash logged to .petricode/crash.log" with no hint
  // of what actually went wrong.
  let pipeline;
  let sessionId: string;
  try {
    const { bootstrap } = await import("./session/bootstrap.js");
    const result = await bootstrap({
      projectDir: opts.projectDir,
      resumeSessionId: opts.resumeSessionId,
      headless: true,
      // No onConfirm — tools requiring confirmation auto-allow (or
      // escalate via ClassifierEscalation when the classifier is on).
    });
    pipeline = result.pipeline;
    sessionId = result.sessionId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: "", stderr: `petricode: ${msg}\n` };
  }
  const turnResult = await runHeadlessTurn(pipeline, opts.prompt, opts.format ?? "text");
  // Drain trace appends BEFORE returning. cli.ts goes straight to
  // process.exit after this — without flush, in-flight audit writes for
  // the just-finished batch get killed mid-syscall and the trace log
  // misses entries.
  await pipeline.flush().catch(() => undefined);
  return { ...turnResult, sessionId };
}
