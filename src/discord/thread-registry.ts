import { readFile, writeFile, rename, mkdir, rmdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThreadBinding, ThreadBindingRegistry } from "./thread-types.js";
import { ManagerError } from "../shared/errors.js";

/**
 * Empty registry constant -- used as the default when no registry file exists.
 */
export const EMPTY_THREAD_REGISTRY: ThreadBindingRegistry = {
  bindings: [],
  updatedAt: 0,
} as const;

/**
 * 999.65 — per-process, per-path serialization for thread-registry
 * read-modify-write cycles.
 *
 * `thread-bindings.json` is mutated by 10+ callsites (routeMessage's
 * lastActivity bump, stampLastDeliveryAt, relayAndMarkCompletedByThreadId's
 * completedAt stamp, thread-manager / thread-cleanup writes, the spawner's
 * own binding writes). Each does read-the-whole-registry →
 * mutate-one-binding → write-the-whole-registry. The IPC server dispatches
 * every request via `void handleMessage(...)` (src/ipc/server.ts) with no
 * serialization, so these cycles run concurrent and uncoordinated.
 *
 * `writeThreadRegistry`'s atomic-rename prevents a *torn file* but NOT a
 * *lost update*: a write rebuilt from a stale snapshot silently clobbers a
 * field another writer just stamped. Production failure (999.65,
 * 2026-05-21): two parallel delegated subagents each had their freshly
 * stamped `lastDeliveryAt` clobbered by a concurrent `routeMessage`
 * lastActivity write → the subagent_complete relay tripped the
 * `delivery-not-confirmed` gate and silently dropped both relays.
 *
 * `mutateThreadRegistry` runs the entire read→modify→write inside a
 * per-path async critical section, eliminating the lost-update class. All
 * binding mutations SHOULD go through it. `writeThreadRegistry` remains
 * exported for whole-registry replacement where the caller already owns
 * the full state; its disk write also takes the same per-path lock and a
 * unique tmp path so direct callers never collide on the shared `.tmp`.
 *
 * The in-process mutex is the primary guard (a single daemon is the norm).
 * M2 — a best-effort cross-process advisory flock fallback is layered on top
 * so two OVERLAPPING daemon processes (restart-overlap, where the old daemon
 * is still draining while the new one boots) also serialize their
 * read-modify-write across processes. The flock FAILS OPEN: if it can't be
 * acquired (stale dir, fs error, contention timeout), the op proceeds anyway
 * on the in-process guard alone — a delivery is never blocked by lock
 * trouble.
 */
const registryWriteChains = new Map<string, Promise<unknown>>();

/**
 * M2 — cross-process advisory lock, dependency-free.
 *
 * Uses `mkdir` (atomic create-or-fail on every POSIX fs) as the lock token:
 * the process that creates `<path>.lock` owns the lock; others spin briefly.
 * A stale lock (older than `staleMs`, e.g. left by a SIGKILL'd daemon) is
 * reclaimed. Returns a release fn, or a no-op release when acquisition gives
 * up (fail-open). NEVER throws.
 */
const LOCK_STALE_MS = 30_000;
const LOCK_SPIN_MS = 25;
const LOCK_MAX_WAIT_MS = 2_000;
const NOOP_RELEASE = async (): Promise<void> => {};

async function acquireFileLock(
  path: string,
  staleMs: number = LOCK_STALE_MS,
): Promise<() => Promise<void>> {
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  while (Date.now() <= deadline) {
    try {
      await mkdir(lockDir);
      // Acquired — release rmdirs it (best-effort; ignore if already gone).
      return async () => {
        try {
          await rmdir(lockDir);
        } catch {
          /* already released / removed — non-fatal */
        }
      };
    } catch (err) {
      if (!isNodeError(err) || err.code !== "EEXIST") {
        // Unexpected fs error (perms, ENOENT on parent) — fail open.
        return NOOP_RELEASE;
      }
      // Held by someone else. Reclaim if stale, else spin.
      try {
        const st = await stat(lockDir);
        if (Date.now() - st.mtimeMs > staleMs) {
          await rmdir(lockDir).catch(() => {});
          continue; // retry mkdir immediately
        }
      } catch {
        // Lock vanished between EEXIST and stat — retry mkdir.
        continue;
      }
      await new Promise((r) => setTimeout(r, LOCK_SPIN_MS));
    }
  }
  // Contention budget exhausted — fail open (in-process guard still holds).
  return NOOP_RELEASE;
}

