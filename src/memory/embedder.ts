import { EmbeddingError } from "./errors.js";
import {
  embedBgeSmall,
  warmupBgeSmall,
  isBgeSmallReady,
  BGE_SMALL_MODEL_ID,
} from "./embedder-bge-small.js";
import { quantizeInt8 } from "./embedder-quantize.js";
import type { EmbeddingReadVersion, QueryVector } from "./embedding-version.js";

/**
 * Phase 115 D-06 / D-08 — embedding-service version dispatcher.
 *
 * `v1-minilm`        — `Xenova/all-MiniLM-L6-v2` (current production
 *                      embedder, 384-dim, MTEB ~56). Path preserved
 *                      bit-identical for the dual-write transition.
 * `v2-bge-small-int8`— `BAAI/bge-small-en-v1.5` + scalar int8 quant
 *                      (Phase 115 D-06 + D-07). 384-dim native, ~5-7
 *                      MTEB-point recall improvement, ~78% storage
 *                      reduction in sqlite-vec.
 *
 * Migration model (D-08): EmbeddingService keeps the legacy `embed(text)`
 * signature (returns Float32Array) so 7+ existing callers — compaction,
 * consolidation, conversation-search, episode-store, memory-scanner,
 * session-summarizer, tier-manager — keep working unchanged. New code
 * paths (Phase 115 dual-write hook in MemoryStore.insert / migration
 * runner) call `embedV1` / `embedV2` directly to read the right format
 * for the target table.
 *
 * The default version that `embed(text)` resolves to is `v1-minilm` until
 * cutover (operator-driven via the embedding-v2 migration state machine
 * in src/memory/migrations/embedding-v2.ts). The dispatcher deliberately
 * does NOT inspect migration state itself — that wiring lives in the
 * MemoryStore + migration runner layer so this file stays a pure
 * embedding utility.
 */

/** Discriminator for the active embedding model + storage format. */
export type EmbeddingVersion = "v1-minilm" | "v2-bge-small-int8";

/**
 * The FeatureExtractionPipeline type from @huggingface/transformers.
 * Defined locally to avoid importing the full package at module level.
 */
