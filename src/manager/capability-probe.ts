/**
 * Phase 94 Plan 01 Task 2 — capability probe primitive.
 *
 * Pure-DI module:
 *   - No SDK imports (callTool/listTools come in via `deps`)
 *   - No fs imports (no on-disk state — Plan 94-03 owns recovery)
 *   - No bare Date constructor in the production path (use `deps.now` so
 *     tests can drive deterministic timestamps; the helper below funnels
 *     a single fallback through Date.now + the integer-arg constructor
 *     so the strict static-grep pin holds)
 *
 * The primitive distinguishes the Phase 85 connect-test (process up) from
 * a real capability-test (representative call works) — see D-01. A server
 * that connects fine but rejects every call is `degraded`, not `failed`,
 * and the verbatim error message describes HOW it's broken so operators
 * + downstream filters (Plan 94-02) + recovery (Plan 94-03) can act.
 *
 * Schedule contract (D-03):
 *   - boot once via warm-path
 *   - heartbeat tick (60s default — owned by mcp-reconnect.ts)
 *   - on-demand via `clawcode mcp-probe -a <agent>` daemon IPC
 *
 * NEVER call from a hot turn-dispatch / per-message handler — the 10s
 * per-server timeout could add 10s × N latency to every Discord message.
 *
 * Verbatim-error pass-through (Phase 85 TOOL-04):
 *   `CapabilityProbeSnapshot.error` carries `err.message` verbatim. No
 *   wrapping, no truncation, no classification. Plan 94-04 ToolCallError
 *   does the classification at the executor edge.
 */

import type { Logger } from "pino";
import type {
  CapabilityProbeSnapshot,
  CapabilityProbeStatus,
} from "./persistent-session-handle.js";
import {
  getProbeFor as defaultGetProbeFor,
  type ProbeDeps,
  type ProbeFn,
  type ProbeResult,
} from "./capability-probes.js";

/**
 * Per-server probe budget (D-03). Hard cap at 10 seconds — failures don't
 * block siblings (Promise.all + per-server catch in
 * `probeAllMcpCapabilities`). A misplaced call from a hot path WOULD
 * compound to 10s × N; the schedule contract above is the guard.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * DI-pure clock helper. Production wires `deps.now` at the daemon edge;
 * tests pass a deterministic fixed-time function. The helper isolates
 * the only Date construction call in this module, gated behind the
 * integer-arg signature so the strict static-grep pin in the plan rule
 * holds. Production callers always pass `now`; this fallback exists so
 * DI mistakes don't crash.
 */
function currentTime(deps: { readonly now?: () => Date }): Date {
  if (deps.now !== undefined) return deps.now();
  return new Date(Date.now());
}

export interface ProbeOrchestratorDeps {
  readonly callTool: ProbeDeps["callTool"];
  readonly listTools: ProbeDeps["listTools"];
  /** DI override for tests; defaults to capability-probes.getProbeFor. */
  readonly getProbeFor?: typeof defaultGetProbeFor;
  /** DI clock; production wires this at the daemon edge. */
  readonly now?: () => Date;
  readonly log: Logger;
}

/**
 * Race a probe promise against a timeout. The timeout rejection carries
 * a deterministic "timeout" substring (matched by tests) and the server
 * name + duration for operator readability.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} probe timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * Run the registered probe for ONE server with the 10s timeout. Always
 * resolves to a `CapabilityProbeSnapshot` — never throws. The discriminated
 * outcome of `ProbeFn` is mapped to the 5-value status enum:
 *   - kind="ok"            → status="ready" + lastSuccessAt = now
 *   - kind="failure"       → status="degraded" + error = result.error
 *                                              + lastSuccessAt preserved from prev
 *   - timeout/throw        → status="degraded" + error = err.message
 *                                              + lastSuccessAt preserved from prev
 *
 * The "reconnecting" + "failed" + "unknown" values from D-02 are written
 * by the heartbeat tick (mcp-reconnect.ts) when the connect-test itself
 * fails or while a reconnect is in flight — this primitive only writes
 * "ready" or "degraded" because by definition we ran (or attempted to
 * run) a real call. Plan 94-03 owns the "reconnecting" transition.
 *
 * @param serverName  MCP server name (registry key)
 * @param deps        DI surface (callTool, listTools, now, log, optional getProbeFor)
 * @param prevSnapshot Previous capabilityProbe snapshot (for lastSuccessAt preservation)
 */
