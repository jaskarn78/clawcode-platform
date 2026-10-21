/**
 * Phase 999.187 — deterministic stand-in for MiniLM used by the recall eval.
 * Hashed bag of crudely-stemmed tokens into 384 dims, L2-normalised. Vector
 * similarity then rewards token overlap, which is enough to exercise every
 * stage of the retrieval pipeline without downloading a model. Never used
 * in production.
 */

const DIM = 384;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function crudeStem(t: string): string {
  return t.replace(/(ing|ed|es|s)$/, "");
}

export async function hashEmbed(text: string): Promise<Float32Array> {
  const v = new Float32Array(DIM);
  const tokens = (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length >= 3)
    .map(crudeStem);
  for (const t of tokens) {
    const h = fnv1a(t);
    v[h % DIM] += 1;
    v[(h >>> 9) % DIM] += 0.5;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i]! * v[i]!;
  if (n === 0) {
    v[0] = 1;
    return v;
  }
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < DIM; i++) v[i]! *= inv;
  return v;
}
