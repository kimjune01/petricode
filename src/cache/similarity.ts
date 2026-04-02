// Cosine similarity between two sparse TF-IDF vectors (Map<string, number>).

export type SparseVector = Map<string, number>;

export function cosine_similarity(a: SparseVector, b: SparseVector): number {
  let dot = 0;
  let mag_a = 0;
  let mag_b = 0;

  for (const [term, weight] of a) {
    mag_a += weight * weight;
    const bw = b.get(term);
    if (bw !== undefined) {
      dot += weight * bw;
    }
  }

  for (const [, weight] of b) {
    mag_b += weight * weight;
  }

  if (mag_a === 0 || mag_b === 0) return 0;
  return dot / (Math.sqrt(mag_a) * Math.sqrt(mag_b));
}

export function weighted_average(
  a: SparseVector,
  weight_a: number,
  b: SparseVector,
  weight_b: number,
): SparseVector {
  const total = weight_a + weight_b;
  const result: SparseVector = new Map();

  for (const [term, val] of a) {
    result.set(term, (val * weight_a) / total);
  }

  for (const [term, val] of b) {
    const existing = result.get(term) ?? 0;
    result.set(term, existing + (val * weight_b) / total);
  }

  return result;
}
