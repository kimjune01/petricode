// ── TUI state ────────────────────────────────────────────────────

import type { Turn, ToolCall } from "../core/types.js";

export type AppPhase = "composing" | "running" | "confirming";

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
    model: "claude-opus-4-7",
    tokenCount: 0,
    error: null,
  };
}
