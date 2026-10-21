import {
  readFile,
  rename,
  mkdir,
  copyFile,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Registry, RegistryEntry } from "./types.js";
import { ManagerError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { parentAgentName } from "./subagent-name.js";

// 260419-q2z Fix C — warn-log calls go through the base `logger` directly
// (NOT a child logger) so `vi.spyOn(logger, "warn")` intercepts them in
// tests. Component is attached as a field on each call instead of via
// child bindings.
const log = {
  warn: (obj: Record<string, unknown>, msg: string): void => {
    logger.warn({ component: "registry", ...obj }, msg);
  },
};

/**
 * Empty registry constant — used as the default when no registry file exists.
 */
export const EMPTY_REGISTRY: Registry = {
  entries: [],
  updatedAt: 0,
} as const;

// ---------------------------------------------------------------------------
// 260419-q2z Fix C — DI seam for fsync simulation.
// Tests inject a fake fsync (e.g. one that rejects EINVAL) to verify the
// best-effort fsync path. Production leaves this null.
// ---------------------------------------------------------------------------
let _fsyncOverride: ((fh: FileHandle) => Promise<void>) | null = null;

/**
 * Test-only hook to override the internal fsync call with a custom function.
 * Pass `null` to restore production behavior. DO NOT USE IN PRODUCTION CODE.
 */
export function _setFsyncForTests(
  fn: ((fh: FileHandle) => Promise<void>) | null,
): void {
  _fsyncOverride = fn;
}

/**
 * Attempt to parse the given path as a registry JSON file. Returns the parsed
 * registry on success, or null if the file is missing OR unparseable.
 *
 * 260419-q2z Fix C — used by {@link readRegistry} to try `path`, then `.bak`,
 * then `.tmp` (pre-rename state) in sequence before giving up.
 */
async function tryReadCandidate(path: string): Promise<Registry | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    // Any other read error (permission, IO) bubbles — the caller decides.
    throw error;
  }
  try {
    return JSON.parse(raw) as Registry;
  } catch {
    return null;
  }
}

/**
 * Read the registry from a JSON file on disk.
 * Returns EMPTY_REGISTRY if the file does not exist.
 *
 * 260419-q2z Fix C — when the primary file is corrupt, attempts recovery from
 * `${path}.bak` (the pre-write snapshot) and `${path}.tmp` (pre-rename state
 * from a mid-write crash) in that order. Throws a {@link ManagerError} with a
 * `clawcode registry repair` hint ONLY when all three candidates are corrupt
 * or absent.
 *
 * @param path - Absolute path to the registry JSON file
 */
export async function readRegistry(path: string): Promise<Registry> {
  // Primary: read path, parse, done.
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return EMPTY_REGISTRY;
    }
    throw error;
  }

  try {
    return JSON.parse(raw) as Registry;
  } catch {
    // Primary is corrupt. Try recovery candidates in priority order.
    const bakPath = `${path}.bak`;
    const bak = await tryReadCandidate(bakPath);
    if (bak !== null) {
      log.warn(
        { path, recoveredFrom: bakPath },
        "recovered from .bak (primary registry corrupt)",
      );
      return bak;
    }
    const tmpPath = `${path}.tmp`;
    const tmp = await tryReadCandidate(tmpPath);
    if (tmp !== null) {
      log.warn(
        { path, recoveredFrom: tmpPath },
        "recovered from .tmp (pre-rename state)",
      );
      return tmp;
    }
    const err = new ManagerError(
      `Corrupt registry file at ${path}: invalid JSON. Run \`clawcode registry repair\` to auto-trim trailing garbage.`,
    );
    err.name = "ManagerError";
    throw err;
  }
}

/**
 * Write the registry to disk atomically with pre-write backup + fsync.
 *
 * 260419-q2z Fix C — corruption-proof pipeline:
 *   1. Copy existing `path` → `path.bak` (skipped on first-ever write).
 *   2. Open `path.tmp`, write the JSON, best-effort fsync, close.
 *   3. Rename `path.tmp` → `path` (POSIX atomic inode swap).
 *
 * fsync errors are logged at warn and swallowed (ramdisks, tmpfs on some FUSE
 * mounts, overlayfs, and Docker-for-Mac can reject fsync). The rename step
 * still runs so the write completes; durability is best-effort.
 *
 * Signature preserved: `Promise<void>`. No caller changes required.
 *
 * @param path - Absolute path to the registry JSON file
 * @param registry - The registry state to persist
 */
