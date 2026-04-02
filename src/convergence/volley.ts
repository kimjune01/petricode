// ── Volley convergence protocol ──────────────────────────────────
// Primary drafts, reviewer challenges, ≤5 rounds. Converged when
// the reviewer finds no issues.

import type { Provider } from "../providers/provider.js";
import type { Content } from "../core/types.js";

const MAX_ROUNDS = 5;

export interface ConvergedArtifact {
  content: string;
  rounds: number;
  reviewer_findings: string[];
  converged: boolean;
}

/**
 * Collect the full text response from a provider stream.
 */
async function collectResponse(
  provider: Provider,
  prompt: Content[][],
): Promise<string> {
  let text = "";
  for await (const chunk of provider.generate(prompt, { max_tokens: 4096 })) {
    if (chunk.type === "content_delta") {
      text += chunk.text;
    }
  }
  return text;
}

/**
 * Build a simple text prompt (single user message).
 */
function userMessage(text: string): Content[][] {
  return [[{ type: "text", text }]];
}

/**
 * Run the volley protocol.
 *
 * 1. Primary produces/revises the artifact.
 * 2. Reviewer reads the artifact cold and challenges it.
 * 3. If reviewer finds no issues → converged.
 * 4. Otherwise, primary revises with reviewer feedback.
 * 5. Hard stop at MAX_ROUNDS.
 */
export async function volley(
  artifact: string,
  primary: Provider,
  reviewer: Provider,
): Promise<ConvergedArtifact> {
  let current = artifact;
  const findings: string[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Reviewer reads cold — no history from previous rounds
    const reviewPrompt = userMessage(
      `Review the following artifact. If you find issues, list them concisely. ` +
      `If the artifact is correct and complete, respond with exactly "NO_ISSUES".\n\n` +
      `---\n${current}\n---`,
    );
    const reviewResponse = await collectResponse(reviewer, reviewPrompt);
    findings.push(reviewResponse);

    // Check convergence
    if (reviewResponse.trim() === "NO_ISSUES") {
      return {
        content: current,
        rounds: round,
        reviewer_findings: findings,
        converged: true,
      };
    }

    // If we've hit the limit, stop
    if (round === MAX_ROUNDS) {
      return {
        content: current,
        rounds: round,
        reviewer_findings: findings,
        converged: false,
      };
    }

    // Primary revises with accumulated context
    const revisePrompt = userMessage(
      `Revise the following artifact based on this reviewer feedback.\n\n` +
      `Reviewer feedback:\n${reviewResponse}\n\n` +
      `Current artifact:\n---\n${current}\n---\n\n` +
      `Produce the revised artifact only, no commentary.`,
    );
    current = await collectResponse(primary, revisePrompt);
  }

  // Should not reach here, but just in case
  return {
    content: current,
    rounds: MAX_ROUNDS,
    reviewer_findings: findings,
    converged: false,
  };
}
