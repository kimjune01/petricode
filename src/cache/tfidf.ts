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

  add_document(text: string): number {
    const tokens = tokenize(text);
    this.documents.push(tokens);
    this.dirty = true;
    return this.documents.length - 1;
  }

  private recompute_idf(): void {
    if (!this.dirty) return;
    this.idf_cache.clear();
    const n = this.documents.length;
    if (n === 0) return;

    // Count how many documents contain each term
    const doc_freq = new Map<string, number>();
    for (const doc of this.documents) {
      const seen = new Set(doc);
      for (const term of seen) {
        doc_freq.set(term, (doc_freq.get(term) ?? 0) + 1);
      }
    }

    for (const [term, df] of doc_freq) {
      this.idf_cache.set(term, Math.log((n + 1) / (df + 1)) + 1);
    }
    this.dirty = false;
  }

  vectorize(text: string): SparseVector {
    this.recompute_idf();
    const tokens = tokenize(text);
    const tf = term_frequency(tokens);
    const vec: SparseVector = new Map();

    for (const [term, freq] of tf) {
      const idf = this.idf_cache.get(term) ?? Math.log((this.documents.length + 1) / 1) + 1;
      vec.set(term, freq * idf);
    }

    return vec;
  }
}
