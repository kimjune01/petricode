// ── Session resume ──────────────────────────────────────────────
// Load a prior session's turns back into the pipeline cache.

import type { Session, Turn } from "../core/types.js";
import type { TransmitSlot } from "../core/contracts.js";
import type { UnionFindCache } from "../cache/cache.js";

export interface ResumeResult {
  sessionId: string;
  turnCount: number;
}

/**
 * Resume a session by replaying its turns into the cache.
 * Rebuilds the union-find from persisted turns.
 */
export async function resumeSession(
  sessionId: string,
  transmit: TransmitSlot,
  cache: UnionFindCache,
): Promise<ResumeResult> {
  const events = await transmit.read(sessionId);

  if (events.length === 0) {
    throw new Error(`Session '${sessionId}' not found or has no turns`);
  }

  let turnCount = 0;
  for (const event of events) {
    const turn: Turn = {
      id: crypto.randomUUID(),
      role: event.role ?? "user",
      content: event.content,
      timestamp: event.timestamp,
    };
    cache.append(turn);
    turnCount++;
  }

  return { sessionId, turnCount };
}

/**
 * List recent sessions from the transmit slot.
 */
export async function listSessions(
  transmit: TransmitSlot,
  limit: number = 10,
): Promise<Session[]> {
  return transmit.list({ limit });
}

/**
 * Find the most recent session for a given project directory.
 * Returns null if no sessions exist.
 */
export async function lastSession(
  transmit: TransmitSlot,
): Promise<Session | null> {
  const sessions = await transmit.list({ limit: 1 });
  return sessions[0] ?? null;
}
