/**
 * Keeps `<workspace>/workflows/` bounded.
 *
 * WHY THIS EXISTS. Nothing prunes generated workflow artifacts today - every
 * run since 2026-07-27 has left its per-step `.md` plus `summary.json` behind
 * forever, and the report work adds two PDFs per run on top. This host has
 * already taken the fleet down once with ENOSPC (openai body-logging), and the
 * failure mode there was not a spike: it grew quietly for days. So the bound is
 * cheap, dumb and always on.
 *
 * POLICY: keep the N most recent workflow directories per agent, by mtime.
 * Deliberately not size-based - a size cap has to decide WHICH run to sacrifice
 * when one run is huge, and "the oldest" is the only answer an operator can
 * predict. It never touches anything outside `workflows/`, and it only removes
 * directories whose names look like workflow ids.
 */

import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

/** Retained workflow directories per agent. */
export const DEFAULT_KEEP_WORKFLOWS = 40;

/** Workflow ids are `wf_` + nanoid(6); nothing else in here is ours to delete. */
const WORKFLOW_DIR_PATTERN = /^wf_[A-Za-z0-9_-]{4,32}$/;

export interface PruneDeps {
  readonly logger: Logger;
  /** Injected in tests. */
  readonly readdir?: typeof readdir;
  readonly stat?: typeof stat;
  readonly rm?: typeof rm;
}

export interface PruneResult {
  readonly scanned: number;
  readonly removed: readonly string[];
}

/**
 * Removes all but the `keep` most recently modified workflow directories under
 * `<workspace>/workflows/`.
 *
 * Best-effort throughout: a missing directory, an unreadable entry or a failed
 * removal is logged and skipped. Pruning must never be able to fail a workflow.
 */
export async function pruneWorkflowArtifacts(
  workspace: string,
  keep: number,
  deps: PruneDeps,
): Promise<PruneResult> {
  const _readdir = deps.readdir ?? readdir;
  const _stat = deps.stat ?? stat;
  const _rm = deps.rm ?? rm;
  const root = join(workspace, "workflows");

  let names: string[];
  try {
    names = await _readdir(root);
  } catch {
    // No workflows directory yet is the normal state for most agents.
    return { scanned: 0, removed: [] };
  }

  const candidates = names.filter((n) => WORKFLOW_DIR_PATTERN.test(n));
  if (candidates.length <= keep) return { scanned: candidates.length, removed: [] };

  const stamped: { name: string; mtimeMs: number }[] = [];
  for (const name of candidates) {
    try {
      const s = await _stat(join(root, name));
      if (s.isDirectory()) stamped.push({ name, mtimeMs: s.mtimeMs });
    } catch {
      // Raced with something else; leaving it is the safe outcome.
    }
  }

  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const doomed = stamped.slice(keep);
  const removed: string[] = [];
  for (const d of doomed) {
    try {
      await _rm(join(root, d.name), { recursive: true, force: true });
      removed.push(d.name);
    } catch (err: unknown) {
      deps.logger.warn(
        {
          component: "workflow-artifact-prune",
          dir: d.name,
          err: err instanceof Error ? err.message : String(err),
        },
        "workflow artifact prune failed for one directory",
      );
    }
  }

  if (removed.length > 0) {
    // Logged rather than silent: a disk-reclaiming deletion the operator cannot
    // see is indistinguishable from data loss when they go looking for a run.
    deps.logger.info(
      {
        component: "workflow-artifact-prune",
        workspace,
        kept: keep,
        removedCount: removed.length,
        removed: removed.slice(0, 10),
      },
      "pruned old workflow artifact directories",
    );
  }
  return { scanned: stamped.length, removed };
}
