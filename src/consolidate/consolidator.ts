// ── ConsolidateSlot implementation ───────────────────────────────
// Reads sessions, extracts triples, groups them, generates
// candidate skills, and polishes each through Volley.

import type { ConsolidateSlot } from "../core/contracts.js";
import type { Session, CandidateSkill, DecisionRecord } from "../core/types.js";
import type { Provider } from "../providers/provider.js";
import type { Triple } from "./extractor.js";
import { extractTriples } from "./extractor.js";
import { volley } from "../convergence/volley.js";

export interface ConsolidatorDeps {
  fast: Provider;
  primary: Provider;
  reviewer: Provider;
  listDecisions?: () => Promise<DecisionRecord[]>;
}

/**
 * Simple grouping: triples with overlapping problem keywords are grouped.
 * Uses the fast model for grouping when there are enough triples.
 */
export function groupTriples(triples: Triple[]): Triple[][] {
  if (triples.length === 0) return [];

  // Simple word-overlap similarity grouping
  const groups: Triple[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < triples.length; i++) {
    if (assigned.has(i)) continue;

    const group: Triple[] = [triples[i]!];
    assigned.add(i);

    const wordsI = new Set(
      triples[i]!.problem.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
    );

    for (let j = i + 1; j < triples.length; j++) {
      if (assigned.has(j)) continue;

      const wordsJ = new Set(triples[j]!.problem.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
      let overlap = 0;
      for (const w of wordsJ) { if (wordsI.has(w)) overlap++; }
      const similarity = overlap / Math.max(wordsI.size, wordsJ.size, 1);

      if (similarity >= 0.3) {
        group.push(triples[j]!);
        assigned.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}

/**
 * Generate a candidate skill from a group of triples.
 */
function groupToCandidate(group: Triple[]): CandidateSkill {
  // Name: derived from the most common problem words
  const wordCounts = new Map<string, number>();
  for (const t of group) {
    for (const w of t.problem.toLowerCase().split(/\s+/).filter((w) => w.length > 3)) {
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
  }
  const topWords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
  const name = topWords.join("-") || "extracted-skill";

  // Body: synthesize approach patterns
  const approaches = group.map((t) => `- ${t.approach} (${t.outcome})`);
  const body = [
    `When facing: ${group[0]!.problem}`,
    "",
    "Approaches that worked:",
    ...approaches,
  ].join("\n");

  // Confidence: based on occurrence count
  const confidence = Math.min(group.length / 5, 1.0);

  const sourceSessions = [...new Set(group.map((t) => t.session_id))];

  return {
    name,
    body,
    confidence,
    source_sessions: sourceSessions,
  };
}

/**
 * Create a ConsolidateSlot implementation.
 */
export function createConsolidator(deps: ConsolidatorDeps): ConsolidateSlot {
  const { fast, primary, reviewer, listDecisions } = deps;

  return {
    async run(sessions: Session[]): Promise<CandidateSkill[]> {
      // 1. Extract triples from all sessions
      const allTriples: Triple[] = [];
      const decisions = listDecisions ? await listDecisions() : [];

      for (const session of sessions) {
        const sessionDecisions = decisions.filter(
          (d) => d.subject_ref.includes(session.id),
        );
        const triples = await extractTriples(session, fast, sessionDecisions);
        allTriples.push(...triples);
      }

      if (allTriples.length === 0) return [];

      // 2. Group similar triples
      const groups = groupTriples(allTriples);

      // 3. Generate candidate skills from groups
      const candidates: CandidateSkill[] = [];
      for (const group of groups) {
        const candidate = groupToCandidate(group);

        // 4. Polish each candidate through Volley
        const polished = await volley(
          `Skill name: ${candidate.name}\n\n${candidate.body}`,
          primary,
          reviewer,
        );

        // Parse polished content back — keep name from pre-volley, use polished body
        candidates.push({
          ...candidate,
          body: polished.content,
        });
      }

      return candidates;
    },
  };
}
