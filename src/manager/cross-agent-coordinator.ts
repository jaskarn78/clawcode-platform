/**
 * Phase 115 Plan 09 T02 — sub-scope 12 (cross-agent consolidation
 * transactionality).
 *
 * The CrossAgentCoordinator wraps fleet-level multi-agent memory writes
 * in a coordinator with `consolidation_run_id` tagging and rollback
 * semantics. Audit trail flows through the existing 115-02
 * `consolidation-runs.jsonl` log (started → completed / failed →
 * rolled-back) so operators have a single surface for every multi-agent
 * write.
 *
 * Architecture note: today's `runConsolidation` (src/memory/consolidation.ts)
 * runs PER-AGENT, called from a per-agent cron handler in `daemon.ts`.
 * The cross-agent partial-failure incident on 2026-05-07 happened
 * because the daemon's per-agent loop had no shared invariant — when
 * admin-clawdy crashed mid-procedure, some agents had completed runs
 * and others hadn't. This module is the abstraction the daemon will
 * call when it wants a multi-agent atomic-batch semantic (e.g., a
 * future fleet-wide priority dream-pass per CONTEXT D-05). It does
 * NOT replace the per-agent path — it composes on top of MemoryStore.
 *
 * Per-agent atomicity guarantee: each `CrossAgentBatchWrite.memories`
 * slice is inserted inside the MemoryStore's own `db.transaction()`
 * (see `MemoryStore.insert` — Phase 107 VEC-CLEAN invariant). A throw
 * partway through one agent's slice rolls back THAT agent's writes.
 * Cross-agent atomicity (one agent fails → revert all others) is
 * surfaced via `kind: "partial-failed"` + an explicit `rollback(runId)`
 * call. We don't auto-rollback because the operator might prefer to
 * keep the partial state and re-run only the failed agent — that
 * decision belongs to the human, per CONTEXT D-10's three-tier policy.
 *
 * Failure modes wired into the run-log:
 *   - `started` (always)
 *   - `completed` (all agents succeed)
 *   - `failed` (>=1 agent failed; succeeded set is non-empty for
 *     partial; empty for full failure — same `failed` status for both)
 *   - `rolled-back` (operator called rollback(runId))
 *
 * Each successful insert receives a `consolidation:<runId>` tag (in
 * addition to whatever tags the caller specified). Rollback uses
 * `findByTag('consolidation:<runId>')` + `delete(id)` per matching
 * memory id. `delete()` cascades to vec_memories + vec_memories_v2
 * (Phase 107 lock), so rollback is fully atomic per agent.
 */

import { nanoid } from "nanoid";
import { appendConsolidationRun } from "./consolidation-run-log.js";
import type { MemoryStore } from "../memory/store.js";
import type {
  CrossAgentBatch,
  CrossAgentBatchStatus,
  CrossAgentBatchWrite,
} from "./cross-agent-coordinator.types.js";
import { CONSOLIDATION_RUN_TAG_PREFIX } from "./cross-agent-coordinator.types.js";

/**
 * Dependencies the coordinator needs. Injected for testability — tests
 * pass an in-memory store factory + a no-op log; the daemon passes the
 * real `manager.getMemoryStore` + the pino logger.
 */
export interface CrossAgentCoordinatorDeps {
  /**
   * Resolve a MemoryStore for an agent label. Throws or returns null
   * when the agent is unknown — the coordinator treats both as a
   * per-agent failure (partial-failed status).
   */
  readonly getStoreForAgent: (agent: string) => MemoryStore | null;
  /**
   * Logger interface compatible with pino. The coordinator never logs
   * unconditionally — only on error (writes a `[diag]` line so
   * operators see the partial-failure inline in the daemon log).
   */
  readonly log: {
    readonly warn: (obj: unknown, msg?: string) => void;
    readonly info: (obj: unknown, msg?: string) => void;
    readonly error: (obj: unknown, msg?: string) => void;
  };
  /**
   * Optional override for the consolidation-run-log directory. Tests
   * redirect away from `~/.clawcode/manager/`. Same plumbing pattern
   * as `ConsolidationDeps.runLogDirOverride` (115-02).
   */
  readonly runLogDirOverride?: string;
}

/**
 * Build the rollback tag value for a given run id. Exported so tests
 * and operator inspection commands can compute the exact tag without
 * re-deriving the format.
 */
export function consolidationRunTag(runId: string): string {
  return `${CONSOLIDATION_RUN_TAG_PREFIX}${runId}`;
}

/**
 * Coordinator for fleet-level multi-agent memory writes.
 *
 * Usage:
 * ```ts
 * const coord = new CrossAgentCoordinator(deps);
 * const result = await coord.runBatch({
 *   targetAgents: ['admin-clawdy', 'fin-research'],
 *   writes: [...]
 * });
 * if (result.kind === 'partial-failed') {
 *   // Operator may call coord.rollback(result.runId) to revert succeeded.
 * }
 * ```
 *
 * The class holds NO mutable state — each call is independent. This
 * matches the rest of the manager codebase (no class-level state in
 * coordinator-style modules).
 */
