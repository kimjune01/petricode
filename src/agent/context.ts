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
    // Skip empty-text blocks so a headless caller passing "" doesn't
    // produce a `text: ""` content block — Anthropic's API rejects
    // empty text fields, OpenAI/Google merely litter the history.
    if (block.type === "text" && block.text.length > 0) userParts.push(block);
  }

  const messages: Message[] = [];

  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts });
  }

  if (userParts.length > 0) {
    messages.push({ role: "user", content: userParts });
  } else {
    // Fallback: producers must emit at least one user message. Use a
    // non-empty placeholder — Anthropic rejects `text: ""`, and silent
    // empty-text blocks are user-hostile even on lenient providers.
    messages.push({ role: "user", content: [{ type: "text", text: "(no input)" }] });
  }

  return messages;
}
