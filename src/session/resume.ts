// ── Session resume ──────────────────────────────────────────────
// Load a prior session's turns back into the pipeline cache.

import type { Session, Turn } from "../core/types.js";
import type { RememberSlot } from "../core/contracts.js";
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
  remember: RememberSlot,
  cache: UnionFindCache,
): Promise<ResumeResult> {
  const events = await remember.read(sessionId);

  if (events.length === 0) {
    throw new Error(`Session '${sessionId}' not found or has no turns`);
  }

  let turnCount = 0;
  for (const event of events) {
    const turn: Turn = {
      id: crypto.randomUUID(),
      role: "user", // events don't store role, infer from position
      content: event.content,
      timestamp: event.timestamp,
    };
    cache.append(turn);
    turnCount++;
  }

  return { sessionId, turnCount };
}

/**
 * List recent sessions from the remember slot.
 */
export async function listSessions(
  remember: RememberSlot,
  limit: number = 10,
): Promise<Session[]> {
  return remember.list({ limit });
}

/**
 * Find the most recent session for a given project directory.
 * Returns null if no sessions exist.
 */
export async function lastSession(
  remember: RememberSlot,
): Promise<Session | null> {
  const sessions = await remember.list({ limit: 1 });
  return sessions[0] ?? null;
}
