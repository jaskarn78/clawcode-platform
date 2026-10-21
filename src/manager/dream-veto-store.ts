/**
 * Phase 115 Plan 05 T02 — Dream-pass veto store (D-10 hybrid policy).
 *
 * Tracks scheduled auto-apply runs that flow through the 30-min Discord
 * veto window (D-10 Row 2 + Row 5). The runner ticks periodically: pending
 * rows past their deadline that have NOT been vetoed get applied; rows
 * with a veto flag get cancelled.
 *
 * Persistence: ~/.clawcode/manager/dream-veto-pending.jsonl — JSONL of
 * VetoStoreRow records. Mirrors consolidation-run-log.ts shape.
 *
 * Per-agent isolation: agentName is part of every row. Tick is fleet-wide
 * but applies in-place; the apply callback is responsible for resolving
 * the agent's per-agent memoryRoot at apply time. Phase 90 isolation lock
 * preserved.
 *
 * Failure semantics: writes propagate errors to the caller (the dream-cron
 * tick wraps in try/catch — same pattern as consolidation-run-log). Reads
 * tolerate ENOENT → empty list.
 *
 * D-10 mapping:
 *   - Row 2 (additive promotion ≥80): scheduleAutoApply with isPriorityPass=false
 *   - Row 5 (priority pass override):  scheduleAutoApply with isPriorityPass=true
 *   - Row 3 / Row 4 do NOT enter the veto store — operator-required only.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DreamResult } from "./dream-pass.js";

/**
 * One promotion candidate carried in the veto-pending row. Mirrors
 * dreamResultSchema.promotionCandidates shape so the apply callback can
 * route the candidate without re-parsing the dream output.
 */
export interface VetoStorePromotion {
  readonly chunkId: string;
  readonly currentPath: string;
  readonly rationale: string;
  readonly priorityScore: number;
  readonly action?: "add" | "edit" | "merge";
  readonly targetMode?: "append" | "overwrite";
  /**
   * Phase 999.188 — snapshot of the chunk taken when the run was scheduled.
   * Chunk ids are regenerated whenever the scanner re-indexes a file
   * (delete-then-insert), so by the time the veto window closes the id the
   * dream cited may be gone. The apply step prefers the live chunk and
   * falls back to this snapshot, so a re-index never loses a promotion.
   */
  readonly heading?: string | null;
  readonly body?: string;
}

/**
 * One veto-pending row. Status transitions:
 *   pending → applied   (tick fired after deadline; no veto)
 *   pending → vetoed    (operator vetoed inside the window)
 *   pending → expired   (apply callback failed; row marked expired with error)
 *
 * Each transition writes a NEW row with the same `runId` — readers reduce
 * by `runId` to compute the latest state. Mirrors consolidation-run-log.
 */
export interface VetoStoreRow {
  readonly runId: string;
  readonly agentName: string;
  readonly candidates: readonly VetoStorePromotion[];
  readonly deadline: number;
  readonly isPriorityPass: boolean;
  readonly status: "pending" | "applied" | "vetoed" | "expired";
  readonly scheduledAt: string;
  readonly resolvedAt?: string;
  readonly vetoReason?: string;
  readonly applyError?: string;
}

/**
 * Public veto-store interface. Production wiring (the daemon-edge dream-
 * cron tick, Plan 95-03) instantiates createDreamVetoStore() once at
 * startup and threads it through registerDreamCron + applyDreamResult.
 *
 * Tests inject an in-memory implementation (see __tests__/dream-veto-store.test.ts).
 */
export interface VetoStore {
  /**
   * Persist a new pending auto-apply request. Called by applyDreamResult
   * (D-10 Row 2 / Row 5) immediately after the dream-pass returns and
   * before the 30-min Discord summary fires.
   */
  scheduleAutoApply(req: ScheduledApply): Promise<void>;

  /**
   * Mark a pending run as vetoed. Operator surface — invoked by the
   * `/clawcode-memory-veto <run_id>` Discord slash or the ❌ react path.
   * Idempotent: vetoing an already-applied run returns without error.
   */
  vetoRun(runId: string, reason: string): Promise<void>;

  /**
   * Periodic tick — applies eligible runs (deadline passed AND no veto
   * recorded). Returns the runIds that were applied this tick, so the
   * caller can log + emit Discord post-apply confirmation.
   *
   * The apply callback is dependency-injected so the store stays pure.
   */
  tick(now: Date, applyFn: VetoApplyFn): Promise<readonly string[]>;

  /**
   * Phase 999.188 — operator approval: close the veto window now. The row
   * stays `pending` with its deadline moved to the past, so the next tick
   * (the approve IPC runs one immediately) applies it through the same
   * path as an expired window. Idempotent on non-pending runs. Optional so
   * older in-memory doubles keep type-checking.
   */
  approveRun?(runId: string): Promise<boolean>;

  /** Read all rows (most-recent-first) for status / debug. */
  list(): Promise<readonly VetoStoreRow[]>;
}

/**
 * Apply callback shape. Invoked once per eligible run at tick time. The
 * callback owns per-agent memoryRoot resolution + actual MEMORY.md /
 * USER.md mutation. Returning false (or throwing) routes the run into
 * `expired` status with the error message captured.
 */
