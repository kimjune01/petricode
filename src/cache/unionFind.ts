import type { Turn } from "../core/types.js";
import type { SparseVector } from "./similarity.js";
import { cosine_similarity, weighted_average } from "./similarity.js";

export interface ClusterNode {
  id: string;
  parent: string;          // points to self if root
  rank: number;
  vector: SparseVector;
  turns: Turn[];           // original turns in this node
  last_accessed: number;   // timestamp of last read access (LRU eviction)
  /**
   * TF-IDF document indices for the turns merged into this node. Carried
   * here so eviction can free them from the index — without this the
   * TfIdfIndex.documents array grows unboundedly and IDF skews because
   * evicted docs continue to inflate the corpus count.
   */
  doc_indices: number[];
}

export class UnionFindForest {
  private nodes = new Map<string, ClusterNode>();

  add(id: string, vector: SparseVector, turns: Turn[], doc_indices: number[] = []): void {
    this.nodes.set(id, {
      id,
      parent: id,
      rank: 0,
      vector,
      turns,
      last_accessed: Date.now(),
      doc_indices,
    });
  }

  find(id: string): string {
    const node = this.nodes.get(id);
    if (!node) return id;
    if (node.parent !== id) {
      node.parent = this.find(node.parent); // path compression
    }
    return node.parent;
  }

  union(a_id: string, b_id: string): string {
    const root_a = this.find(a_id);
    const root_b = this.find(b_id);
    if (root_a === root_b) return root_a;

    const a = this.nodes.get(root_a);
    const b = this.nodes.get(root_b);
    if (!a || !b) return a ? root_a : root_b;

    // Merge by rank
    let winner: ClusterNode;
    let loser: ClusterNode;
    if (a.rank >= b.rank) {
      winner = a;
      loser = b;
    } else {
      winner = b;
      loser = a;
    }

    loser.parent = winner.id;
    if (winner.rank === loser.rank) {
      winner.rank++;
    }

    // Weighted-average centroid
    const w_a = winner.turns.length;
    const w_b = loser.turns.length;
    winner.vector = weighted_average(winner.vector, w_a, loser.vector, w_b);
    winner.turns = [...winner.turns, ...loser.turns];
    winner.doc_indices = [...winner.doc_indices, ...loser.doc_indices];
    winner.last_accessed = Math.max(winner.last_accessed, loser.last_accessed);
    loser.turns = []; // C4: prevent stale copies from leaking into find_turn
    loser.doc_indices = [];

    return winner.id;
  }

  roots(): ClusterNode[] {
    const result: ClusterNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.parent === node.id) {
        result.push(node);
      }
    }
    return result;
  }

  root_count(): number {
    return this.roots().length;
  }

  get_node(id: string): ClusterNode | undefined {
    return this.nodes.get(id);
  }

  /** Find the root closest to the given vector. Returns [root_id, similarity]. */
  nearest_root(vector: SparseVector): [string, number] | null {
    const roots = this.roots();
    if (roots.length === 0) return null;

    let best_id = roots[0]!.id;
    let best_sim = cosine_similarity(vector, roots[0]!.vector);

    for (let i = 1; i < roots.length; i++) {
      const sim = cosine_similarity(vector, roots[i]!.vector);
      if (sim > best_sim) {
        best_sim = sim;
        best_id = roots[i]!.id;
      }
    }

    return [best_id, best_sim];
  }

  /** Find the closest pair of roots. Returns [id_a, id_b, similarity]. */
  closest_pair(): [string, string, number] | null {
    const roots = this.roots();
    if (roots.length < 2) return null;

    let best_a = roots[0]!.id;
    let best_b = roots[1]!.id;
    let best_sim = -1;

    for (let i = 0; i < roots.length; i++) {
      for (let j = i + 1; j < roots.length; j++) {
        const sim = cosine_similarity(roots[i]!.vector, roots[j]!.vector);
        if (sim > best_sim) {
          best_sim = sim;
          best_a = roots[i]!.id;
          best_b = roots[j]!.id;
        }
      }
    }

    return [best_a, best_b, best_sim];
  }

  /** Get all turns belonging to the cluster rooted at root_id. */
  expand(root_id: string): Turn[] {
    const root = this.find(root_id);
    const node = this.nodes.get(root);
    if (node) {
      node.last_accessed = Date.now();
      return node.turns;
    }
    return [];
  }

  /**
   * Remove a node and all its children from the forest. Returns the
   * collected doc_indices so the caller can evict them from any
   * associated TF-IDF index.
   */
  remove(id: string): number[] {
    const root = this.find(id);
    // Collect all nodes belonging to this root
    const to_remove: string[] = [];
    const doc_indices: number[] = [];
    for (const [nid, node] of this.nodes) {
      if (this.find(nid) === root) {
        to_remove.push(nid);
        for (const di of node.doc_indices) doc_indices.push(di);
      }
    }
    for (const nid of to_remove) {
      this.nodes.delete(nid);
    }
    return doc_indices;
  }

  /** Find which cluster a turn belongs to and return it. */
  find_turn(message_id: string): Turn | undefined {
    for (const node of this.nodes.values()) {
      for (const turn of node.turns) {
        if (turn.id === message_id) {
          // Update LRU timestamp on the cluster root
          const root_id = this.find(node.id);
          const root_node = this.nodes.get(root_id);
          if (root_node) {
            root_node.last_accessed = Date.now();
          }
          return turn;
        }
      }
    }
    return undefined;
  }
}
