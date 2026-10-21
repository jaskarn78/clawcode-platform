/**
 * Phase 91 Plan 01 Task 1 — Sync-state persistence (SYNC-01 + SYNC-02 + SYNC-05).
 *
 * Persists the continuous-sync state at `~/.clawcode/manager/sync-state.json`:
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "updatedAt": "2026-04-24T19:36:00.000Z",
 *   "authoritativeSide": "openclaw",
 *   "lastSyncedAt": "2026-04-24T19:30:00.000Z",
 *   "openClawHost": "example-user@10.0.0.3",
 *   "openClawWorkspace": "/home/example-user/.openclaw/workspace-acme",
 *   "clawcodeWorkspace": "/home/clawcode/.clawcode/agents/acme",
 *   "perFileHashes": { "MEMORY.md": "ab12...", "memory/2026-04-24.md": "cd34..." },
 *   "conflicts": [],
 *   "openClawSessionCursor": null
 * }
 * ```
 *
 * Invariants (pinned by __tests__/sync-state-store.test.ts):
 *   - Missing file → DEFAULT_SYNC_STATE (no throw, no warn — first-boot path)
 *   - Corrupt JSON → DEFAULT_SYNC_STATE + warn (daemon must not crash)
 *   - Invalid schema → DEFAULT_SYNC_STATE + warn (Zod safeParse fallback)
 *   - writeSyncState uses `<path>.<rand>.tmp` + rename() for atomicity
 *     (mirrors src/manager/effort-state-store.ts exactly per Phase 83
 *     blueprint; tmp lives in the SAME dir so rename is atomic within FS)
 *   - updateSyncStateConflict is idempotent — duplicate unresolved conflicts
 *     for the same path collapse to one entry
 *   - Immutable: writeSyncState NEVER mutates the passed-in SyncStateFile
 *
 * Mirrors the Phase 83 effort-state-store.ts pattern verbatim — if you need
 * to understand the atomic temp+rename discipline, read that file first.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import {
  syncStateFileSchema,
  type SyncStateFile,
  type SyncConflict,
} from "./types.js";

/** Canonical file path for the sync-state store. */
export const DEFAULT_SYNC_STATE_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "sync-state.json",
);

/** Canonical JSONL observability log path (consumed by Plan 91-05). */
export const DEFAULT_SYNC_JSONL_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "sync.jsonl",
);

/**
 * Factory-default sync state used on first boot + as fallback when the
 * persisted file is missing, unparseable, or schema-invalid.
 *
 * Defaults encode the fin-client sync topology (D-01): OpenClaw on
 * 10.0.0.3 is authoritative, pull direction from example-user's workspace
 * into the clawcode user's agents/acme directory. Operator flips
 * authoritativeSide via `clawcode sync set-authoritative` (Plan 91-04).
 */
export const DEFAULT_SYNC_STATE: SyncStateFile = {
  version: 1,
  updatedAt: "",
  authoritativeSide: "openclaw",
  lastSyncedAt: null,
  openClawHost: "example-user@10.0.0.3",
  openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
  clawcodeWorkspace: "/home/clawcode/.clawcode/agents/acme",
  perFileHashes: {},
  conflicts: [],
  openClawSessionCursor: null,
};

/**
 * Read the persisted sync state from `filePath`.
 *
 * Returns DEFAULT_SYNC_STATE in ALL failure modes (missing file, corrupt
 * JSON, invalid schema). Missing file is the expected first-boot path —
 * no warn. Other failures log a warn (so operators see real corruption)
 * and still return a usable default so the runner can proceed.
 */
export async function readSyncState(
  filePath: string,
  log?: Logger,
): Promise<SyncStateFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // First-boot / no-persistence path — silent.
      return DEFAULT_SYNC_STATE;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn({ filePath, error: msg }, "sync-state read failed");
    return DEFAULT_SYNC_STATE;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn({ filePath, error: msg }, "sync-state JSON parse failed");
    return DEFAULT_SYNC_STATE;
  }

  const parsed = syncStateFileSchema.safeParse(obj);
  if (!parsed.success) {
    log?.warn(
      { filePath, issues: parsed.error.issues.length },
      "sync-state file schema invalid, using defaults",
    );
    return DEFAULT_SYNC_STATE;
  }

  return parsed.data;
}

/**
 * Atomically persist `next` to `filePath`.
 *
 * Pattern mirrors src/manager/effort-state-store.ts exactly:
 *   1. mkdir -p parent dir.
 *   2. Write to `<filePath>.<rand>.tmp` (same dir → atomic rename).
 *   3. rename() tmp → filePath.
 *
 * The tmp suffix uses 6 random bytes (12 hex chars) to avoid collisions
 * under concurrent writers. This function NEVER mutates `next`; callers
 * should construct a new SyncStateFile via object spread.
 */
export async function writeSyncState(
  filePath: string,
  next: SyncStateFile,
  log?: Logger,
): Promise<void> {
  // Enforce immutability: freeze-friendly — we never touch `next` again.
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  log?.debug(
    {
      filePath,
      authoritativeSide: next.authoritativeSide,
      fileCount: Object.keys(next.perFileHashes).length,
    },
    "sync-state persisted",
  );
}

/**
 * Append a new conflict to `conflicts[]`. Idempotent: if the given path
 * already has an unresolved entry (resolvedAt === null), this is a no-op.
 * If the prior entry is resolved (resolvedAt !== null), a fresh conflict
 * is appended — represents a new divergence after a prior resolution.
 *
 * Consumed by Plan 91-02 conflict detection. Atomic via writeSyncState.
 */
export async function updateSyncStateConflict(
  filePath: string,
  conflict: SyncConflict,
  log?: Logger,
): Promise<void> {
  const existing = await readSyncState(filePath, log);
  const alreadyUnresolved = existing.conflicts.some(
    (c) => c.path === conflict.path && c.resolvedAt === null,
  );
  if (alreadyUnresolved) {
    return; // idempotent
  }
  const next: SyncStateFile = {
    ...existing,
    updatedAt: new Date().toISOString(),
    conflicts: [...existing.conflicts, conflict],
  };
  await writeSyncState(filePath, next, log);
}

/**
 * Mark a conflict resolved (Plan 91-04's `clawcode sync resolve` CLI).
 *
 * Strategy: set resolvedAt on matching unresolved entries instead of
 * removing them — operator may want audit trail. If you need to purge,
 * filter out resolved entries older than N days in a separate finalize
 * path (Plan 91-05 log-rotation).
 */
export async function clearSyncStateConflict(
  filePath: string,
  path: string,
  log?: Logger,
): Promise<void> {
  const existing = await readSyncState(filePath, log);
  const resolvedAt = new Date().toISOString();
  const nextConflicts = existing.conflicts.map((c) =>
    c.path === path && c.resolvedAt === null ? { ...c, resolvedAt } : c,
  );
  // Skip write if nothing changed — avoids spurious updatedAt bumps.
  const changed = nextConflicts.some(
    (c, i) => c !== existing.conflicts[i],
  );
  if (!changed) return;
  const next: SyncStateFile = {
    ...existing,
    updatedAt: new Date().toISOString(),
    conflicts: nextConflicts,
  };
  await writeSyncState(filePath, next, log);
}
