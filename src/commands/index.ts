// ── Slash commands ───────────────────────────────────────────────

export interface CommandResult {
  output: string;
  exit?: boolean;
}

export type CommandHandler = (args: string) => CommandResult;

// Clear callback — set by App to wire hot zone reset
let clearCallback: (() => void) | null = null;

export function setClearCallback(cb: () => void): void {
  clearCallback = cb;
}

const commands: Record<string, CommandHandler> = {
  exit: () => ({ output: "Goodbye.", exit: true }),
  quit: () => ({ output: "Goodbye.", exit: true }),
  help: () => ({
    output: [
      "Available commands:",
      "  /help         — show this message",
      "  /exit, /quit  — quit petricode",
      "  /clear        — reset conversation (keeps session)",
      "  /compact      — compact conversation history",
      "  /skills       — list available skills",
      "  /consolidate  — extract skills from session history",
      "",
      "Tips:",
      "  @path/to/file — include file contents in prompt",
      "  Ctrl+C        — quit immediately",
      "  q             — quit when input is empty",
    ].join("\n"),
  }),
  clear: () => {
    if (clearCallback) clearCallback();
    return { output: "Conversation cleared." };
  },
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
