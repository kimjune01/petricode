// ── Context assembly ─────────────────────────────────────────────
// Build the system prompt from perceived context fragments.

import type { Content, Message, PerceivedEvent } from "../core/types.js";

/**
 * Assemble system-level context from a perceived event into Message[].
 * System messages carry context/skill blocks; user messages carry the input.
 */
export function assembleContext(perceived: PerceivedEvent): Message[] {
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

  const messages: Message[] = [];

  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts });
  }

  if (userParts.length > 0) {
    messages.push({ role: "user", content: userParts });
  } else {
    // Fallback: at minimum produce an empty user message
    messages.push({ role: "user", content: [{ type: "text", text: "" }] });
  }

  return messages;
}
