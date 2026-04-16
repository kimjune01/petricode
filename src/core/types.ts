// ── Content types ─────────────────────────────────────────────────

export type Content =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type StreamChunk =
  | { type: "content_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string; index?: number }
  | { type: "tool_use_delta"; input_json: string; index?: number }
  | { type: "done" };

// ── Message (prompt-level wrapper with explicit role) ────────────

export interface Message {
  role: "user" | "assistant" | "system";
  content: Content[];
}

// ── Core domain ───────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

export interface Turn {
  id: string;
  role: "user" | "assistant" | "system";
  content: Content[];
  tool_calls?: ToolCall[];
  timestamp: number;
}

export interface Session {
  id: string;
  turns: Turn[];
  metadata: Record<string, unknown>;
}

// ── Perceive output ───────────────────────────────────────────────

export interface PerceivedEvent {
  kind: "perceived";
  source: string;
  content: Content[];
  /**
   * Trusted blocks that should be routed to the system role (context
   * fragments, skill bodies). Kept separate from `content` so user input
   * can never be lifted into the system role by spoofing a leading XML
   * tag — routing is by source field, not by text prefix.
   */
  system_content?: Content[];
  timestamp: number;
  role?: "user" | "assistant" | "system";
}

// ── Filter output ─────────────────────────────────────────────────

export type FilterResult =
  | { pass: true }
  | { pass: false; reason: string };

// ── Context ───────────────────────────────────────────────────────

export interface ContextFragment {
  source: string;
  content: string;
  relevance: number;
}

// ── Skills ────────────────────────────────────────────────────────

export interface Skill {
  name: string;
  body: string;
  frontmatter: Record<string, unknown>;
  trigger: "slash_command" | "auto" | "manual";
}

export interface CandidateSkill {
  name: string;
  body: string;
  confidence: number;
  source_sessions: string[];
}

// ── Decisions ─────────────────────────────────────────────────────

export interface DecisionRecord {
  decision_type: string;
  subject_ref: string;
  presented_context: ContextFragment[];
  problem_frame: string;
  outcome_ref: string;
}

// ── Errors ────────────────────────────────────────────────────────

export interface RetryableError {
  kind: "retryable";
  message: string;
  retry_after_ms?: number;
}