export async function writeRegistry(
  path: string,
  registry: Registry,
): Promise<void> {
  const dir = dirname(path);

  try {
    await mkdir(dir, { recursive: true });

    const json = JSON.stringify(registry, null, 2);

    // Step 1 — copy current path to .bak before touching anything. Ignore
    // ENOENT (first-ever write has nothing to back up).
    const bakPath = `${path}.bak`;
    try {
      await copyFile(path, bakPath);
    } catch (error: unknown) {
      if (!(isNodeError(error) && error.code === "ENOENT")) {
        throw error;
      }
    }

    // Step 2 — open tmp, write, best-effort fsync, close.
    //
    // Each concurrent write uses a unique PID+counter-suffixed staging path
    // so two writers cannot truncate each other's staging file mid-flight.
    // The canonical `${path}.tmp` is cleaned up on the happy path so
    // readRegistry's .tmp recovery only returns a result after a real
    // mid-rename crash (not a test teardown race).
    const tmpPath = `${path}.tmp`;
    const stagingPath = `${tmpPath}.${process.pid}.${_stagingCounter++}`;
    const fh = await open(stagingPath, "w");
    try {
      await fh.writeFile(json, "utf-8");
      try {
        const fsync = _fsyncOverride ?? ((handle) => handle.sync());
        await fsync(fh);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        log.warn(
          { path, err: message },
          "fsync skipped (filesystem does not support fsync)",
        );
      }
    } finally {
      await fh.close();
    }

    // Step 3 — atomic rename stagingPath → path. POSIX atomic inode swap:
    // readers see either the pre-rename inode or the post-rename inode; no
    // torn state possible.
    await rename(stagingPath, path);

    // Best-effort cleanup of any stale canonical tmp left behind by a prior
    // interrupted write (pre-rename crash). Ignore ENOENT.
    try {
      await unlink(tmpPath);
    } catch (error: unknown) {
      if (!(isNodeError(error) && error.code === "ENOENT")) {
        throw error;
      }
    }
  } catch (error: unknown) {
    // ENOENT at the outermost level means the target directory was
    // unlinked during the write — either a test teardown race (rm -rf on
    // tmpDir while a detached crash-write was still in flight) or a
    // concurrent operator `rm` of ~/.clawcode/. Neither is a programming
    // error in SessionManager; the registry simply no longer exists. Log
    // at debug and swallow. Any other error propagates normally.
    if (isNodeError(error) && error.code === "ENOENT") {
      log.warn(
        { path, err: error.message },
        "writeRegistry: target path vanished mid-write (likely teardown race) — skipping",
      );
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Atomic read-modify-write — lost-update guard for the agent registry.
//
// `readRegistry → mutate → writeRegistry` is NOT atomic on its own: two
// concurrent callers both read the same snapshot and the second write clobbers
// the first's entry, after which the clobbered agent's next `updateEntry`
// throws "Agent '<name>' not found in registry". This is the file-level analog
// of the 999.65 thread-registry lost-update, and it is exactly what made
// concurrent workflow worker spawns (`WorkflowOrchestrator.fanOut`) fail
// ~1-of-2 ("not found in registry" at registry.ts).
//
// `mutateRegistry` serializes the whole read→modify→write behind a per-path
// in-process promise chain (mirrors `mutateThreadRegistry` and the
// SessionManager `withLifecycleLock`) so each caller observes the previous
// caller's committed write. The lock is held ONLY across the brief read + sync
// transform + write — NEVER across a caller's own long async work
// (createSession / warm-path). So agent starts (and thus parallel fan-out) keep
// running concurrently; only the registry bookkeeping serializes.
//
// Single-writer scope: the live agent registry has exactly one writer process
// (the daemon — SessionManager + SessionRecovery + the daemon boot/sweep
// paths). An in-process chain is therefore sufficient; unlike the thread
// registry, no cross-process file lock is needed (the only other writer,
// `clawcode registry repair`, is an offline operator action run with the daemon
// stopped).
//
// Contract (same shape as mutateThreadRegistry):
//   - `mutator` MUST be SYNCHRONOUS and PURE: take the current registry, return
//     the next one, never mutate the input. The synchronous-ness is
//     load-bearing — a sync mutator cannot `await mutateRegistry`, so re-entrant
//     self-deadlock is structurally impossible.
//   - Return the SAME registry reference to signal "no change"; the write is
//     then skipped (preserves callers' historical no-op-no-write behavior).
//   - A throw inside the mutator (e.g. `updateEntry` on a missing entry)
//     propagates to THIS caller but never poisons the chain for the next.
//   - Returns the persisted (or unchanged) registry so callers can keep their
//     `registry` scratch var populated without a second read.
// ---------------------------------------------------------------------------
const registryWriteChains = new Map<string, Promise<unknown>>();

export async function mutateRegistry(
  path: string,
  mutator: (current: Registry) => Registry,
): Promise<Registry> {
  // Normalize so two spellings of the same file (relative vs absolute, trailing
  // slash, `.`/`..` segments) can never bifurcate into separate chains and
  // silently drop the lock between writers.
  const key = resolve(path);
  const critical = async (): Promise<Registry> => {
    const current = await readRegistry(path);
    const next = mutator(current);
    if (next !== current) {
      await writeRegistry(path, next);
    }
    return next;
  };
  const prev = registryWriteChains.get(key) ?? Promise.resolve();
  const run = prev.then(critical, critical);
  // Non-rejecting tail keeps the chain flowing after a throwing critical
  // section — the rejection still surfaces to this caller via `run`.
  registryWriteChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * 260419-q2z Fix C — per-process staging counter. Used to build a unique tmp
 * path so concurrent writeRegistry calls on the same file cannot truncate
 * each other's staging file before rename.
 */
let _stagingCounter = 0;

/**
 * Create a new registry entry with default values.
 * Status is "stopped", all counters are 0, all nullable fields are null.
 *
 * @param name - The agent name
 */
export function createEntry(name: string): RegistryEntry {
  return {
    name,
    status: "stopped",
    sessionId: null,
    startedAt: null,
    restartCount: 0,
    consecutiveFailures: 0,
    lastError: null,
    lastStableAt: null,
    // Phase 56 Plan 01 — warm-path fields default to pre-check state.
    warm_path_ready: false,
    warm_path_readiness_ms: null,
    // clawdy-v2-stability (2026-04-19) — stoppedAt is populated only when
    // stopAgent transitions the entry to status="stopped". A newly-created
    // entry is never "already stopped" in the reap sense, so null here.
    stoppedAt: null,
  };
}

/**
 * Update a named entry in the registry, returning a new Registry object.
 * Does NOT mutate the original registry (immutable update).
 * Throws ManagerError if the named agent is not found.
 *
 * @param registry - The current registry state
 * @param name - The agent name to update
 * @param updates - Partial fields to merge into the entry
 */
export function updateEntry(
  registry: Registry,
  name: string,
  updates: Partial<Omit<RegistryEntry, "name">>,
): Registry {
  const index = registry.entries.findIndex((e) => e.name === name);
  if (index === -1) {
    throw new ManagerError(`Agent '${name}' not found in registry`);
  }

  const existingEntry = registry.entries[index];
  const updatedEntry: RegistryEntry = { ...existingEntry, ...updates };

  const newEntries = registry.entries.map((entry, i) =>
    i === index ? updatedEntry : entry,
  );

  return {
    entries: newEntries,
    updatedAt: Date.now(),
  };
}

/**
 * A registry entry removed by {@link reconcileRegistry}, together with the
 * reason the pruner rejected it. Emitted for ops logging so operators can
 * trace ghost-entry removals in journalctl.
 */
export type PrunedEntry = {
  readonly name: string;
  readonly reason:
    | "unknown-agent"
    | "orphaned-subagent"
    | "orphaned-thread"
    | "stale-subagent"
    | "stale-thread"
    | "phantom-subagent"
    | "phantom-thread";
};

/**
 * Default TTL for reaping stopped subagent / thread-session entries. Any
 * sub/thread entry with `status:"stopped"` and a `stoppedAt` older than this
 * TTL (or missing `stoppedAt` — legacy pre-fix data) is considered abandoned
 * and pruned by {@link reconcileRegistry}. 1 hour balances "keep recently-stopped
 * entries visible in dashboards for debug" against "don't let gravestones
 * accumulate for days". Parent agents are NEVER reaped by this TTL — only
 * `*-sub-*` and `*-thread-*` entries.
 */
export const STOPPED_SUBAGENT_REAP_TTL_MS = 60 * 60 * 1000;

/**
 * Reconcile the registry against the currently-configured set of agents.
 *
 * Returns a new Registry with ghost entries removed, plus a list of pruned
 * entries for logging. Does NOT mutate the input registry.
 *
 * Retention rules (an entry is KEPT iff any of these is true):
 *   1. `entry.name` is in `knownAgentNames` (a configured agent). Parent
 *      agents are NEVER TTL-reaped — even when stopped they represent
 *      actual configured agents and the operator expects persistent state.
 *   2. `entry.name` matches `{parent}-sub-{id}` OR the delegated form
 *      `{parent}-via-{delegate}-{id}` (Phase 999.3) AND parent ∈
 *      `knownAgentNames` AND the entry is either not stopped, or stopped
 *      within the reap TTL.
 *   3. `entry.name` matches `{parent}-thread-{id}` AND parent ∈ `knownAgentNames`
 *      AND the entry is either not stopped, or stopped within the reap TTL.
 *
 * Any other entry is pruned with a reason:
 *   - `"unknown-agent"` — no `-sub-` / `-via-` / `-thread-` suffix, and name
 *     not in `knownAgentNames`.
 *   - `"orphaned-subagent"` — has a `-sub-` / `-via-` suffix but parent
 *     segment is empty or not in `knownAgentNames`.
 *   - `"orphaned-thread"` — has `-thread-` suffix but parent segment is empty
 *     or not in `knownAgentNames`.
 *   - `"stale-subagent"` — subagent whose parent IS configured but the entry
 *     has been `status:"stopped"` longer than {@link STOPPED_SUBAGENT_REAP_TTL_MS}
 *     (or the entry predates the `stoppedAt` field, meaning it's legacy zombie
 *     data and should be cleaned up on first boot with the new reap path).
 *   - `"stale-thread"` — same rule for thread-session entries.
 *   - `"phantom-subagent"` — subagent whose parent IS configured, `status` is
 *     NOT `"stopped"` (e.g. `"running"` / `"starting"`), AND the caller passed
 *     `pruneNonStoppedSubagents: true`. Used on daemon boot to reap entries
 *     whose child process crashed in a prior daemon instance before
 *     `stopAgent` could transition them to `"stopped"` — no child process is
 *     alive across a daemon restart, so any non-stopped sub/thread entry at
 *     boot is by definition a phantom.
 *   - `"phantom-thread"` — same rule for thread-session entries.
 *
 * Names like `-sub-foo` / `-thread-foo` (empty parent segment) are routed to
 * `orphaned-subagent` / `orphaned-thread` respectively — structurally they
 * look like subagent/thread sessions with a broken parent, and the empty
 * string is never treated as a live parent even if it happens to be present
 * in `knownAgentNames`.
 *
 * When no pruning occurs the original registry is returned by reference
 * (identity-equal) so callers can skip the `writeRegistry` call entirely
 * on clean boots. When pruning occurs, `updatedAt` bumps to `now`.
 *
 * @param registry         The current registry state
 * @param knownAgentNames  The set of agent names currently configured
 * @param options          Optional overrides for reap behavior — `now` is
 *                         injected for tests; `reapTtlMs` defaults to
 *                         {@link STOPPED_SUBAGENT_REAP_TTL_MS};
 *                         `pruneNonStoppedSubagents` enables phantom reaping
 *                         (daemon passes `true` at boot — see JSDoc above).
 */
export function reconcileRegistry(
  registry: Registry,
  knownAgentNames: ReadonlySet<string>,
  options: {
    readonly now?: number;
    readonly reapTtlMs?: number;
    readonly pruneNonStoppedSubagents?: boolean;
  } = {},
): { readonly registry: Registry; readonly pruned: readonly PrunedEntry[] } {
  const now = options.now ?? Date.now();
  const reapTtlMs = options.reapTtlMs ?? STOPPED_SUBAGENT_REAP_TTL_MS;
  const pruneNonStopped = options.pruneNonStoppedSubagents ?? false;

  const pruned: PrunedEntry[] = [];
  const kept: RegistryEntry[] = [];

  /**
   * True when the sub/thread entry should be TTL-reaped — i.e. it is fully
   * stopped and either (a) stoppedAt is older than the TTL or (b) stoppedAt
   * is missing (legacy pre-fix data — treat as stopped long ago).
   *
   * Non-stopped statuses (starting / running / stopping / crashed / restarting /
   * failed) are always retained regardless of stoppedAt so we never reap an
   * entry mid-lifecycle. `failed` in particular is kept so operators can see
   * the terminal failure in the dashboard.
   */
  const isStaleStopped = (entry: RegistryEntry): boolean => {
    if (entry.status !== "stopped") return false;
    if (entry.stoppedAt == null) return true; // legacy entry — reap immediately
    return now - entry.stoppedAt >= reapTtlMs;
  };

  for (const entry of registry.entries) {
    // Rule 1: exact match to a configured agent — never TTL-reaped.
    if (knownAgentNames.has(entry.name)) {
      kept.push(entry);
      continue;
    }

    // Rule 2: live subagent session — name shaped like `{parent}-sub-{id}`
    // OR the Phase 999.3 delegated form `{parent}-via-{delegate}-{id}`.
    //
    // Phase 999.19 — widened to catch `-via-` entries so delegated ghost
    // sessions route through the same retention/orphan/stale logic as
    // `-sub-` entries (pre-fix they fell through to `unknown-agent`).
    // Parent extraction prefers the central `parentAgentName` (strips
    // either spawner suffix, including a multi-segment delegate). For
    // non-conforming entries — a `-sub-`/`-via-` substring WITHOUT the
    // trailing nanoid6 — `parentAgentName` returns the input unchanged,
    // so we fall back to the legacy substring slice. That fallback
    // preserves the prior empty-parent → `orphaned-subagent` behaviour
    // for malformed names (e.g. `-sub-foo`, `ghost-sub-xyz`).
    const subIdx = entry.name.indexOf("-sub-");
    const viaIdx = entry.name.indexOf("-via-");
    if (subIdx !== -1 || viaIdx !== -1) {
      const strippedParent = parentAgentName(entry.name);
      const parent =
        strippedParent !== entry.name
          ? strippedParent
          : entry.name.slice(0, subIdx !== -1 ? subIdx : viaIdx);
      if (parent.length === 0 || !knownAgentNames.has(parent)) {
        pruned.push({ name: entry.name, reason: "orphaned-subagent" });
      } else if (isStaleStopped(entry)) {
        pruned.push({ name: entry.name, reason: "stale-subagent" });
      } else if (pruneNonStopped && entry.status !== "stopped") {
        pruned.push({ name: entry.name, reason: "phantom-subagent" });
      } else {
        kept.push(entry);
      }
      continue;
    }

    // Rule 3: live thread session — name shaped like `{parent}-thread-{id}`.
    const threadIdx = entry.name.indexOf("-thread-");
    if (threadIdx !== -1) {
      const parent = entry.name.slice(0, threadIdx);
      if (parent.length === 0 || !knownAgentNames.has(parent)) {
        pruned.push({ name: entry.name, reason: "orphaned-thread" });
      } else if (isStaleStopped(entry)) {
        pruned.push({ name: entry.name, reason: "stale-thread" });
      } else if (pruneNonStopped && entry.status !== "stopped") {
        pruned.push({ name: entry.name, reason: "phantom-thread" });
      } else {
        kept.push(entry);
      }
      continue;
    }

    // No structural match — plain unknown agent.
    pruned.push({ name: entry.name, reason: "unknown-agent" });
  }

  if (pruned.length === 0) {
    return { registry, pruned: [] };
  }

  return {
    registry: { entries: kept, updatedAt: now },
    pruned,
  };
}

/**
 * Type guard for Node.js system errors with a code property.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
