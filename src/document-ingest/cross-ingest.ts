/**
 * Phase 101 Plan 03 Task 2 (U6, CF-2) — crossIngestToMemory.
 *
 * Mirrors every ingested document chunk into the agent's memory pipeline so
 * Phase 90 hybrid-RRF (vec + BM25) can surface document content on
 * subsequent operator turns — no retrieval-side code changes required.
 *
 * Writes (idempotent on `(agent, docSlug)`):
 *   - memory_chunks                      (path = `document:<docSlug>`)
 *   - memory_chunks_fts                  (FTS5 over heading + body)
 *   - vec_memory_chunks (v1 float[384])  when migrationPhase ∈ {v1-only, dual-write}
 *   - vec_memory_chunks_v2 (int8[384])   when migrationPhase ∈ {dual-write, v2-only}
 *
 * Coordination with Phase 115 (CF-2):
 *   The migration is owned by the existing Phase 115 `EmbeddingV2Migrator`
 *   state machine (`src/memory/migrations/embedding-v2.ts`). That machine
 *   carries seven phases; we expose a three-phase facade ('v1-only' |
 *   'dual-write' | 'v2-only') at this seam because the plan + caller
 *   telemetry speaks in that simpler vocabulary. Mapping:
 *
 *     idle, rolled-back                              -> 'v1-only'
 *     dual-write, re-embedding, re-embed-complete    -> 'dual-write'
 *     cutover, v1-dropped                            -> 'v2-only'
 *
 *   On first document ingest for an agent still at 'v1-only' (= idle), we
 *   auto-flip the migration to 'dual-write' (legal `idle -> dual-write`
 *   transition per `LEGAL_TRANSITIONS`) so the cross-ingest's v2 vec write
 *   stays consistent with Phase 115's dual-write invariant. This is CF-2
 *   cross-write coordination — without it, dropping a `vec_memory_chunks_v2`
 *   row for an agent still nominally in v1 mode would violate the migrator's
 *   "v2 column is empty in v1-only phase" assumption.
 *
 * Threat model:
 *   T-101-11 — adversarial `docSlug` such as `../../etc/passwd` is mitigated
 *   here by a strict regex (`/^[a-z0-9-]+$/`) that rejects anything outside
 *   the safe slug grammar. Validation happens BEFORE any write.
 */
import { createHash } from "node:crypto";
import type { MemoryStore } from "../memory/store.js";
import {
  EmbeddingV2Migrator,
  type EmbeddingMigrationPhase,
} from "../memory/migrations/embedding-v2.js";

/**
 * Three-phase facade exposed to the cross-ingest caller. The underlying
 * Phase 115 `EmbeddingV2Migrator` carries seven phases; we collapse them
 * here. See the module docblock for the full mapping table.
 */
export type CrossIngestMigrationPhase = "v1-only" | "dual-write" | "v2-only";

/** Strict slug grammar — T-101-11 mitigation. */
const DOC_SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Thin adapter over `EmbeddingV2Migrator` that surfaces the three-phase
 * facade the cross-ingest seam speaks. Constructed per-call (per-agent).
 *
 * Reuses the existing per-agent `migrations` SQLite table (NOT a separate
 * JSON file under `~/.clawcode/agents/<agent>/migration-phase.json`) so we
 * don't fork the migration-state-of-truth. The plan called for a JSON
 * store; the plan also said "If a store of this shape already exists in
 * the codebase, reuse it." It does, so we reuse it.
 */
export class MigrationPhaseStore {
  private readonly migrator: EmbeddingV2Migrator;

  constructor(store: MemoryStore, agent: string) {
    this.migrator = new EmbeddingV2Migrator(store.getDatabase(), agent);
  }

  /** Read the current 3-phase facade phase. */
  get(): CrossIngestMigrationPhase {
    return facadeFor(this.migrator.getState().phase);
  }

  /**
   * Auto-flip from 'v1-only' to 'dual-write' (CF-2 coordination). No-op if
   * already past 'v1-only'. Returns the resulting 3-phase facade phase.
   */
  flipToDualWriteIfV1Only(): CrossIngestMigrationPhase {
    const current = this.migrator.getState().phase;
    const facade = facadeFor(current);
    if (facade === "v1-only") {
      // idle / rolled-back both have 'dual-write' in their legal
      // transition set — see LEGAL_TRANSITIONS in embedding-v2.ts.
      this.migrator.transition("dual-write");
      return "dual-write";
    }
    return facade;
  }
}

function facadeFor(phase: EmbeddingMigrationPhase): CrossIngestMigrationPhase {
  switch (phase) {
    case "idle":
    case "rolled-back":
      return "v1-only";
    case "dual-write":
    case "re-embedding":
    case "re-embed-complete":
      return "dual-write";
    case "cutover":
    case "v1-dropped":
      return "v2-only";
  }
}

/** Input chunk shape — minimal contract for cross-ingest (id + content). */
export interface CrossIngestChunk {
  readonly index: number;
  readonly content: string;
  /** WP3 — per-chunk heading override; defaults to the document heading. */
  readonly heading?: string;
}

