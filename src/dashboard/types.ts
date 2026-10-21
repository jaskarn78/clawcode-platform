/**
 * Shared type definitions for the web dashboard.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Configuration for the dashboard HTTP server.
 */
export type DashboardServerConfig = {
  readonly port: number;
  readonly socketPath: string;
  readonly pollIntervalMs?: number;
  /**
   * Interface to bind the HTTP listener to. Defaults to "127.0.0.1"
   * (localhost only). Set to "0.0.0.0" to expose on all interfaces --
   * only safe when the host is behind a private network boundary
   * (Tailscale, VPN, LAN with firewall). Never expose to the public
   * internet without adding authentication first.
   */
  readonly host?: string;
  /**
   * Phase 61 TRIG-03: Optional webhook handler injected by daemon.ts.
   * Routes POST /webhook/<triggerId> to the WebhookSource's HTTP handler
   * for HMAC verification and event ingestion.
   */
  readonly webhookHandler?: (
    triggerId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;

  /**
   * Phase 116-06 T04/T07 — dashboard action audit log. Optional so legacy
   * callers (tests, fixtures) keep working without a JSONL writer. When
   * provided, every dashboard-originated mutation (the F26 PUT config, the
   * F09 migration POSTs, the F10 MCP reconnect, the F28 task POSTs, the
   * F15 veto, the POST /api/agents/:n/:action) calls `.recordAction(...)`
   * after the IPC dispatch succeeds. The SPA telemetry POST appends
   * through the same writer with `action: 'dashboard_v2_*'`. The F23
   * viewer reads the same file via the `list-dashboard-audit` IPC.
   */
  readonly auditTrail?: import("./dashboard-audit-trail.js").DashboardAuditTrail;

  /**
   * Phase 116-06 T08 — operator-driven cutover redirect.
   *
   * When this getter returns `true`, `GET /` responds with
   * `301 Location: /dashboard/v2/` instead of serving the legacy
   * static index.html. The daemon injects a closure over the live
   * `config` ref so the read picks up `defaults.dashboardCutoverRedirect`
   * AFTER each ConfigWatcher hot-reload — no server restart needed.
   *
   * The getter is invoked on every incoming GET / request; keep it cheap
   * (a single property read). Omit (undefined) for legacy callers (tests,
   * embeddings); the handler treats `undefined` identically to `false`.
   */
  readonly cutoverRedirectEnabled?: () => boolean;

  /**
   * 999.95 — live HTML preview store. Injected by daemon.ts so the `/preview`
   * routes can read stored content and register per-id SSE listeners. Optional
   * so legacy callers (tests/fixtures) keep working without a store; when
   * undefined the preview routes respond 503.
   */
  readonly previewStore?: import("./preview-store.js").PreviewStore;
};

/**
 * Agent status data as presented to the dashboard UI.
 * Merged from registry entries and context zone status.
 *
 * Phase 56 Plan 02 — warm-path fields flow through verbatim from the
 * registry entry (server-emit pattern). The dashboard reads these without
 * computing any thresholds: `warm_path_ready` toggles the badge color,
 * `warm_path_readiness_ms` drives the label. Both are optional so legacy
 * entries (pre-Phase-56) render a neutral '—' badge.
 */
export type AgentStatusData = {
  readonly name: string;
  readonly status: string;
  readonly uptime: number | null;
  readonly startedAt: number | null;
  readonly restartCount: number;
  readonly lastError: string | null;
  readonly zone: string | null;
  readonly fillPercentage: number | null;
  readonly model?: string;
  readonly channels?: readonly string[];
  readonly warm_path_ready?: boolean;
  readonly warm_path_readiness_ms?: number | null;
};

/**
 * Full dashboard state snapshot broadcast via SSE.
 */
export type DashboardState = {
  readonly agents: readonly AgentStatusData[];
  readonly updatedAt: number;
};

/**
 * Scheduled task data from the scheduler IPC endpoint.
 */
export type ScheduleData = {
  readonly name: string;
  readonly agentName: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly lastRun: number | null;
  readonly lastStatus: string;
  readonly lastError: string | null;
  readonly nextRun: number | null;
};

/**
 * Context health check data from the heartbeat IPC endpoint.
 */
export type HealthData = {
  readonly agents: Record<
    string,
    {
      readonly checks: Record<
        string,
        {
          readonly status: string;
          readonly message: string;
          readonly lastChecked: string;
        }
      >;
      readonly overall: string;
      readonly zone?: string;
      readonly fillPercentage?: number;
    }
  >;
};

/**
 * Delivery queue statistics and failed entries.
 */
export type DeliveryQueueData = {
  readonly stats: {
    readonly pending: number;
    readonly inFlight: number;
    readonly failed: number;
    readonly delivered: number;
    readonly totalEnqueued: number;
  };
  readonly failed: ReadonlyArray<{
    readonly id: string;
    readonly agentName: string;
    readonly content: string;
    readonly lastError: string | null;
    readonly createdAt: string;
    readonly attempts: number;
  }>;
};

/**
 * Aggregated memory statistics per agent.
 */
export type MemoryStatsData = {
  readonly agents: Record<
    string,
    {
      readonly entryCount: number;
      readonly episodeCount: number;
      readonly tierDistribution: Record<string, number>;
    }
  >;
};

/**
 * Phase 109-D — fleet-wide observability snapshot.
 *
 * Surfaced via the `fleet-stats` IPC method and the `/api/fleet-stats`
 * dashboard endpoint. All fields are optional/nullable so a host without
 * the underlying source (non-Linux dev machine, broker not running, etc.)
 * still produces a valid response — operators see "unknown" rather than
 * a 500.
 *
 * Back-compat invariant: this type is NOT folded into DashboardState.
 * The existing /api/status payload stays byte-identical so the current
 * dashboard JS keeps rendering. Operators who want fleet-stats poll the
 * new endpoint.
 */
export type FleetStatsData = {
  /** cgroup memory pressure snapshot (Linux only — null on other hosts). */
  readonly cgroup: {
    readonly memoryCurrentBytes: number;
    readonly memoryMaxBytes: number | null;
    readonly memoryPercent: number | null;
  } | null;
  /**
   * Live `claude` proc count (from /proc) minus daemon-tracked agent count.
   * Positive value = orphan claudes the daemon doesn't see (109-B target).
   * null when /proc is unavailable.
   */
  readonly claudeProcDrift: {
    readonly liveCount: number;
    readonly trackedCount: number;
    readonly drift: number;
  } | null;
  /**
   * Per-MCP-cmdline-pattern aggregate (count + summed VmRSS in MB).
   *
   * Phase 110 Stage 0a — `runtime` field added so /api/fleet-stats
   * consumers can split shim-runtime cohorts (Stage 0/1 targets) from
   * yaml-defined externals (out of scope) without re-deriving from
   * cmdline. Optional in the type because pre-Stage-0a dashboards keep
   * working byte-identically; daemon always populates it post-Stage-0a.
   */
  readonly mcpFleet: ReadonlyArray<{
    readonly pattern: string;
    readonly count: number;
    readonly rssMB: number;
    readonly runtime?: "node" | "static" | "python" | "external";
  }>;
  /**
   * Phase 110 Stage 0a — rolled-up shim-runtime baseline. The summary
   * `/api/fleet-stats` consumers read to track Stage 0 progress without
   * iterating `mcpFleet`. `null` when no shim-runtime entries exist
   * (distinguish from all-zero baseline). Optional for back-compat with
   * pre-Stage-0a clients; always populated post-Stage-0a.
   */
  readonly shimRuntimeBaseline?: {
    readonly node: { readonly count: number; readonly rssMB: number };
    readonly static?: { readonly count: number; readonly rssMB: number };
    readonly python?: { readonly count: number; readonly rssMB: number };
  } | null;
  /**
   * Phase 119 D-05 — `no_webhook_fallbacks_total{agent, channel}` counter.
   *
   * Monotonic counter since daemon start. Keyed by `${agent}:${channel}` so
   * a single colon separator stays journalctl-grep friendly. Increments on
   * every fallback dispatch (bot-direct path OR inbox-only return path) via
   * the single helper `incrementNoWebhookFallback` in `fleet-stats.ts`. The
   * webhook-success path does NOT increment — the counter measures fallback
   * frequency, not delivery volume.
   *
   * JSON-safe by construction: typed as Record (not Map) so the IPC reply
   * serializes correctly without a Map→Record adapter at the boundary. The
   * snapshot is a shallow copy of the internal counter map — mutating the
   * returned value never mutates daemon state.
   *
   * Optional for back-compat with pre-Phase-119 clients; the daemon always
   * populates it (even at `{}`) post-Phase-119. Dashboard explicitly renders
   * the empty-state, not absent-state.
   */
  readonly noWebhookFallbacksTotal?: Readonly<Record<string, number>>;
  /** Epoch ms — when this snapshot was taken. */
  readonly sampledAt: number;
};

/** A single task edge for the dashboard task graph (OBS-03). */
export type TaskGraphEdge = {
  readonly task_id: string;
  readonly caller_agent: string;
  readonly target_agent: string;
  readonly status: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly chain_token_cost: number;
};

/** Payload for the task-state-change SSE event and /api/tasks endpoint. */
export type TaskGraphData = {
  readonly tasks: readonly TaskGraphEdge[];
};