/**
 * Serialize an async operation against `key`. Each call chains onto the
 * previous one for the same key, so operations run strictly one-at-a-time
 * IN-PROCESS. The op is additionally wrapped in a best-effort cross-process
 * advisory file lock (M2) for restart-overlap safety; the file lock fails
 * open so it never blocks a delivery.
 *
 * The *stored* chain promise never rejects (a failed op is isolated) so one
 * failure does not skip the next caller; the real result/rejection is still
 * returned to the current caller.
 */
function withRegistryLock<T>(key: string, op: () => Promise<T>): Promise<T> {
  const prev = registryWriteChains.get(key) ?? Promise.resolve();
  const guarded = async (): Promise<T> => {
    const release = await acquireFileLock(key);
    try {
      return await op();
    } finally {
      await release();
    }
  };
  const run = prev.then(guarded, guarded);
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
 * Read the thread registry from a JSON file on disk.
 * Returns EMPTY_THREAD_REGISTRY if the file does not exist.
 * Throws ManagerError if the file contains invalid JSON.
 *
 * @param path - Absolute path to the thread registry JSON file
 */
export async function readThreadRegistry(
  path: string,
): Promise<ThreadBindingRegistry> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return EMPTY_THREAD_REGISTRY;
    }
    throw error;
  }

  try {
    return JSON.parse(raw) as ThreadBindingRegistry;
  } catch {
    throw new ManagerError(
      `Corrupt thread registry file at ${path}: invalid JSON`,
    );
  }
}

/**
 * Internal — write the registry to disk. Uses a UNIQUE tmp path per write
 * so two concurrent writes never overwrite each other's tmp file before
 * the rename. Atomic-rename gives a torn-free file; the per-path lock in
 * `writeThreadRegistry` / `mutateThreadRegistry` gives lost-update safety.
 */
async function writeRegistryToDisk(
  path: string,
  registry: ThreadBindingRegistry,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  // 999.65 — unique tmp path. The previous shared `${path}.tmp` let two
  // concurrent writers clobber each other's tmp content before rename.
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(registry, null, 2), "utf-8");
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup of the orphaned tmp file on failure.
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(tmpPath);
    } catch {
      /* tmp already gone or unwritable — non-fatal */
    }
    throw err;
  }
}

/**
 * Write the thread registry to disk atomically.
 *
 * Use this ONLY when the caller already owns the complete registry state
 * it wants persisted (e.g. the one-time migration). For any
 * read-then-modify-one-binding flow use `mutateThreadRegistry` instead —
 * a bare read + write here races with every other writer.
 *
 * The disk write is serialized through the per-path lock and uses a unique
 * tmp file, so direct callers never collide on the shared `.tmp`.
 *
 * @param path - Absolute path to the thread registry JSON file
 * @param registry - The registry state to persist
 */
export async function writeThreadRegistry(
  path: string,
  registry: ThreadBindingRegistry,
): Promise<void> {
  await withRegistryLock(path, () => writeRegistryToDisk(path, registry));
}

/**
 * 999.65 — atomic read-modify-write of the thread registry.
 *
 * Runs `mutator` against a freshly-read registry snapshot and persists the
 * result, with the entire read→modify→write held in a per-path critical
 * section. This is the lost-update-safe way to mutate one (or more)
 * bindings: concurrent callers run strictly one-at-a-time, so each sees the
 * previous caller's committed write.
 *
 * `mutator` MUST be pure (return a new registry; never mutate the input)
 * and SHOULD be cheap — it holds the lock for the whole process while it
 * runs. Return the input registry unchanged to signal "no write needed";
 * the write still happens but is harmless. Returning the same object is
 * fine — it is always persisted.
 *
 * Returns the registry that was persisted, so callers can inspect the
 * post-write state without a second read.
 *
 * @param path - Absolute path to the thread registry JSON file
 * @param mutator - Pure function: current registry -> next registry
 */
export async function mutateThreadRegistry(
  path: string,
  mutator: (current: ThreadBindingRegistry) => ThreadBindingRegistry,
): Promise<ThreadBindingRegistry> {
  return withRegistryLock(path, async () => {
    const current = await readThreadRegistry(path);
    const next = mutator(current);
    await writeRegistryToDisk(path, next);
    return next;
  });
}

/**
 * Add a new binding to the registry. Returns a new registry (immutable).
 * Throws ManagerError if a binding for the threadId already exists.
 *
 * @param registry - The current registry state
 * @param binding - The new thread binding to add
 */
export function addBinding(
  registry: ThreadBindingRegistry,
  binding: ThreadBinding,
): ThreadBindingRegistry {
  const existing = registry.bindings.find(
    (b) => b.threadId === binding.threadId,
  );
  if (existing) {
    throw new ManagerError(
      `Thread binding for '${binding.threadId}' already exists`,
    );
  }

  return {
    bindings: [...registry.bindings, binding],
    updatedAt: Date.now(),
  };
}

