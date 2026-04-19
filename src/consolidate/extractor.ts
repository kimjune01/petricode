// ── Triple extraction from sessions ─────────────────────────────
// Feeds session turns to the fast model to extract
// problem → approach → outcome triples.

import type { Provider } from "../providers/provider.js";
import type { Message, Session, StreamChunk, DecisionRecord } from "../core/types.js";

export interface Triple {
  problem: string;
  approach: string;
  outcome: string;
  session_id: string;
}

/**
 * Collect full text from a provider stream.
 */
async function collect(provider: Provider, prompt: Message[]): Promise<string> {
  let text = "";
  for await (const chunk of provider.generate(prompt, { max_tokens: 4096 })) {
    if (chunk.type === "content_delta") {
      text += chunk.text;
    }
  }
  return text;
}

/**
 * Build a single user message.
 */
function userMsg(text: string): Message[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

/**
 * Turn a session's text turns into a flat transcript string.
 */
function sessionToTranscript(session: Session): string {
  return session.turns
    .map((t) => {
      const texts = t.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text);
      return `[${t.role}] ${texts.join(" ")}`;
    })
    .join("\n");
}

/**
 * Parse the model's response into triples.
 * Expects lines in the format: PROBLEM: ... | APPROACH: ... | OUTCOME: ...
 */
export function parseTriples(raw: string, sessionId: string): Triple[] {
  const triples: Triple[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Greedy `(.+)` for PROBLEM and APPROACH so a `|` inside the
    // free-form text doesn't bisect the line and silently drop the
    // whole triple. The APPROACH/OUTCOME keywords are anchored, so
    // greedy matching still terminates correctly — the regex consumes
    // up to the rightmost `| APPROACH:` and `| OUTCOME:`.
    const problemMatch = trimmed.match(/PROBLEM:\s*(.+)\s*\|\s*APPROACH:\s*(.+)\s*\|\s*OUTCOME:\s*(.+)/i);
    if (problemMatch) {
      triples.push({
        problem: problemMatch[1]!.trim(),
        approach: problemMatch[2]!.trim(),
        outcome: problemMatch[3]!.trim(),
        session_id: sessionId,
      });
    }
  }
  return triples;
}

const EXTRACTION_PROMPT = `Extract problem→approach→outcome patterns from this session transcript.
Return each pattern on its own line in this exact format:
PROBLEM: <description> | APPROACH: <what was tried> | OUTCOME: <result>

If no clear patterns exist, return nothing.

Transcript:
`;

/**
 * Extract triples from a single session using the fast model.
 */
export async function extractTriples(
  session: Session,
  fast: Provider,
  decisions?: DecisionRecord[],
): Promise<Triple[]> {
  let transcript = sessionToTranscript(session);

  // Enrich with decision records if available
  if (decisions && decisions.length > 0) {
    const decisionBlock = decisions
      .map((d) => `Decision: ${d.decision_type} — ${d.problem_frame} → ${d.outcome_ref}`)
      .join("\n");
    transcript += `\n\nDecision records:\n${decisionBlock}`;
  }

  const response = await collect(fast, userMsg(EXTRACTION_PROMPT + transcript));
  return parseTriples(response, session.id);
}
