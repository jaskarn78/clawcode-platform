/**
 * Phase 108 Plan 04 — `mcp-broker` heartbeat check (POOL-07).
 *
 * Polls OnePasswordMcpBroker.getPoolStatus() and surfaces critical when
 * any pool currently referenced by an agent (agentRefCount > 0) has
 * alive=false. Pools with alive=false AND agentRefCount=0 are ignored —
 * those represent cleanly-drained pools the broker tore down because
 * the last referencing agent disconnected (CONTEXT.md §Pool keep-alive
 * decision: drain immediately on last-ref).
 *
 * **CRITICAL invariant** (RESEARCH.md §"Heartbeat health check"):
 *   This check MUST NOT call any tool dispatch path. A synthetic
 *   `password_read` would consume 1Password rate-limit budget — the
 *   exact budget pooling exists to PRESERVE. Internal liveness via
 *   `child.exitCode === null` (already surfaced via getPoolStatus.alive)
 *   is sufficient. The provider type is intentionally narrow:
 *   `{ getPoolStatus(): BrokerPoolStatus[] }` — no callTool, no
 *   dispatch, no sendRequest. Adding any of those is a SEC-grade
 *   regression and the test asserts `Object.keys(provider) ===
 *   ['getPoolStatus']`.
 *
 * Cadence: 60s (matches default heartbeat tick). Mirrors the every-tick
 * shape of `fs-probe` and `mcp-reconnect`.
 *
 * Per-agent isolation: this check is a global broker probe, not a
 * per-agent one. The heartbeat runner calls execute(ctx) once per
 * running agent, but the result is the same for every agent — the
 * broker is daemon-singleton state. We accept the redundant per-agent
 * invocation rather than reshaping the runner; the underlying
 * getPoolStatus() is a Map-walk + struct-build, ~µs cost.
 */

import type { CheckModule, CheckContext, CheckResult } from "../types.js";

/**
 * Snapshot of a single broker pool's runtime state. Mirrors the
 * production OnePasswordMcpBroker.getPoolStatus() return shape (see
 * src/mcp/broker/broker.ts:67 PoolStatus type) so the heartbeat check
 * can stay decoupled from the broker implementation — only this
 * narrow surface is consumed.
 */
export type BrokerPoolStatus = {
  readonly tokenHash: string;
  readonly alive: boolean;
  readonly agentRefCount: number;
  readonly inflightCount: number;
  readonly queueDepth: number;
  /**
   * Optional 24h respawn count (POOL-04 telemetry). Production broker
   * exposes `respawnCount` (lifetime); 24h windowing is post-Phase-108
   * polish, but the field is reserved here so future work doesn't need
   * to widen the type.
   */
  readonly respawnCount24h?: number;
  /** Phase 109-A — dispatched calls in the trailing 60s window. */
  readonly rpsLastMin?: number;
  /** Phase 109-A — throttle-classified responses in the trailing 24h window. */
  readonly throttleEvents24h?: number;
  /** Phase 109-A — last Retry-After seconds parsed from a throttle response. */
  readonly lastRetryAfterSec?: number | null;
};

/**
 * The narrow provider surface the heartbeat consumes. INTENTIONALLY
 * does NOT include `dispatch` / `callTool` / `sendRequest` — see the
 * SEC-grade comment in the file header. The production daemon
 * constructs this provider as a small adapter over the broker:
 *   { getPoolStatus: () => broker.getPoolStatus() }
 * (108-05 wires the adapter; this check is decoupled from broker.ts).
 */
export type BrokerStatusProvider = {
  getPoolStatus(): readonly BrokerPoolStatus[];
};

/**
 * CheckContext extension carrying the broker-status provider. The
 * heartbeat runner does not yet have a typed slot for this; production
 * wiring (Plan 108-05) injects it via a setter mirroring
 * setSecretsResolver / setThreadManager. Tests pass it inline.
 */
type ContextWithBroker = CheckContext & {
  readonly brokerStatusProvider?: BrokerStatusProvider;
};

const mcpBrokerCheck: CheckModule = {
  name: "mcp-broker",
  /**
   * 60s cadence — matches default heartbeat tick. Per-agent loop in the
   * runner is fine because getPoolStatus() is a tiny Map-walk; we don't
   * need to deduplicate to a once-per-tick shape.
   */
  interval: 60,
  execute: async (ctx: CheckContext): Promise<CheckResult> => {
    const provider = (ctx as ContextWithBroker).brokerStatusProvider;
    if (provider === undefined) {
      // Provider unwired (e.g. config has no MCP servers, or running on
      // a host where OP_SERVICE_ACCOUNT_TOKEN isn't set). Treat as
      // healthy — the broker isn't being used, so it can't be broken.
      return {
        status: "healthy",
        message: "mcp-broker provider not configured (no 1Password pooling on this host)",
      };
    }

    const pools = provider.getPoolStatus();
    const inUse = pools.filter((p) => p.agentRefCount > 0);
    const dead = inUse.filter((p) => !p.alive);

    if (dead.length === 0) {
      const drainedCount = pools.length - inUse.length;
      return {
        status: "healthy",
        message: `${inUse.length} pool(s) alive, ${drainedCount} drained`,
        metadata: {
          poolCount: pools.length,
          inUseCount: inUse.length,
          drainedCount,
        },
      };
    }

    const failedHashes = dead.map((d) => d.tokenHash);
    return {
      status: "critical",
      message: `mcp-broker pool(s) dead with active agents: ${failedHashes.join(", ")}`,
      metadata: {
        failedPools: failedHashes,
        deadPoolDetails: dead.map((d) => ({
          tokenHash: d.tokenHash,
          agentRefCount: d.agentRefCount,
          inflightCount: d.inflightCount,
          queueDepth: d.queueDepth,
        })),
      },
    };
  },
};

export default mcpBrokerCheck;
