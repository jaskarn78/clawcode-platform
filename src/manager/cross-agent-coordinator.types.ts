/**
 * Phase 115 Plan 09 T02 — sub-scope 12 (cross-agent consolidation
 * transactionality) types.
 *
 * The coordinator wraps fleet-level multi-agent memory writes — e.g.,
 * a consolidation cycle that touches multiple per-agent stores in one
 * pass — with `consolidation_run_id` tagging and rollback semantics.
 *
 * Today's incident (admin-clawdy interrupted mid-procedure on 2026-05-07)
 * left inconsistent state across agents because each per-agent
 * `runConsolidation` invocation had no awareness of the other agents'
 * state. This module is the abstraction the daemon uses when it wants
 * a multi-agent atomic-batch semantic.
 *
 * The existing per-agent `runConsolidation` (src/memory/consolidation.ts)
 * is preserved verbatim — coordinator wraps the per-agent surface, it
 * does not replace it. Cross-agent partial failure is recorded via the
 * 115-02 `consolidation-runs.jsonl` audit trail (with `target_agents`
 * carrying multiple names) and rolled back via `consolidation:<runId>`
 * tag deletion.
 */

import type { MemoryEntry } from "../memory/types.js";

/**
 * One per-agent slice of a fleet batch. Each slice carries the agent
 * label + the memories to insert into that agent's store. The
 * coordinator is responsible for tagging every inserted memory with
 * `consolidation:<runId>` so rollback can find them by tag.
 */
export interface CrossAgentBatchWrite {
  /** Agent label — must match an agent registered in the manager. */
  readonly agent: string;
  /**
   * Memories to insert into this agent's store. Each entry's existing
   * `tags` are preserved + the `consolidation:<runId>` tag is appended
   * by the coordinator. The embedding is provided as Float32Array since
   * sqlite-vec's vec_memories column is float32 (Phase 90 lock); the
   * v2 (int8) embedding is not yet exposed here — Plan 115-06 migration
   * runner handles that path separately.
   */
  readonly memories: ReadonlyArray<{
    readonly content: string;
    readonly source: MemoryEntry["source"];
    readonly importance?: number;
    readonly tags?: readonly string[];
    readonly embedding: Float32Array;
  }>;
}

/**
 * A fleet-level batch crossing multiple agents. The runId is stable
 * across status transitions in the consolidation-run-log JSONL —
 * readers reduce by run_id to compute the latest state.
 */
export interface CrossAgentBatch {
  /**
   * URL-safe unique id (nanoid recommended). Optional — when omitted
   * the coordinator generates one. Carrying a caller-provided id is
   * useful for the daemon's per-batch trace correlation.
   */
  readonly runId?: string;
  /** Agent labels covered by this batch. Must match writes[].agent set. */
  readonly targetAgents: readonly string[];
  /** Per-agent slices. Order is the order they will be applied. */
  readonly writes: readonly CrossAgentBatchWrite[];
  /**
   * ISO 8601 timestamp of when the caller began assembling the batch.
   * Optional — the coordinator stamps `new Date().toISOString()` if
   * omitted. Used by the run-log so reducer logic can compute batch
   * duration consistently.
   */
  readonly startedAt?: string;
}

/**
 * Result of running a cross-agent batch through the coordinator.
 *
 * Discriminated union — readers branch on `kind`:
 *   - `completed` — every per-agent slice succeeded; run-log gets a
 *     `completed` row with the total memories added.
 *   - `partial-failed` — at least one slice failed but at least one
 *     succeeded. The succeeded slices' inserts ARE in their respective
 *     stores (tagged with `consolidation:<runId>`); the operator can
 *     either accept the partial state or call `coordinator.rollback(runId)`
 *     to revert the succeeded slices. Run-log gets a `failed` row.
 *   - `rolled-back` — operator (or auto-rollback policy) called
 *     `rollback(runId)` and the deletes succeeded for `reverted` agents.
 *     Run-log gets a `rolled-back` row.
 */
export type CrossAgentBatchStatus =
  | {
      readonly kind: "completed";
      readonly runId: string;
      readonly perAgent: Readonly<Record<string, { readonly added: number }>>;
    }
  | {
      readonly kind: "partial-failed";
      readonly runId: string;
      readonly succeeded: readonly string[];
      readonly failed: ReadonlyArray<{
        readonly agent: string;
        readonly error: string;
      }>;
      readonly perAgent: Readonly<
        Record<string, { readonly added: number }>
      >;
    }
  | {
      readonly kind: "rolled-back";
      readonly runId: string;
      readonly reverted: readonly string[];
      readonly perAgent: Readonly<
        Record<string, { readonly removed: number }>
      >;
    };

/**
 * Tag prefix used to mark every memory inserted via the coordinator.
 * Format: `consolidation:<runId>`. Rollback finds memories by exact-
 * value match against `findByTag()`.
 *
 * This is the rollback target. Operators who want to manually inspect
 * "what did this run write" can: `clawcode memory --tag consolidation:<runId>`
 * (uses MemoryStore.findByTag() under the hood).
 */
export const CONSOLIDATION_RUN_TAG_PREFIX = "consolidation:";
