// ── Tool interface ───────────────────────────────────────────────

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}