type FeatureExtractionPipeline = (
  text: string,
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * Maximum word count before truncation. MiniLM's limit is 256 tokens, so
 * 200 words is the most it can see; WP2 (2026-10-25) sized chunk parts at
 * 220 words (memory-chunks.ts) so a part is embedded almost whole here and
 * fully by bge-small (BGE_SMALL_MAX_WORDS = 350). Exported for tests.
 */
export const MINILM_MAX_WORDS = 200;
const MAX_WORDS = MINILM_MAX_WORDS;

/** v1 model id — pinned for the dual-write transition. */
export const V1_MINILM_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** Re-export so callers can import a single-source-of-truth model id. */
export { BGE_SMALL_MODEL_ID } from "./embedder-bge-small.js";

/**
 * EmbeddingService wraps @huggingface/transformers for local text embeddings.
 *
 * Phase 115 D-06 + D-08 dispatcher refactor:
 *   - `embed(text)`        — Phase 1-114 contract preserved. Returns
 *                            Float32Array, defaults to v1 (MiniLM). Existing
 *                            callers don't change.
 *   - `embedV1(text)`      — Explicit MiniLM path (Float32Array, 384-dim).
 *                            Used during dual-write to write vec_memories
 *                            even after v2 cutover prep.
 *   - `embedV2Float32(t)`  — Explicit bge-small path BEFORE quantization.
 *                            Returns Float32Array for diagnostics + recall
 *                            tests.
 *   - `embedV2(text)`      — bge-small + int8 quantization. Returns
 *                            Int8Array — the storage shape for vec_memories_v2
 *                            (sqlite-vec int8[384] column).
 *
 * The original v1 (MiniLM) ONNX path is kept verbatim from Phases 1-114
 * to guarantee bit-identical embeddings for the dual-write transition
 * window. The model is downloaded on first warmup (~23MB for v1, +33MB
 * for v2) and cached in `~/.cache/huggingface`.
 */
export class EmbeddingService {
  private pipeline: FeatureExtractionPipeline | null = null;
  private warmPromise: Promise<void> | null = null;

  /**
   * Pre-warm the embedding model. Idempotent — only downloads once.
   * Call at daemon startup to avoid cold-start latency on first embed.
   *
   * Phase 115 D-08 — only warms v1 (MiniLM) by default; v2 (bge-small)
   * warms lazily on first `embedV2`/`embedV2Float32` call to keep
   * baseline daemon-boot memory unchanged. Call `warmupV2()` explicitly
   * at daemon boot only when the operator has flipped a per-agent
   * migration into `dual-write` or later phase.
   */
  async warmup(): Promise<void> {
    if (this.pipeline) return;
    if (this.warmPromise) return this.warmPromise;
    this.warmPromise = this.doWarmup();
    return this.warmPromise;
  }

  /**
   * Phase 115 D-06 — explicit v2 (bge-small) warmup. Operator-driven
   * (called by the migration runner when an agent transitions to
   * `dual-write` or later). Downloading the bge-small model is ~33MB
   * one-shot; subsequent calls are no-ops.
   */
  async warmupV2(): Promise<void> {
    await warmupBgeSmall();
  }

  /**
   * Embed text into a 384-dimensional Float32Array.
   *
   * Phase 115 D-08 — preserves the Phase 1-114 contract verbatim. The
   * dispatcher resolves to v1 (MiniLM) by default; callers that need
   * v2 explicitly should use `embedV2` / `embedV2Float32`. This keeps
   * 7 existing call sites (compaction, consolidation, conversation-
   * search, episode-store, memory-scanner, session-summarizer,
   * tier-manager) bit-identical until cutover.
   */
  async embed(text: string): Promise<Float32Array> {
    return this.embedV1(text);
  }

  /**
   * Phase 115 D-08 — explicit v1 (MiniLM) path. Identical behavior to
   * the legacy `embed()` method. Used by:
   *   - Dual-write hook in MemoryStore.insert when migration phase is
   *     `dual-write` or `re-embedding` (writes BOTH v1 + v2).
   *   - The migration runner's "preserve v1 vector for rollback path".
   */
  async embedV1(text: string): Promise<Float32Array> {
    try {
      if (!this.pipeline) {
        await this.warmup();
      }

      const truncated = truncateText(text);
      const output = await this.pipeline!(truncated, {
        pooling: "mean",
        normalize: true,
      });
      const data = output.tolist()[0] as number[];
      return new Float32Array(data);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new EmbeddingError(`Failed to embed text: ${message}`);
    }
  }

  /**
   * Phase 115 D-06 — bge-small float32 path BEFORE quantization. Used
   * by:
   *   - Recall regression tests (compare to v1 KNN on same input).
   *   - The migration runner when computing recall-loss diagnostics.
   *   - Diagnostic CLI output (operator-readable inspection of the
   *     pre-quant vector — operators rarely need this but it's free).
   */
  async embedV2Float32(text: string): Promise<Float32Array> {
    return embedBgeSmall(text);
  }

  /**
   * Phase 115 D-06 + D-07 — bge-small + int8 quantization. The storage
   * format for `vec_memories_v2` (sqlite-vec int8[384]). Used by:
   *   - Dual-write hook in MemoryStore.insert (writes vec_memories_v2).
   *   - The migration runner's batch re-embed loop (writes historical
   *     memories' v2 vectors).
   *   - Read path post-cutover (query embedding for vec_memories_v2
   *     MATCH).
   */
  async embedV2(text: string): Promise<Int8Array> {
    const float32 = await this.embedV2Float32(text);
    return quantizeInt8(float32);
  }

  /**
   * Phase 999.119 v2 switch — embed a QUERY for the space the agent reads
   * from. Callers get the version from `MemoryStore.getEmbeddingReadVersion()`
   * (or use `MemoryStore.embedQuery`, which does both). The v2 result keeps
   * the pre-quantization float alongside the int8 MATCH vector.
   */
  async embedForVersion(
    text: string,
    version: EmbeddingReadVersion,
  ): Promise<QueryVector> {
    if (version === "v2") {
      const float = await this.embedV2Float32(text);
      return Object.freeze({ version: "v2" as const, vector: quantizeInt8(float), float });
    }
    return Object.freeze({ version: "v1" as const, vector: await this.embedV1(text) });
  }

  /** Returns whether the v1 (MiniLM) embedding pipeline is ready. */
  isReady(): boolean {
    return this.pipeline !== null;
  }

  /** Phase 115 — returns whether the v2 (bge-small) pipeline is warm. */
  isV2Ready(): boolean {
    return isBgeSmallReady();
  }

  private async doWarmup(): Promise<void> {
    try {
      const { pipeline } = await import("@huggingface/transformers");
      this.pipeline = (await pipeline(
        "feature-extraction",
        V1_MINILM_MODEL_ID,
      )) as unknown as FeatureExtractionPipeline;
    } catch (error) {
      this.warmPromise = null;
      const message =
        error instanceof Error ? error.message : "Unknown error";
      throw new EmbeddingError(`Failed to warm up embedding model: ${message}`);
    }
  }
}

/** Truncate text to MAX_WORDS words to stay within model token limits. */
function truncateText(text: string): string {
  const words = text.split(/\s+/);
  if (words.length <= MAX_WORDS) return text;
  return words.slice(0, MAX_WORDS).join(" ");
}
