/**
 * Phase 91 Plan 02 Task 1 — Pure conflict-detection function (SYNC-06).
 *
 * Given a baseline of `perFileHashes` (what we last wrote to the ClawCode
 * destination on the previous successful cycle) + a list of candidate files
 * for this cycle (each with source sha256 from OpenClaw + destination sha256
 * currently on the ClawCode side), decide which files are:
 *
 *   - CLEAN — safe to rsync through this cycle
 *   - CONFLICT — operator edited the destination since our last write; skip
 *     this cycle, log, alert admin-clawdy once, and stop propagating this
 *     file until `clawcode sync resolve <path>` (Plan 91-04) resumes it
 *
 * Zero I/O: no filesystem, no logger, no clock outside the `now` argument.
 * All decisions are pure functions of the inputs, so unit tests don't need
 * mocks beyond a fixed Date.
 *
 * Decision matrix (derived from 91-CONTEXT §D-11, §D-12, §D-13):
 *
 *   | last-written-hash  | destHash    | sourceHash drifted? | verdict   |
 *   |--------------------|-------------|---------------------|-----------|
 *   | undefined          | any         | any                 | CLEAN     |
 *   | any                | null (gone) | any                 | CLEAN     |
 *   | H                  | H           | any                 | CLEAN     |
 *   | H                  | H'  (≠ H)   | any                 | CONFLICT  |
 *
 * D-11 LITERAL READING vs SAFER READING — this code picks the SAFER reading:
 *
 *   D-11 literal: "destHash ≠ last-written-hash AND sourceHash changed since
 *   last sync" → operator-only edit (sourceHash unchanged) would NOT be a
 *   conflict, flow as clean, and rsync would silently overwrite it.
 *
 *   SAFER: ANY destHash drift from the baseline is a conflict, regardless of
 *   whether source also drifted. Because rsync WOULD overwrite the operator's
 *   edit on a match-destination-to-source run; the point of conflict detection
 *   is to refuse silent clobber.
 *
 *   This code implements the SAFER reading. D-13 source-wins only kicks in
 *   when the operator explicitly resolves via `clawcode sync resolve`.
 *
 * Returned structures are deeply frozen — callers must construct a new object
 * to mutate (matching the project's immutability rule from ~/.claude/rules/
 * coding-style.md).
 */

import type { SyncConflict } from "./types.js";

/**
 * Per-file hash triple produced by the sync runner before rsync runs. The
 * runner gathers:
 *   - `sourceHash` from ssh+sha256sum against the OpenClaw host (or rsync
 *     --dry-run + remote probe)
 *   - `destHash` from local sha256 of `{clawcodeWorkspace}/{path}`, or null
 *     if the file does not exist on the destination side
 */
export type FileHashPair = Readonly<{
  readonly path: string;
  readonly sourceHash: string;
  readonly destHash: string | null;
}>;

/**
 * Partition of the candidate set into paths that may flow through rsync this
 * cycle (`cleanFiles`) and paths that must be skipped as conflicts.
 */
export type ConflictDetectionResult = Readonly<{
  readonly cleanFiles: readonly string[];
  readonly conflicts: readonly SyncConflict[];
}>;

/**
 * Partition `currentCandidates` into cleanFiles + conflicts.
 *
 * - `lastWrittenHashes` — sync-state.json's `perFileHashes`, i.e. the sha256
 *   of each destination file the LAST successful cycle wrote. First-ever sync
 *   for a path has `lastWrittenHashes[path] === undefined`.
 * - `currentCandidates` — all files eligible for transfer this cycle, each
 *   tagged with the source+dest sha256.
 * - `now` — stamp applied to SyncConflict.detectedAt. Passed in for test
 *   determinism; production callers supply `new Date()`.
 *
 * Every candidate appears in EXACTLY ONE of the two output arrays — this is
 * the partition invariant exercised by the property test in the test file.
 */
export function detectConflicts(
  lastWrittenHashes: Readonly<Record<string, string>>,
  currentCandidates: readonly FileHashPair[],
  now: Date,
): ConflictDetectionResult {
  const clean: string[] = [];
  const conflicts: SyncConflict[] = [];
  const nowIso = now.toISOString();

  for (const cand of currentCandidates) {
    const last = lastWrittenHashes[cand.path];

    // First-ever sync for this path — always clean. rsync will create it.
    if (last === undefined) {
      clean.push(cand.path);
      continue;
    }

    // Dest file missing (never existed, or operator deleted it) — clean.
    // rsync will re-create it from source. D-12 treats deletions as a
    // user signal to re-sync, not as a conflict.
    if (cand.destHash === null) {
      clean.push(cand.path);
      continue;
    }

    // Dest untouched since our last write — safe to overwrite with any
    // source change. This is the happy path for ~100% of files in a
    // healthy sync cycle.
    if (cand.destHash === last) {
      clean.push(cand.path);
      continue;
    }

    // Dest drifted from last-written. Operator edited the destination file
    // since our last successful write. CONFLICT — skip, log, alert.
    //
    // Safer reading of D-11: regardless of whether the source also drifted,
    // we refuse to silently overwrite operator edits.
    conflicts.push(
      Object.freeze({
        path: cand.path,
        sourceHash: cand.sourceHash,
        destHash: cand.destHash,
        detectedAt: nowIso,
        resolvedAt: null,
      }) as SyncConflict,
    );
  }

  return Object.freeze({
    cleanFiles: Object.freeze(clean) as readonly string[],
    conflicts: Object.freeze(conflicts) as readonly SyncConflict[],
  }) as ConflictDetectionResult;
}
