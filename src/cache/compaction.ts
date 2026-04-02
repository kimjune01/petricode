import type { Turn } from "../core/types.js";
import { UnionFindForest } from "./unionFind.js";
import { TfIdfIndex } from "./tfidf.js";

export interface CompactionConfig {
  merge_threshold: number;  // cosine similarity threshold for merging (default 0.5)
  max_clusters: number;     // hard cap on cluster count (default 20)
}

const DEFAULT_CONFIG: CompactionConfig = {
  merge_threshold: 0.5,
  max_clusters: 20,
};

/** Extract text content from a turn. */
export function turn_text(turn: Turn): string {
  return turn.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ");
}

/**
 * Graduate a turn into the cold zone.
 * Computes TF-IDF vector, finds nearest cluster, merges or creates new.
 */
export function graduate(
  turn: Turn,
  forest: UnionFindForest,
  index: TfIdfIndex,
  config: CompactionConfig = DEFAULT_CONFIG,
): void {
  const text = turn_text(turn);
  index.add_document(text);
  const vector = index.vectorize(text);

  const nearest = forest.nearest_root(vector);

  if (nearest && nearest[1] >= config.merge_threshold) {
    // Merge into existing cluster
    const temp_id = `grad_${turn.id}`;
    forest.add(temp_id, vector, [turn]);
    forest.union(nearest[0], temp_id);
  } else {
    // New singleton cluster
    forest.add(turn.id, vector, [turn]);
  }

  // Enforce hard cap
  enforce_cap(forest, config.max_clusters);
}

/** Evict least-recently-used clusters until under the cap. */
export function enforce_cap(
  forest: UnionFindForest,
  max_clusters: number,
): void {
  while (forest.root_count() > max_clusters) {
    const roots = forest.roots();
    if (roots.length === 0) break;

    // Find root with oldest max timestamp (LRU)
    let lru_root = roots[0]!;
    let lru_ts = Math.max(...lru_root.turns.map((t) => t.timestamp));

    for (let i = 1; i < roots.length; i++) {
      const ts = Math.max(...roots[i]!.turns.map((t) => t.timestamp));
      if (ts < lru_ts) {
        lru_ts = ts;
        lru_root = roots[i]!;
      }
    }

    forest.remove(lru_root.id);
  }
}
