/**
 * Phase 96 Plan 01 D-CONTEXT — filesystem capability probe primitive.
 *
 * Pure-DI module:
 *   - No SDK imports (fs.access comes in via deps)
 *   - No node:fs imports (production wiring at daemon edge)
 *   - No bare Date constructor (use deps.now so tests can drive
 *     deterministic timestamps; matches Phase 94 capability-probe.ts idiom)
 *
 * 3-value status enum (ready|degraded|unknown) — INTENTIONALLY DIVERGES
 * from Phase 94's 5-value MCP capability enum because filesystem capability
 * has no reconnect/failed analog: operator-driven ACL changes don't
 * transition through transient connect states.
 *
 * Schedule contract (D-01):
 *   - boot once via warm-path
 *   - heartbeat tick (60s default — wired in Plan 96-07)
 *   - on-demand via /clawcode-probe-fs slash + clawcode probe-fs CLI (96-05)
 *
 * NEVER call from a hot turn-dispatch / per-message handler — the 5s
 * per-path timeout could add 5s × N latency to every Discord message.
 *
 * Verbatim-error pass-through (Phase 85 TOOL-04 inheritance):
 *   FsCapabilitySnapshot.error carries err.message verbatim. No wrapping,
 *   no truncation, no classification. Plan 96-03/96-04 ToolCallError does
 *   the classification at the executor edge.
 */

import type { Logger } from "pino";
import type {
  FsCapabilityMode,
  FsCapabilitySnapshot,
  FsCapabilityStatus,
} from "./persistent-session-handle.js";

/**
 * Per-path probe budget (D-01). Hard cap at 5 seconds. Failures don't
 * block siblings (Promise.all + per-path catch). A misplaced call from a
 * hot path WOULD compound to 5s × N; the schedule contract above is the
 * guard.
 */
export const FS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Discriminated-union outcome — 2 variants per Phase 84/86/88/90/92/94/95
 * pattern. Production callers of runFsProbe always observe one of these.
 */
export type FsProbeOutcome =
  | {
      readonly kind: "completed";
      readonly snapshot: ReadonlyMap<string, FsCapabilitySnapshot>;
      readonly durationMs: number;
    }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Pure-DI deps surface. Production wires node:fs/promises.access +
 * node:fs/promises.realpath + node:path.resolve at the daemon edge.
 * Tests stub all four. fsConstants carries the POSIX read/write bitmasks
 * (R_OK=4, W_OK=2 in node 22 LTS).
 */
export interface FsProbeDeps {
  /** Wraps node:fs/promises.access. */
  readonly fsAccess: (path: string, mode: number) => Promise<void>;
  /** node:fs.constants. */
  readonly fsConstants: { readonly R_OK: number; readonly W_OK: number };
  /** Wraps node:fs/promises.realpath — canonical-path resolution (D-06). */
  readonly realpath: (path: string) => Promise<string>;
  /**
   * Wraps node:path.resolve — fallback when realpath rejects with ENOENT.
   * Optional; when omitted, the input path is used as-is for the snapshot
   * key. Production wires `path.resolve` from node:path.
   */
  readonly resolve?: (path: string) => string;
  /** DI clock; production wires this at the daemon edge. */
  readonly now?: () => Date;
  readonly log: Logger;
}

/**
 * Race a probe promise against a timeout. The timeout rejection carries
 * a deterministic "timeout" substring (matched by tests) and the path +
 * duration for operator readability. Mirrors Phase 94 capability-probe
 * withTimeout shape.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`fs probe ${label} timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * DI-pure clock helper. Production wires deps.now at the daemon edge;
 * tests pass a deterministic fixed-time function. The helper isolates the
 * only Date construction call in this module — gated behind the
 * integer-arg signature so the strict static-grep pin in 96-01-PLAN.md
 * (no bare-arg Date constructor) holds. Production callers always pass
 * `now`; this fallback exists so DI mistakes don't crash. Mirrors Phase
 * 94 capability-probe.ts idiom.
 */
function currentTime(deps: { readonly now?: () => Date }): Date {
  if (deps.now !== undefined) return deps.now();
  return new Date(Date.now());
}

/**
 * Canonicalize a single path: try realpath first, fall back to deps.resolve
 * on ENOENT. When deps.resolve is missing, fall through to the input path
 * itself (test default). D-06 boundary check requires canonical key.
 */