/**
 * Remove a binding by threadId. Returns a new registry (immutable).
 * Returns unchanged registry if threadId not found (no throw).
 *
 * @param registry - The current registry state
 * @param threadId - The thread ID to remove
 */
export function removeBinding(
  registry: ThreadBindingRegistry,
  threadId: string,
): ThreadBindingRegistry {
  const filtered = registry.bindings.filter((b) => b.threadId !== threadId);
  if (filtered.length === registry.bindings.length) {
    return registry;
  }

  return {
    bindings: filtered,
    updatedAt: Date.now(),
  };
}

/**
 * Update the lastActivity timestamp for a binding. Returns a new registry (immutable).
 * Returns unchanged registry if threadId not found.
 *
 * @param registry - The current registry state
 * @param threadId - The thread ID to update
 * @param timestamp - The new lastActivity timestamp
 */
export function updateActivity(
  registry: ThreadBindingRegistry,
  threadId: string,
  timestamp: number,
): ThreadBindingRegistry {
  const index = registry.bindings.findIndex((b) => b.threadId === threadId);
  if (index === -1) {
    return registry;
  }

  const existing = registry.bindings[index];
  const updated: ThreadBinding = { ...existing, lastActivity: timestamp };
  const newBindings = registry.bindings.map((b, i) =>
    i === index ? updated : b,
  );

  return {
    bindings: newBindings,
    updatedAt: Date.now(),
  };
}

/**
 * Find a binding by threadId. Returns undefined if not found.
 *
 * @param registry - The current registry state
 * @param threadId - The thread ID to look up
 */
export function getBindingForThread(
  registry: ThreadBindingRegistry,
  threadId: string,
): ThreadBinding | undefined {
  return registry.bindings.find((b) => b.threadId === threadId);
}

/**
 * Get all bindings for a given agent name.
 *
 * @param registry - The current registry state
 * @param agentName - The agent name to filter by
 */
export function getBindingsForAgent(
  registry: ThreadBindingRegistry,
  agentName: string,
): readonly ThreadBinding[] {
  return registry.bindings.filter((b) => b.agentName === agentName);
}

/**
 * Phase 999.36 sub-bug C (D-09, D-10) — find a binding by sessionName.
 *
 * The subagent's sessionName is the SDK-level agent identity (e.g.
 * `fin-client-sub-OV9rkf`). When the LLM in a subagent context
 * calls `clawcode_share_file` and passes `agent: <its own sessionName>`,
 * the daemon's IPC handler uses this helper to resolve the actual
 * Discord thread the subagent is bound to — overriding the otherwise-
 * incorrect fallback to `agentConfig.channels[0]`.
 *
 * Returns undefined for non-subagent invocations (no binding has the
 * given sessionName) — caller MUST fall through to existing channel
 * resolution.
 *
 * Disambiguates the shared-workspace failure class: when two agents in
 * the same workspace (e.g. fin-client + acme-content-creator)
 * spawn subagents, each subagent's sessionName is unique even though
 * the parent agentName field on the binding is shared by the family.
 * Looking up by sessionName picks the correct binding deterministically.
 *
 * @param registry - The current registry state
 * @param sessionName - The subagent session name to look up
 */
export function getBindingForSession(
  registry: ThreadBindingRegistry,
  sessionName: string,
): ThreadBinding | undefined {
  return registry.bindings.find((b) => b.sessionName === sessionName);
}

/**
 * Phase 999.36 sub-bug D — stamp lastDeliveryAt on a binding.
 *
 * 999.65 — now routed through `mutateThreadRegistry` so the
 * read→modify→write runs in a per-path critical section. The previous
 * bare read + write raced `routeMessage`'s lastActivity bump (and any
 * other concurrent writer): a stale-snapshot write silently clobbered the
 * freshly stamped `lastDeliveryAt`, which then made the subagent_complete
 * relay trip the `delivery-not-confirmed` gate and silently drop.
 *
 * `producedRealContent` (optional) is stamped in the same critical-section
 * write so out-of-band relay paths (quiescence sweep, session-end backstop)
 * can refuse to relay a placeholder-only turn. Omit to leave the existing
 * `producedRealContent` value untouched — used by the session-end backstop
 * which stamps delivery without a content signal.
 *
 * No-op (returns `no-binding`) if the threadId has no binding.
 * Failure-mode: registry write rejection → returns { ok: false, reason }
 * so the caller (the spawner) can log without crashing the delivery path.
 */
