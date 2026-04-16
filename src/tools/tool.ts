// ── Tool interface ───────────────────────────────────────────────

export interface ToolSchema {
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

export interface ToolExecuteOptions {
  signal?: AbortSignal;
  /**
   * Project root. Tools that operate on the filesystem should default
   * their working directory to this rather than process.cwd() — otherwise
   * a stray launch from the user's home directory lets the LLM scan
   * unrelated files.
   */
  cwd?: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: ToolSchema;
  execute(args: Record<string, unknown>, opts?: ToolExecuteOptions): Promise<string>;
}
