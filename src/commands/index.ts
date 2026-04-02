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
      "  /skills   — list available skills",
    ].join("\n"),
  }),
  compact: () => ({ output: "Compaction not yet implemented." }),
  skills: () => ({ output: "No skills loaded." }),
};

/**
 * Register additional command handlers (e.g., from loaded skills).
 * Existing built-in commands cannot be overridden.
 */
export function registerCommands(
  handlers: Record<string, CommandHandler>,
): void {
  for (const [name, handler] of Object.entries(handlers)) {
    if (!(name in commands)) {
      commands[name] = handler;
    }
  }
}

/**
 * Override a specific command handler (e.g., replacing the /skills stub).
 */
export function overrideCommand(name: string, handler: CommandHandler): void {
  commands[name] = handler;
}

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
