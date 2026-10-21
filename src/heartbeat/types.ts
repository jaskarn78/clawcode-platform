import type { SessionManager } from "../manager/session-manager.js";
import type { Registry } from "../manager/types.js";
import type { ThreadManager } from "../discord/thread-manager.js";
import type { TaskStore } from "../tasks/store.js";
import type { SecretsResolver } from "../manager/secrets-resolver.js";
import type { BrokerStatusProvider } from "./checks/mcp-broker.js";
import type { InboxMessage } from "../collaboration/types.js";

/**
 * Health check status values.
 */
export type CheckStatus = "healthy" | "warning" | "critical";

/**
 * Result of a single health check execution.
 */
export type CheckResult = {
  readonly status: CheckStatus;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Context provided to each check during execution.
 */
export type CheckContext = {
  readonly agentName: string;
  readonly sessionManager: SessionManager;
  readonly registry: Registry;
  readonly config: HeartbeatConfig;
  readonly threadManager?: ThreadManager;
  readonly taskStore?: TaskStore;
  /**
   * Phase 104 plan 03 (SEC-05) — exposed to checks that build
   * RecoveryDeps so the op-refresh recovery handler can invalidate the
   * secrets cache before re-resolving stale auth-error values. Optional
   * because most checks (auto-linker, fs-probe, etc.) don't need it; only
   * mcp-reconnect builds RecoveryDeps. Tests for those unrelated checks
   * leave it undefined and continue working unchanged.
   */
  readonly secretsResolver?: SecretsResolver;
  /**
   * Phase 108 (POOL-07) — daemon-side adapter exposing
   * `broker.getPoolStatus()` to the mcp-broker heartbeat check. Optional
   * because most checks (auto-linker, fs-probe, etc.) don't need it; only
   * the mcp-broker check reads it. Tests for unrelated checks leave it
   * undefined and continue working unchanged. **Intentionally narrow:
   * NEVER add a dispatch / callTool / sendRequest method here — see
   * checks/mcp-broker.ts header (rate-limit-budget invariant).**
   */
  readonly brokerStatusProvider?: BrokerStatusProvider;
  /**
   * Phase 124 Plan 04 T-02 — auto-trigger wiring. When present, the
   * `context-fill` check fires this closure (fire-and-forget) whenever
   * the per-agent `autoCompactAt` threshold is crossed AND the cooldown
   * window has elapsed. Daemon constructs the closure as a thin wrapper
   * around `handleCompactSession` with the same deps the IPC path uses,
   * so both manual and auto paths flow through identical compaction
   * semantics. UNDEFINED when the runner has not been wired (legacy /
   * test path); the check then skips auto-trigger silently.
   */
  readonly compactSessionTrigger?: (agent: string) => Promise<void>;
  /**
   * Phase 124 Plan 04 T-02 — last-compaction ISO timestamp lookup. Used
   * by the context-fill check to enforce the 5-min cooldown gate. Reads
   * from the same `CompactionEventLog` the `heartbeat-status` IPC payload
   * surfaces, so manual + auto compactions share one cooldown view.
   */
  readonly getLastCompactionAt?: (agent: string) => string | null;
  /** Injectable clock — production uses Date.now (testability hook). */
  readonly now?: () => number;
  /**
   * Phase 124 Plan 04 T-02 — auto-trigger cooldown window in
   * milliseconds. Default 5 min (5*60*1000). Operator can tune via
   * config in a future phase; today it's hard-coded at the daemon-side
   * runner wiring.
   */
  readonly cooldownMs?: number;
  /**
   * Quick 260520-r70 — shared agent-to-agent ack-emitter. The inbox
   * reconciler check fires this (fire-and-forget) AFTER markProcessed
   * succeeds for each delivered cross-agent message. It is the EXACT
   * same emitter instance InboxSource holds (single hook, no
   * bifurcation). UNDEFINED when the runner has not been wired
   * (legacy / test path); the check then skips ack emission silently.
   * Mirrors the `compactSessionTrigger` optional-DI pattern above.
   */
  readonly inboxAckEmitter?: (
    consumed: InboxMessage,
    consumerAgent: string,
  ) => Promise<void>;
  /**
   * Phase 999.117 WS-2 — the SHARED cross-path delivery dedupe. Same
   * instance InboxSource and the Discord bridge relay hold; separate
   * instances would each see a subset of the paths and dedupe nothing
   * between them, which is the exact bug being fixed. UNDEFINED on the
   * legacy/test path → no dedupe, behaviour unchanged.
   */
  readonly deliveryDedupe?: { claim(deliveryId: string | undefined): boolean };
  /**
   * Phase 140 Plan 02 — v3 PTY supervision state lookup for the
   * `pty-liveness` check. Returns the `PtySupervisor.getState()` value for
   * the agent's `claude --channels` child, or `undefined` when no supervisor
   * is registered for the agent. Daemon (Plan 03/04) wires this to the live
   * supervisor registry; tests inject a fake getter. UNDEFINED on the
   * legacy/test path — the `pty-liveness` check treats a v3 agent with no
   * supervisor wired as dead (critical), and returns healthy for non-v3
   * agents regardless (so masking/SDK agents never flap). Mirrors the
   * `compactSessionTrigger` / `inboxAckEmitter` optional-DI pattern above.
   */
  readonly getPtyState?: (
    agent: string,
  ) => import("../llm-runtime/supervisors/pty-supervisor.js").PtyState | undefined;
  /**
   * Phase 140 Plan 02 — v3 ClawCode channel-MCP readiness lookup for the
   * `pty-liveness` check. Returns `true` once the agent's channel server
   * reports `ready` (capability handshake complete), else `false`. Daemon
   * (Plan 03) wires this to the live channel server's readiness signal; tests
   * inject a fake. When the agent's PTY is alive but this returns `false` the
   * check reports `warning` (channel not yet ready), distinguishing a
   * still-warming agent from a dead one.
   */
  readonly getChannelMcpReady?: (agent: string) => boolean;
};

/**
 * A discoverable health check module.
 * Each check file exports a default CheckModule.
 */
export type CheckModule = {
  readonly name: string;
  readonly interval?: number;
  readonly timeout?: number; // Per-check timeout in seconds. Overrides config.checkTimeoutSeconds.
  readonly execute: (context: CheckContext) => Promise<CheckResult>;
};

/**
 * Resolved heartbeat configuration from the config schema.
 */
export type HeartbeatConfig = {
  readonly enabled: boolean;
  readonly intervalSeconds: number;
  readonly checkTimeoutSeconds: number;
  /**
   * Phase 999.12 HB-01 — per-check timeout override for the inbox check
   * only (in milliseconds). Cross-agent turns commonly take 30-90s; the
   * fleet-wide checkTimeoutSeconds (default 10s) generates false-positive
   * critical alerts on the inbox check during an in-flight turn. Specified
   * in milliseconds (rather than seconds) to disambiguate from
   * `checkTimeoutSeconds` and align with millisecond-granular timeout
   * primitives used elsewhere. Threaded from
   * `defaults.heartbeatInboxTimeoutMs` (schema default 60_000).
   */
  readonly inboxTimeoutMs?: number;
  readonly contextFill: {
    readonly warningThreshold: number;
    readonly criticalThreshold: number;
    readonly zoneThresholds?: {
      readonly yellow: number;
      readonly orange: number;
      readonly red: number;
    };
  };
};

/**
 * A single NDJSON log entry written to heartbeat.log.
 */
export type HeartbeatLogEntry = {
  readonly timestamp: string;
  readonly agent: string;
  readonly check: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
};
