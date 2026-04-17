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
      "  /help         — show this message",
      "  /exit, /quit  — quit petricode",
      "  /clear        — reset conversation (keeps session)",
      "  /compact      — compact conversation history",
      "  /skills       — list available skills",
      "",
      "Tips:",
      "  @path/to/file — include file contents in prompt",
      "  Ctrl+C        — interrupt / quit",
    ].join("\n"),
  }),
  // /clear is intercepted directly in App.tsx so it can reset React state;
  // the stub here is the fallback for headless callers (tests).
  clear: () => ({ output: "Conversation cleared." }),
  // Stubs — App.tsx overrides these via overrideCommand once the pipeline
  // is wired. Kept here so tryCommand returns something useful in headless
  // contexts (tests, scripts) instead of "Unknown command".
  compact: () => ({ output: "Compaction not yet implemented." }),
  skills: () => ({ output: "No skills loaded." }),
  // /consolidate is intentionally not wired yet. Roadmap:
  //   1. Skills authored manually.
  //   2. Meta-skills added on top.
  //   3. Repeated tasks compress into skills via runConsolidate.
  //   4. Repeated skill invocations compose.
  //   5. End state: composite skills like /copyedit get generated and
  //      implemented automagically.
  // The data path (runConsolidate → consolidator) is implemented and
  // tested; only the slash-command registration is held back until the
  // manual-skill phase has produced enough material to compress.
  //
  // Half-baked further layer: a meta-consolidate that watches petricode's
  // own sessions, mines patterns in its tool-use and failure modes, and
  // proposes skills or code edits to itself. Bootstrapping is the open
  // problem — needs enough self-history to mine, plus a sandboxed eval
  // before any auto-apply lands on disk.
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
