/**
 * Phase 108 — OnePasswordMcpBroker.
 *
 * Owns N pooled MCP children — one per unique OP_SERVICE_ACCOUNT_TOKEN
 * (keyed by tokenHash). Multiplexes JSON-RPC requests from M agents onto
 * the shared children with id rewriting, per-agent concurrency caps,
 * structured audit logging, and auto-respawn on child crash.
 *
 * Plan: 108-02 — control plane. Pairs with PooledChild (108-01) for the
 * per-child data plane; in this implementation the broker integrates the
 * data-plane lifecycle directly via the injected `spawnFn` so it can be
 * developed in parallel with 108-01.
 *
 * Token-literal redaction (Phase 104 SEC-07): the broker NEVER logs the
 * literal OP_SERVICE_ACCOUNT_TOKEN value. Only `tokenHash` (8 hex chars)
 * appears in logs. The rawToken is only passed to child spawn via env.
 */
import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";

/** JSON-RPC server-defined error code (range -32099..-32000). */
export const BROKER_ERROR_CODE_DRAIN_TIMEOUT = -32002;

/**
 * INC-2026-07-27 — the pool child for this tokenHash could not be spawned
 * (the daemon's spawnFn refused because rawToken was empty/unresolvable,
 * or the spawn itself threw). Returned to the ATTACHING agent only; every
 * other agent and every other pool is unaffected.
 *
 * Mirrors `BrokerErrorCode.PoolNotInitialized` in ./types.ts (-32003).
 * broker.ts declares flat per-code constants rather than importing that
 * enum — same pattern as BROKER_ERROR_CODE_DRAIN_TIMEOUT above; keep the
 * two values in sync.
 */
export const BROKER_ERROR_CODE_POOL_UNAVAILABLE = -32003;

/** Default per-agent concurrency cap (CONTEXT.md decision §4). */
const DEFAULT_PER_AGENT_MAX_CONCURRENT = 4;

/** Default drain ceiling on last-ref disconnect (Pitfall 3). */
const DEFAULT_DRAIN_TIMEOUT_MS = 2000;

/**
 * Phase 999.26.1 — minimum delay before SIGTERMing a pool whose refCount
 * just dropped to 0 with no inflight requests. Without this, the
 * `inflight.size === 0` fast path in `beginDrain` immediately kills the
 * pool child, which causes pool churn when transient probe shims connect
 * + disconnect rapidly (heartbeat probes, on-demand mcp-status, etc.).
 *
 * Each pool spawn costs ~500ms cold start; killing-and-respawning every
 * 60s heartbeat tick AND every rebind from `mcpEnvOverrides` mismatch
 * caused warm-path timeouts during fin-client boot on 2026-05-01.
 *
 * 1000ms is enough to absorb a typical heartbeat probe cycle (probe shim
 * spawns, connects, sends `tools/list`, gets response, disconnects — all
 * within ~200-400ms typically) and the next agent dispatch arrives well
 * within this window for active agents.
 */
const DEFAULT_DRAIN_FAST_PATH_DELAY_MS = 1000;

/**
 * Phase 999.106 QW-3 — pool-child respawn backoff + circuit breaker.
 *
 * INVARIANT: a pool child that boots-then-dies is NEVER respawned faster
 * than the backoff schedule below, and a child that keeps dying stops
 * being respawned at all until the breaker cooldown elapses.
 *
 * Before these existed, `handleChildExit` respawned unconditionally from
 * the child's own 'exit' listener with no delay and no cap — `respawnCount`
 * was logging-only. A child that dies during boot (1P 429, auth failure)
 * therefore respawned as fast as the spawn could fork. Measured in
 * production on 2026-08-14: 44 overlapping `@takescake/1password-mcp`
 * process trees, none older than ~52min against a 4.6h daemon.
 *
 * Exported so tests pin the schedule rather than duplicating the numbers.
 */

/** A child that exits sooner than this after spawn never booted. */
export const RESPAWN_FAST_EXIT_MS = 30_000;

/** First backed-off delay; doubles per additional consecutive fast exit. */
export const RESPAWN_BACKOFF_BASE_MS = 1_000;

/** Ceiling on the exponential delay. */
export const RESPAWN_BACKOFF_MAX_MS = 300_000;

/** Fast exits inside RESPAWN_BREAKER_WINDOW_MS that trip the breaker. */
export const RESPAWN_BREAKER_THRESHOLD = 5;

/** Sliding window the threshold is counted over. */
export const RESPAWN_BREAKER_WINDOW_MS = 600_000;

/** How long the breaker stays open before a single half-open probe. */
export const RESPAWN_BREAKER_COOLDOWN_MS = 900_000;

/**
 * Breaker state for one pool's respawn loop.
 *
 * "half-open" is a probe spawn: exactly one child is allowed through after
 * the cooldown. If it also dies fast the breaker re-opens for another
 * cooldown; if it lives past RESPAWN_FAST_EXIT_MS the breaker closes.
 */
type BreakerState = "closed" | "open" | "half-open";

/**
 * Spawn function injection point. Tests pass a fake; production passes a
 * real `child_process.spawn`-backed function. The broker calls this once
 * per pool (per unique tokenHash) and re-calls it on auto-respawn.
 *
 * INC-2026-07-27 — returns `ChildProcess | null`. `null` means "refuse to
 * spawn a pool for this tokenHash" (the daemon's implementation returns it
 * when the tokenHash resolves to an empty rawToken). The broker treats a
 * refusal as a per-agent degradation, NOT a daemon-level failure: it never
 * constructs a Pool for a refused spawn, so `Pool.child` stays
 * non-nullable and the pool map can never hold a poisoned entry.
 */
export type BrokerSpawnFn = (args: {
  tokenHash: string;
  rawToken: string;
}) => ChildProcess | null;

/**
 * Per-agent connection — the broker doesn't own the wire (ShimServer
 * does); it just gets a typed handle that lets it deliver JSON-RPC
 * responses back to the originating agent and observe disconnect.
 */
export type BrokerAgentConnection = {
  agentName: string;
  tokenHash: string;
  /**
   * Raw OP_SERVICE_ACCOUNT_TOKEN literal. Required for the FIRST
   * connection on a tokenHash so the broker can spawn the pool child;
   * subsequent connections on the same hash carry the same token but
   * the broker never logs it.
   */
  rawToken: string;
  send(msg: JsonRpcMessage): void;
  onClose(fn: () => void): void;
};