export type VetoApplyFn = (
  row: VetoStoreRow,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export interface ScheduledApply {
  readonly runId: string;
  readonly agentName: string;
  readonly candidates: readonly VetoStorePromotion[];
  readonly deadline: number;
  readonly isPriorityPass: boolean;
}

/**
 * Default JSONL path: ~/.clawcode/manager/dream-veto-pending.jsonl. Tests
 * pass dirOverride (a tmpdir) — REPLACES the homedir-derived parent.
 */
function resolveLogPath(dirOverride?: string): { dir: string; file: string } {
  const dir = dirOverride ?? join(homedir(), ".clawcode", "manager");
  return { dir, file: join(dir, "dream-veto-pending.jsonl") };
}

/**
 * Append one row to the veto-pending log. Creates the directory tree if
 * missing. Errors propagate — caller wraps in try/catch.
 */
async function appendRow(
  row: VetoStoreRow,
  dirOverride?: string,
): Promise<void> {
  const { dir, file } = resolveLogPath(dirOverride);
  await fs.mkdir(dir, { recursive: true });

  // Truncate vetoReason / applyError defensively — defense against
  // accidental DB-row dumps that could leak content (115-02 threat model).
  const truncated: VetoStoreRow = {
    ...row,
    vetoReason:
      typeof row.vetoReason === "string" && row.vetoReason.length > 200
        ? row.vetoReason.slice(0, 200)
        : row.vetoReason,
    applyError:
      typeof row.applyError === "string" && row.applyError.length > 200
        ? row.applyError.slice(0, 200)
        : row.applyError,
  };
  const line = JSON.stringify(truncated) + "\n";
  await fs.appendFile(file, line, { encoding: "utf8" });
}

/**
 * Read every row in the log (oldest-first). ENOENT → empty array.
 * Malformed lines are skipped (defensive against partial-write crashes).
 */
async function readAllRows(
  dirOverride?: string,
): Promise<readonly VetoStoreRow[]> {
  const { file } = resolveLogPath(dirOverride);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ENOENT") return [];
    throw err;
  }

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const out: VetoStoreRow[] = [];
  for (const l of lines) {
    try {
      const row = JSON.parse(l) as VetoStoreRow;
      out.push(row);
    } catch {
      // Skip — partial write from a crashed daemon. Operator can still
      // read every well-formed row before AND after the broken line.
    }
  }
  return out;
}

/**
 * Reduce the JSONL log to the latest state per runId. Last write wins
 * (status transitions naturally promote pending → applied/vetoed/expired).
 */
function latestByRunId(
  rows: readonly VetoStoreRow[],
): ReadonlyMap<string, VetoStoreRow> {
  const map = new Map<string, VetoStoreRow>();
  for (const row of rows) {
    map.set(row.runId, row);
  }
  return map;
}

/**
 * Production-wired VetoStore backed by JSONL persistence at
 * ~/.clawcode/manager/dream-veto-pending.jsonl. Pass dirOverride from
 * tests to redirect to a tmpdir.
 */
export function createDreamVetoStore(
  dirOverride?: string,
): VetoStore {
  return {
    async scheduleAutoApply(req: ScheduledApply): Promise<void> {
      const row: VetoStoreRow = {
        runId: req.runId,
        agentName: req.agentName,
        candidates: req.candidates,
        deadline: req.deadline,
        isPriorityPass: req.isPriorityPass,
        status: "pending",
        scheduledAt: new Date().toISOString(),
      };
      await appendRow(row, dirOverride);
    },

    async vetoRun(runId: string, reason: string): Promise<void> {
      const all = await readAllRows(dirOverride);
      const latest = latestByRunId(all).get(runId);
      if (!latest || latest.status !== "pending") {
        // Idempotent — vetoing an unknown / non-pending run is a no-op.
        return;
      }
      const vetoRow: VetoStoreRow = {
        ...latest,
        status: "vetoed",
        resolvedAt: new Date().toISOString(),
        vetoReason: reason,
      };
      await appendRow(vetoRow, dirOverride);
    },

    async approveRun(runId: string): Promise<boolean> {
      const all = await readAllRows(dirOverride);
      const latest = latestByRunId(all).get(runId);
      if (!latest || latest.status !== "pending") return false;
      await appendRow({ ...latest, deadline: 0 }, dirOverride);
      return true;
    },

    async tick(now: Date, applyFn: VetoApplyFn): Promise<readonly string[]> {
      const all = await readAllRows(dirOverride);
      const latest = latestByRunId(all);
      const applied: string[] = [];
      const nowMs = now.getTime();

      for (const row of latest.values()) {
        if (row.status !== "pending") continue;
        if (nowMs < row.deadline) continue; // still inside veto window

        // Deadline passed — apply.
        let result: { ok: true } | { ok: false; error: string };
        try {
          result = await applyFn(row);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { ok: false, error: msg };
        }

        const resolvedAt = new Date().toISOString();
        if (result.ok) {
          await appendRow(
            { ...row, status: "applied", resolvedAt },
            dirOverride,
          );
          applied.push(row.runId);
        } else {
          await appendRow(
            {
              ...row,
              status: "expired",
              resolvedAt,
              applyError: result.error,
            },
            dirOverride,
          );
        }
      }
      return Object.freeze(applied);
    },

    async list(): Promise<readonly VetoStoreRow[]> {
      const all = await readAllRows(dirOverride);
      const latest = latestByRunId(all);
      // Most-recent-first by scheduledAt.
      const sorted = [...latest.values()].sort((a, b) =>
        b.scheduledAt.localeCompare(a.scheduledAt),
      );
      return Object.freeze(sorted);
    },
  };
}
