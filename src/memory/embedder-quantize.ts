/**
 * Phase 115 D-07 — int8 scalar quantization for sqlite-vec vec_memories_v2.
 *
 * Why fixed-range (NOT per-vector) quantization:
 *   sqlite-vec's int8[N] column type computes distances on raw int8 values
 *   directly — it doesn't carry a per-vector scale/offset header. If we used
 *   per-vector min/max scaling, two vectors with different ranges would
 *   compare meaningfully only after dequant — which the native distance
 *   metric does NOT do. The CORRECT pattern (per
 *   https://alexgarcia.xyz/sqlite-vec/guides/scalar-quant.html) is a SHARED
 *   range across all vectors, mapped uniformly to int8 [-128, 127]. Distance
 *   comparisons in int8 space then preserve the original ranking.
 *
 * Why [-1, +1] is the right shared range for our case:
 *   bge-small-en-v1.5 with `pooling: "mean"` + `normalize: true` produces
 *   L2-unit-norm 384-dim vectors. Each component is bounded by
 *   |v[i]| ≤ ||v|| = 1. Empirically the per-component magnitude is much
 *   smaller (~0.05-0.15) but [-1, 1] is the tight theoretical bound and
 *   the natural choice for L2-normalized embeddings. Using [-0.2, 0.2]
 *   would give ~5x finer resolution for typical vectors but wastes the
 *   int8 range when an outlier component approaches ±1. The Phase 115
 *   research perf-caching-retrieval.md §3 reports <2% recall loss at
 *   this configuration on 384-dim normalized embeddings.
 *
 * Storage: 4x reduction (4 bytes/dim float32 → 1 byte/dim int8) =
 *   384*4 = 1536 bytes/vec → 384 bytes/vec. Per Phase 115 D-09 cost
 *   discipline: 11 agents × 30K vectors × 1152 bytes saved ≈ 380MB
 *   storage reduction across the fleet.
 *
 * Recall loss: <2% per perf-caching-retrieval.md §3 at 384-dim
 *   L2-normalized, fixed-range quantization. The `recallLossEstimate`
 *   helper below is exposed for diagnostics; the migration runner can
 *   sample-check recall before transitioning a per-agent state to
 *   `cutover`.
 */

/**
 * Phase 115 D-07 — fixed quantization range. Tied to the
 * L2-unit-norm output of bge-small-en-v1.5 (`normalize: true`).
 * Per-component values are theoretically bounded by ||v|| = 1, so
 * [-1, +1] is the natural shared range across the corpus. DO NOT
 * change without re-running recall regression — both writers AND
 * readers (sqlite-vec native distance) MUST agree on the range.
 */
export const QUANTIZATION_MIN = -1.0;
export const QUANTIZATION_MAX = 1.0;

/** Step size: maps [-1, +1] → [-128, 127] (255 buckets across the int8 range). */
const QUANTIZATION_SCALE = 255 / (QUANTIZATION_MAX - QUANTIZATION_MIN);

/** Dequant inverse step. Used by `dequantizeInt8` for diagnostics. */
const QUANTIZATION_INVERSE_SCALE = (QUANTIZATION_MAX - QUANTIZATION_MIN) / 255;

/**
 * Quantize a Float32Array (one vector) to Int8Array using fixed [-1, +1]
 * → [-128, 127] scaling. Out-of-range values are clamped (rare for
 * L2-normalized embeddings — when it happens the recall loss for that
 * specific dim is bounded by saturation at the int8 endpoint).
 *
 * Phase 115 D-07 — the sqlite-vec native distance metric (cosine via
 * `int8[N] distance_metric=cosine`) operates DIRECTLY on the int8
 * values: callers do NOT need to dequantize on the read path. The
 * `dequantizeInt8` helper below exists only for diagnostic-purpose
 * recall checks during migration validation.
 */
export function quantizeInt8(v: Float32Array): Int8Array {
  const n = v.length;
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    // Clamp to [-1, +1] before scaling so out-of-range values saturate
    // at the int8 endpoint rather than wrapping around.
    let x = v[i];
    if (x < QUANTIZATION_MIN) x = QUANTIZATION_MIN;
    else if (x > QUANTIZATION_MAX) x = QUANTIZATION_MAX;
    // Map [-1, +1] → [0, 255] via scale, then shift to [-128, 127].
    const q = Math.round((x - QUANTIZATION_MIN) * QUANTIZATION_SCALE) - 128;
    // Final clamp belt-and-suspenders: rounding could in principle push
    // boundary values one tick outside Int8Array's range.
    out[i] = q < -128 ? -128 : q > 127 ? 127 : q;
  }
  return out;
}

/**
 * Inverse of `quantizeInt8`. Returns a Float32Array recovered from int8
 * encoding under the fixed [-1, +1] range. Quant error per element is
 * bounded by ½ × QUANTIZATION_INVERSE_SCALE ≈ ±0.0039.
 *
 * NOT used in the read path (sqlite-vec native distance handles int8
 * directly). Exposed for:
 *   - Recall regression tests (compare KNN-on-int8 ranking to
 *     KNN-on-float32 ranking on the same input set).
 *   - Diagnostic CLI inspection (operator-readable post-quant vector,
 *     used rarely but free).
 *   - The migration runner's pre-cutover recall sampler.
 */
export function dequantizeInt8(q: Int8Array): Float32Array {
  const n = q.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (q[i] + 128) * QUANTIZATION_INVERSE_SCALE + QUANTIZATION_MIN;
  }
  return out;
}

/**
 * Recall-loss diagnostic — given two top-K result lists (the same
 * query, one against float32 vectors + one against int8 quantized
 * vectors), returns the fraction of float32 results NOT recovered in
 * the int8 results. 0 = perfect recall; 1 = total recall miss.
 *
 * Used by the migration runner to sample recall before allowing
 * transition to `cutover`. Phase 115 D-07 + research §3 target:
 * `recallLossEstimate < 0.02` at K=10 on 384-dim normalized vectors.
 */
export function recallLossEstimate(
  originalKnn: readonly string[],
  quantizedKnn: readonly string[],
): number {
  if (originalKnn.length === 0) return 0;
  const set = new Set(quantizedKnn);
  let intersection = 0;
  for (const id of originalKnn) {
    if (set.has(id)) intersection++;
  }
  return 1 - intersection / originalKnn.length;
}

/**
 * Convenience helper — convert an Int8Array to a Node Buffer suitable for
 * passing to sqlite-vec via `vec_int8(?)` SQL function. The vec0 driver
 * requires the bytes via the `vec_int8` constructor (a raw Int8Array
 * binding is rejected as a float32 mismatch — see Phase 115 D-07
 * verification log).
 */
export function int8ToBuffer(v: Int8Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
