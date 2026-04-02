import type { CacheSlot } from "../core/contracts.js";
import type { Turn, ContextFragment } from "../core/types.js";
import { UnionFindForest } from "./unionFind.js";
import { TfIdfIndex } from "./tfidf.js";
import { graduate, turn_text, type CompactionConfig } from "./compaction.js";

export interface UnionFindCacheConfig {
  hot_capacity: number;      // ring buffer size (default 10)
  max_clusters: number;      // cold zone cluster cap (default 20)
  merge_threshold: number;   // cosine similarity threshold (default 0.5)
  token_limit: number;       // auto-compact threshold (default 200000)
}

const DEFAULT_CONFIG: UnionFindCacheConfig = {
  hot_capacity: 10,
  max_clusters: 20,
  merge_threshold: 0.5,
  token_limit: 200000,
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

    // Graduate oldest when hot overflows
    while (this.hot.length > this.config.hot_capacity) {
      const oldest = this.hot.shift()!;
      graduate(oldest, this.forest, this.index, this.compaction_config);
    }

    // Auto-compact when token count exceeds 50% of limit
    if (this.token_count() > this.config.token_limit * 0.5) {
      this.compact();
    }
  }

  read(): Turn[] {
    const hot_turns = [...this.hot];
    const cold_summaries = this.cold_summaries();
    return [...cold_summaries, ...hot_turns];
  }

  compact(): void {
    this.compact_count++;

    // Graduate all but the most recent half of hot turns
    const keep = Math.ceil(this.config.hot_capacity / 2);
    while (this.hot.length > keep) {
      const oldest = this.hot.shift()!;
      graduate(oldest, this.forest, this.index, this.compaction_config);
    }
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
    return this.forest.roots().map((root) => ({
      id: `cluster_${root.id}`,
      role: "system" as const,
      content: [
        {
          type: "text" as const,
          text: this.summarize_cluster(root.turns),
        },
      ],
      timestamp: Math.max(...root.turns.map((t) => t.timestamp)),
    }));
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