/** Args for {@link crossIngestToMemory}. */
export interface CrossIngestArgs {
  readonly agent: string;
  readonly docSlug: string;
  readonly chunks: ReadonlyArray<CrossIngestChunk>;
  /**
   * WP3 (2026-10-25) — heading stored on every mirror row (and indexed by
   * FTS). Callers pass the original filename so <memory-context> renders
   * "invoice-10432.pdf" instead of "document:1729…-invoice-10432-pdf". Never
   * null: when omitted the docSlug is used.
   */
  readonly heading?: string | null;
  /**
   * P1-CROSSINGEST — PRECOMPUTED embeddings, index-aligned (positionally) with
   * `chunks`. The caller computes these once in the dedicated embed worker
   * (P1-EMBED-WORKER) and passes them in, so cross-ingest is pure synchronous
   * sqlite on the main thread and does NOT lazy-load a SECOND ONNX model copy.
   *
   * `precomputedV1` (MiniLM float32) is REQUIRED — the v1 vec row is always
   * written. `precomputedV2` (bge int8) is required only when the migration
   * phase is dual-write/v2-only; pass null otherwise.
   */
  readonly precomputedV1: Float32Array[] | null;
  readonly precomputedV2: Int8Array[] | null;
  readonly memoryStore: MemoryStore;
  readonly migrationPhaseStore: MigrationPhaseStore;
}

/** Result returned by {@link crossIngestToMemory}. */
export interface CrossIngestResult {
  readonly chunksWritten: number;
  readonly migrationPhaseAfter: CrossIngestMigrationPhase;
}

/**
 * Mirror `chunks` into the agent's memory store under path
 * `document:<docSlug>`. See module docblock for full semantics.
 *
 * @throws if `docSlug` does not match `/^[a-z0-9-]+$/` (T-101-11).
 */
export async function crossIngestToMemory(
  args: CrossIngestArgs,
): Promise<CrossIngestResult> {
  // T-101-11 — strict slug validation BEFORE any write.
  if (!DOC_SLUG_RE.test(args.docSlug)) {
    throw new Error(
      `invalid docSlug: contains disallowed characters (must match /^[a-z0-9-]+$/): ${args.docSlug}`,
    );
  }

  // P1-CROSSINGEST — validate precomputed embeddings BEFORE the flip + delete so
  // a bad input can never orphan a half-deleted docSlug. Throw loudly; never
  // silent-skip an embedding (a missing v1/v2 vec row is a silent search-quality
  // regression).
  if (!args.precomputedV1) {
    throw new Error(
      "crossIngestToMemory: precomputedV1 is required (the v1 vec row is always written)",
    );
  }
  if (args.precomputedV1.length !== args.chunks.length) {
    throw new Error(
      `crossIngestToMemory: precomputedV1 length ${args.precomputedV1.length} != chunks ${args.chunks.length}`,
    );
  }
  if (
    args.precomputedV2 &&
    args.precomputedV2.length !== args.chunks.length
  ) {
    throw new Error(
      `crossIngestToMemory: precomputedV2 length ${args.precomputedV2.length} != chunks ${args.chunks.length}`,
    );
  }

  // CF-2 — auto-flip to dual-write on first document ingest for v1-only
  // agents; otherwise read-only.
  const migrationPhaseAfter =
    args.migrationPhaseStore.flipToDualWriteIfV1Only();
  const writeV2 =
    migrationPhaseAfter === "dual-write" || migrationPhaseAfter === "v2-only";
  if (writeV2 && !args.precomputedV2) {
    throw new Error(
      `crossIngestToMemory: precomputedV2 is required in ${migrationPhaseAfter} phase`,
    );
  }

  const path = `document:${args.docSlug}`;
  const fileMtimeMs = Date.now();
  const docHeading =
    typeof args.heading === "string" && args.heading.trim().length > 0
      ? args.heading.trim()
      : args.docSlug;

  // Idempotency: a re-ingest of the same docSlug DELETEs all prior rows
  // across memory_chunks + vec_memory_chunks + vec_memory_chunks_v2 +
  // memory_chunks_fts (and the memory_files ledger row).
  args.memoryStore.deleteMemoryChunksByPath(path);

  let chunksWritten = 0;
  let i = 0;
  for (const chunk of args.chunks) {
    // Precomputed v1 (always present, validated above) — index-aligned with
    // chunks. The v2-only chunks-side cutover is a future Plan 115-09 concern.
    const embeddingV1 = args.precomputedV1[i];

    // file_mtime_ms is shared across all chunks for this docSlug so the
    // time-window filter treats the document as a unit.
    const fileSha256 = createHash("sha256")
      .update(`${args.docSlug}\0${chunk.index}\0${chunk.content}`)
      .digest("hex");

    const tokenCount = Math.ceil(chunk.content.length * 0.25);
    const chunkId = args.memoryStore.insertMemoryChunk({
      path,
      chunkIndex: chunk.index,
      // WP3 — the heading is the filename (never null) so the rendered
      // memory context names the document.
      heading: chunk.heading ?? docHeading,
      body: chunk.content,
      tokenCount,
      // Documents are operator-curated artifacts; score_weight matches
      // /memory/vault/ (+0.2) so Phase 90 RRF nudges them above generic
      // session notes when relevance is otherwise equal.
      scoreWeight: 0.2,
      fileMtimeMs,
      fileSha256,
      embedding: embeddingV1,
    });

    // CF-2: write the v2 vec row when the agent is in dual-write or v2-only.
    if (writeV2) {
      // Non-null asserted: validated above when writeV2 is true.
      const embeddingV2 = args.precomputedV2![i];
      args.memoryStore.insertChunkEmbeddingV2(chunkId, embeddingV2);
    }

    chunksWritten++;
    i++;
  }

  return Object.freeze({ chunksWritten, migrationPhaseAfter });
}
