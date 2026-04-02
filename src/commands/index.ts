// ── Slash commands ───────────────────────────────────────────────

export interface CommandResult {
  output: string;
  exit?: boolean;
}

export type CommandHandler = (args: string) => CommandResult;

const commands: Record<string, CommandHandler> = {
  exit: () => ({ output: "Goodbye.", exit: true }),
  quit: () => ({ output: "Goodbye.", exit: true }),
  help: () => ({
    output: [
      "Available commands:",
      "  /help     — show this message",
      "  /exit     — quit petricode",
      "  /compact  — compact conversation history (stub)",
      "  /skills   — list available skills (stub)",
    ].join("\n"),
  }),
  compact: () => ({ output: "Compaction not yet implemented." }),
  skills: () => ({ output: "No skills loaded." }),
};

/**
 * Try to parse and execute a slash command. Returns null if the input
 * is not a slash command.
 */
export function tryCommand(input: string): CommandResult | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  const handler = commands[name];
  if (!handler) {
    return { output: `Unknown command: /${name}. Type /help for a list.` };
  }

  return handler(args);
}
