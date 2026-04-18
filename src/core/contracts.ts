import type {
  Turn,
  PerceivedEvent,
  RetryableError,
  FilterResult,
  Session,
  Skill,
  CandidateSkill,
  DecisionRecord,
  ContextFragment,
  CompactionResult,
} from "./types.js";

// ── Perceive ──────────────────────────────────────────────────────

export interface PerceiveSlot {
  perceive(raw_input: unknown): Promise<PerceivedEvent | RetryableError>;
}

// ── Cache ─────────────────────────────────────────────────────────

export interface CacheSlot {
  append(turn: Turn): void;
  read(): Turn[];
  compact(): CompactionResult;
  token_count(): number;

  // Extensions (optional — implement when needed)
  expand?(root_id: string): Turn[];
  find?(message_id: string): Turn | undefined;
  load_context?(path: string): ContextFragment[];
}

// ── Filter ────────────────────────────────────────────────────────

export interface FilterSlot {
  filter(subject: unknown): Promise<FilterResult>;
}

// ── Transmit ──────────────────────────────────────────────────────

export interface TransmitSlot {
  append(event: PerceivedEvent): Promise<void>;
  read(session_id: string): Promise<PerceivedEvent[]>;
  list(filter?: Record<string, unknown>): Promise<Session[]>;

  // Extensions (optional — implement when needed)
  prune?(policy: Record<string, unknown>): Promise<number>;
  write_skill?(skill: Skill): Promise<void>;
  read_skills?(): Promise<Skill[]>;
  delete_skill?(name: string): Promise<boolean>;
  append_decision?(session_id: string, record: DecisionRecord): Promise<void>;
  list_decisions?(filter?: Record<string, unknown>): Promise<DecisionRecord[]>;
}

// ── Consolidate ───────────────────────────────────────────────────

export interface ConsolidateSlot {
  run(sessions: Session[]): Promise<CandidateSkill[]>;

  // Extensions (optional — implement when needed)
  classify_frame?(): Promise<string>;
  extract_keyframes?(): Promise<unknown[]>;
  detect_convergence?(): Promise<boolean>;
  rank?(): Promise<CandidateSkill[]>;
}

// ── Slot map (for type-safe container) ────────────────────────────

export interface SlotMap {
  perceive: PerceiveSlot;
  cache: CacheSlot;
  filter: FilterSlot;
  transmit: TransmitSlot;
  consolidate: ConsolidateSlot;
}

export type SlotName = keyof SlotMap;
