import type { Turn } from "../core/types.js";
import type { FilterResult } from "../core/types.js";

/**
 * Reject turns with empty or whitespace-only text content.
 */
export function validateContent(turn: Turn): FilterResult {
  const textParts = turn.content.filter((c) => c.type === "text");
  if (textParts.length === 0) {
    return { pass: false, reason: "Turn has no text content" };
  }
  const allWhitespace = textParts.every(
    (c) => c.type === "text" && c.text.trim() === "",
  );
  if (allWhitespace) {
    return { pass: false, reason: "Turn text is empty or whitespace-only" };
  }
  return { pass: true };
}
