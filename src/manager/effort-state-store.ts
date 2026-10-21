/**
 * Phase 83 Plan 02 Task 1 — Runtime effort-state persistence (EFFORT-03).
 *
 * Per-agent runtime effort overrides survive daemon + agent restarts. The
 * persistence file lives alongside the existing registry.json at
 * `~/.clawcode/manager/effort-state.json` and carries a versioned +
 * atomic shape:
 *
 * ```json
 * {
 *   "version": 1,
 *   "updatedAt": "2026-04-21T17:00:00.000Z",
 *   "agents": {
 *     "clawdy": "high",
 *     "fin-client": "max"
 *   }
 * }
 * ```
 *
 * Invariants pinned by __tests__/effort-state-store.test.ts:
 *   - Missing file → `null` for every agent (no throw)
 *   - Corrupt JSON → `null` + warn (daemon must not crash)
 *   - Invalid top-level schema → `null` for any agent (Zod guard)
 *   - `writeEffortState` uses `<path>.<rand>.tmp` + `rename()` for atomicity
 *     (mirrors the v2.1 yaml-writer pattern from
 *     src/migration/yaml-writer.ts); the tmp file lives in the SAME dir so
 *     rename is atomic within the filesystem.
 *   - Fire-and-forget callers (SessionManager.setEffortForAgent) rely on
 *     `.catch`-logging — persistence failure MUST NOT abort the turn.
 *
 * Note: we keep a dedicated file rather than extending registry.json because
 *   - registry.json is a fleet-status ledger with its own zod schema + recovery
 *     logic; overloading it pollutes boundaries and complicates hot-reload.
 *   - effort-state is runtime-only mutable state — registry.json is
 *     predominantly status + session IDs.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod/v4";
import { effortSchema, type EffortLevel } from "../config/schema.js";

/** The canonical file path for the effort-state store. */
export const DEFAULT_EFFORT_STATE_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "effort-state.json",
);

// Quick 260715-j1j review IN-01 — the ENVELOPE is validated strictly, but
// per-agent values are `z.unknown()` and validated INDIVIDUALLY (per-entry
// salvage below): one unknown level — e.g. a persisted "ultracode" read by
// code whose effortSchema predates it, or a future 9th level under rollback
// — drops only THAT entry instead of resetting every agent's override.
// NOTE: this only helps FORWARD-compat of code carrying this fix; already-
// deployed OLD code still whole-file-rejects (documented D13 blast radius).
const effortStateEnvelopeSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  agents: z.record(z.string(), z.unknown()),
});

export type EffortStateFile = {
  version: 1;
  updatedAt: string;
  agents: Record<string, EffortLevel>;
};

/**
 * Per-entry salvage (IN-01): split a raw agents record into valid levels and
 * the names of dropped invalid entries. Pure — callers own the warn log.
 */
function salvageAgentEntries(raw: Record<string, unknown>): {
  agents: Record<string, EffortLevel>;
  dropped: string[];
} {
  const agents: Record<string, EffortLevel> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const parsed = effortSchema.safeParse(value);
    if (parsed.success) {
      agents[name] = parsed.data;
    } else {
      dropped.push(name);
    }
  }
  return { agents, dropped };
}

const EMPTY: EffortStateFile = {
  version: 1,
  updatedAt: "",
  agents: {},
};

/**
 * Read the persisted effort level for `agentName` from `filePath`.
 *
 * Returns `null` in ALL failure modes (missing file, corrupt JSON, invalid
 * top-level schema, unknown agent). A missing file is the expected fresh
 * state on first boot — no warn. Any OTHER read / parse failure logs a
 * warn (so operators see real corruption) and still returns `null`.
 */
export async function readEffortState(
  filePath: string,
  agentName: string,
  log?: Logger,
): Promise<EffortLevel | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // First-boot / no-persistence path — silent.
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn({ filePath, error: msg }, "effort-state read failed");
    return null;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn({ filePath, error: msg }, "effort-state JSON parse failed");
    return null;
  }

  const parsed = effortStateEnvelopeSchema.safeParse(obj);
  if (!parsed.success) {
    log?.warn(
      { filePath, issues: parsed.error.issues.length },
      "effort-state file schema invalid, ignoring",
    );
    return null;
  }

  // Quick 260715-j1j review IN-01 — per-entry salvage: an unknown level on
  // ANY sibling no longer nulls the whole record; only invalid entries are
  // dropped (warn lists them so operators see the salvage happen).
  const { agents, dropped } = salvageAgentEntries(parsed.data.agents);
  if (dropped.length > 0) {
    log?.warn(
      { filePath, dropped },
      "effort-state: dropped invalid persisted entries (per-entry salvage); valid siblings kept",
    );
  }
  return agents[agentName] ?? null;
}

/**
 * Atomically persist `level` for `agentName` into `filePath`.
 *
 * Read-modify-write pattern:
 *   1. Read + parse existing state (missing / corrupt treated as empty).
 *   2. Merge `{ agentName: level }` into a fresh file shape.
 *   3. Write to `<filePath>.<rand>.tmp` in the same directory.
 *   4. `rename()` tmp → filePath (atomic within the filesystem).
 *
 * The tmp-suffix uses 12 hex bytes of randomness to avoid collisions when
 * two agents persist concurrently (SessionManager currently serializes
 * per-agent, but the store itself must be safe for future concurrent
 * callers). Directory is created recursively on first write.
 */
export async function writeEffortState(
  filePath: string,
  agentName: string,
  level: EffortLevel,
  log?: Logger,
): Promise<void> {
  const existing = await readExistingOrEmpty(filePath);
  const next: EffortStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents: { ...existing.agents, [agentName]: level },
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  log?.debug({ agent: agentName, level }, "effort-state persisted");
}

/**
 * Remove `agentName` from the persisted state, leaving other agents intact.
 * No-ops silently when the file is missing or corrupt (nothing to clear).
 *
 * NOTE: SessionManager.stopAgent does NOT call this by design — runtime
 * effort must survive stop/start. Only an explicit reset path (out of
 * scope for Plan 02) would invoke `clearEffortState`.
 */
export async function clearEffortState(
  filePath: string,
  agentName: string,
  log?: Logger,
): Promise<void> {
  const existing = await readExistingOrEmpty(filePath);
  if (!(agentName in existing.agents)) {
    return; // nothing to clear
  }
  // Build `next` with `agentName` excluded — immutable patterns per
  // global coding-style rules (never mutate existing).
  const next: EffortStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents: Object.fromEntries(
      Object.entries(existing.agents).filter(([k]) => k !== agentName),
    ),
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  log?.debug({ agent: agentName }, "effort-state cleared");
}

/**
 * Shared read-existing helper for writeEffortState + clearEffortState.
 * Returns a fresh empty file shape on ANY failure (missing, unparseable,
 * invalid envelope). Callers treat corrupt files as "start fresh" rather
 * than abort — an already-broken file must not block future writes.
 *
 * Quick 260715-j1j review IN-01 — per-entry salvage here too: a write
 * against a file with ONE invalid sibling entry must not clobber every
 * other agent's valid override (the old whole-file parse reset to EMPTY).
 */
async function readExistingOrEmpty(filePath: string): Promise<EffortStateFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = effortStateEnvelopeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      const { agents } = salvageAgentEntries(parsed.data.agents);
      return { version: 1, updatedAt: parsed.data.updatedAt, agents };
    }
  } catch {
    /* fall through — treat as empty */
  }
  return EMPTY;
}
