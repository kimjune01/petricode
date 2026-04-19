// ── Tool execution sub-pipe ──────────────────────────────────────
// Runs each tool call through policy, executes approved ones,
// returns results as Content[].

import type { Content, ToolCall, Turn } from "../core/types.js";
import type { PolicyRule } from "../filter/policy.js";
import { evaluatePolicy } from "../filter/policy.js";
import { LoopDetector } from "../filter/loopDetection.js";
import { maskToolOutput } from "../filter/toolMasking.js";
import { validateToolArgs } from "../filter/pathValidation.js";
import { isDangerousShell } from "../filter/shellDanger.js";
import { rewriteRmToMv } from "../filter/shellRewrite.js";
import type { TriageClassifier, Classification } from "../filter/triageClassifier.js";
import type { ToolRegistry } from "../tools/registry.js";

/**
 * What the user picked at the confirmation prompt.
 * - `"allow"`  → execute the tool with its original args
 * - `"deny"`   → reject; push a DENY result
 * - `"alternative"` → execute with the rewritten args (e.g. mv-to-trash
 *   instead of rm -rf). Only valid when ConfirmFn was passed an
 *   `alternative`; otherwise the caller should treat it as deny.
 */
export type ConfirmDecision = "allow" | "deny" | "alternative";

/**
 * Soft alternative offered alongside a dangerous-shell prompt: a
 * pre-computed safer rewrite the user can pick instead of allow/deny.
 * Currently only emitted for `rm -r*` (mv to /tmp/petricode-trash/).
 */
export interface ConfirmAlternative {
  /** Short, human-readable label for the prompt UI. */
  label: string;
  /** Replacement args for the tool call when the user picks this. */
  args: Record<string, unknown>;
}

export type ConfirmFn = (
  call: ToolCall,
  classification?: Classification,
  alternative?: ConfirmAlternative,
) => Promise<ConfirmDecision>;

export type ClassifiedNotice = (call: ToolCall, c: Classification) => void;

export interface ToolSubpipeOptions {
  registry: ToolRegistry;
  projectDir?: string;
  policyRules?: PolicyRule[];
  loopDetector?: LoopDetector;
  onConfirm?: ConfirmFn;
  signal?: AbortSignal;
  /** Fast-LLM classifier consulted when static policy returns ASK_USER. */
  classifier?: TriageClassifier;
  /** Recent conversation turns fed to the classifier as context. */
  recentTurns?: Turn[];
  /** Called once per classified call so the TUI can render a banner. */
  onClassified?: ClassifiedNotice;
  /**
   * `--permissive` mode opts in here: any shell ALLOW gets re-checked
   * against the dangerous-pattern predicate. Matches escalate to
   * ASK_USER with a synthesized rationale, so the user sees WHY a
   * specific shell call was gated even though the policy says ALLOW.
   */
  permissiveShellGuard?: boolean;
  /**
   * Session ID, used by the soft-delete rewriter to scope its trash
   * directory (`/tmp/petricode-trash/<sessionId>/<ts>/`). Without it
   * the rewriter falls back to no alternative — the prompt still works
   * as plain allow/deny.
   */
  sessionId?: string;
}

export type ToolOutcome = "ALLOW" | "DENY";

export interface ToolResult {
  toolUseId: string;
  name: string;
  outcome: ToolOutcome;
  content: string;
}

const INTERRUPTED_CONTENT = "Interrupted by user — tool call was not executed.";

/**
 * Was this AbortError thrown by runToolSubpipe with a partial result set?
 * Pipeline uses this to recover the actual results of tools that finished
 * before Ctrl+C, instead of synthesizing "Interrupted" for the whole batch.
 */
export function getPartialToolResults(err: unknown): ToolResult[] | undefined {
  if (err instanceof DOMException && err.name === "AbortError") {
    const maybe = (err as DOMException & { partialResults?: ToolResult[] }).partialResults;
    if (Array.isArray(maybe)) return maybe;
  }
  return undefined;
}

function makeAbortWithPartial(results: ToolResult[]): DOMException {
  const err = new DOMException("Aborted", "AbortError");
  Object.defineProperty(err, "partialResults", {
    value: results,
    enumerable: false,
    writable: false,
  });
  return err;
}

function interruptedResult(tc: ToolCall): ToolResult {
  return {
    toolUseId: tc.id,
    name: tc.name,
    outcome: "ALLOW",
    content: INTERRUPTED_CONTENT,
  };
}

/**
 * Thrown when the classifier returned ASK_USER in headless mode — there's
 * no human to confirm with, so the run must halt and surface the
 * rationale to the caller. Headless.ts detects this and exits cleanly.
 *
 * `partialResults` carries any tools that finished BEFORE the escalation
 * so the pipeline can persist them. Without this, a batch like
 * [ALLOW edit, ASK_USER bash] would lose the executed edit from
 * conversation history when bash escalated, leaving the next turn blind
 * to its own side-effects.
 */