export type BrokerDeps = {
  log: Logger;
  spawnFn: BrokerSpawnFn;
  perAgentMaxConcurrent?: number;
  drainTimeoutMs?: number;
};

/** Public status surface — used by heartbeat and Phase 108-04 telemetry. */
export type PoolStatus = {
  tokenHash: string;
  alive: boolean;
  agentRefCount: number;
  inflightCount: number;
  queueDepth: number;
  respawnCount: number;
  childPid: number | null;
  /**
   * Phase 109-A — per-pool throughput + throttle observability. Lets
   * operators see WHICH pool is hammering the 1Password service-account
   * quota in real time and whether the upstream is throttling.
   *
   * Both fields are optional so existing 108 consumers (heartbeat check)
   * keep working without an explicit upgrade — they read PoolStatus.alive
   * + agentRefCount only. Tests assert that the heartbeat provider
   * surface stays narrow.
   */
  /** Dispatched calls in the trailing 60s window. */
  rpsLastMin?: number;
  /** Count of throttle-classified responses in the trailing 24h window. */
  throttleEvents24h?: number;
  /** Last Retry-After value (seconds) parsed from a throttle response, or null. */
  lastRetryAfterSec?: number | null;
  /**
   * Phase 999.106 QW-3 — respawn-breaker observability. Optional for the
   * same reason as the 109-A fields: existing consumers (heartbeat check,
   * `clawcode broker-status`) read a narrower shape and must keep
   * compiling without an explicit upgrade.
   *
   * `breakerOpen` is true only while respawns are SUSPENDED — a half-open
   * probe that is currently serving traffic reports false.
   */
  breakerOpen?: boolean;
  /** Consecutive fast exits; 0 once a child proves itself. */
  consecutiveFastExits?: number;
};

/** Phase 109-A — heuristic detector for upstream throttle responses. */
const THROTTLE_RE = /rate.?limit|429|too many requests/i;

/** 24h in milliseconds — drop throttle-event timestamps older than this. */
const THROTTLE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minimal JSON-RPC message types — we don't need a full schema here. */
type JsonRpcId = number | string;
type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type InflightEntry = {
  agent: BrokerAgentConnection;
  agentReqId: JsonRpcId;
  tool: string;
  turnId: string | undefined;
  startedAt: number;
};

type QueueEntry = {
  agent: BrokerAgentConnection;
  msg: JsonRpcMessage;
  tool: string;
  turnId: string | undefined;
};

type Pool = {
  tokenHash: string;
  rawToken: string;
  child: ChildProcess;
  alive: boolean;
  refCount: number;
  respawnCount: number;
  inflight: Map<number, InflightEntry>; // pool-side id → route
  queue: QueueEntry[];                  // FIFO, per-pool
  stdoutBuf: string;
  draining: boolean;
  drainTimer: NodeJS.Timeout | null;
  /**
   * Phase 109-A — dispatch timestamps (epoch ms). Trimmed to the trailing
   * 60s window on every read. Bounded length: max ~600 entries at 10 rps,
   * O(n) trim per status read which is fine at heartbeat cadence.
   */
  rpsBuffer: number[];
  /** Phase 109-A — throttle-event timestamps in the trailing 24h window. */
  throttleBuffer: number[];
  /** Phase 109-A — last parsed Retry-After (seconds), null if never. */
  lastRetryAfterSec: number | null;
  /**
   * Phase 999.106 QW-3 — epoch ms the CURRENT child was spawned. Drives
   * the fast-exit classification in `handleChildExit`; re-stamped on every
   * respawn so each child is judged on its OWN lifetime.
   */
  spawnedAt: number;
  /** Consecutive fast exits. Reset to 0 by any child that proves itself. */
  consecutiveFastExits: number;
  /**
   * Fast-exit timestamps, trimmed to RESPAWN_BREAKER_WINDOW_MS on write —
   * so `.length` IS the in-window count the threshold compares against.
   */
  fastExitTimes: number[];
  breakerState: BreakerState;
  /** Pending backed-off respawn, or null. */
  respawnTimer: NodeJS.Timeout | null;
  /** Pending half-open probe while the breaker is open, or null. */
  breakerTimer: NodeJS.Timeout | null;
};

type AgentSemaphore = {
  active: number;
};

export class OnePasswordMcpBroker {
  private readonly log: Logger;
  private readonly spawnFn: BrokerSpawnFn;
  private readonly perAgentMaxConcurrent: number;
  private readonly drainTimeoutMs: number;

  private readonly pools: Map<string, Pool> = new Map();
  private readonly agentSemaphores: Map<string, AgentSemaphore> = new Map();
  /** Pitfall 2: pin agent → tokenHash on first connect to detect drift. */
  private readonly agentTokenSticky: Map<string, string> = new Map();

  private nextPoolId = 1;
  private draining = false;

  constructor(deps: BrokerDeps) {
    this.log = deps.log;
    this.spawnFn = deps.spawnFn;
    this.perAgentMaxConcurrent =
      deps.perAgentMaxConcurrent ?? DEFAULT_PER_AGENT_MAX_CONCURRENT;
    this.drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  }

