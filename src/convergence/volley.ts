// ── Volley convergence protocol ──────────────────────────────────
// Primary drafts, reviewer challenges, ≤5 rounds. Converged when
// the reviewer finds no issues.

import type { Provider } from "../providers/provider.js";
import type { Message } from "../core/types.js";

const MAX_ROUNDS = 5;
// Per-call timeout. Without this, a hung provider stream (network
// partition, rate-limit that doesn't surface as an error, provider
// stuck mid-stream) blocks volley indefinitely with no recourse for
// the caller. Consolidator → volley is invoked from /consolidate so
// the user could be staring at a frozen TUI; pick a generous bound.
const PROVIDER_TIMEOUT_MS = 90_000;

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
  prompt: Message[],
): Promise<string> {
  // Race the stream against a timeout. Provider.generate ignores the
  // signal we'd like to plumb through, so we settle for an outer
  // Promise.race — the iterator may keep ticking after timeout, but
  // the awaiter returns and the function above gives up on this call.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`volley: provider stalled after ${PROVIDER_TIMEOUT_MS}ms`)),
      PROVIDER_TIMEOUT_MS,
    );
  });
  const collect = (async () => {
    let text = "";
    for await (const chunk of provider.generate(prompt, { max_tokens: 4096 })) {
      if (chunk.type === "content_delta") {
        text += chunk.text;
      }
    }
    return text;
  })();
  try {
    return await Promise.race([collect, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Build a simple text prompt (single user message).
 */
function userMessage(text: string): Message[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
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
  // Input validation
  if (!artifact || !artifact.trim()) {
    throw new Error("Volley: artifact is empty or whitespace-only");
  }
  if (primary.model_id() === reviewer.model_id()) {
    throw new Error(
      `Volley: primary and reviewer use the same model (${primary.model_id()}). Self-review is an anti-pattern.`,
    );
  }

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

    // Check convergence. Accept "NO_ISSUES" with optional trailing
    // punctuation (LLMs often add `.` or `!`) and any case — strict
    // equality forced extra revision rounds at primary-tier cost when
    // the reviewer was already satisfied.
    if (/^no_issues[.!]?$/i.test(reviewResponse.trim())) {
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

    // Primary revises with only the latest feedback (not accumulated).
    // Feeding all historical findings causes regression — the model tries
    // to fix issues that were already resolved in earlier rounds.
    const latestFinding = findings[findings.length - 1]!;
    const revisePrompt = userMessage(
      `Revise the following artifact based on the reviewer feedback.\n\n` +
      `Reviewer feedback:\n${latestFinding}\n\n` +
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
