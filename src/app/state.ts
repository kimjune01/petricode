// ── TUI state ────────────────────────────────────────────────────

import type { Turn, ToolCall } from "../core/types.js";

export type AppPhase = "idle" | "composing" | "running" | "confirming";

export interface AppState {
  phase: AppPhase;
  turns: Turn[];
  pendingToolCall: ToolCall | null;
  model: string;
  tokenCount: number;
  error: string | null;
}

export function initialState(): AppState {
  return {
    phase: "composing",
    turns: [],
    pendingToolCall: null,
    model: "claude-sonnet-4-20250514",
    tokenCount: 0,
    error: null,
  };
}
