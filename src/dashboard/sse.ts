/**
 * SSE (Server-Sent Events) connection manager.
 * Polls daemon IPC for agent status and broadcasts to connected clients.
 */

import type { ServerResponse } from "node:http";
import type { Logger } from "pino";
import { sendIpcRequest } from "../ipc/client.js";
import type {
  AgentStatusData,
  DashboardState,
  ScheduleData,
  HealthData,
  DeliveryQueueData,
  MemoryStatsData,
} from "./types.js";

type SseManagerConfig = {
  readonly socketPath: string;
  readonly pollIntervalMs: number;
  readonly log: Logger;
};

/** Memory stats are polled less frequently (every 15s). */
const MEMORY_POLL_INTERVAL_MS = 15_000;

/**
 * Manages SSE client connections and periodic polling of agent status.
 */
export class SseManager {
  private readonly clients = new Set<ServerResponse>();
  private readonly socketPath: string;
  private readonly pollIntervalMs: number;
  private readonly log: Logger;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private memoryIntervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Cached agent names from the last status poll (used for memory queries).
   *
   * clawdy-v2-stability (2026-04-19): we now track running-status alongside
   * the name so `pollMemoryStats` can skip non-running entries. Polling a
   * stopped subagent triggered `Memory store not found` errors at level 50
   * on every 15s memory tick — spam that masked real problems in journalctl.
   * Only entries whose daemon-reported status is "running" own an open
   * MemoryStore; querying anything else is guaranteed to fail.
   */
  private lastAgentNames: readonly string[] = [];
  private lastRunningAgentNames: readonly string[] = [];

  constructor(config: SseManagerConfig) {
    this.socketPath = config.socketPath;
    this.pollIntervalMs = config.pollIntervalMs;
    this.log = config.log;
  }

  /**
   * Add an SSE client connection. Sets appropriate headers and
   * removes the client on close.
   */
  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(":keepalive\n\n");

    this.clients.add(res);
    this.log.debug({ clientCount: this.clients.size }, "SSE client connected");

