/**
 * Phase 100 follow-up — runtime gsd.projectDir override persistence.
 *
 * Backs the `/gsd-set-project` Discord slash command + the `set-gsd-project`
 * IPC handler in daemon.ts. Lets operators switch an agent's GSD project root
 * at runtime without editing `clawcode.yaml` and triggering a config reload
 * race (gsd.projectDir is in NON_RELOADABLE_FIELDS — Phase 100 GSD-07).
 *
 * The override file lives alongside `effort-state.json` at
 * `~/.clawcode/manager/gsd-project-overrides.json` and carries a versioned +
 * atomic shape:
 *
 * ```json
 * {
 *   "version": 1,
 *   "updatedAt": "2026-04-26T19:11:34Z",
 *   "agents": {
 *     "Admin Clawdy": "/opt/clawcode-projects/sandbox",
 *     "fin-client": "/home/example-user/.openclaw/workspace-acme"
 *   }
 * }
 * ```
 *
 * Loader integration: `loadConfig` reads the overrides at boot via
 * `readAllGsdProjectOverrides` and merges them into the resolved config so
 * the override survives daemon restart.
 *
 * Invariants pinned by __tests__/gsd-project-store.test.ts:
 *   - Missing file → `null` for every agent (no throw)
 *   - Corrupt JSON → `null` + warn (daemon must not crash)
 *   - Invalid top-level schema → `null` for any agent (Zod guard)
 *   - `writeGsdProjectOverride` uses `<path>.<rand>.tmp` + `rename()` for
 *     atomicity (mirrors the effort-state-store + v2.1 yaml-writer pattern)
 *
 * Note: dedicated file rather than extending registry.json or effort-state.json
 *   — same boundary discipline as effort-state-store (different lifecycle,
 *   different schema, different recovery).
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod/v4";

/** The canonical file path for the gsd-project-overrides store. */
export const DEFAULT_GSD_PROJECT_OVERRIDES_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "gsd-project-overrides.json",
);

/**
 * The override file schema. agents is a record of agentName → projectDir.
 * Both are non-empty strings — empty values are rejected at parse time.
 */
const gsdProjectOverridesFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  agents: z.record(z.string().min(1), z.string().min(1)),
});

export type GsdProjectOverridesFile = z.infer<
  typeof gsdProjectOverridesFileSchema
>;

const EMPTY: GsdProjectOverridesFile = {
  version: 1,
  updatedAt: "",
  agents: {},
};

/**
 * Read the persisted projectDir override for `agentName` from `filePath`.
 *
 * Returns `null` in ALL failure modes (missing file, corrupt JSON, invalid
 * top-level schema, unknown agent). A missing file is the expected fresh
 * state on first boot — no warn. Any OTHER read / parse failure logs a
 * warn (so operators see real corruption) and still returns `null`.
 */
export async function readGsdProjectOverride(
  filePath: string,
  agentName: string,
  log?: Logger,
): Promise<string | null> {
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
    log?.warn({ filePath, error: msg }, "gsd-project-overrides read failed");
    return null;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn(
      { filePath, error: msg },
      "gsd-project-overrides JSON parse failed",
    );
    return null;
  }

  const parsed = gsdProjectOverridesFileSchema.safeParse(obj);
  if (!parsed.success) {
    log?.warn(
      { filePath, issues: parsed.error.issues.length },
      "gsd-project-overrides file schema invalid, ignoring",
    );
    return null;
  }

  const projectDir = parsed.data.agents[agentName];
  return projectDir ?? null;
}

/**
 * Read ALL persisted overrides as a Map<agentName, projectDir>.
 *
 * Used by the loader at boot to merge overrides into resolvedAgents BEFORE
 * SessionManager spins up sessions. Returns an empty Map on missing file or
 * any parse / schema failure (the daemon must not crash on a corrupt
 * overrides file — operators can fix or delete it).
 */
export async function readAllGsdProjectOverrides(
  filePath: string,
  log?: Logger,
): Promise<Map<string, string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new Map();
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn({ filePath, error: msg }, "gsd-project-overrides read failed");
    return new Map();
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn(
      { filePath, error: msg },
      "gsd-project-overrides JSON parse failed",
    );
    return new Map();
  }
  const parsed = gsdProjectOverridesFileSchema.safeParse(obj);
  if (!parsed.success) {
    log?.warn(
      { filePath, issues: parsed.error.issues.length },
      "gsd-project-overrides file schema invalid, ignoring",
    );
    return new Map();
  }
  return new Map(Object.entries(parsed.data.agents));
}

/**
 * Atomically persist `projectDir` for `agentName` into `filePath`.
 *
 * Read-modify-write pattern:
 *   1. Read + parse existing state (missing / corrupt treated as empty).
 *   2. Merge `{ agentName: projectDir }` into a fresh file shape.
 *   3. Write to `<filePath>.<rand>.tmp` in the same directory.
 *   4. `rename()` tmp → filePath (atomic within the filesystem).
 *
 * The tmp-suffix uses 12 hex bytes of randomness to avoid collisions when
 * two writes happen concurrently. Directory created recursively on first write.
 */
export async function writeGsdProjectOverride(
  filePath: string,
  agentName: string,
  projectDir: string,
  log?: Logger,
): Promise<void> {
  const existing = await readExistingOrEmpty(filePath);
  const next: GsdProjectOverridesFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents: { ...existing.agents, [agentName]: projectDir },
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  log?.debug(
    { agent: agentName, projectDir },
    "gsd-project-override persisted",
  );
}

/**
 * Remove `agentName` from the persisted overrides, leaving siblings intact.
 * No-ops silently when file is missing or corrupt (nothing to clear).
 */
export async function clearGsdProjectOverride(
  filePath: string,
  agentName: string,
  log?: Logger,
): Promise<void> {
  const existing = await readExistingOrEmpty(filePath);
  if (!(agentName in existing.agents)) return;
  const next: GsdProjectOverridesFile = {
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
  log?.debug({ agent: agentName }, "gsd-project-override cleared");
}

/**
 * Shared read-existing helper for write + clear. Returns a fresh empty file
 * shape on ANY failure (missing, unparseable, invalid schema). Callers treat
 * corrupt files as "start fresh" — an already-broken file must not block
 * future writes.
 */
async function readExistingOrEmpty(
  filePath: string,
): Promise<GsdProjectOverridesFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = gsdProjectOverridesFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through — treat as empty */
  }
  return EMPTY;
}