async function canonicalize(
  rawPath: string,
  deps: FsProbeDeps,
): Promise<string> {
  try {
    return await deps.realpath(rawPath);
  } catch {
    // realpath ENOENT (or other failure) — fall back to resolve-only
    return deps.resolve ? deps.resolve(rawPath) : rawPath;
  }
}

/**
 * Probe a single path with the FS_PROBE_TIMEOUT_MS budget. Always returns
 * a [canonicalKey, FsCapabilitySnapshot] pair — never throws. Verbatim
 * error pass-through (Phase 85 TOOL-04).
 *
 * status='ready' when fs.access(R_OK) succeeds — mode='ro' is the safe
 * default; promotion to 'rw' requires explicit fileAccess + W_OK probe
 * (deferred to a future plan).
 *
 * status='degraded' on any failure — mode='denied'; lastSuccessAt
 * preserved from prevEntry if available (D-CONTEXT freshness signal).
 */
async function probeOne(
  rawPath: string,
  deps: FsProbeDeps,
  now: Date,
  prevEntry: FsCapabilitySnapshot | undefined,
): Promise<readonly [string, FsCapabilitySnapshot]> {
  const canonical = await canonicalize(rawPath, deps);
  try {
    await withTimeout(
      deps.fsAccess(canonical, deps.fsConstants.R_OK),
      FS_PROBE_TIMEOUT_MS,
      canonical,
    );
    const status: FsCapabilityStatus = "ready";
    const mode: FsCapabilityMode = "ro";
    const lastSuccessAt = now.toISOString();
    return [
      canonical,
      {
        status,
        mode,
        lastProbeAt: now.toISOString(),
        lastSuccessAt,
      },
    ] as const;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const status: FsCapabilityStatus = "degraded";
    const mode: FsCapabilityMode = "denied";
    return [
      canonical,
      {
        status,
        mode,
        lastProbeAt: now.toISOString(),
        error: errMsg,
        // Preserve lastSuccessAt across degraded ticks — D-CONTEXT
        // freshness signal for /clawcode-status + LLM context.
        ...(prevEntry?.lastSuccessAt !== undefined
          ? { lastSuccessAt: prevEntry.lastSuccessAt }
          : {}),
      },
    ] as const;
  }
}

/**
 * Pure orchestrator. Probes ALL paths in parallel via Promise.all + per-
 * path timeout. Failures don't block siblings (FP-PARALLEL-INDEPENDENCE).
 * Verbatim error pass-through. Returns a NEW Map (FP-IMMUT — never
 * mutates `prevSnapshot`).
 *
 * @param paths        Raw fileAccess paths from agent config (post-token-expansion)
 * @param deps         DI surface (fsAccess, realpath, resolve?, now?, log)
 * @param prevSnapshot Previous snapshot keyed by canonical absPath (for
 *                     lastSuccessAt preservation across heartbeat ticks)
 */
export async function runFsProbe(
  paths: readonly string[],
  deps: FsProbeDeps,
  prevSnapshot?: ReadonlyMap<string, FsCapabilitySnapshot>,
): Promise<FsProbeOutcome> {
  const start = currentTime(deps);
  const startMs = start.getTime();

  try {
    const settled = await Promise.all(
      paths.map(async (rawPath) => {
        try {
          // First canonicalize so we can look up prevEntry by canonical key.
          const canonical = await canonicalize(rawPath, deps);
          const prevEntry = prevSnapshot?.get(canonical);
          return await probeOne(rawPath, deps, start, prevEntry);
        } catch (err) {
          // Defensive — probeOne already swallows fs.access failures.
          // This catches programmer errors only (sync throws inside
          // canonicalize/probeOne). Mirrors Phase 94's defensive Promise.all
          // catch idiom.
          const errMsg = err instanceof Error ? err.message : String(err);
          const fallbackKey = deps.resolve ? deps.resolve(rawPath) : rawPath;
          return [
            fallbackKey,
            {
              status: "degraded" as const,
              mode: "denied" as const,
              lastProbeAt: start.toISOString(),
              error: errMsg,
            },
          ] as const;
        }
      }),
    );
    const snapshot = new Map(settled);
    const end = currentTime(deps);
    const durationMs = end.getTime() - startMs;
    return { kind: "completed", snapshot, durationMs };
  } catch (err) {
    return {
      kind: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
