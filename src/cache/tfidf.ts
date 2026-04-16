import type { SparseVector } from "./similarity.js";

// Simple TF-IDF: tokenize on word boundaries, compute term frequency,
// scale by inverse document frequency from the corpus.

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\b\w+\b/g) ?? [];
}

function term_frequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  // Normalize by document length
  for (const [term, count] of tf) {
    tf.set(term, count / tokens.length);
  }
  return tf;
}

export class TfIdfIndex {
  // Each document is stored as its raw tokens for IDF recalculation
  private documents: string[][] = [];
  private idf_cache: Map<string, number> = new Map();
  private dirty = true;
  private live_n = 0;

  add_document(text: string): number {
    const tokens = tokenize(text);
    this.documents.push(tokens);
    this.dirty = true;
    return this.documents.length - 1;
  }

  /** Remove a document by index. Prevents unbounded growth when clusters are evicted. */
  remove_document(index: number): void {
    if (index >= 0 && index < this.documents.length) {
      this.documents[index] = []; // tombstone — preserves index stability
      this.dirty = true;
    }
  }

  /** Current document count for bookkeeping. */
  document_count(): number {
    return this.documents.length;
  }

  /** Count of documents that haven't been tombstoned. */
  live_document_count(): number {
    let n = 0;
    for (const doc of this.documents) {
      if (doc.length > 0) n++;
    }
    return n;
  }

  private recompute_idf(): void {
    if (!this.dirty) return;
    this.idf_cache.clear();

    // Count both n (live docs) and doc_freq from the same scan, skipping
    // tombstones. Using documents.length (which still counts tombstones)
    // would inflate n relative to df and over-weight every IDF as evictions
    // pile up across a long session.
    const doc_freq = new Map<string, number>();
    let n = 0;
    for (const doc of this.documents) {
      if (doc.length === 0) continue;
      n++;
      const seen = new Set(doc);
      for (const term of seen) {
        doc_freq.set(term, (doc_freq.get(term) ?? 0) + 1);
      }
    }
    if (n === 0) return;

    for (const [term, df] of doc_freq) {
      this.idf_cache.set(term, Math.log((n + 1) / (df + 1)) + 1);
    }
    this.live_n = n;
    this.dirty = false;
  }

  vectorize(text: string): SparseVector {
    this.recompute_idf();
    const tokens = tokenize(text);
    const tf = term_frequency(tokens);
    const vec: SparseVector = new Map();

    for (const [term, freq] of tf) {
      const idf = this.idf_cache.get(term) ?? Math.log((this.live_n + 1) / 1) + 1;
      vec.set(term, freq * idf);
    }

    return vec;
  }
}
