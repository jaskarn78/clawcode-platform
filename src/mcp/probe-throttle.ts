/**
 * Per-server throttle for the heartbeat MCP probe.
 *
 * WHY. `mcp-reconnect` re-probes every configured MCP server on every heartbeat
 * tick (60s), and a probe SPAWNS A THROWAWAY COPY of the server: connect
 * handshake first, then a capability probe, so a healthy server is started twice
 * per tick. For a stdio server that is a few milliseconds. For
 * `playwright-shopping` it is a launcher script, `op` work, Xvfb and a real
 * Chrome — measured on clawdy as one full browser stack every ~2 minutes,
 * forever. That churn is also what turned a 3-read `op inject` into ~108
 * 1Password reads/hour during INC-2026-08-11, and it is why the MemoryGuard
 * chrome instance budget needed a reserved slot.
 *
 * WHY NOT JUST SKIP THE SERVER. Because skipping is silently destructive. The
 * LLM tool-list filter gates on `capabilityProbe.status === "ready"`
 * (`filter-tools-by-capability-probe.ts`), and an ABSENT state yields
 * `undefined`, which is not "ready" — so a server excluded from probing loses
 * every one of its tools from the model's tool list. The broker-pooled
 * exclusion (`broker-shim-detect.ts`) gets away with it only because the broker
 * has a separate heartbeat that keeps its state fresh. There is no such
 * substitute here.
 *
 * SO: throttle, and CARRY THE PRIOR STATE FORWARD unchanged. A skipped tick must
 * leave `capabilityProbe` exactly as it was, so the server keeps reading
 * "ready" and keeps its tools.
 *
 * The throttle is keyed on `capabilityProbe.lastRunAt`, which is already
 * persisted per server — no new state to thread through the tick.
 *
 * Three rules, all deliberate:
 *   1. Default is 0 = probe every tick. Every existing server is unaffected.
 *   2. Only a HEALTHY server is throttled. Anything degraded/failed/unknown is
 *      probed every tick, so recovery detection stays as fast as it is today.
 *   3. No prior state (cold boot, first tick) always probes, so a server is
 *      never left sitting in `unknown` waiting out an interval.
 */

/** The per-server knob this module reads. */
export interface ThrottleableServer {
  readonly name: string;
  /** Minimum ms between probes for a server that is currently healthy. 0 = every tick. */
  readonly minProbeIntervalMs?: number;
}

/** The slice of `McpServerState` the decision depends on. */
export interface PriorProbeState {
  readonly status: string;
  readonly capabilityProbe?: {
    readonly status: string;
    readonly lastRunAt: string;
  };
}

/**
 * True when this server must be probed on this tick.
 *
 * Returning true is always SAFE (it is today's behavior); returning false is
 * only safe when the caller carries the prior state forward verbatim.
 */
export function shouldProbeNow(
  server: ThrottleableServer,
  prior: PriorProbeState | undefined,
  nowMs: number,
): boolean {
  const interval = server.minProbeIntervalMs ?? 0;
  if (interval <= 0) return true;

  // Rule 3 — nothing to carry forward.
  if (!prior?.capabilityProbe) return true;

  // Rule 2 — only steady-state healthy servers are throttled. Both the connect
  // status and the capability status must be ready: they can disagree, and a
  // server whose capability probe is degraded is exactly the one to keep
  // watching closely.
  if (prior.status !== "ready") return true;
  if (prior.capabilityProbe.status !== "ready") return true;

  const last = Date.parse(prior.capabilityProbe.lastRunAt);
  // An unparseable timestamp is treated as "probe" rather than as 0 (epoch),
  // which would otherwise read as infinitely stale and probe anyway - same
  // outcome, but stated deliberately instead of by accident.
  if (!Number.isFinite(last)) return true;

  // Clock going backwards (NTP step) must not wedge a server into never
  // probing again, so a negative age counts as due.
  const ageMs = nowMs - last;
  if (ageMs < 0) return true;

  return ageMs >= interval;
}

export interface PartitionResult<T> {
  /** Servers to probe on this tick (spawned). */
  readonly toProbe: readonly T[];
  /** Servers whose prior state must be carried forward untouched. */
  readonly carried: readonly T[];
}

/**
 * Splits the configured servers into "probe now" and "carry forward".
 * Order-preserving within each bucket.
 */
export function partitionByThrottle<T extends ThrottleableServer>(
  servers: readonly T[],
  priorState: ReadonlyMap<string, PriorProbeState>,
  nowMs: number,
): PartitionResult<T> {
  const toProbe: T[] = [];
  const carried: T[] = [];
  for (const s of servers) {
    if (shouldProbeNow(s, priorState.get(s.name), nowMs)) toProbe.push(s);
    else carried.push(s);
  }
  return { toProbe, carried };
}
