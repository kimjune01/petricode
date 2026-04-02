// ── /consolidate command ─────────────────────────────────────────

import type { RememberSlot, ConsolidateSlot } from "../core/contracts.js";
import type { CommandResult } from "./index.js";
import type { ReviewDecision } from "../app/components/ConsolidateReview.js";

export interface ConsolidateCommandDeps {
  remember: RememberSlot;
  consolidator: ConsolidateSlot;
}

/**
 * Run consolidation: extract candidates from sessions.
 * Returns candidates for TUI review.
 */
export async function runConsolidate(
  deps: ConsolidateCommandDeps,
): Promise<CommandResult> {
  const sessions = await deps.remember.list();
  if (sessions.length === 0) {
    return { output: "No sessions to consolidate." };
  }

  const candidates = await deps.consolidator.run(sessions);
  if (candidates.length === 0) {
    return { output: "No candidate skills extracted from sessions." };
  }

  return {
    output: `Found ${candidates.length} candidate skill${candidates.length !== 1 ? "s" : ""}. Opening review...`,
  };
}

/**
 * Write approved skills from review decisions.
 */
export async function writeApproved(
  remember: RememberSlot,
  decisions: ReviewDecision[],
): Promise<string> {
  const approved = decisions.filter((d) => d.action === "approve");
  if (approved.length === 0) {
    return "No skills approved.";
  }

  for (const { candidate } of approved) {
    await remember.write_skill!({
      name: candidate.name,
      body: candidate.body,
      frontmatter: {
        confidence: candidate.confidence,
        source_sessions: candidate.source_sessions,
        generated: true,
      },
      trigger: "manual",
    });
  }

  return `Wrote ${approved.length} skill${approved.length !== 1 ? "s" : ""}.`;
}
