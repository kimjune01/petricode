// ── /consolidate command ─────────────────────────────────────────

import type { TransmitSlot, ConsolidateSlot } from "../core/contracts.js";
import type { Session, Turn } from "../core/types.js";
import type { CommandResult } from "./index.js";
import type { ReviewDecision } from "../app/components/ConsolidateReview.js";

export interface ConsolidateCommandDeps {
  transmit: TransmitSlot;
  consolidator: ConsolidateSlot;
}

/**
 * Run consolidation: extract candidates from sessions.
 * Returns candidates for TUI review.
 */
export async function runConsolidate(
  deps: ConsolidateCommandDeps,
): Promise<CommandResult> {
  const summaries = await deps.transmit.list();
  if (summaries.length === 0) {
    return { output: "No sessions to consolidate." };
  }

  // `transmit.list()` returns metadata only — `turns: []`. Hydrate each
  // session via `read()` so the extractor builds a non-empty transcript;
  // otherwise the fast model gets EXTRACTION_PROMPT + "" and returns no
  // triples for every session.
  const sessions: Session[] = await Promise.all(
    summaries.map(async (s) => {
      const events = await deps.transmit.read(s.id);
      const turns: Turn[] = events.map((ev) => ({
        id: crypto.randomUUID(),
        role: ev.role ?? "user",
        content: ev.content,
        timestamp: ev.timestamp,
      }));
      return { ...s, turns };
    }),
  );

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
  transmit: TransmitSlot,
  decisions: ReviewDecision[],
): Promise<string> {
  const approved = decisions.filter((d) => d.action === "approve");
  if (approved.length === 0) {
    return "No skills approved.";
  }

  for (const { candidate } of approved) {
    await transmit.write_skill!({
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
