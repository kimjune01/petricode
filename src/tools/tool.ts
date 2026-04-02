// ── Tool interface ───────────────────────────────────────────────

export interface ToolSchema {
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

export interface Tool {
  name: string;
  description: string;
  input_schema: ToolSchema;
  execute(args: Record<string, unknown>): Promise<string>;
}
