import { EmbeddingError } from "./errors.js";

/**
 * Phase 115 D-06 — bge-small-en-v1.5 ONNX embedder.
 *
 * Locked model id (D-06): `BAAI/bge-small-en-v1.5`. Reasons (per
 * .planning/research/115-memory-redesign/perf-caching-retrieval.md §3
 * + sota-synthesis.md §2.1):
 *   - 5-7 MTEB points over MiniLM-L6 (~56 → ~64).
 *   - Same 384-dim native — drop-in storage compatible (no MRL truncation
 *     needed for the default path; Phase 115 keeps 384-dim).
 *   - Apache 2.0, ONNX path proven in `@huggingface/transformers`.
 *   - ~33MB download, mean-pooled + L2-normalized retrieval setup is the
 *     model's documented recommended configuration.
 *
 * Provided as a SEPARATE FILE (not folded into embedder.ts) so the v1
 * (MiniLM) path stays bit-identical for the dual-write transition window
 * (D-08). EmbeddingService dispatcher in embedder.ts routes embedV1 →
 * MiniLM and embedV2 → this module.
 *
 * Pipeline / pooling / normalize choices match the bge-small-en-v1.5
 * documented retrieval setup:
 *   - pooling: "mean"      — model produces per-token reps; mean-pool to
 *                            a single vector for retrieval.
 *   - normalize: true      — L2-normalize for cosine-similarity-as-dot
 *                            (sqlite-vec int8 distance_metric=cosine).
 *
 * Truncation discipline: 200-word soft cap matches MiniLM's existing
 * `MAX_WORDS = 200` discipline in embedder.ts so a v1→v2 dual-write
 * pair embeds the same input substring (otherwise dual-write would
 * compare tail-truncated v1 against full-text v2 and recall comparisons
 * would lie).
 */

/**
 * The FeatureExtractionPipeline shape from @huggingface/transformers.
 * Defined locally to avoid a top-level import (lazy-loaded in warmup()
 * matches the embedder.ts pattern).
 */
type FeatureExtractionPipeline = (
  text: string,
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{
  tolist?(): number[][];
  data?: Float32Array | number[];
}>;

/** Phase 115 D-06 — model id locked. Pinned by static-grep regression test. */
export const BGE_SMALL_MODEL_ID = "BAAI/bge-small-en-v1.5";

/** Phase 115 D-06 — native dim. Same as MiniLM (no MRL truncation needed). */
export const BGE_SMALL_DIM = 384;

/** Soft-truncation cap matching MiniLM's MAX_WORDS for dual-write parity. */
const MAX_WORDS = 200;

/**
 * Singleton-style holder so warmup() is idempotent across the daemon
 * lifetime. Mirrors EmbeddingService's holder pattern in embedder.ts but
 * scoped to v2-only state — a shared holder would cross-contaminate the
 * v1 + v2 lazy-init paths during dual-write.
 */
let _pipeline: FeatureExtractionPipeline | null = null;
let _warmPromise: Promise<void> | null = null;

/**
 * Pre-warm the bge-small ONNX pipeline. Idempotent (only downloads once).
 * Call at daemon startup AFTER v1 warmup to avoid first-turn latency
 * during dual-write phase. ~33MB download cached at
 * `~/.cache/huggingface` on first run.
 */
export async function warmupBgeSmall(): Promise<void> {
  if (_pipeline) return;
  if (_warmPromise) return _warmPromise;
  _warmPromise = (async () => {
    try {
      const { pipeline } = await import("@huggingface/transformers");
      _pipeline = (await pipeline(
        "feature-extraction",
        BGE_SMALL_MODEL_ID,
        { dtype: "fp32" },
      )) as unknown as FeatureExtractionPipeline;
    } catch (error) {
      _warmPromise = null;
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new EmbeddingError(
        `Failed to warm up bge-small embedding model: ${message}`,
      );
    }
  })();
  return _warmPromise;
}

/**
 * Embed `text` to a 384-dim Float32Array using bge-small-en-v1.5.
 * Auto-warms on first call. Truncates input to 200 words (MAX_WORDS) to
 * stay within the model's 512-token context and to match the v1 MiniLM
 * truncation discipline so dual-write pairs embed the same substring.
 *
 * Output is mean-pooled + L2-normalized — operator can directly feed
 * into sqlite-vec cosine-distance MATCH or dot-product downstream.
 */
export async function embedBgeSmall(text: string): Promise<Float32Array> {
  try {
    if (!_pipeline) {
      await warmupBgeSmall();
    }
    const truncated = truncateText(text);
    const out = await _pipeline!(truncated, {
      pooling: "mean",
      normalize: true,
    });

    // Two output shapes are emitted by @huggingface/transformers depending
    // on version + pipeline config: `.tolist()` for the Tensor object path
    // (legacy / v3) and a plain `.data` Float32Array on the v4 fast path.
    // Both are real call paths in embedder.ts callers, so handle both.
    let data: number[] | Float32Array | null = null;
    if (typeof (out as { tolist?: unknown }).tolist === "function") {
      const list = (out as { tolist: () => number[][] }).tolist();
      data = list[0] as number[];
    } else if ((out as { data?: unknown }).data) {
      data = (out as { data: Float32Array | number[] }).data;
    }
    if (!data) {
      throw new EmbeddingError(
        `bge-small pipeline returned no usable output (no .tolist or .data)`,
      );
    }
    if (data.length !== BGE_SMALL_DIM) {
      throw new EmbeddingError(
        `bge-small pipeline returned ${data.length}-dim output; expected ${BGE_SMALL_DIM}-dim`,
      );
    }
    return new Float32Array(data);
  } catch (error) {
    if (error instanceof EmbeddingError) throw error;
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new EmbeddingError(`Failed to embed text (bge-small): ${message}`);
  }
}

/** Returns whether the bge-small pipeline is warm. */
export function isBgeSmallReady(): boolean {
  return _pipeline !== null;
}

/**
 * Test-only — reset the singleton state. Used to isolate vitest runs that
 * need to verify warmup behavior (otherwise prior test files' warm
 * pipeline leaks across test runs).
 *
 * @internal
 */
export function _resetBgeSmallForTests(): void {
  _pipeline = null;
  _warmPromise = null;
}

function truncateText(text: string): string {
  const words = text.split(/\s+/);
  if (words.length <= MAX_WORDS) return text;
  return words.slice(0, MAX_WORDS).join(" ");
}
