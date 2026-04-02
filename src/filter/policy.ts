// ── Policy engine ────────────────────────────────────────────────
// Gate tool execution: ALLOW, DENY, or ASK_USER.

export type PolicyOutcome = "ALLOW" | "DENY" | "ASK_USER";

export interface PolicyRule {
  tool: string; // exact name or "*"
  outcome: PolicyOutcome;
}

// Read-only tools default to ALLOW; everything else ASK_USER.
const READ_TOOLS = new Set(["file_read", "glob", "grep"]);

/**
 * Evaluate a tool name against the policy rule list.
 * First matching rule wins. If no rule matches, apply defaults:
 *   reads → ALLOW, writes/shell → ASK_USER.
 */
export function evaluatePolicy(
  toolName: string,
  rules: PolicyRule[] = [],
): PolicyOutcome {
  for (const rule of rules) {
    if (rule.tool === "*" || rule.tool === toolName) {
      return rule.outcome;
    }
  }
  // Default policy
  return READ_TOOLS.has(toolName) ? "ALLOW" : "ASK_USER";
}
