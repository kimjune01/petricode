import type { CacheSlot } from "../core/contracts.js";
import type { Turn, ContextFragment, CompactionResult } from "../core/types.js";
import { UnionFindForest } from "./unionFind.js";
import { TfIdfIndex } from "./tfidf.js";
import { graduate, enforce_cap, turn_text, type CompactionConfig } from "./compaction.js";

export interface UnionFindCacheConfig {
  hot_capacity: number;      // ring buffer size (default 10)
  max_clusters: number;      // cold zone cluster cap (default 20)
  merge_threshold: number;   // cosine similarity threshold (default 0.5)
}

const DEFAULT_CONFIG: UnionFindCacheConfig = {
  hot_capacity: 10,
  max_clusters: 20,
  merge_threshold: 0.5,
};

export class UnionFindCache implements CacheSlot {
  private hot: Turn[] = [];
  private forest = new UnionFindForest();
  private index = new TfIdfIndex();
  private config: UnionFindCacheConfig;
  private compaction_config: CompactionConfig;

  // Track compact calls for testing
  compact_count = 0;

  constructor(config?: Partial<UnionFindCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.compaction_config = {
      merge_threshold: this.config.merge_threshold,
      max_clusters: this.config.max_clusters,
    };
  }

  append(turn: Turn): void {
    this.hot.push(turn);

    // Graduate oldest when hot overflows; LRU eviction happens inside graduate()
    while (this.hot.length > this.config.hot_capacity) {
      const oldest = this.hot.shift()!;
      graduate(oldest, this.forest, this.index, this.compaction_config);

      // If the graduated turn declared tool_use blocks, the matching
      // tool_result lives in the very next hot turn (Pipeline always
      // appends the assistant + tool_result pair atomically). Pull
      // that one into cold too — otherwise Anthropic rejects the next
      // call with "tool_result without preceding tool_use".
      const toolUseIds = oldest.content
        .filter((c) => c.type === "tool_use")
        .map((c) => (c as { type: "tool_use"; id: string }).id);
      while (toolUseIds.length > 0 && this.hot[0]) {
        const next = this.hot[0];
        const matchedIds = next.content
          .filter((c) => c.type === "tool_result")
          .map((c) => (c as { type: "tool_result"; tool_use_id: string }).tool_use_id);
        const overlap = matchedIds.some((id) => toolUseIds.includes(id));
        if (!overlap) break;
        this.hot.shift();
        graduate(next, this.forest, this.index, this.compaction_config);
      }
    }
  }

  read(): Turn[] {
    const hot_turns = [...this.hot];
    const cold_summaries = this.cold_summaries();
    // Do NOT update last_accessed here — read() is called every turn,
    // which would give all clusters the same timestamp and defeat LRU.
    // Timestamps are updated only on explicit access via find() or expand().
    return [...cold_summaries, ...hot_turns];
  }

  compact(): CompactionResult {
    this.compact_count++;

    const before = this.token_count();

    // Graduate all but the most recent half of hot turns
    const keep = Math.ceil(this.config.hot_capacity / 2);
    while (this.hot.length > keep) {
      const oldest = this.hot.shift()!;
      graduate(oldest, this.forest, this.index, this.compaction_config);
    }

    // Enforce cluster cap via LRU eviction
    enforce_cap(this.forest, this.config.max_clusters, this.index);

    const after = this.token_count();
    return {
      removed_tokens: Math.max(0, before - after),
      // Fraction of original tokens still present after compaction.
      // 1.0 = no-op; lower = more aggressive compression. 1.0 also when
      // the cache was empty before — preserving "nothing" is trivially
      // total preservation, not a divide-by-zero.
      preserved_pct: before > 0 ? after / before : 1.0,
    };
  }

  // Drop everything: hot ring, cold forest, and the TF-IDF index that
  // backs cluster similarity. Used by /clear so the next turn starts
  // with an empty conversation history (the model otherwise still sees
  // the entire prior session because the UI's setState doesn't touch
  // the cache).
  clear(): void {
    this.hot = [];
    this.forest = new UnionFindForest();
    this.index = new TfIdfIndex();
  }

  token_count(): number {
    let chars = 0;

    // Hot zone
    for (const turn of this.hot) {
      chars += turn_text(turn).length;
    }

    // Cold zone — count cluster summaries, not originals
    for (const root of this.forest.roots()) {
      chars += this.summarize_cluster(root.turns).length;
    }

    return Math.ceil(chars / 4);
  }

  expand(root_id: string): Turn[] {
    // Strip cluster_ prefix so cold summary IDs resolve in the forest
    const id = root_id.startsWith("cluster_") ? root_id.slice(8) : root_id;
    return this.forest.expand(id);
  }

  find(message_id: string): Turn | undefined {
    // Check hot first
    const hot_match = this.hot.find((t) => t.id === message_id);
    if (hot_match) return hot_match;

    // Check cold
    return this.forest.find_turn(message_id);
  }

  // Not implemented for this cache type
  load_context(_path: string): ContextFragment[] {
    return [];
  }

  // ── Private ────────────────────────────────────────────────────

  private cold_summaries(): Turn[] {
    // Sort by timestamp ascending so the model sees cold summaries in
    // chronological order. forest.roots() returns Map-insertion order, which
    // preserves only original add order — once unions happen, that no longer
    // tracks recency, and read() would prepend cold summaries before hot
    // turns with no temporal signal across the boundary.
    return this.forest
      .roots()
      .map((root) => ({
        id: `cluster_${root.id}`,
        role: "system" as const,
        content: [
          {
            type: "text" as const,
            text: this.summarize_cluster(root.turns),
          },
        ],
        timestamp: Math.max(...root.turns.map((t) => t.timestamp)),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  private summarize_cluster(turns: Turn[]): string {
    if (turns.length === 1) {
      return turn_text(turns[0] as Turn);
    }
    const snippets = turns.map(
      (t) => `[${t.role}] ${turn_text(t).slice(0, 100)}`,
    );
    return `Cluster (${turns.length} turns): ${snippets.join(" | ")}`;
  }
}