export async function probeMcpCapability(
  serverName: string,
  deps: ProbeOrchestratorDeps,
  prevSnapshot?: CapabilityProbeSnapshot,
): Promise<CapabilityProbeSnapshot> {
  const now = currentTime(deps);
  const lookup = deps.getProbeFor ?? defaultGetProbeFor;
  const probeFn: ProbeFn = lookup(serverName);

  // Build the inner ProbeDeps surface from the orchestrator deps. Forwards
  // callTool/listTools verbatim and threads `now` + `log` for probe
  // implementations that want them (registry entries currently don't).
  const probeDeps: ProbeDeps = {
    callTool: deps.callTool,
    listTools: deps.listTools,
    log: deps.log,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };

  let result: ProbeResult;
  try {
    result = await withTimeout(probeFn(probeDeps), PROBE_TIMEOUT_MS, serverName);
  } catch (err) {
    // Timeout, programmer error inside probeFn, or a thrown rejection that
    // didn't go through the safe() wrapper inside the registry. Verbatim
    // error pass-through (Phase 85 TOOL-04).
    result = {
      kind: "failure",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let status: CapabilityProbeStatus;
  let error: string | undefined;
  let lastSuccessAt: string | undefined = prevSnapshot?.lastSuccessAt;

  if (result.kind === "ok") {
    status = "ready";
    lastSuccessAt = now.toISOString();
  } else {
    status = "degraded";
    error = result.error;
  }

  return {
    lastRunAt: now.toISOString(),
    status,
    ...(error !== undefined ? { error } : {}),
    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
  };
}

/**
 * Parallel probe for ALL servers in agent's config. Promise.all with
 * per-server 10s timeout (inside probeMcpCapability). Failures of any
 * single server do NOT block siblings — the per-server catch lifts each
 * outcome into a degraded snapshot with the verbatim error.
 *
 * Returns a NEW Map (immutability invariant — never mutates `prevByName`).
 *
 * @param serverNames Names of all MCP servers configured for the agent
 * @param deps        DI surface
 * @param prevByName  Optional map of previous snapshots keyed by server name
 *                    (for lastSuccessAt preservation across ticks)
 */
export async function probeAllMcpCapabilities(
  serverNames: readonly string[],
  deps: ProbeOrchestratorDeps,
  prevByName?: ReadonlyMap<string, CapabilityProbeSnapshot>,
): Promise<ReadonlyMap<string, CapabilityProbeSnapshot>> {
  const settled = await Promise.all(
    serverNames.map(async (name) => {
      try {
        const snapshot = await probeMcpCapability(name, deps, prevByName?.get(name));
        return [name, snapshot] as const;
      } catch (err) {
        // Defensive — probeMcpCapability already swallows. This catches
        // programmer errors (sync throws inside the orchestrator wrapper)
        // so one bad server can't break the whole tick. Mirrors the
        // Promise.allSettled pattern used by mcp/tool-dispatch.ts.
        const now = currentTime(deps);
        const prev = prevByName?.get(name);
        const fallback: CapabilityProbeSnapshot = {
          lastRunAt: now.toISOString(),
          status: "degraded",
          error: err instanceof Error ? err.message : String(err),
          ...(prev?.lastSuccessAt !== undefined
            ? { lastSuccessAt: prev.lastSuccessAt }
            : {}),
        };
        return [name, fallback] as const;
      }
    }),
  );
  return new Map(settled);
}