  /**
   * Register a new agent connection. Spawns the pool child on first
   * reference for the tokenHash; otherwise increments refCount.
   */
  async acceptConnection(conn: BrokerAgentConnection): Promise<void> {
    if (this.draining) {
      conn.send({
        jsonrpc: "2.0",
        error: {
          code: BROKER_ERROR_CODE_DRAIN_TIMEOUT,
          message: "Broker shutting down",
        },
      });
      return;
    }

    // Pitfall 2 (Phase 999.26 fix) — agent tokenHash drift handling.
    //
    // When the daemon's env-override resolver returns a different
    // OP_SERVICE_ACCOUNT_TOKEN for an agent across reconnects (legitimate
    // 1Password rotation, scope change via config edit, secrets-resolver
    // cache TTL flip), the agent's shim spawns with a new tokenHash. The
    // ORIGINAL behavior REJECTED the new connection and required a daemon
    // restart — but the SDK respawn loop reads the SAME env on every retry,
    // so the agent reconnects with the SAME new hash, hits the same
    // rejection, and loops every ~3s forever. Production observed this on
    // 2026-05-01 with acme-scope agents (55 events for fin-client
    // in 20 min, saturating MCP capacity to the point of QUEUE_FULL on
    // user messages).
    //
    // FIX: rebind. The daemon is the authority on the agent's token; if
    // the resolver gives us a new one, the broker follows. Detach from old
    // pool (decrement refCount, drain if 0), update sticky map, fall
    // through to normal first-connect path on the new pool. Inflight
    // requests on the old pool's child continue to completion (the OLD
    // token is still valid for those — they were issued under it).
    const stickyHash = this.agentTokenSticky.get(conn.agentName);
    if (stickyHash !== undefined && stickyHash !== conn.tokenHash) {
      this.poolLog(conn.tokenHash).warn(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${conn.tokenHash}`,
          agent: conn.agentName,
          oldHash: stickyHash,
          newHash: conn.tokenHash,
        },
        "agent token rotated — rebinding to new pool",
      );
      this.detachAgentFromOldPool(conn.agentName, stickyHash);
    }
    if (stickyHash === undefined || stickyHash !== conn.tokenHash) {
      this.agentTokenSticky.set(conn.agentName, conn.tokenHash);
    }

    const pool = this.ensurePool(conn.tokenHash, conn.rawToken);
    if (pool === null) {
      // INC-2026-07-27 — pool spawn refused (unresolvable rawToken) or the
      // spawn threw. Degrade THIS agent only; the daemon stays up. We do
      // NOT register a pool, so the agent's subsequent JSON-RPC lines fall
      // through to handleAgentMessage's "No pool for tokenHash" branch and
      // receive a structured error carrying their own request id — which is
      // what the SDK surfaces as a failed MCP server.
      this.poolLog(conn.tokenHash).error(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${conn.tokenHash}`,
          agent: conn.agentName,
        },
        "pool spawn refused — agent 1password MCP degraded (daemon unaffected)",
      );
      // Unpin the sticky hash so a retry is treated as a first connect
      // instead of logging a bogus "token rotated" rebind warning.
      this.agentTokenSticky.delete(conn.agentName);
      conn.send({
        jsonrpc: "2.0",
        error: {
          code: BROKER_ERROR_CODE_POOL_UNAVAILABLE,
          message: "Pool unavailable — MCP token could not be resolved",
        },
      });
      return;
    }
    pool.refCount += 1;

    // Cancel any pending drain — we have a fresh reference.
    if (pool.drainTimer !== null) {
      clearTimeout(pool.drainTimer);
      pool.drainTimer = null;
      pool.draining = false;
    }

    // 999.106 QW-3 review fix — a respawn/probe timer that fires DURING a
    // drain window is dropped by isPoolRespawnable (draining=true) on the
    // assumption the drain will delete the pool. When a reconnect rescues
    // the drain instead (the branch above), the pool would otherwise sit
    // alive=false with NO pending timer forever — every request failing
    // fast until the daemon restarts. Re-arm exactly what was dropped: an
    // open breaker re-arms its probe; otherwise the respawn resumes on the
    // pool's own backoff schedule.
    if (
      !pool.alive &&
      pool.respawnTimer === null &&
      pool.breakerTimer === null &&
      !pool.draining &&
      !this.draining
    ) {
      if (pool.breakerState === "open") {
        this.armBreakerProbe(pool);
      } else {
        const delayMs = respawnBackoffMs(pool.consecutiveFastExits);
        if (delayMs === 0) this.respawnNow(pool);
        else this.scheduleRespawn(pool, delayMs);
      }
    }

    conn.onClose(() => {
      this.handleAgentDisconnect(conn);
    });

