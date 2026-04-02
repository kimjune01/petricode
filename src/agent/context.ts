// ── Context assembly ─────────────────────────────────────────────
// Build the system prompt from perceived context fragments.

import type { Content, PerceivedEvent } from "../core/types.js";

/**
 * Assemble system-level context from a perceived event into Content[][].
 * The first entry is the system message (context fragments).
 * The second entry is the user's expanded input.
 */
export function assembleContext(perceived: PerceivedEvent): Content[][] {
  const systemParts: Content[] = [];
  const userParts: Content[] = [];

  for (const block of perceived.content) {
    if (block.type !== "text") continue;

    // Context and skill blocks go into the system message
    if (
      block.text.startsWith("<context ") ||
      block.text.startsWith("<skill ")
    ) {
      systemParts.push(block);
    } else {
      // The expanded user input
      userParts.push(block);
    }
  }

  const messages: Content[][] = [];

  if (systemParts.length > 0) {
    messages.push(systemParts);
  }

  if (userParts.length > 0) {
    messages.push(userParts);
  } else {
    // Fallback: at minimum produce an empty user message
    messages.push([{ type: "text", text: "" }]);
  }

  return messages;
}
