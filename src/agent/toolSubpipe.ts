// ── Tool execution sub-pipe ──────────────────────────────────────
// Runs each tool call through policy, executes approved ones,
// returns results as Content[].

import type { Content, ToolCall, Turn } from "../core/types.js";
import type { PolicyRule } from "../filter/policy.js";
import { evaluatePolicy } from "../filter/policy.js";
import { LoopDetector } from "../filter/loopDetection.js";
import { maskToolOutput } from "../filter/toolMasking.js";
import type { ToolRegistry } from "../tools/registry.js";

export type ConfirmFn = (call: ToolCall) => Promise<boolean>;

export interface ToolSubpipeOptions {
  registry: ToolRegistry;
  policyRules?: PolicyRule[];
  loopDetector?: LoopDetector;
  onConfirm?: ConfirmFn;
}

export type ToolOutcome = "ALLOW" | "DENY";

export interface ToolResult {
  toolUseId: string;
  name: string;
  outcome: ToolOutcome;
  content: string;
}

/**
 * Process tool calls from an assistant turn through the policy filter,
 * execute approved ones, and return results.
 */
export async function runToolSubpipe(
  turn: Turn,
  options: ToolSubpipeOptions,
): Promise<ToolResult[]> {
  const { registry, policyRules = [], loopDetector, onConfirm } = options;
  const results: ToolResult[] = [];

  if (!turn.tool_calls || turn.tool_calls.length === 0) {
    return results;
  }

  for (const tc of turn.tool_calls) {
    const toolUseId = tc.id;

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
      const rawResult = await registry.execute(tc.name, tc.args);
      const masked = maskToolOutput(rawResult);
      tc.result = masked.content;
      results.push({
        toolUseId,
        name: tc.name,
        outcome: "ALLOW",
        content: masked.content,
      });
    } catch (err) {
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
