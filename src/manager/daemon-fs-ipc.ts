/**
 * Phase 96 Plan 05 DIPC- — daemon probe-fs + list-fs-status IPC handlers.
 *
 * Extracted as pure-DI module (mirroring Phase 92 daemon cutover-button-action
 * idiom) so tests can exercise the handlers without spawning the full daemon.
 * Production wiring at the daemon edge passes node:fs/promises.access /
 * realpath / writeFile / rename / mkdir / readFile via the deps surface;
 * tests stub all I/O.
 *
 * Discord/CLI parity invariant (RESEARCH.md Validation Architecture Dim 6):
 * BOTH `/clawcode-probe-fs` Discord slash AND `clawcode probe-fs` CLI route
 * through `handleProbeFsIpc`. Both surfaces produce identical FsProbeOutcome.
 * Drift between surfaces is a regression — pinned by DIPC-PARITY test.
 *
 * Last-writer-wins on fs-capability.json (RESEARCH.md Pitfall 6): heartbeat
 * tick + on-demand probe both write the file; concurrent writes resolve via
 * atomic temp+rename inside writeFsSnapshot. The handler returns the
 * in-memory snapshot it produced — independent of file state, so callers
 * see the result of THEIR probe (not whichever write won the rename race).
 *
 * Pure-DI module:
 *   - No SDK imports
 *   - No node:fs imports (production wires at daemon edge)
 *   - No bare Date constructor (clock via deps.now)
 *   - No SessionManager/SessionHandle imports (handle accessor passed via deps)
 */

import type { Logger } from "pino";

import { ManagerError } from "../shared/errors.js";
import { runFsProbe } from "./fs-probe.js";
import type { FsProbeOutcome } from "./fs-probe.js";
import type { FsCapabilitySnapshot } from "./persistent-session-handle.js";

/**
 * Wire shape returned by `probe-fs` IPC. JSON-RPC-friendly: snapshot is an
 * array of [canonicalPath, FsCapabilitySnapshot] tuples (Maps don't survive
 * JSON.stringify). The Discord slash + CLI both re-hydrate this shape.
 *
 * Optional `changes` field reserved for the --diff invocation path; for v1
 * the daemon doesn't compute diffs server-side — the CLI's --diff renders
 * outcome.changes when present, future iterations may populate it from the
 * persisted prior snapshot.
 */
export type ProbeFsIpcOutcome =
  | {
      readonly kind: "completed";
      readonly snapshot: ReadonlyArray<readonly [string, FsCapabilitySnapshot]>;
      readonly durationMs: number;
      readonly changes?: ReadonlyArray<{
        readonly path: string;
        readonly from: string;
        readonly to: string;
      }>;
    }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Wire shape returned by `list-fs-status` IPC. Mirrors the daemon-side
 * serializer of SessionHandle.getFsCapabilitySnapshot Map → flat array.
 */
export type ListFsStatusResponse = {
  readonly agent: string;
  readonly paths: ReadonlyArray<{
    readonly path: string;
    readonly status: "ready" | "degraded" | "unknown";
    readonly mode: "rw" | "ro" | "denied";
    readonly lastProbeAt: string;
    readonly lastSuccessAt?: string;
    readonly error?: string;
  }>;
};

/**
 * Subset of SessionHandle accessors needed by the IPC handlers. Production
 * wires `manager.getSessionHandle(agent)` and adapts to this narrower shape;
 * tests stub directly. Returning null indicates "agent not running" (no
 * SessionHandle available — operator hasn't started the agent yet).
 */
export type FsSessionHandleAccessors = {
  readonly getFsCapabilitySnapshot: () => ReadonlyMap<string, FsCapabilitySnapshot>;
  readonly setFsCapabilitySnapshot: (
    next: ReadonlyMap<string, FsCapabilitySnapshot>,
  ) => void;
};

/**
 * Pure-DI deps for `handleProbeFsIpc`. Production wires:
 *   - resolveFileAccessForAgent → resolveFileAccess(agent, agentCfg, defaults)
 *   - getHandleAccessors        → manager.getSessionHandle(agent)
 *   - fsAccess                  → node:fs/promises.access
 *   - fsConstants               → node:fs.constants
 *   - realpath                  → node:fs/promises.realpath
 *   - resolve                   → node:path.resolve
 *   - writeFsSnapshot           → src/manager/fs-snapshot-store.ts
 *   - getFsCapabilityPath       → ~/.clawcode/agents/${agent}/fs-capability.json
 *   - now                       → () => new Date()
 */
export interface ProbeFsIpcDeps {
  readonly resolveFileAccessForAgent: (agent: string) => readonly string[];
  readonly getHandleAccessors: (
    agent: string,
  ) => FsSessionHandleAccessors | null;
  readonly fsAccess: (path: string, mode: number) => Promise<void>;
  readonly fsConstants: { readonly R_OK: number; readonly W_OK: number };
  readonly realpath: (path: string) => Promise<string>;
  readonly resolve?: (path: string) => string;
  /**
   * Writes the snapshot to the fs-capability.json (Phase 91 atomic
   * temp+rename mirror). Failures are logged but do NOT block the IPC
   * response — operator gets the in-memory outcome regardless. RESEARCH.md
   * Pitfall 6: persistence is best-effort; in-memory IS the source of truth
   * for the just-completed probe.
   */
  readonly writeFsSnapshot: (
    agent: string,
    snapshot: ReadonlyMap<string, FsCapabilitySnapshot>,
    filePath: string,
  ) => Promise<void>;
  readonly getFsCapabilityPath: (agent: string) => string;
  readonly now?: () => Date;
  readonly log: Logger;
}

