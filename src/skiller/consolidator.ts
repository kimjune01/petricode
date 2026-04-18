// ── Skiller / Consolidator ──────────────────────────────────────
// Final rewrite step in the skiller sub-pipeline: take an activated
// skill body and substitute $ARGUMENTS with the captured argument
// string. Result is the trusted text that downstream Transmit injects
// as system content (skill-as-prompt) or as a tool result (Skill tool).

/**
 * Substitute $ARGUMENTS in skill body with the provided arguments string.
 */
export function substituteArguments(body: string, args: string): string {
  // Use split/join instead of replace to prevent $-token evaluation in args
  return body.split("$ARGUMENTS").join(args);
}