export async function stampLastDeliveryAt(
  registryPath: string,
  threadId: string,
  deliveredAt: number,
  producedRealContent?: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    let found = false;
    await mutateThreadRegistry(registryPath, (registry) => {
      const idx = registry.bindings.findIndex(
        (b) => b.threadId === threadId,
      );
      if (idx === -1) {
        return registry;
      }
      found = true;
      const existing = registry.bindings[idx]!;
      const updated: ThreadBinding = {
        ...existing,
        lastDeliveryAt: deliveredAt,
        ...(producedRealContent !== undefined
          ? { producedRealContent }
          : {}),
      };
      return {
        bindings: registry.bindings.map((b, i) =>
          i === idx ? updated : b,
        ),
        updatedAt: Date.now(),
      };
    });
    if (!found) {
      return { ok: false, reason: "no-binding" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Steer-subagent prep: clear the relay gates on a binding so an
 * interrupted-mid-turn subagent doesn't trigger a quiescence-relay on the
 * half-delivered output. After this runs, the binding looks "in-flight,
 * nothing delivered yet" — the next genuine completion (subagent_complete
 * call OR the next turn's postInitialMessage-equivalent stamp) re-arms
 * the gates.
 *
 * Atomic via `mutateThreadRegistry` so this can't race a concurrent
 * `stampLastDeliveryAt` (the spawner's post-delivery stamp). No-op
 * (`no-binding`) if the threadId has no binding. Refuses (`terminal`)
 * if the binding already has `completedAt` set — a terminal binding
 * shouldn't be re-armed.
 *
 * Returns the outcome so callers can log/refuse upstream; never throws
 * (registry write errors fold into `{ ok: false, reason: <msg> }`).
 */
export async function resetSteerGates(
  registryPath: string,
  threadId: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: "no-binding" | "terminal" | string }
> {
  try {
    let outcome:
      | { ok: true }
      | { ok: false; reason: "no-binding" | "terminal" } = {
      ok: false,
      reason: "no-binding",
    };
    await mutateThreadRegistry(registryPath, (registry) => {
      const idx = registry.bindings.findIndex(
        (b) => b.threadId === threadId,
      );
      if (idx === -1) {
        outcome = { ok: false, reason: "no-binding" };
        return registry;
      }
      const existing = registry.bindings[idx]!;
      if (existing.completedAt !== undefined && existing.completedAt !== null) {
        outcome = { ok: false, reason: "terminal" };
        return registry;
      }
      outcome = { ok: true };
      const updated: ThreadBinding = {
        ...existing,
        lastDeliveryAt: null,
        producedRealContent: false,
      };
      return {
        bindings: registry.bindings.map((b, i) =>
          i === idx ? updated : b,
        ),
        updatedAt: Date.now(),
      };
    });
    return outcome;
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Phase 999.36 sub-bug D — one-time migration for pre-Phase-999.36 bindings.
 *
 * Bindings created before this phase lack `lastDeliveryAt`. After this
 * phase deploys, the relay gate refuses to fire if lastDeliveryAt is null.
 * For bindings that ALREADY had a relay event before deploy (completedAt
 * is set), do nothing — they're terminal. For bindings with no completedAt
 * AND no lastDeliveryAt, treat lastActivity as the delivery proxy
 * (assumes pre-Phase-999.36 deliveries did happen, just weren't stamped).
 *
 * Run ONCE on daemon startup; idempotent (re-running is a no-op for
 * already-migrated bindings).
 *
 * REMOVE AFTER 999.36+1 milestone closes — bindings will be naturally
 * migrated by then.
 *
 * 999.65 — routed through `mutateThreadRegistry` so the migration's
 * read→modify→write is serialized against any concurrent writer (the
 * migration runs at startup, but spawner activity can already be in
 * flight).
 *
 * Returns count of bindings migrated for log visibility.
 */
export async function migrateBindingsForPhase999_36(
  registryPath: string,
): Promise<{ migrated: number; total: number }> {
  let migrated = 0;
  let total = 0;
  await mutateThreadRegistry(registryPath, (registry) => {
    total = registry.bindings.length;
    migrated = 0;
    const updatedBindings = registry.bindings.map((b) => {
      if (b.completedAt !== undefined && b.completedAt !== null) {
        return b;
      }
      if (b.lastDeliveryAt !== undefined && b.lastDeliveryAt !== null) {
        return b;
      }
      migrated++;
      return { ...b, lastDeliveryAt: b.lastActivity };
    });
    if (migrated === 0) {
      return registry;
    }
    return {
      bindings: updatedBindings,
      updatedAt: Date.now(),
    };
  });
  return { migrated, total };
}

/**
 * Type guard for Node.js system errors with a code property.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