    this.poolLog(conn.tokenHash).debug(
      {
        component: "mcp-broker",
        pool: `1password-mcp:${conn.tokenHash}`,
        agent: conn.agentName,
        agentRefCount: pool.refCount,
      },
      "agent attached to pool",
    );
  }

  /**
   * Route a JSON-RPC message from an agent onto the pool. Public so the
   * ShimServer (and tests) can drive it directly.
   */
  async handleAgentMessage(
    conn: BrokerAgentConnection,
    msg: JsonRpcMessage,
  ): Promise<void> {
    const pool = this.pools.get(conn.tokenHash);
    if (pool === undefined) {
      conn.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: BROKER_ERROR_CODE_DRAIN_TIMEOUT,
          message: "No pool for tokenHash",
        },
      });
      return;
    }

    const tool = this.deriveTool(msg);
    const turnId = this.deriveTurnId(msg);

    // Phase 999.106 QW-3 — fail fast while the child is dead. `alive` is
    // false only in the window between a child's exit and its respawn:
    // either the backoff timer is pending or the breaker has suspended
    // respawns entirely. Writing to the dead child's stdin would EPIPE
    // (caught, but reported as a drain error) or black-hole the request,
    // so answer immediately with the code the daemon already maps to
    // "this agent's 1password MCP is degraded". Notifications (no id)
    // fall through to the existing drop path — there is nobody to answer.
    if (!pool.alive && msg.id !== undefined) {
      this.poolLog(conn.tokenHash).warn(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${conn.tokenHash}`,
          agent: conn.agentName,
          turnId,
          tool,
          breakerState: pool.breakerState,
          consecutiveFastExits: pool.consecutiveFastExits,
        },
        "request rejected — pool child down, respawn backing off",
      );
      conn.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: BROKER_ERROR_CODE_POOL_UNAVAILABLE,
          message: "Pool child unavailable — respawn backing off",
        },
      });
      return;
    }

    // Audit log per dispatched call (POOL-06, decision §5). Always-on.
    this.poolLog(conn.tokenHash).debug(
      {
        component: "mcp-broker",
        pool: `1password-mcp:${conn.tokenHash}`,
        agent: conn.agentName,
        turnId,
        tool,
      },
      "dispatch",
    );

    if (msg.id === undefined) {
      // Notification — broker does not multiplex agent → child notifs.
      this.poolLog(conn.tokenHash).debug(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${conn.tokenHash}`,
          agent: conn.agentName,
          tool,
        },
        "notification dropped",
      );
      return;
    }

    const sem = this.getAgentSemaphore(conn.agentName);
    if (sem.active >= this.perAgentMaxConcurrent) {
      pool.queue.push({ agent: conn, msg, tool, turnId });
      return;
    }

    this.dispatchToChild(pool, conn, msg, tool, turnId);
  }

  /** Deferred-dispatch path used after a slot frees up. */
  private dispatchToChild(
    pool: Pool,
    conn: BrokerAgentConnection,
    msg: JsonRpcMessage,
    tool: string,
    turnId: string | undefined,
  ): void {
    const sem = this.getAgentSemaphore(conn.agentName);
    sem.active += 1;

    const poolId = this.nextPoolId++;
    const now = Date.now();
    pool.inflight.set(poolId, {
      agent: conn,
      agentReqId: msg.id as JsonRpcId,
      tool,
      turnId,
      startedAt: now,
    });
    // Phase 109-A — record dispatch for rps observability. Trimmed lazily
    // on getPoolStatus reads so the hot dispatch path stays cheap.
    pool.rpsBuffer.push(now);

    const rewritten = { ...msg, id: poolId };
    try {
      pool.child.stdin?.write(JSON.stringify(rewritten) + "\n");
    } catch (err) {
      // EPIPE / closed — surface as drain-timeout-style error.
      this.poolLog(pool.tokenHash).warn(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${pool.tokenHash}`,
          agent: conn.agentName,
          err: String(err),
        },
        "child stdin write failed",
      );
      pool.inflight.delete(poolId);
      sem.active -= 1;
      conn.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: BROKER_ERROR_CODE_DRAIN_TIMEOUT,
          message: "Pool child unavailable",
        },
      });
    }
  }

  /**
   * Pool spawn + stdout/exit wiring.
   *
   * Returns `null` when the injected spawnFn refuses or throws.
   * INC-2026-07-27: the `Pool` literal is only constructed AFTER a live
   * child is in hand, so `Pool.child` stays non-nullable and a refused
   * spawn can never register a poisoned pool in `this.pools` — the map
   * simply has no entry for that tokenHash and the next attach retries a
   * clean spawn.
   */
  private ensurePool(tokenHash: string, rawToken: string): Pool | null {
    const existing = this.pools.get(tokenHash);
    if (existing !== undefined) return existing;

    const child = this.trySpawnChild(tokenHash, rawToken);
    if (child === null) return null;
    const pool: Pool = {
      tokenHash,
      rawToken,
      child,
      alive: true,
      refCount: 0,
      respawnCount: 0,
      inflight: new Map(),
      queue: [],
      stdoutBuf: "",
      draining: false,
      drainTimer: null,
      rpsBuffer: [],
      throttleBuffer: [],
      lastRetryAfterSec: null,
      spawnedAt: Date.now(),
      consecutiveFastExits: 0,
      fastExitTimes: [],
      breakerState: "closed",
      respawnTimer: null,
      breakerTimer: null,
    };
    this.wireChild(pool);
    this.pools.set(tokenHash, pool);

    this.poolLog(tokenHash).info(
      {
        component: "mcp-broker",
        pool: `1password-mcp:${tokenHash}`,
        childPid: child.pid ?? null,
      },
      "pool child spawned",
    );

    return pool;
  }

  /**
   * INC-2026-07-27 — the single seam around the injected spawnFn. Both a
   * deliberate refusal (`return null` — daemon-side empty rawToken) and a
   * raw throw (resolveBrokerChildSpawn / child_process.spawn blowing up on
   * EACCES, bad argv, …) are converted to `null` here.
   *
   * Why the try/catch and not just the widened return type: the two call
   * sites are (a) `ensurePool`, reached from `acceptConnection`, which the
   * ShimServer invokes UN-AWAITED (`void broker.acceptConnection(...)`) so
   * a throw becomes an unhandledRejection, and (b) `handleChildExit`,
   * which runs inside the child's `'exit'` listener so a throw becomes an
   * uncaughtException. The daemon's handlers `process.exit(1)` on both —
   * that is exactly how one agent's bad token took the whole fleet down.
   *
   * SEC-07: only tokenHash is logged, never the literal.
   */
  private trySpawnChild(
    tokenHash: string,
    rawToken: string,
  ): ChildProcess | null {
    let child: ChildProcess | null | undefined;
    try {
      child = this.spawnFn({ tokenHash, rawToken });
    } catch (err) {
      this.poolLog(tokenHash).error(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${tokenHash}`,
          err: String(err),
        },
        "pool child spawn threw — treating as refused (daemon unaffected)",
      );
      return null;
    }
    if (child === null || child === undefined) {
      this.poolLog(tokenHash).warn(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${tokenHash}`,
        },
        "pool child spawn refused by daemon spawnFn",
      );
      return null;
    }
    return child;
  }

  private wireChild(pool: Pool): void {
    const child = pool.child;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      pool.stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let idx = pool.stdoutBuf.indexOf("\n");
      while (idx !== -1) {
        const line = pool.stdoutBuf.slice(0, idx);
        pool.stdoutBuf = pool.stdoutBuf.slice(idx + 1);
        if (line.length > 0) this.handleChildLine(pool, line);
        idx = pool.stdoutBuf.indexOf("\n");
      }
    });

    child.on("exit", (code, signal) => {
      this.handleChildExit(pool, code, signal);
    });

    child.on("error", (err) => {
      this.poolLog(pool.tokenHash).error(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${pool.tokenHash}`,
          err: String(err),
        },
        "pool child error",
      );
    });
  }

  private handleChildLine(pool: Pool, line: string): void {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(line) as JsonRpcMessage;
    } catch (err) {
      this.poolLog(pool.tokenHash).warn(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${pool.tokenHash}`,
          err: String(err),
        },
        "malformed JSON line from child",
      );
      return;
    }

    if (parsed.id === undefined) {
      // Notification from child — drop (no fan-out policy yet, see 108-00).
      this.poolLog(pool.tokenHash).debug(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${pool.tokenHash}`,
          method: parsed.method,
        },
        "child notification dropped",
      );
      return;
    }

    const poolId = typeof parsed.id === "number" ? parsed.id : Number(parsed.id);
    const route = pool.inflight.get(poolId);
    if (route === undefined) {
      // Late or unmatched response.
      return;
    }
    pool.inflight.delete(poolId);

    // Phase 109-A — classify error responses as throttle if message matches.
    // Stateless heuristic: exact regex on the JSON-RPC error.message string.
    // Token-redaction invariant (Phase 104 SEC-07): we DO NOT log error.data,
    // only the boolean classification + parsed retryAfter integer.
    if (parsed.error !== undefined) {
      const errMsg = parsed.error.message ?? "";
      if (THROTTLE_RE.test(errMsg)) {
        const tNow = Date.now();
        pool.throttleBuffer.push(tNow);
        const ra = parseRetryAfterSeconds(parsed.error.data);
        if (ra !== null) pool.lastRetryAfterSec = ra;
        this.poolLog(pool.tokenHash).warn(
          {
            component: "mcp-broker",
            pool: `1password-mcp:${pool.tokenHash}`,
            agent: route.agent.agentName,
            turnId: route.turnId,
            tool: route.tool,
            retryAfterSec: ra,
            throttleEvents24h: countWithinWindow(pool.throttleBuffer, tNow, THROTTLE_WINDOW_MS),
          },
          "throttle response from pool child",
        );
      }
    }

    // Restore agent-side id and deliver.
    const restored: JsonRpcMessage = { ...parsed, id: route.agentReqId };
    try {
      route.agent.send(restored);
    } catch {
      // Agent disconnect race — swallow.
    }

    // Release semaphore slot, drain pool queue if applicable.
    this.releaseAgentSlot(pool, route.agent.agentName);

    this.poolLog(pool.tokenHash).debug(
      {
        component: "mcp-broker",
        pool: `1password-mcp:${pool.tokenHash}`,
        agent: route.agent.agentName,
        turnId: route.turnId,
        tool: route.tool,
        durationMs: Date.now() - route.startedAt,
        result: parsed.error !== undefined ? "error" : "ok",
      },
      "dispatch complete",
    );

    // If pool was draining and inflight is now empty → kill immediately.
    if (pool.draining && pool.inflight.size === 0 && pool.refCount === 0) {
      this.killPoolNow(pool);
    }
  }

  private releaseAgentSlot(pool: Pool, agentName: string): void {
    const sem = this.getAgentSemaphore(agentName);
    sem.active = Math.max(0, sem.active - 1);

    // Drain pool queue: find next entry whose agent has free slot.
    for (let i = 0; i < pool.queue.length; i++) {
      const entry = pool.queue[i]!;
      const entrySem = this.getAgentSemaphore(entry.agent.agentName);
      if (entrySem.active < this.perAgentMaxConcurrent) {
        pool.queue.splice(i, 1);
        this.dispatchToChild(pool, entry.agent, entry.msg, entry.tool, entry.turnId);
        return;
      }
    }
  }

  private handleChildExit(
    pool: Pool,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const exitedAt = Date.now();
    const lifetimeMs = exitedAt - pool.spawnedAt;
    pool.alive = false;
    this.poolLog(pool.tokenHash).warn(
      {
        component: "mcp-broker",
        pool: `1password-mcp:${pool.tokenHash}`,
        exitCode: code,
        signal,
        inflightCount: pool.inflight.size,
        lifetimeMs,
      },
      "pool child exited",
    );

    // Fail every inflight with a structured pool-crash error. We use the
    // drain-timeout code as a generic broker-side failure marker; the
    // PooledChild module (108-01) defines the precise crash code which
    // the integration tests assert.
    const inflightSnapshot = Array.from(pool.inflight.values());
    pool.inflight.clear();
    for (const entry of inflightSnapshot) {
      try {
        entry.agent.send({
          jsonrpc: "2.0",
          id: entry.agentReqId,
          error: {
            code: -32001, // BROKER_ERROR_CODE_POOL_CRASH from 108-01
            message: "Pool child exited unexpectedly",
          },
        });
      } catch {
        // ignore
      }
      const sem = this.getAgentSemaphore(entry.agent.agentName);
      sem.active = Math.max(0, sem.active - 1);
    }

    // Auto-respawn if any agents still attached and we're not draining.
    //
    // Phase 999.106 QW-3 — this guard stays FIRST, ahead of any fast-exit
    // bookkeeping: a child SIGTERMed by `killPoolNow` fires 'exit' on a
    // pool that is already out of the map, and that exit must not push a
    // breaker timestamp or arm a timer that would resurrect the child.
    if (!(pool.refCount > 0 && !pool.draining && !this.draining)) {
      // No agents — remove pool (and any timer still pointing at it).
      this.clearPoolTimers(pool);
      this.forgetPool(pool);
      return;
    }

    this.recordExitOutcome(pool, exitedAt, lifetimeMs);

    if (this.shouldOpenBreaker(pool)) {
      this.openBreaker(pool);
      return;
    }

    const delayMs = respawnBackoffMs(pool.consecutiveFastExits);
    if (delayMs === 0) {
      // Immediate — a direct call, NOT setTimeout(…, 0). The respawn (and
      // its INC-2026-07-27 teardown-on-refusal path) must still complete
      // inside this 'exit' listener, which is what the incident regression
      // tests assert synchronously.
      this.respawnNow(pool);
      return;
    }
    this.scheduleRespawn(pool, delayMs);
  }

  /**
   * Phase 999.106 QW-3 — classify the exit that just happened and update
   * the backoff/breaker counters.
   *
   * A child that lived at least RESPAWN_FAST_EXIT_MS proves the pool is
   * healthy, so it clears EVERY piece of inherited failure state — the
   * counter, the window, and the breaker (a half-open probe that survived
   * this long has graduated). Doing the reset here, before the delay is
   * computed, is what keeps a long-lived child's one-off crash on the
   * immediate-respawn path no matter what the pool's history was.
   */
  private recordExitOutcome(
    pool: Pool,
    exitedAt: number,
    lifetimeMs: number,
  ): void {
    if (lifetimeMs >= RESPAWN_FAST_EXIT_MS) {
      pool.consecutiveFastExits = 0;
      pool.fastExitTimes = [];
      pool.breakerState = "closed";
      return;
    }
    pool.consecutiveFastExits += 1;
    pool.fastExitTimes = [
      ...trimWindow(pool.fastExitTimes, exitedAt, RESPAWN_BREAKER_WINDOW_MS),
      exitedAt,
    ];
  }

  private shouldOpenBreaker(pool: Pool): boolean {
    // The child proved itself — recordExitOutcome already closed the breaker.
    if (pool.consecutiveFastExits === 0) return false;
    // A failed half-open probe re-opens on its OWN evidence. The window
    // count can NOT be the trigger here: RESPAWN_BREAKER_COOLDOWN_MS (15m)
    // is deliberately longer than RESPAWN_BREAKER_WINDOW_MS (10m), so by
    // the time a probe runs, every fast exit that opened the breaker has
    // aged out and the count is back to 1. Do not "simplify" this branch
    // away into the threshold test below — that reopens the churn loop.
    if (pool.breakerState === "half-open") return true;
    return pool.fastExitTimes.length >= RESPAWN_BREAKER_THRESHOLD;
  }

  /**
   * Suspend respawns for this pool and arm the single half-open probe.
   *
   * The pool deliberately STAYS in the map with `alive: false` — that is
   * what makes `handleAgentMessage` fail fast and what surfaces the
   * degraded pool to the existing heartbeat check (mcpBrokerCheck reports
   * critical for `alive=false && agentRefCount>0`). A fresh `acceptConnection`
   * during the cooldown attaches to the open-breaker pool rather than
   * spawning: an SDK reconnect loop must not be a respawn loop by proxy.
   */
  private openBreaker(pool: Pool): void {
    pool.breakerState = "open";
    const queuedFailed = this.failQueuedRequests(
      pool,
      "Pool child respawn suspended — circuit breaker open",
    );
    this.poolLog(pool.tokenHash).warn(
      {
        component: "mcp-broker",
        pool: `1password-mcp:${pool.tokenHash}`,
        tokenHash: pool.tokenHash,
        consecutiveFastExits: pool.consecutiveFastExits,
        fastExitsInWindow: pool.fastExitTimes.length,
        breakerWindowMs: RESPAWN_BREAKER_WINDOW_MS,
        cooldownMs: RESPAWN_BREAKER_COOLDOWN_MS,
        respawnCount: pool.respawnCount,
        agentRefCount: pool.refCount,
        queuedFailed,
      },
      "pool child respawn breaker OPEN — 1password MCP degraded for this token",
    );
    this.armBreakerProbe(pool);
  }

  private armBreakerProbe(pool: Pool): void {
    this.clearBreakerTimer(pool);
    const timer = setTimeout(() => {
      pool.breakerTimer = null;
      if (!this.isPoolRespawnable(pool)) return;
      pool.breakerState = "half-open";
      this.poolLog(pool.tokenHash).info(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${pool.tokenHash}`,
          consecutiveFastExits: pool.consecutiveFastExits,
        },
        "pool child respawn breaker HALF-OPEN — probing with one child",
      );
      this.respawnNow(pool);
    }, RESPAWN_BREAKER_COOLDOWN_MS);
    // Unlike the ≤2s drainTimer, these run for minutes — an armed probe
    // must never be the reason the process stays alive.
    timer.unref();
    pool.breakerTimer = timer;
  }

  private scheduleRespawn(pool: Pool, delayMs: number): void {
    const queuedFailed = this.failQueuedRequests(
      pool,
      "Pool child respawn backing off",
    );
    this.clearRespawnTimer(pool);
    const timer = setTimeout(() => {
      pool.respawnTimer = null;
      if (!this.isPoolRespawnable(pool)) return;
      this.respawnNow(pool);
    }, delayMs);
    timer.unref();
    pool.respawnTimer = timer;
    this.poolLog(pool.tokenHash).warn(
      {
        component: "mcp-broker",
        pool: `1password-mcp:${pool.tokenHash}`,
        backoffMs: delayMs,
        consecutiveFastExits: pool.consecutiveFastExits,
        agentRefCount: pool.refCount,
        queuedFailed,
      },
      "pool child exited fast — respawn deferred (backoff)",
    );
  }

  /**
   * Re-validate on the timer edge. Between arming and firing the pool may
   * have drained, been killed and replaced by a fresh pool on the same
   * tokenHash, or the daemon may have started shutting down — in every
   * case the deferred spawn must be dropped rather than forking a child
   * nobody is waiting for.
   */
  private isPoolRespawnable(pool: Pool): boolean {
    return (
      this.pools.get(pool.tokenHash) === pool &&
      !this.draining &&
      !pool.draining &&
      pool.refCount > 0
    );
  }

  private respawnNow(pool: Pool): void {
    pool.respawnCount += 1;
    const newChild = this.trySpawnChild(pool.tokenHash, pool.rawToken);
    if (newChild === null) {
      // INC-2026-07-27 — respawn refused or threw. Tear the pool down
      // rather than assigning a null child (THAT is what would poison the
      // pool). Inflight entries were already failed AND semaphore-released
      // by handleChildExit; queued entries never incremented the semaphore
      // (only dispatchToChild does), so they just need the typed error.
      // Dropping the map entry lets a later attach re-attempt a clean
      // spawn once the daemon token map is repaired.
      const queuedFailed = this.failQueuedRequests(
        pool,
        "Pool child respawn failed",
      );
      this.poolLog(pool.tokenHash).error(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${pool.tokenHash}`,
          respawnCount: pool.respawnCount,
          agentRefCount: pool.refCount,
          queuedFailed,
        },
        "pool child respawn refused — pool removed (daemon unaffected)",
      );
      this.clearPoolTimers(pool);
      this.forgetPool(pool);
      return;
    }
    pool.child = newChild;
    pool.alive = true;
    pool.stdoutBuf = "";
    pool.spawnedAt = Date.now();
    this.wireChild(pool);
    this.poolLog(pool.tokenHash).info(
      {
        component: "mcp-broker",
        pool: `1password-mcp:${pool.tokenHash}`,
        respawnCount: pool.respawnCount,
        consecutiveFastExits: pool.consecutiveFastExits,
        breakerState: pool.breakerState,
        childPid: newChild.pid ?? null,
      },
      "pool child respawned",
    );
    // Flush queue: any queued items can now dispatch on fresh child. Only
    // the immediate path can find anything here — every deferred path
    // fails the queue up front rather than parking it for minutes.
    const queued = pool.queue.splice(0);
    for (const q of queued) {
      const sem = this.getAgentSemaphore(q.agent.agentName);
      if (sem.active < this.perAgentMaxConcurrent) {
        this.dispatchToChild(pool, q.agent, q.msg, q.tool, q.turnId);
      } else {
        pool.queue.push(q);
      }
    }
  }

  /**
   * Answer every queued request with the pool-unavailable contract and
   * empty the queue. Returns how many were failed (for the caller's log).
   *
   * Queued entries never took a semaphore slot — only `dispatchToChild`
   * increments — so there is nothing to release here.
   */
  private failQueuedRequests(pool: Pool, message: string): number {
    const queuedSnapshot = pool.queue.splice(0);
    for (const q of queuedSnapshot) {
      try {
        q.agent.send({
          jsonrpc: "2.0",
          id: q.msg.id,
          error: {
            code: BROKER_ERROR_CODE_POOL_UNAVAILABLE,
            message,
          },
        });
      } catch {
        // Agent disconnect race — ignore.
      }
    }
    return queuedSnapshot.length;
  }

  /**
   * Drop the pool from the map ONLY if the map still points at this exact
   * object. A late 'exit' from a killed child must never evict the fresh
   * pool a reconnecting agent just created on the same tokenHash.
   */
  private forgetPool(pool: Pool): void {
    if (this.pools.get(pool.tokenHash) === pool) {
      this.pools.delete(pool.tokenHash);
    }
  }

  private clearRespawnTimer(pool: Pool): void {
    if (pool.respawnTimer !== null) {
      clearTimeout(pool.respawnTimer);
      pool.respawnTimer = null;
    }
  }

  private clearBreakerTimer(pool: Pool): void {
    if (pool.breakerTimer !== null) {
      clearTimeout(pool.breakerTimer);
      pool.breakerTimer = null;
    }
  }

  /** Every timer this pool can own — drain, backed-off respawn, probe. */
  private clearPoolTimers(pool: Pool): void {
    if (pool.drainTimer !== null) {
      clearTimeout(pool.drainTimer);
      pool.drainTimer = null;
    }
    this.clearRespawnTimer(pool);
    this.clearBreakerTimer(pool);
  }

  /**
   * Phase 999.26 — detach an agent from a previously-bound pool when the
   * daemon's env-override resolver returns a new tokenHash for that agent.
   *
   * Mirrors the bookkeeping in `handleAgentDisconnect` (refCount decrement,
   * drain trigger when refCount hits 0) but is keyed by `(agentName,
   * oldTokenHash)` rather than the connection object — the new connection
   * is on a DIFFERENT pool, and the old connection's onClose has already
   * fired (or is about to fire as the shim respawn cycle completes).
   *
   * Inflight requests on the old pool's child are NOT canceled — they
   * complete on the old token (still valid until 1P actually invalidates
   * it). The old pool drains naturally once its refCount reaches 0.
   *
   * Safe to call when no old pool exists (no-op).
   */
  private detachAgentFromOldPool(
    agentName: string,
    oldTokenHash: string,
  ): void {
    const oldPool = this.pools.get(oldTokenHash);
    if (oldPool === undefined) return;
    oldPool.refCount = Math.max(0, oldPool.refCount - 1);
    // Drop any queued entries owned by this agent on the old pool. The
    // requests will be reissued on the new pool by the SDK when the agent
    // retries (or silently dropped if the agent moved on).
    oldPool.queue = oldPool.queue.filter(
      (q) => q.agent.agentName !== agentName,
    );
    if (oldPool.refCount === 0) {
      this.beginDrain(oldPool);
    }
  }

  private handleAgentDisconnect(conn: BrokerAgentConnection): void {
    const pool = this.pools.get(conn.tokenHash);
    if (pool === undefined) return;
    pool.refCount = Math.max(0, pool.refCount - 1);

    // Drop any queued entries for this agent (won't be deliverable).
    pool.queue = pool.queue.filter((q) => q.agent !== conn);

    // Clear sticky pin once agent has no more connections anywhere.
    let agentStillAttached = false;
    for (const [, p] of this.pools) {
      for (const e of p.inflight.values()) {
        if (e.agent.agentName === conn.agentName) {
          agentStillAttached = true;
          break;
        }
      }
      if (agentStillAttached) break;
    }
    if (!agentStillAttached) {
      // Note: refCount already decremented above; if pool refCount > 0
      // there are still other connections for this agent name; we keep
      // the sticky pin until the very last connection closes. We use a
      // simple heuristic: if no pool has this agentName in any inflight
      // AND refCount==0 across all pools, drop sticky.
      let anyConnElsewhere = false;
      for (const [, p] of this.pools) {
        if (p.refCount > 0 && p.tokenHash === conn.tokenHash && p === pool) continue;
        // We don't track per-agent refcounts, so be conservative: leave sticky.
        if (p.refCount > 0) anyConnElsewhere = true;
      }
      if (!anyConnElsewhere) {
        this.agentSemaphores.delete(conn.agentName);
      }
    }

    if (pool.refCount === 0) {
      this.beginDrain(pool);
    }
  }

  private beginDrain(pool: Pool): void {
    if (pool.draining) return;
    pool.draining = true;
    this.poolLog(pool.tokenHash).info(
      {
        component: "mcp-broker",
        pool: `1password-mcp:${pool.tokenHash}`,
        inflightCount: pool.inflight.size,
      },
      "pool draining (last ref disconnected)",
    );

    // Phase 999.26.1 — when there's no inflight, schedule the kill on a
    // short delay instead of SIGTERMing immediately. This absorbs the
    // transient connect-disconnect cycles caused by probe shims (heartbeat
    // probes, on-demand mcp-status) so the pool child survives until the
    // next legitimate dispatch. If a fresh connection rescues the pool
    // before the delay elapses, `acceptConnection`'s drain-cancel branch
    // clears the timer and the pool stays alive with zero respawn cost.
    if (pool.inflight.size === 0) {
      pool.drainTimer = setTimeout(() => {
        this.killPoolNow(pool);
      }, DEFAULT_DRAIN_FAST_PATH_DELAY_MS);
      return;
    }

    pool.drainTimer = setTimeout(() => {
      // Drain timeout — fail every inflight with structured error.
      const inflightSnapshot = Array.from(pool.inflight.values());
      pool.inflight.clear();
      for (const entry of inflightSnapshot) {
        try {
          entry.agent.send({
            jsonrpc: "2.0",
            id: entry.agentReqId,
            error: {
              code: BROKER_ERROR_CODE_DRAIN_TIMEOUT,
              message: "Pool drain timeout exceeded",
            },
          });
        } catch {
          // ignore
        }
      }
      this.killPoolNow(pool);
    }, this.drainTimeoutMs);
  }

  private killPoolNow(pool: Pool): void {
    this.clearPoolTimers(pool);
    if (pool.alive) {
      try {
        pool.child.kill("SIGTERM");
      } catch (err) {
        this.poolLog(pool.tokenHash).warn(
          {
            component: "mcp-broker",
            pool: `1password-mcp:${pool.tokenHash}`,
            err: String(err),
          },
          "SIGTERM failed",
        );
      }
    }
    this.pools.delete(pool.tokenHash);
  }

  private getAgentSemaphore(agentName: string): AgentSemaphore {
    let sem = this.agentSemaphores.get(agentName);
    if (sem === undefined) {
      sem = { active: 0 };
      this.agentSemaphores.set(agentName, sem);
    }
    return sem;
  }

  private deriveTool(msg: JsonRpcMessage): string {
    if (msg.method === "tools/call" && typeof msg.params === "object" && msg.params !== null) {
      const name = (msg.params as { name?: unknown }).name;
      if (typeof name === "string") return name;
    }
    return msg.method ?? "unknown";
  }

  private deriveTurnId(msg: JsonRpcMessage): string | undefined {
    if (typeof msg.params !== "object" || msg.params === null) return undefined;
    const meta = (msg.params as { _meta?: unknown })._meta;
    if (typeof meta !== "object" || meta === null) return undefined;
    const turnId = (meta as { turnId?: unknown }).turnId;
    return typeof turnId === "string" ? turnId : undefined;
  }

  private poolLog(tokenHash: string): Logger {
    return this.log.child({ pool: `1password-mcp:${tokenHash}` });
  }

  /** Snapshot of every pool's status — used by heartbeat. */
  getPoolStatus(): PoolStatus[] {
    const now = Date.now();
    const out: PoolStatus[] = [];
    for (const [, pool] of this.pools) {
      // Phase 109-A — lazy trim on read. Cheap because the buffers are
      // bounded by recent dispatch rate (rps × 60) and recent throttle
      // count (rare events).
      pool.rpsBuffer = trimWindow(pool.rpsBuffer, now, 60_000);
      pool.throttleBuffer = trimWindow(
        pool.throttleBuffer,
        now,
        THROTTLE_WINDOW_MS,
      );
      out.push({
        tokenHash: pool.tokenHash,
        alive: pool.alive,
        agentRefCount: pool.refCount,
        inflightCount: pool.inflight.size,
        queueDepth: pool.queue.length,
        respawnCount: pool.respawnCount,
        childPid: pool.child.pid ?? null,
        rpsLastMin: pool.rpsBuffer.length,
        throttleEvents24h: pool.throttleBuffer.length,
        lastRetryAfterSec: pool.lastRetryAfterSec,
        breakerOpen: pool.breakerState === "open",
        consecutiveFastExits: pool.consecutiveFastExits,
      });
    }
    return out;
  }

  /** Reject new connections; existing finish naturally. */
  preDrainNotify(): void {
    this.draining = true;
  }

  /**
   * Full daemon-shutdown drain — kill every pool child within the ceiling.
   */
  async shutdown(timeoutMs: number = 5000): Promise<void> {
    this.draining = true;
    const deadline = Date.now() + timeoutMs;

    for (const [, pool] of this.pools) {
      // Phase 999.106 QW-3 — disarm first. A backed-off respawn or a
      // 15-minute breaker probe that fires after the drain would spawn a
      // pool child the daemon is no longer there to own.
      this.clearPoolTimers(pool);
      // Force-fail any queued or inflight; SIGTERM child.
      const inflightSnapshot = Array.from(pool.inflight.values());
      pool.inflight.clear();
      for (const entry of inflightSnapshot) {
        try {
          entry.agent.send({
            jsonrpc: "2.0",
            id: entry.agentReqId,
            error: {
              code: BROKER_ERROR_CODE_DRAIN_TIMEOUT,
              message: "Broker shutting down",
            },
          });
        } catch {
          // ignore
        }
      }
      pool.queue = [];
      try {
        pool.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }

    // Wait for children to exit (best-effort) up to deadline.
    while (Date.now() < deadline) {
      const stillAlive = Array.from(this.pools.values()).some((p) => p.alive);
      if (!stillAlive) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    this.pools.clear();
  }
}

/**
 * Phase 999.106 QW-3 — respawn delay for the Nth consecutive fast exit.
 *
 *   n === 0 → the child that just died had proven itself (lived at least
 *             RESPAWN_FAST_EXIT_MS). A one-off crash respawns immediately,
 *             exactly as the broker behaved before backoff existed.
 *   n === 1 → first fast exit, still immediate. Backoff throttles a LOOP,
 *             and one exit is not yet a loop; keeping it immediate also
 *             preserves the synchronous respawn/teardown inside the 'exit'
 *             listener that the INC-2026-07-27 regression tests pin.
 *   n >= 2  → RESPAWN_BACKOFF_BASE_MS doubling per additional fast exit
 *             (1s, 2s, 4s, …), capped at RESPAWN_BACKOFF_MAX_MS.
 *
 * Pure — exported so the schedule is pinned by a table test.
 */
export function respawnBackoffMs(consecutiveFastExits: number): number {
  if (consecutiveFastExits <= 1) return 0;
  const raw = RESPAWN_BACKOFF_BASE_MS * 2 ** (consecutiveFastExits - 2);
  return Math.min(raw, RESPAWN_BACKOFF_MAX_MS);
}

/**
 * Phase 109-A — drop timestamps older than `windowMs` from the buffer's
 * head. Pure; returns a new array slice.
 */
function trimWindow(
  buf: readonly number[],
  now: number,
  windowMs: number,
): number[] {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < buf.length && (buf[i] as number) < cutoff) i++;
  return buf.slice(i);
}

function countWithinWindow(
  buf: readonly number[],
  now: number,
  windowMs: number,
): number {
  const cutoff = now - windowMs;
  let n = 0;
  for (const t of buf) if (t >= cutoff) n++;
  return n;
}

/**
 * Phase 109-A — best-effort parse of an MCP error.data shape into a
 * Retry-After seconds integer. Accepts numbers, strings of seconds, or
 * shapes like `{ retryAfter: 5 }` or `{ retryAfterSeconds: 5 }`. Returns
 * null when no recognizable value is present.
 */
function parseRetryAfterSeconds(data: unknown): number | null {
  if (typeof data === "number" && Number.isFinite(data)) return data;
  if (typeof data === "string") {
    const n = Number(data);
    return Number.isFinite(n) ? n : null;
  }
  if (data !== null && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["retryAfter", "retryAfterSeconds", "retry_after"]) {
      const v = obj[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}
