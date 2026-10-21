/**
 * Phase 999.119 v2 switch (2026-09-05) — the one place that knows there are
 * two embedding spaces.
 *
 *   v1 — `Xenova/all-MiniLM-L6-v2`, float32[384], tables `vec_memories` /
 *        `vec_memory_chunks`. Always written.
 *   v2 — `BAAI/bge-small-en-v1.5` + fixed-range int8, tables
 *        `vec_memories_v2` / `vec_memory_chunks_v2`. Written from the
 *        `dual-write` phase on; READ once the agent's migration reaches
 *        `cutover` (see `EmbeddingV2Migrator.currentReadVersion`).
 *
 * The two spaces do not score alike. Measured on production corpora
 * (2026-09-05, four agents, 120 memories + 780 random pairs each):
 *
 *                      random pair p50   nearest neighbour p50
 *   v1 (MiniLM)        0.30 – 0.67       0.92 – 0.93
 *   v2 (bge-small)     0.67 – 0.83       0.95 – 0.97
 *
 * bge-small packs everything into roughly [0.5, 1]; MiniLM spreads it
 * over [0, 1]. Every threshold and weight in this codebase (linker 0.6,
 * graph-walk 0.3, dedup 0.85, the 0.7/0.3 semantic-vs-decay blend) was
 * tuned on the v1 scale. Rather than re-tune each one, v2 similarities
 * are mapped back onto the v1 scale at the store boundary:
 *
 *   sim_v1eq = (sim_v2 - 0.5) / 0.5
 *
 * which sends the measured v2 random-pair medians to 0.34–0.66 and the
 * nearest-neighbour medians to 0.90–0.94 — the v1 numbers within a few
 * hundredths. Distances returned by the store are therefore ALWAYS on the
 * v1 scale, whichever table served them, and no consumer needs to know.
 */

import type { EmbeddingMigrationPhase } from "./migrations/embedding-v2.js";

/** Which vector space a read runs against. */
export type EmbeddingReadVersion = "v1" | "v2";

/**
 * A query embedding tagged with the space it belongs to. `float` on v2 is
 * the pre-quantization vector, kept for in-process cosine (graph walk) so
 * the query side is not quantized twice.
 */
export type QueryVector =
  | Readonly<{ version: "v1"; vector: Float32Array }>
  | Readonly<{ version: "v2"; vector: Int8Array; float: Float32Array }>;

/** Lower edge of the v2 similarity band (empirical, see module doc). */
export const V2_SIMILARITY_FLOOR = 0.5;

/** Phases in which reads are served from the v2 tables. */
const V2_READ_PHASES: ReadonlySet<EmbeddingMigrationPhase> = new Set([
  "cutover",
  "v1-dropped",
]);

/** Phases in which every new memory / chunk also gets a v2 vector. */
export const V2_WRITE_PHASES: ReadonlySet<EmbeddingMigrationPhase> = new Set([
  "dual-write",
  "re-embedding",
  "re-embed-complete",
  "cutover",
  "v1-dropped",
]);

/** Map a migration phase to the space reads run against. */
export function readVersionForPhase(
  phase: EmbeddingMigrationPhase,
): EmbeddingReadVersion {
  return V2_READ_PHASES.has(phase) ? "v2" : "v1";
}

/** True when `x` is a tagged QueryVector rather than a bare v1 Float32Array. */
export function isQueryVector(
  x: Float32Array | QueryVector,
): x is QueryVector {
  return !(x instanceof Float32Array);
}

/** Wrap a bare v1 embedding; pass a QueryVector through unchanged. */
export function toQueryVector(x: Float32Array | QueryVector): QueryVector {
  return isQueryVector(x) ? x : { version: "v1", vector: x };
}

/**
 * Bring a cosine similarity onto the v1 scale. Identity for v1; the
 * empirical affine map for v2 (clamped to [0, 1]).
 */
export function normalizeSimilarity(
  similarity: number,
  version: EmbeddingReadVersion,
): number {
  if (version === "v1") return similarity;
  const mapped = (similarity - V2_SIMILARITY_FLOOR) / (1 - V2_SIMILARITY_FLOOR);
  return mapped < 0 ? 0 : mapped > 1 ? 1 : mapped;
}

/**
 * Bring a sqlite-vec cosine DISTANCE (1 - similarity) onto the v1 scale.
 * Identity for v1.
 */
export function normalizeDistance(
  distance: number,
  version: EmbeddingReadVersion,
): number {
  if (version === "v1") return distance;
  return 1 - normalizeSimilarity(1 - distance, version);
}