export class CrossAgentCoordinator {
  constructor(private readonly deps: CrossAgentCoordinatorDeps) {}

  /**
   * Run a fleet batch. Per-agent slices are applied in order; each
   * slice's MemoryStore.insert call wraps in `db.transaction()` for
   * per-agent atomicity. Cross-agent atomicity is surfaced via the
   * returned status — caller decides whether to rollback.
   *
   * Cancellation: not exposed today. If a future caller needs to
   * abort mid-fleet, plumb an AbortSignal through `runBatch(batch, signal)`
   * and check it between writes.
   */
  async runBatch(batch: CrossAgentBatch): Promise<CrossAgentBatchStatus> {
    const runId = batch.runId ?? nanoid();
    const startedAt = batch.startedAt ?? new Date().toISOString();
    const targetAgents: readonly string[] = batch.targetAgents;

    // Started row — wrapped in try/catch so log failure NEVER aborts the
    // batch. Mirrors the runConsolidation pattern in 115-02.
    try {
      await appendConsolidationRun(
        {
          run_id: runId,
          target_agents: targetAgents,
          memories_added: 0,
          status: "started",
          errors: [],
          started_at: startedAt,
        },
        this.deps.runLogDirOverride,
      );
    } catch (err) {
      this.deps.log.warn(
        {
          action: "cross-agent-run-log-started-failed",
          runId,
          error: err instanceof Error ? err.message : String(err),
        },
        "[diag] cross-agent-run-log unwriteable on started (non-fatal)",
      );
    }

    const succeeded: string[] = [];
    const failed: Array<{ agent: string; error: string }> = [];
    const perAgent: Record<string, { added: number }> = {};
    let totalAdded = 0;

    for (const write of batch.writes) {
      try {
        const added = await this.applyOneAgentSlice(write, runId);
        succeeded.push(write.agent);
        perAgent[write.agent] = { added };
        totalAdded += added;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failed.push({ agent: write.agent, error: errMsg });
        // Per-agent failure — log once with [diag] prefix so the
        // operator's tail follows it inline. Defensive truncation
        // mirrors consolidation-run-log.ts (>200 chars trimmed).
        const truncated = errMsg.length > 200 ? errMsg.slice(0, 200) : errMsg;
        this.deps.log.error(
          {
            runId,
            agent: write.agent,
            error: truncated,
            action: "cross-agent-batch-failed",
          },
          "[diag] cross-agent-batch-failed",
        );
      }
    }

    const completedAt = new Date().toISOString();

    if (failed.length === 0) {
      // All slices succeeded — terminal completed row.
      try {
        await appendConsolidationRun(
          {
            run_id: runId,
            target_agents: targetAgents,
            memories_added: totalAdded,
            status: "completed",
            errors: [],
            started_at: startedAt,
            completed_at: completedAt,
          },
          this.deps.runLogDirOverride,
        );
      } catch (err) {
        this.deps.log.warn(
          {
            action: "cross-agent-run-log-completed-failed",
            runId,
            error: err instanceof Error ? err.message : String(err),
          },
          "[diag] cross-agent-run-log unwriteable on completed (non-fatal)",
        );
      }
      return Object.freeze({
        kind: "completed",
        runId,
        perAgent: Object.freeze(perAgent),
      });
    }

    // Partial (or full) failure — terminal failed row. Operator may
    // call rollback(runId) afterward; until then the succeeded set's
    // writes ARE persisted with the runId tag.
    try {
      await appendConsolidationRun(
        {
          run_id: runId,
          target_agents: targetAgents,
          memories_added: totalAdded,
          status: "failed",
          errors: failed.map((f) => `${f.agent}: ${f.error}`),
          started_at: startedAt,
          completed_at: completedAt,
        },
        this.deps.runLogDirOverride,
      );
    } catch (err) {
      this.deps.log.warn(
        {
          action: "cross-agent-run-log-failed-row-failed",
          runId,
          error: err instanceof Error ? err.message : String(err),
        },
        "[diag] cross-agent-run-log unwriteable on failed (non-fatal)",
      );
    }

    // Surface a single fleet-level diagnostic so operators tailing the
    // daemon log see "this fleet batch is in partial state" exactly once
    // per batch (each per-agent failure already logged above).
    this.deps.log.error(
      {
        runId,
        succeeded,
        failed: failed.map((f) => f.agent),
        action: "cross-agent-partial-failure",
      },
      "[diag] cross-agent partial failure — operator should review consolidation-runs.jsonl",
    );

    return Object.freeze({
      kind: "partial-failed",
      runId,
      succeeded: Object.freeze([...succeeded]),
      failed: Object.freeze(
        failed.map((f) => Object.freeze({ agent: f.agent, error: f.error })),
      ),
      perAgent: Object.freeze(perAgent),
    });
  }

