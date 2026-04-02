import type { Tool } from "./tool.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: "${name}"`);

    // Validate required fields from schema
    const schema = tool.input_schema;
    const required = (schema.required ?? []) as string[];
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        throw new Error(
          `Tool "${name}" missing required argument: "${field}"`
        );
      }
    }

    return tool.execute(args);
  }
}

// ── Default registry with all five tools ────────────────────────

import { ReadFileTool } from "./readFile.js";
import { WriteFileTool } from "./writeFile.js";
import { ShellTool } from "./shell.js";
import { GrepTool } from "./grep.js";
import { GlobTool } from "./glob.js";

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(ReadFileTool);
  registry.register(WriteFileTool);
  registry.register(ShellTool);
  registry.register(GrepTool);
  registry.register(GlobTool);
  return registry;
}