export class ClassifierEscalation extends Error {
  readonly toolName: string;
  readonly rationale: string;
  readonly partialResults: ToolResult[];
  /**
   * Plain text the assistant said before invoking the escalated tool.
   * Pipeline fills this in so headless can print the model's
   * explanation alongside the rationale instead of swallowing it.
   */
  assistantText?: string;
  constructor(toolName: string, rationale: string, partialResults: ToolResult[] = []) {
    super(`Classifier requested human review of ${toolName}: ${rationale}`);
    this.name = "ClassifierEscalation";
    this.toolName = toolName;
    this.rationale = rationale;
    this.partialResults = partialResults;
  }
}

/**
 * Process tool calls from an assistant turn through the policy filter,
 * execute approved ones, and return results.
 */
export async function runToolSubpipe(
  turn: Turn,
  options: ToolSubpipeOptions,
): Promise<ToolResult[]> {
  const {
    registry,
    projectDir,
    policyRules = [],
    loopDetector,
    onConfirm,
    signal,
    classifier,
    recentTurns = [],
    onClassified,
    permissiveShellGuard = false,
    sessionId,
  } = options;
  const results: ToolResult[] = [];

  if (!turn.tool_calls || turn.tool_calls.length === 0) {
    return results;
  }

  // Bail BEFORE pre-launching classifier calls. If signal is already
  // aborted at entry (Ctrl+C landed between LLM stream end and sub-pipe
  // start), kicking off classify() would write an "ERROR / classifier
  // unreachable" trace line for every tool — false-positive audit spam
  // when the real story is just "user cancelled the batch".
  if (signal?.aborted) {
    throw makeAbortWithPartial(turn.tool_calls.map(interruptedResult));
  }

  // Tool calls already executed in this batch — fed to the classifier so
  // it can reason about sequences ("edit follows a read of same file →
  // probably safe"). Only includes prior calls in the SAME turn.
  const priorToolCalls: ToolCall[] = [];

  // Defend against LLMs hallucinating two tool calls with the same
  // tool_use_id. Anthropic rejects the next request with a 400 if
  // duplicate IDs come back in tool_results, AND the tool would run
  // twice — both arbitrary side-effects. Synthesize a DENY for the
  // second occurrence so the conversation stays well-formed.
  const seenIds = new Set<string>();

  // Pre-launch classifier calls for every tool whose static policy returns
  // ASK_USER. Without this, a 50-call batch (e.g. parallel grep + reads
  // for context-gathering) ate 50× the classifier latency sequentially,
  // stalling the agent for ~75s. Now they run concurrently and the main
  // loop just awaits the matching promise when it gets to that index.
  //
  // We pass the full batch as `priorToolCalls` instead of the
  // sequentially-executed prefix — the classifier judges intent, not
  // post-hoc execution order, and the LLM emitted all calls in one shot
  // already knowing what it intended.
  //
  // SECURITY: gate kick-off on local checks (path validation) so we
  // don't exfiltrate args to Google for tool calls that would have been
  // denied locally — a malicious `{path: "../../etc/passwd"}` should
  // never leave the machine. Loop detection is intentionally NOT gated
  // here; it depends on prior batch state and may legitimately allow on
  // first sight even when later calls in the batch would loop.
  // `undefined` slot = no classifier OR the call won't reach classification
  // (DENY/ALLOW from static policy, or path-validation failure). Anything
  // that DID kick off resolves to a Classification (fail-closed to ASK_USER
  // on rejection — see .catch below).
  const classifications: (Promise<Classification> | undefined)[] = [];
  if (classifier) {
    const batchPriors: ToolCall[] = turn.tool_calls.slice();
    for (const tc of turn.tool_calls) {
      if (evaluatePolicy(tc.name, policyRules) !== "ASK_USER") {
        classifications.push(undefined);
        continue;
      }
      if (projectDir && validateToolArgs(tc.name, tc.args, projectDir)) {
        // Path validation will deny this in the main loop — don't ship
        // the args to Google.
        classifications.push(undefined);
        continue;
      }
      classifications.push(
        classifier
          .classify(tc, { recentTurns, priorToolCalls: batchPriors }, signal)
          .catch((err): Classification => ({
            // Fail CLOSED to ASK_USER, not undefined — the classifier's
            // own catch returns ASK_USER, but a synchronous throw before
            // its try-block (e.g. argsHash blowing up on a circular ref)
            // would land here. Returning undefined would make the
            // headless escalation guard `verdict === "ASK_USER"` evaluate
            // false, silently auto-executing tools that should have
            // halted the run.
            verdict: "ASK_USER",
            rationale: "[classifier rejected before completion]",
            latency_ms: 0,
            fallback_reason: err instanceof Error ? err.message : String(err),
          })),
      );
    }
  }

  for (let idx = 0; idx < turn.tool_calls.length; idx++) {
    const tc = turn.tool_calls[idx]!;
    if (signal?.aborted) {
      // Synthesize "Interrupted" for this tool + everything after it,
      // preserving the real results already in `results`. The pipeline
      // catches the throw and persists the merged set.
      for (const remaining of turn.tool_calls.slice(idx)) {
        results.push(interruptedResult(remaining));
      }
      throw makeAbortWithPartial(results);
    }
    const toolUseId = tc.id;

    if (seenIds.has(toolUseId)) {
      results.push({
        toolUseId,
        name: tc.name,
        outcome: "DENY",
        content: `Denied: duplicate tool_use_id '${toolUseId}' in batch`,
      });
      continue;
    }
    seenIds.add(toolUseId);

    // Path validation (before policy, before execution)
    if (projectDir) {
      const pathError = validateToolArgs(tc.name, tc.args, projectDir);
      if (pathError) {
        results.push({
          toolUseId,
          name: tc.name,
          outcome: "DENY",
          content: `Denied: ${pathError.message}`,
        });
        continue;
      }
    }

    // Loop detection
    if (loopDetector) {
      const loopCheck = loopDetector.check(tc);
      if (!loopCheck.pass) {
        results.push({
          toolUseId,
          name: tc.name,
          outcome: "DENY",
          content: `Denied: ${loopCheck.reason}`,
        });
        continue;
      }
    }

    // Policy evaluation
    let policyOutcome = evaluatePolicy(tc.name, policyRules);
    // `--permissive` means "auto-allow anything reversible", so when
    // shell would otherwise pass through ALLOW we re-check the actual
    // command against the dangerous-pattern list. Matches promote to
    // ASK_USER with a reason; the reason is shown to the user (TUI) or
    // becomes the DENY message for headless callers (no human to ask).
    let dangerReason: string | undefined;
    if (
      permissiveShellGuard
      && policyOutcome === "ALLOW"
      && tc.name === "shell"
    ) {
      const cmd = (tc.args as { command?: unknown } | undefined)?.command;
      const verdict = isDangerousShell(typeof cmd === "string" ? cmd : "");
      if (verdict.dangerous) {
        policyOutcome = "ASK_USER";
        dangerReason = verdict.reason;
      }
    }

    if (policyOutcome === "DENY") {
      results.push({
        toolUseId,
        name: tc.name,
        outcome: "DENY",
        content: `Denied by policy: ${tc.name}`,
      });
      continue;
    }

    // Headless permissive + dangerous shell: no human to confirm, but
    // the user asked us to gate this. DENY with the reason rather than
    // halting the whole run via ClassifierEscalation — the LLM sees the
    // refusal and can pick a safer approach.
    if (policyOutcome === "ASK_USER" && dangerReason && !onConfirm) {
      results.push({
        toolUseId,
        name: tc.name,
        outcome: "DENY",
        content: `Denied by permissive guard: ${dangerReason}`,
      });
      continue;
    }

    if (policyOutcome === "ASK_USER") {
      // Triage classifier (fast LLM) refines the default. ALLOW skips
      // the user prompt; DENY surfaces the rationale to the model so it
      // can self-correct; ASK_USER falls through to onConfirm with the
      // rationale shown in the prompt. The classify() Promise was
      // already kicked off above so all batch members run in parallel —
      // here we just await this index's slot.
      let classification: Classification | undefined;
      if (classifier) {
        classification = await classifications[idx];
        if (classification && onClassified) {
          try { onClassified(tc, classification); } catch { /* UI errors don't gate execution */ }
        }
      }
      // Surface the danger reason in the confirmation prompt. Synthesize
      // a Classification so ToolConfirmation's existing rationale-render
      // path lights up — without this the user sees a generic prompt and
      // has to guess WHICH part of the command tripped the guard.
      if (dangerReason && !classification) {
        classification = {
          verdict: "ASK_USER",
          rationale: `Permissive guard: ${dangerReason}`,
          latency_ms: 0,
        };
      }

      // After the classifier returned, re-check abort. If the user hit
      // Ctrl+C while Flash was inflight, the classifier's catch-all
      // fail-open returns ASK_USER — without this re-check we'd happily
      // call onConfirm and prompt the user to confirm the very tool
      // they just tried to cancel.
      if (signal?.aborted) {
        for (const remaining of turn.tool_calls.slice(idx)) {
          results.push(interruptedResult(remaining));
        }
        throw makeAbortWithPartial(results);
      }

      if (classification?.verdict === "DENY") {
        results.push({
          toolUseId,
          name: tc.name,
          outcome: "DENY",
          content: `Denied by classifier: ${classification.rationale}`,
        });
        continue;
      }

      // ALLOW skips onConfirm entirely — the user is the safety net via
      // Ctrl+C, watching the banner that onClassified just rendered.
      const needsConfirm = classification?.verdict !== "ALLOW";

      if (needsConfirm && onConfirm) {
        // Offer the soft-delete alternative when the gate fired on an rm
        // recursive pattern AND we have a sessionId to scope the trash
        // dir. The rewriter is strict — multi-target, globs, catastrophic
        // paths, anything with shell metacharacters all return null and
        // we fall back to plain allow/deny. The label gets rendered in
        // the prompt so the user knows where the data goes.
        let alternative: ConfirmAlternative | undefined;
        if (
          dangerReason
          && tc.name === "shell"
          && sessionId
          && /\brm\b/.test(dangerReason)
        ) {
          const cmd = (tc.args as { command?: unknown } | undefined)?.command;
          if (typeof cmd === "string") {
            const rewrite = rewriteRmToMv(cmd, { sessionId });
            if (rewrite) {
              alternative = {
                label: rewrite.label,
                args: { ...tc.args, command: rewrite.rewrittenCmd },
              };
            }
          }
        }
        // Confirmation can throw AbortError if the user Ctrl+C's while the
        // prompt is open. Route it through the same partial-results path
        // as a mid-execution abort — otherwise the unwrapped throw lacks
        // partialResults, the pipeline's getPartialToolResults returns
        // undefined, and every real result accumulated so far in `results`
        // gets clobbered by the empty-fallback in commitToolBatch.
        let decision: ConfirmDecision;
        try {
          decision = await onConfirm(tc, classification, alternative);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            results.push(interruptedResult(tc));
            for (const remaining of turn.tool_calls.slice(idx + 1)) {
              results.push(interruptedResult(remaining));
            }
            throw makeAbortWithPartial(results);
          }
          throw err;
        }
        if (decision === "deny") {
          results.push({
            toolUseId,
            name: tc.name,
            outcome: "DENY",
            content: `Denied by user: ${tc.name}`,
          });
          continue;
        }
        // "alternative" without an offered alternative is a UI bug —
        // fail closed so we don't execute the original (potentially
        // dangerous) call after the user thought they picked the safer
        // form. Treat as deny.
        if (decision === "alternative") {
          if (!alternative) {
            results.push({
              toolUseId,
              name: tc.name,
              outcome: "DENY",
              content: `Denied: alternative was selected but none was offered for ${tc.name}`,
            });
            continue;
          }
          // Mutate the call's args so the executor and the cached
          // tool_use both reflect what actually ran. Without rewriting
          // tc.args, the conversation history would show the LLM
          // requesting `rm -rf foo` even though we ran `mv foo /tmp/...`.
          tc.args = alternative.args;
        }
      }
      // No onConfirm AND classifier escalated (ASK_USER) → no human is
      // available to confirm. Throw a typed escalation so headless.ts
      // can render the rationale and exit cleanly. (Without classifier,
      // we fall through to execute — preserves YOLO headless behavior.)
      // Carry partialResults so the pipeline can persist tools that
      // already executed in this same batch (otherwise they vanish from
      // history and the agent rolls back to before its own side-effects).
      if (!onConfirm && classification?.verdict === "ASK_USER") {
        throw new ClassifierEscalation(tc.name, classification.rationale, [...results]);
      }
    }

    // Execute the tool
    try {
      const rawResult = await registry.execute(tc.name, tc.args, { signal, cwd: projectDir });
      const masked = maskToolOutput(rawResult);
      tc.result = masked.content;
      results.push({
        toolUseId,
        name: tc.name,
        outcome: "ALLOW",
        content: masked.content,
      });
    } catch (err) {
      // Abort: synthesize "Interrupted" for this tool + remaining tools,
      // attach the merged result set to the error, and re-throw. Pipeline
      // uses getPartialToolResults() to recover the real results from
      // tools that finished before Ctrl+C, instead of clobbering them all.
      if (err instanceof DOMException && err.name === "AbortError") {
        results.push(interruptedResult(tc));
        for (const remaining of turn.tool_calls.slice(idx + 1)) {
          results.push(interruptedResult(remaining));
        }
        throw makeAbortWithPartial(results);
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      tc.result = `Error: ${errMsg}`;
      results.push({
        toolUseId,
        name: tc.name,
        outcome: "ALLOW",
        content: `Error: ${errMsg}`,
      });
    }
    priorToolCalls.push(tc);
  }

  return results;
}

/**
 * Convert tool results into Content[] for appending to conversation.
 */
export function toolResultsToContent(results: ToolResult[]): Content[] {
  return results.map((r) => ({
    type: "tool_result" as const,
    tool_use_id: r.toolUseId,
    content: r.content,
  }));
}