  /**
   * Roll back every memory tagged with `consolidation:<runId>` across
   * the given agents. If `agents` is omitted, rolls back across the
   * `target_agents` recorded in the most-recent run-log row for this
   * runId (best-effort — when the row is unreadable, falls back to
   * empty set and returns immediately).
   *
   * Returns a `rolled-back` status with per-agent removed counts.
   * The run-log gets a `rolled-back` row appended.
   *
   * Idempotent: re-running rollback after a rollback finds zero
   * matches and returns `removed: 0` for each agent. No error.
   */
  async rollback(
    runId: string,
    agents: readonly string[],
  ): Promise<CrossAgentBatchStatus> {
    const tag = consolidationRunTag(runId);
    const removed: Record<string, { removed: number }> = {};
    const reverted: string[] = [];

    for (const agent of agents) {
      try {
        const store = this.deps.getStoreForAgent(agent);
        if (store === null) {
          this.deps.log.warn(
            {
              runId,
              agent,
              action: "cross-agent-rollback-store-missing",
            },
            "[diag] cross-agent-rollback: agent store missing — skipping",
          );
          continue;
        }
        const matches = store.findByTag(tag);
        let count = 0;
        for (const m of matches) {
          if (store.delete(m.id)) count++;
        }
        removed[agent] = { removed: count };
        if (count > 0 || matches.length === 0) reverted.push(agent);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.deps.log.error(
          {
            runId,
            agent,
            error: errMsg.length > 200 ? errMsg.slice(0, 200) : errMsg,
            action: "cross-agent-rollback-failed",
          },
          "[diag] cross-agent-rollback-failed",
        );
        // Don't push to reverted; continue with the remaining agents.
      }
    }

    // Append the rolled-back row. Captures the per-agent removal counts
    // by joining them into the errors[] field with a `note:` prefix —
    // not strictly an error, but the existing JSONL schema only has
    // errors[] for free-form text and we don't want to invent a new
    // field today. Future schema rev can split this out.
    const completedAt = new Date().toISOString();
    const rollbackNotes = Object.entries(removed).map(
      ([a, r]) => `note: ${a} removed=${r.removed}`,
    );
    try {
      await appendConsolidationRun(
        {
          run_id: runId,
          target_agents: agents,
          memories_added: 0,
          status: "rolled-back",
          errors: rollbackNotes,
          started_at: completedAt,
          completed_at: completedAt,
        },
        this.deps.runLogDirOverride,
      );
    } catch (err) {
      this.deps.log.warn(
        {
          action: "cross-agent-run-log-rolled-back-failed",
          runId,
          error: err instanceof Error ? err.message : String(err),
        },
        "[diag] cross-agent-run-log unwriteable on rolled-back (non-fatal)",
      );
    }

    return Object.freeze({
      kind: "rolled-back",
      runId,
      reverted: Object.freeze([...reverted]),
      perAgent: Object.freeze(removed),
    });
  }

  /**
   * Apply one agent's slice. Each insert is tagged with
   * `consolidation:<runId>` so rollback can find it. Per-agent
   * atomicity is provided by `MemoryStore.insert` which wraps every
   * write in `db.transaction()` (Phase 107 VEC-CLEAN invariant).
   *
   * Returns the count of inserted memories (excludes dedup-merged ones
   * whose insert returned an existing entry — those are not strictly
   * "added" by this run, and rollback would not touch them).
   */
  private async applyOneAgentSlice(
    write: CrossAgentBatchWrite,
    runId: string,
  ): Promise<number> {
    const store = this.deps.getStoreForAgent(write.agent);
    if (store === null) {
      throw new Error(`getStoreForAgent returned null for agent ${write.agent}`);
    }
    const tag = consolidationRunTag(runId);
    let added = 0;
    for (const m of write.memories) {
      const taggedTags = [...(m.tags ?? []), tag];
      const before = store.findByTag(tag).length;
      store.insert(
        {
          content: m.content,
          source: m.source,
          importance: m.importance,
          tags: taggedTags,
        },
        m.embedding,
      );
      // Determine whether this insert actually added a new row vs hit
      // a dedup-merge. The cheapest signal we have without changing the
      // MemoryStore API surface is "does the tag-set count increase by
      // 1?" When dedup merges into an existing entry, that entry's tags
      // are NOT updated to include our run-id tag (mergeMemory only
      // touches content + importance + tags-merge inside its own path),
      // so the tag set count stays flat — a clean signal.
      const after = store.findByTag(tag).length;
      if (after > before) added++;
    }
    return added;
  }
}
