/**
 * Phase 96 Plan 01 — atomic filesystem-capability snapshot persistence.
 *
 * Mirrors src/sync/sync-state-store.ts:75-160 verbatim. Atomic temp+rename:
 *   1. mkdir -p parent dir
 *   2. write to <path>.<rand>.tmp (same dir → atomic rename)
 *   3. rename(tmp, finalPath)
 *
 * Schema-validated read with graceful null fallback on
 * missing/corrupt/invalid. Reload-safe across daemon restarts. Persists
 * to ~/.clawcode/agents/<agent>/fs-capability.json — operator-observable
 * state for /clawcode-status + clawcode fs-status (Plan 96-05).
 *
 * IMPORTANT: readFsSnapshot is for diagnostics/UI surfaces — NOT for
 * short-circuiting fresh probes at boot. Cold-start re-probe; trust the
 * file ONLY for observability (per 96-01-PLAN.md pitfalls).
 */

import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import type { Logger } from "pino";
import type { FsCapabilitySnapshot } from "./persistent-session-handle.js";

/**
 * Pure-DI deps surface. Production wires node:fs/promises.{writeFile,
 * rename, mkdir, readFile} at the daemon edge. Tests stub all four.
 */
export interface FsSnapshotStoreDeps {
  readonly writeFile: (
    path: string,
    data: string,
    encoding: "utf8",
  ) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly mkdir: (
    path: string,
    options: { recursive: true },
  ) => Promise<void>;
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly log?: Logger;
}

/**
 * On-disk payload shape. The agent name is captured for ops/debug
 * (filesystem path already encodes it). lastProbeAt is the snapshot's
 * own write time (the runner's "this is when I serialized" stamp); each
 * path entry has its own lastProbeAt from the probe primitive.
 */
export interface FsSnapshotPayload {
  readonly agent: string;
  readonly lastProbeAt: string;
  readonly paths: Readonly<Record<string, FsCapabilitySnapshot>>;
}

/**
 * Zod schema for per-entry FsCapabilitySnapshot. Mirrors the TypeScript
 * shape declared on persistent-session-handle.ts. Used by readFsSnapshot
 * for safe parsing of disk content.
 */
const fsCapabilitySnapshotEntrySchema = z.object({
  status: z.enum(["ready", "degraded", "unknown"]),
  mode: z.enum(["rw", "ro", "denied"]),
  lastProbeAt: z.string().min(1),
  lastSuccessAt: z.string().min(1).optional(),
  error: z.string().optional(),
});

/** Top-level payload schema. */
const fsSnapshotPayloadSchema = z.object({
  agent: z.string().min(1),
  lastProbeAt: z.string().min(1),
  paths: z.record(z.string(), fsCapabilitySnapshotEntrySchema),
});

/**
 * Compute the canonical fs-capability.json path for a given agent. The
 * production path is ~/.clawcode/agents/<agent>/fs-capability.json (per
 * 96-CONTEXT.md). Exported for daemon wiring + slash/CLI consumers.
 *
 * NOTE: ~ expansion is the caller's responsibility (production resolves
 * via os.homedir at the daemon edge).
 */
export const DEFAULT_FS_CAPABILITY_FILENAME = "fs-capability.json";

/**
 * Atomically persist `snapshot` to `filePath`. Mirrors
 * src/sync/sync-state-store.ts:writeSyncState verbatim. Random suffix
 * (12 hex chars) prevents tmp filename collision under concurrent writes.
 *
 * Order: mkdir → writeFile(tmp) → rename(tmp, finalPath). Each step
 * awaited so callers get a single observable error per operation.
 *
 * NEVER mutates `snapshot` (ReadonlyMap input).
 */
export async function writeFsSnapshot(
  agent: string,
  snapshot: ReadonlyMap<string, FsCapabilitySnapshot>,
  filePath: string,
  deps: FsSnapshotStoreDeps,
  now: () => Date = () => new Date(),
): Promise<void> {
  await deps.mkdir(dirname(filePath), { recursive: true });
  const suffix = randomBytes(6).toString("hex");
  const tmp = `${filePath}.${suffix}.tmp`;
  const payload: FsSnapshotPayload = {
    agent,
    lastProbeAt: now().toISOString(),
    paths: Object.fromEntries(snapshot),
  };
  await deps.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await deps.rename(tmp, filePath);
  deps.log?.debug?.(
    { filePath, agent, pathCount: snapshot.size },
    "fs-capability persisted",
  );
}

/**
 * Read + schema-validate the persisted snapshot. Returns a ReadonlyMap
 * keyed by canonical absPath, or null on any failure (missing file,
 * corrupt JSON, schema mismatch).
 *
 * Failure logs:
 *   - Missing file (ENOENT) → silent (first-boot path; expected)
 *   - Corrupt JSON         → log.warn
 *   - Schema mismatch      → log.warn
 */
export async function readFsSnapshot(
  filePath: string,
  deps: FsSnapshotStoreDeps,
): Promise<ReadonlyMap<string, FsCapabilitySnapshot> | null> {
  let raw: string;
  try {
    raw = await deps.readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      deps.log?.warn?.(
        { filePath, error: err instanceof Error ? err.message : String(err) },
        "fs-capability read failed",
      );
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    deps.log?.warn?.(
      { filePath, error: err instanceof Error ? err.message : String(err) },
      "fs-capability JSON parse failed",
    );
    return null;
  }

  const result = fsSnapshotPayloadSchema.safeParse(parsed);
  if (!result.success) {
    deps.log?.warn?.(
      { filePath, issueCount: result.error.issues.length },
      "fs-capability schema mismatch",
    );
    return null;
  }

  return new Map(Object.entries(result.data.paths));
}
