// ── Tool execution sub-pipe ──────────────────────────────────────
// Runs each tool call through policy, executes approved ones,
// returns results as Content[].

import type { Content, ToolCall, Turn } from "../core/types.js";
import type { PolicyRule } from "../filter/policy.js";
import { evaluatePolicy } from "../filter/policy.js";
import { LoopDetector } from "../filter/loopDetection.js";
import { maskToolOutput } from "../filter/toolMasking.js";
import { validateToolArgs } from "../filter/pathValidation.js";
import type { ToolRegistry } from "../tools/registry.js";

export type ConfirmFn = (call: ToolCall) => Promise<boolean>;

export interface ToolSubpipeOptions {
  registry: ToolRegistry;
  projectDir?: string;
  policyRules?: PolicyRule[];
  loopDetector?: LoopDetector;
  onConfirm?: ConfirmFn;
  signal?: AbortSignal;
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
 * Process tool calls from an assistant turn through the policy filter,
 * execute approved ones, and return results.
 */
export async function runToolSubpipe(
  turn: Turn,
  options: ToolSubpipeOptions,
): Promise<ToolResult[]> {
  const { registry, projectDir, policyRules = [], loopDetector, onConfirm, signal } = options;
  const results: ToolResult[] = [];

  if (!turn.tool_calls || turn.tool_calls.length === 0) {
    return results;
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
    const policyOutcome = evaluatePolicy(tc.name, policyRules);

    if (policyOutcome === "DENY") {
      results.push({
        toolUseId,
        name: tc.name,
        outcome: "DENY",
        content: `Denied by policy: ${tc.name}`,
      });
      continue;
    }

    if (policyOutcome === "ASK_USER") {
      if (onConfirm) {
        const allowed = await onConfirm(tc);
        if (!allowed) {
          results.push({
            toolUseId,
            name: tc.name,
            outcome: "DENY",
            content: `Denied by user: ${tc.name}`,
          });
          continue;
        }
      }
      // If no onConfirm handler, fall through to execute (headless mode)
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
