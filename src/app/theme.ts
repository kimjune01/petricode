// ── Semantic color tokens ────────────────────────────────────────
// Single source of truth for TUI colors. Components import from here.

export const colors = {
  /** User input prompt and approval indicators */
  prompt: "green",
  /** User message prefix */
  user: "cyan",
  /** Assistant message prefix */
  assistant: "blue",
  /** Error text */
  error: "red",
  /** Tool calls, confirmations, warnings */
  tool: "yellow",
  /** Reviewer/secondary accent */
  accent: "magenta",
  /** Borders, secondary text, dimmed content */
  muted: "gray",
  /** Inline code in markdown */
  code: "cyan",
  /** Hints, suggestions in error display */
  hint: "gray",
} as const;

export type ColorRole = keyof typeof colors;

/** Spacing scale — terminal character cells */
export const spacing = {
  xs: 0,
  sm: 1,
  md: 2,
  lg: 3,
} as const;