    res.on("close", () => {
      this.clients.delete(res);
      this.log.debug({ clientCount: this.clients.size }, "SSE client disconnected");
    });
  }

  /**
   * Broadcast an event to all connected SSE clients.
   *
   * Known event types currently dispatched by daemon-side callers:
   *   - `agent-status`        (10s poll)            — DashboardState
   *   - `schedules`           (10s poll)            — schedules array
   *   - `health`              (10s poll)            — HealthData
   *   - `delivery-queue`      (10s poll)            — DeliveryQueueData
   *   - `task-state-change`   (10s poll)            — list-tasks payload
   *   - `memory-stats`        (15s poll)            — MemoryStatsData
   *   - `error`               (poll failure)        — { message }
   *
   * Phase 116-03 F27 — event-driven additions (NOT polled; fired inline
   * from captureDiscordExchange in src/discord/capture.ts via the
   * `onConversationTurn` hook the bridge constructor accepts):
   *   - `conversation-turn`   (per turn write)      — { agent, turnId, role, ts }
   *
   * Payload is metadata-only — UI fetches full content on demand via
   * /api/conversations/search or /api/conversations/:agent/recent. Keeps
   * the per-event byte-count near-zero so 10-50 events/sec at peak stays
   * well under 1KB/s aggregate.
   */
  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  /**
   * Start periodic polling of daemon IPC for agent status.
   */
  start(): void {
    if (this.intervalId !== null) return;

    // Primary poll: agent status, schedules, health, delivery queue
    this.intervalId = setInterval(() => {
      void this.pollAndBroadcast();
    }, this.pollIntervalMs);

    // Slower poll: memory stats (every 15s)
    this.memoryIntervalId = setInterval(() => {
      void this.pollMemoryStats();
    }, MEMORY_POLL_INTERVAL_MS);

    this.log.info({ pollIntervalMs: this.pollIntervalMs }, "SSE polling started");
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.memoryIntervalId !== null) {
      clearInterval(this.memoryIntervalId);
      this.memoryIntervalId = null;
    }
    this.log.info("SSE polling stopped");
  }

  /**
   * Fetch current status from daemon and broadcast to all SSE clients.
   * Exported for direct use by the /api/status endpoint.
   */
  async fetchCurrentState(): Promise<DashboardState> {
    const [statusResult, zoneResult] = await Promise.all([
      sendIpcRequest(this.socketPath, "status", {}),
      sendIpcRequest(this.socketPath, "context-zone-status", {}).catch(() => ({
        agents: {},
      })),
    ]);

    const statusData = statusResult as {
      entries: ReadonlyArray<{
        name: string;
        status: string;
        startedAt: number | null;
        restartCount: number;
        lastError: string | null;
        // Phase 56 Plan 02 — optional passthrough from the registry.
        warm_path_ready?: boolean;
        warm_path_readiness_ms?: number | null;
      }>;
    };

    const zoneData = zoneResult as {
      agents: Record<string, { zone: string; fillPercentage: number }>;
    };

    const agents: AgentStatusData[] = statusData.entries.map((entry) => {
      const zoneInfo = zoneData.agents[entry.name];
      const uptime =
        entry.startedAt !== null ? Date.now() - entry.startedAt : null;

      return {
        name: entry.name,
        status: entry.status,
        uptime,
        startedAt: entry.startedAt,
        restartCount: entry.restartCount,
        lastError: entry.lastError,
        zone: zoneInfo?.zone ?? null,
        fillPercentage: zoneInfo?.fillPercentage ?? null,
        // Phase 56 Plan 02 — warm-path fields flow verbatim from the daemon.
        // Server-emit pattern: no client-side threshold logic anywhere.
        warm_path_ready: entry.warm_path_ready,
        warm_path_readiness_ms: entry.warm_path_readiness_ms,
      };
    });

    // Cache agent names for memory poll. Memory/episode IPC is only valid
    // against "running" agents — SessionManager opens the MemoryStore on
    // startAgent and closes it on stopAgent. Keep the full name list for
    // other consumers but filter for the memory poll.
    this.lastAgentNames = agents.map((a) => a.name);
    this.lastRunningAgentNames = agents
      .filter((a) => a.status === "running")
      .map((a) => a.name);

    return {
      agents,
      updatedAt: Date.now(),
    };
  }

  /**
   * Fetch schedule data from daemon.
   */
  async fetchSchedules(): Promise<{ schedules: readonly ScheduleData[] }> {
    const result = await sendIpcRequest(this.socketPath, "schedules", {});
    return result as { schedules: readonly ScheduleData[] };
  }

  /**
   * Fetch health/heartbeat data from daemon.
   *
   * Phase 138 Plan 02 T-04 / T-07 — SSE piggyback decision.
   * `fetchHealth` calls the `heartbeat-status` IPC, whose payload now
   * carries the fleet-level `creditTelemetry` field (Plan 02 T-02). The
   * `pollAndBroadcast` loop already broadcasts this verbatim on the
   * `health` SSE event at the heartbeat cadence — so credit-telemetry
   * updates are delivered with ZERO new SSE event and ZERO new timer.
   * The dashboard `CreditTelemetryPanel` re-reads `creditTelemetry` off
   * each `health`/heartbeat-status refresh. A dedicated
   * `credit-telemetry-update` event would have duplicated the same
   * payload on the same cadence — explicitly NOT added (PLAN T-04
   * researcher_todo #2: piggyback the existing timer).
   */
  async fetchHealth(): Promise<HealthData> {
    const result = await sendIpcRequest(this.socketPath, "heartbeat-status", {});
    return result as HealthData;
  }

  /**
   * Fetch delivery queue status from daemon.
   */
  async fetchDeliveryQueue(): Promise<DeliveryQueueData> {
    const result = await sendIpcRequest(this.socketPath, "delivery-queue-status", {});
    return result as DeliveryQueueData;
  }

  /**
   * Poll daemon and broadcast agent status plus additional data to all connected clients.
   */
  private async pollAndBroadcast(): Promise<void> {
    // Agent status (primary)
    try {
      const state = await this.fetchCurrentState();
      this.broadcast("agent-status", state);
    } catch (err) {
      this.log.warn({ err }, "Failed to poll daemon for dashboard");
      this.broadcast("error", { message: "Daemon not reachable" });
    }

    // Schedules
    try {
      const schedules = await this.fetchSchedules();
      this.broadcast("schedules", schedules);
    } catch (err) {
      this.log.debug({ err }, "Failed to poll schedules");
    }

    // Health
    try {
      const health = await this.fetchHealth();
      this.broadcast("health", health);
    } catch (err) {
      this.log.debug({ err }, "Failed to poll health");
    }

    // Delivery queue
    try {
      const deliveryQueue = await this.fetchDeliveryQueue();
      this.broadcast("delivery-queue", deliveryQueue);
    } catch (err) {
      this.log.debug({ err }, "Failed to poll delivery queue");
    }

    // Task graph (Phase 63 OBS-03)
    try {
      const taskData = await sendIpcRequest(this.socketPath, "list-tasks", {});
      this.broadcast("task-state-change", taskData);
    } catch (err) {
      this.log.debug({ err }, "Failed to poll tasks");
    }
  }

  /**
   * Poll per-agent memory stats (slower interval).
   *
   * Only queries agents whose last-observed status is "running". A stopped /
   * crashed / failed agent has no open MemoryStore — asking the daemon for
   * `memory-list` against it guarantees a "Memory store not found" throw,
   * which ipc-server logs at level 50. Before the clawdy-v2-stability fix
   * (2026-04-19) this caused 26×/tick log spam on clawdy because stopped
   * subagent gravestones were still in the registry. The reap path in
   * reconcileRegistry prunes gravestones eventually, but this filter is
   * the primary defense — it prevents the spam even for a new subagent
   * that just transitioned to stopped seconds ago.
   */
  private async pollMemoryStats(): Promise<void> {
    // No connected clients → nobody to broadcast to, so skip the work entirely.
    //
    // This poll is expensive and there is no cheap version of it: `memory-list`
    // runs `SELECT tier, COUNT(*) FROM memories GROUP BY tier` (no index on
    // `tier` → full table scan) plus `COUNT(*)` over the sqlite-vec
    // `vec_memories` shadow tables, per agent. Measured on the prod host
    // 2026-09-19: 175,422 pages / 718 MB of page-cache reads and 12,029 read
    // syscalls/sec every 15s, ~18% of a core sustained — with zero browsers
    // open. `start()` is called unconditionally by the dashboard server, so
    // without this guard the scan runs forever on an otherwise idle box.
    //
    // The cheap status poll in `pollAndBroadcast` deliberately keeps running:
    // it refreshes `lastRunningAgentNames`, which this poll depends on.
    if (this.clients.size === 0) return;

    const agentNames = [...this.lastRunningAgentNames];
    if (agentNames.length === 0) return;

    const agents: Record<
      string,
      { entryCount: number; episodeCount: number; tierDistribution: Record<string, number> }
    > = {};

    const results = await Promise.allSettled(
      agentNames.map(async (name) => {
        const [memResult, epResult] = await Promise.all([
          sendIpcRequest(this.socketPath, "memory-list", { agent: name, limit: 1 }),
          sendIpcRequest(this.socketPath, "episode-list", { agent: name, count: true }),
        ]);

        const memData = memResult as {
          entries: ReadonlyArray<{ tier?: string }>;
          totalCount?: number;
          tierCounts?: Record<string, number>;
        };
        const epData = epResult as { count: number };

        return {
          name,
          entryCount: memData.totalCount ?? memData.entries?.length ?? 0,
          episodeCount: epData.count ?? 0,
          tierDistribution: memData.tierCounts ?? {},
        };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { name, ...stats } = result.value;
        agents[name] = stats;
      }
    }

    const memoryStats: MemoryStatsData = { agents };
    this.broadcast("memory-stats", memoryStats);
  }
}
