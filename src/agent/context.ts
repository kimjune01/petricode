// ── Context assembly ─────────────────────────────────────────────
// Build the system prompt from perceived context fragments.

import type { Content, Message, PerceivedEvent } from "../core/types.js";

/**
 * Assemble system-level context from a perceived event into Message[].
 * Routing is by source field, NOT by text prefix — user input that
 * happens to start with `<context …>` must never escalate to system.
 */
export function assembleContext(perceived: PerceivedEvent): Message[] {
  const systemParts: Content[] = [];
  const userParts: Content[] = [];

  for (const block of perceived.system_content ?? []) {
    if (block.type === "text") systemParts.push(block);
  }

  for (const block of perceived.content) {
    if (block.type === "text") userParts.push(block);
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
