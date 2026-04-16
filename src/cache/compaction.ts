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

/**
 * Extract text content from a turn, including condensed renderings of
 * tool_use and tool_result blocks. Without these, an assistant turn
 * containing only a tool_use produces an empty cluster summary, which
 * leaves the model blind to what was attempted.
 */
export function turn_text(turn: Turn): string {
  return turn.content
    .map((c) => {
      if (c.type === "text") return c.text;
      if (c.type === "tool_use") {
        const argsStr = JSON.stringify(c.input ?? {});
        return `[tool_use ${c.name}(${argsStr.length > 200 ? argsStr.slice(0, 200) + "…" : argsStr})]`;
      }
      if (c.type === "tool_result") {
        const r = c.content;
        return `[tool_result ${r.length > 200 ? r.slice(0, 200) + "…" : r}]`;
      }
      return "";
    })
    .filter((s) => s.length > 0)
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
  const docIdx = index.add_document(text);
  const vector = index.vectorize(text);

  const nearest = forest.nearest_root(vector);

  if (nearest && nearest[1] >= config.merge_threshold) {
    // Merge into existing cluster
    const temp_id = `grad_${turn.id}`;
    forest.add(temp_id, vector, [turn], [docIdx]);
    forest.union(nearest[0], temp_id);
  } else {
    // New singleton cluster
    forest.add(turn.id, vector, [turn], [docIdx]);
  }

  // Enforce hard cap
  enforce_cap(forest, config.max_clusters, index);
}

/**
 * Evict least-recently-used clusters until under the cap.
 *
 * If `index` is provided, also tombstones the evicted documents so
 * TfIdfIndex doesn't grow unbounded across long sessions and IDF
 * weights stay aligned with the live corpus.
 */
export function enforce_cap(
  forest: UnionFindForest,
  max_clusters: number,
  index?: TfIdfIndex,
): void {
  while (forest.root_count() > max_clusters) {
    const roots = forest.roots();
    if (roots.length === 0) break;

    // Find root with oldest last_accessed timestamp (true LRU)
    let lru_root = roots[0]!;
    let lru_ts = lru_root.last_accessed;

    for (let i = 1; i < roots.length; i++) {
      const ts = roots[i]!.last_accessed;
      if (ts < lru_ts) {
        lru_ts = ts;
        lru_root = roots[i]!;
      }
    }

    const evicted = forest.remove(lru_root.id);
    if (index) {
      for (const di of evicted) index.remove_document(di);
    }
  }
}
