/**
 * Phase 91 Plan 01 — Shared sync-runner types.
 *
 * Defines the SyncStateFile persisted at `~/.clawcode/manager/sync-state.json`
 * (SYNC-01/02/05), and the SyncRunOutcome discriminated union consumed by
 * Plan 91-02 (conflict detection), 91-04 (CLI surface), and 91-05
 * (observability / Discord reporting).
 *
 * Zod schemas keep JSON parsing safe: safeParse returns success=false for
 * corrupt files instead of throwing — mirrors Phase 83 effort-state-store.
 */

import { z } from "zod/v4";

/**
 * One recorded conflict — destination file sha256 diverged from the
 * perFileHashes entry we last wrote (operator edited ClawCode side).
 *
 * Conflict detection itself lands in Plan 91-02; this schema is defined
 * here because sync-state-store + sync-runner already persist/clear it.
 */
export const syncConflictSchema = z.object({
  path: z.string(),
  sourceHash: z.string(),
  destHash: z.string(),
  detectedAt: z.string(),
  resolvedAt: z.string().nullable(),
});

export type SyncConflict = z.infer<typeof syncConflictSchema>;

/**
 * Persisted sync state — atomic temp+rename JSON at
 * `~/.clawcode/manager/sync-state.json` (D-02). Fields:
 *
 *   - authoritativeSide: "openclaw" (default) | "clawcode" (post-cutover) |
 *     "deprecated" (Phase 96 D-11 — Phase 91 mirror disabled, agents read
 *     source via ACL; rollback within DEPRECATION_ROLLBACK_WINDOW_MS).
 *   - deprecatedAt: ISO timestamp set when authoritativeSide flipped to
 *     "deprecated" (Phase 96). Optional — absent on v2.4 fixtures (additive
 *     non-breaking schema migration). Used by `clawcode sync re-enable-timer`
 *     to enforce the 7-day rollback window.
 *   - perFileHashes: {relpath → sha256 hex} of destination files last written
 *   - conflicts: unresolved conflicts (Plan 91-02 appends, 91-04 clears)
 *   - openClawSessionCursor: Plan 91-03 conversation-turn translator cursor
 */
export const syncStateFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  authoritativeSide: z.enum(["openclaw", "clawcode", "deprecated"]),
  deprecatedAt: z.string().datetime().optional(),
  lastSyncedAt: z.string().nullable(),
  openClawHost: z.string(),
  openClawWorkspace: z.string(),
  clawcodeWorkspace: z.string(),
  perFileHashes: z.record(z.string(), z.string()),
  conflicts: z.array(syncConflictSchema),
  openClawSessionCursor: z.string().nullable(),
});

export type SyncStateFile = z.infer<typeof syncStateFileSchema>;

/**
 * Phase 96 D-11 — rollback window for the Phase 91 mirror deprecation.
 *
 * 7 days in milliseconds (= 604800000 ms). Operator can re-enable the
 * Phase 91 systemd timer via `clawcode sync re-enable-timer` only within
 * this window of `state.deprecatedAt`. After expiry, the CLI refuses with
 * an operator-actionable error directing them to set up sync fresh.
 *
 * Mirrors Phase 91 plan 06's ROLLBACK_WINDOW_MS for the forward-cutover —
 * SAME duration, DIFFERENT preconditions (forward-cutover vs deprecation).
 * Both windows operate on the same sync-state.json file via different
 * state transitions (last-writer-wins per atomic temp+rename).
 */
export const DEPRECATION_ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Discriminated union returned by syncOnce(). Callers branch on `kind` to
 * drive observability, Discord alerts, CLI exit codes.
 *
 * - synced:              successful cycle, files changed
 * - skipped-no-changes:  rsync succeeded, zero file transfers
 * - partial-conflicts:   rsync succeeded but some files skipped (Plan 91-02)
 * - paused:              authoritativeSide=clawcode w/o reverse opt-in (D-18)
 * - deprecated:          authoritativeSide=deprecated (Phase 96 D-11) — Phase 91
 *                        mirror disabled, agents read source via ACL; no rsync,
 *                        no alert, ledger-only.
 * - failed-ssh:          execa/ssh error before rsync started
 * - failed-rsync:        rsync exited with a non-zero, non-23 code
 */
export type SyncRunOutcome =
  | {
      kind: "synced";
      cycleId: string;
      filesAdded: number;
      filesUpdated: number;
      filesRemoved: number;
      filesSkippedConflict: number;
      bytesTransferred: number;
      durationMs: number;
    }
  | {
      kind: "skipped-no-changes";
      cycleId: string;
      durationMs: number;
    }
  | {
      kind: "partial-conflicts";
      cycleId: string;
      filesAdded: number;
      filesUpdated: number;
      filesRemoved: number;
      filesSkippedConflict: number;
      bytesTransferred: number;
      durationMs: number;
      conflicts: readonly SyncConflict[];
    }
  | {
      kind: "paused";
      cycleId: string;
      reason: "authoritative-is-clawcode-no-reverse-opt-in";
    }
  | {
      kind: "deprecated";
      cycleId: string;
      reason: string;
    }
  | {
      kind: "failed-ssh";
      cycleId: string;
      error: string;
      durationMs: number;
    }
  | {
      kind: "failed-rsync";
      cycleId: string;
      error: string;
      durationMs: number;
      exitCode: number;
    };

/**
 * JSONL observability entry shape at ~/.clawcode/manager/sync.jsonl (SYNC-07).
 * One line per cycle outcome — flat object, standard tools (jq, grep) can
 * parse without knowing the discriminated union.
 */
export type SyncJsonlEntry = Readonly<{
  timestamp: string;
  cycleId: string;
  direction: "openclaw-to-clawcode";
  status: SyncRunOutcome["kind"];
  filesAdded?: number;
  filesUpdated?: number;
  filesRemoved?: number;
  filesSkippedConflict?: number;
  bytesTransferred?: number;
  durationMs?: number;
  exitCode?: number;
  error?: string;
  reason?: string;
}>;