/**
 * Pure-DI deps for `handleListFsStatusIpc`. The handler is a thin serializer
 * over SessionHandle.getFsCapabilitySnapshot — caching IS the cache.
 */
export interface ListFsStatusIpcDeps {
  readonly getHandleAccessors: (
    agent: string,
  ) => FsSessionHandleAccessors | null;
}

/**
 * Phase 96 Plan 05 — `probe-fs` IPC handler.
 *
 * Algorithm:
 *   1. Resolve fileAccess for the agent (paths post-token-expansion +
 *      resolve, dedup'd; handled by resolveFileAccess in src/config/loader.ts)
 *   2. Look up SessionHandle accessors; throw ManagerError if absent
 *   3. Invoke runFsProbe with prev snapshot for lastSuccessAt preservation
 *   4. On completed: persist atomically (best-effort — log warning on
 *      failure; do NOT block return) AND update in-memory snapshot
 *   5. Return outcome with snapshot serialized as [path, state] tuples
 *
 * NEVER re-implements runFsProbe. The daemon handler is thin orchestration
 * only — pinned by static-grep `grep -q "runFsProbe" src/manager/daemon.ts`.
 */
export async function handleProbeFsIpc(
  params: { readonly agent: string },
  deps: ProbeFsIpcDeps,
): Promise<ProbeFsIpcOutcome> {
  const agent = params.agent;
  if (typeof agent !== "string" || agent.length === 0) {
    throw new ManagerError("probe-fs: agent param required");
  }

  const accessors = deps.getHandleAccessors(agent);
  if (accessors === null) {
    throw new ManagerError(`probe-fs: agent '${agent}' not running`);
  }

  const paths = deps.resolveFileAccessForAgent(agent);
  const prevSnapshot = accessors.getFsCapabilitySnapshot();

  const outcome: FsProbeOutcome = await runFsProbe(
    paths,
    {
      fsAccess: deps.fsAccess,
      fsConstants: deps.fsConstants,
      realpath: deps.realpath,
      ...(deps.resolve !== undefined ? { resolve: deps.resolve } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      log: deps.log,
    },
    prevSnapshot,
  );

  if (outcome.kind === "completed") {
    // Update in-memory snapshot FIRST so subsequent reads (Discord
    // /clawcode-status, clawcode fs-status) see the fresh state.
    accessors.setFsCapabilitySnapshot(outcome.snapshot);

    // Atomic persist — best-effort. RESEARCH.md Pitfall 6: file-system
    // failures (disk full, permissions race) MUST NOT block the IPC
    // response. Operator already has the result from the in-memory mirror.
    try {
      const path = deps.getFsCapabilityPath(agent);
      await deps.writeFsSnapshot(agent, outcome.snapshot, path);
    } catch (err) {
      deps.log.warn(
        {
          agent,
          error: err instanceof Error ? err.message : String(err),
        },
        "probe-fs: writeFsSnapshot failed — in-memory snapshot updated, persist skipped",
      );
    }

    return {
      kind: "completed",
      snapshot: Array.from(outcome.snapshot.entries()),
      durationMs: outcome.durationMs,
    };
  }

  return {
    kind: "failed",
    error: outcome.error,
  };
}

/**
 * Phase 96 Plan 05 — `list-fs-status` IPC handler.
 *
 * Thin serializer: reads SessionHandle.getFsCapabilitySnapshot() (an
 * in-memory Map mirror updated by probe-fs / heartbeat tick) and flattens
 * to a JSON-RPC-friendly array of {path, status, mode, lastProbeAt, ...}
 * objects. NO probe spawn — this is a pure read of the cached state.
 *
 * Never throws on empty snapshot — returns paths:[] for an agent that
 * hasn't probed yet (boot pre-warm-path). Throws ManagerError ONLY when the
 * agent has no SessionHandle (operator hasn't started it).
 */
export async function handleListFsStatusIpc(
  params: { readonly agent: string },
  deps: ListFsStatusIpcDeps,
): Promise<ListFsStatusResponse> {
  const agent = params.agent;
  if (typeof agent !== "string" || agent.length === 0) {
    throw new ManagerError("list-fs-status: agent param required");
  }

  const accessors = deps.getHandleAccessors(agent);
  if (accessors === null) {
    throw new ManagerError(`list-fs-status: agent '${agent}' not running`);
  }

  const snapshot = accessors.getFsCapabilitySnapshot();
  const paths = Array.from(snapshot.entries()).map(([path, state]) => ({
    path,
    status: state.status,
    mode: state.mode,
    lastProbeAt: state.lastProbeAt,
    ...(state.lastSuccessAt !== undefined
      ? { lastSuccessAt: state.lastSuccessAt }
      : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
  }));

  return { agent, paths };
}
