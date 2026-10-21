/**
 * Phase 116 T08 — TanStack Query wrappers for the existing daemon REST API.
 *
 * Pattern: each hook queries the REST endpoint on first mount + window focus,
 * THEN useSse.ts pushes incremental updates into the same cache key. The
 * component code only sees `useQuery(...)` and doesn't have to know whether
 * the value came from REST or SSE.
 *
 * Cache keys are tuples matching the SSE event names (useSse.ts) so the
 * setQueryData([eventName], data) bridge lands in the right slot.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

// ---------------------------------------------------------------------------
// Shared types — minimal shape declarations to keep the hooks self-typed
// without importing daemon-side TS. Real types land in Plan 116-01 per
// component as they need richer payloads.
// ---------------------------------------------------------------------------

export type AgentStatusEntry = {
  readonly name: string
  readonly model: 'sonnet' | 'opus' | 'haiku' | string
  readonly status?: 'active' | 'idle' | 'starting' | 'errored' | 'stopped' | string
  readonly lastTurnAt?: string | null
  // Loose-typed bag for fields we don't yet need to narrow.
  readonly [key: string]: unknown
}

export type AgentStatusPayload = {
  readonly agents: readonly AgentStatusEntry[]
  readonly [key: string]: unknown
}

// ---------------------------------------------------------------------------
// REST fetchers — kept thin so SSE-driven setQueryData replaces the value
// transparently. Each fetcher returns the raw payload shape the daemon emits.
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin' })
  if (!r.ok) {
    throw new Error(`fetch ${url} failed with status ${r.status}`)
  }
  return (await r.json()) as T
}

// ---------------------------------------------------------------------------
// Hooks — one per SSE event channel + one for per-agent cache telemetry.
// Tier 1 components in Plan 116-01 will consume these directly.
// ---------------------------------------------------------------------------

/**
 * Fleet agent-status snapshot. Initial fetch via REST (`/api/status`); SSE
 * `agent-status` events push subsequent updates into the same cache key.
 *
 * The daemon's existing dashboard REST surface for fleet state is
 * `/api/status` (verified against src/dashboard/server.ts:429). The SSE
 * `agent-status` event broadcasts the same shape on every poll tick.
 */
export function useAgents(): UseQueryResult<AgentStatusPayload> {
  return useQuery({
    queryKey: ['agent-status'],
    queryFn: () => fetchJson<AgentStatusPayload>('/api/status'),
    staleTime: Infinity, // SSE pushes invalidations; REST is only the initial fetch.
  })
}

/**
 * Knowledge-graph payload for one agent (`/api/graph/:agent`). Mirrors the
 * daemon's MemoryGraphResult (src/manager/memory-graph-handler.ts).
 */
export interface GraphNode {
  readonly id: string
  readonly content: string
  readonly source: string
  readonly importance: number
  readonly accessCount: number
  readonly tags: readonly string[]
  readonly createdAt: string
  readonly tier: string
  // Derived client-side from the full link set (degree); not on the wire.
  linkCount?: number
}

export interface GraphLink {
  readonly source: string
  readonly target: string
  readonly text: string
}

export interface GraphPayload {
  readonly nodes: readonly GraphNode[]
  readonly links: readonly GraphLink[]
}

/**
 * Knowledge graph for a single agent. Pure REST (no SSE channel) — graph data
 * changes slowly, so a 60s stale window is plenty. Disabled until an agent is
 * selected so we never fetch `/api/graph/`.
 */
export function useGraph(agent: string | null): UseQueryResult<GraphPayload> {
  return useQuery({
    queryKey: ['graph', agent],
    queryFn: () => fetchJson<GraphPayload>(`/api/graph/${encodeURIComponent(agent ?? '')}`),
    enabled: !!agent,
    staleTime: 60_000,
  })
}

/**
 * Per-agent latency report (`/api/agents/:name/latency`).
 *
 * Carries `first_token_headline.{p50,p95,p99,count,slo_status,slo_threshold_ms,slo_metric}` —
 * the OBSERVED first-token percentiles needed for F01 (SLO breach banner) and
 * the F03 tile's SLO color. The threshold lives on `useAgentCache(name).slos`
 * (Plan 116-00 T02 surface); the observed values live HERE.
 *
 * Polled every 30s — operator-acceptable refresh; the daemon's SSE bridge
 * doesn't broadcast `latency` events today, so polling is the only signal.
 */
export function useAgentLatency(
  agentName: string | null,
  since: string = '24h',
): UseQueryResult<unknown> {
  return useQuery({
    queryKey: ['agent-latency', agentName, since],
    queryFn: () =>
      fetchJson(
        `/api/agents/${encodeURIComponent(agentName ?? '')}/latency?since=${encodeURIComponent(since)}`,
      ),
    enabled: agentName !== null && agentName !== '',
    refetchInterval: 30_000,
    staleTime: 30_000,
  })
}

/**
 * Per-agent 24h activity buckets — drives the F03 tile sparkline.
 *
 * Phase 116-postdeploy 2026-05-12. Replaces the Skeleton placeholder that
 * has rendered on each AgentTile since Phase 116-01 (the original comment
 * said "lands with 116-04 drawer" — the drawer shipped without it).
 *
 * REST: `/api/agents/:name/activity?windowHours=N`. Daemon clamps
 * windowHours to [1, 168]. Empty buckets array → tile renders the
 * "no turns 24h" empty state instead of the chart.
 *
 * Refetch every 60s — a sparkline doesn't need faster cadence than the
 * underlying turn rate, and the SSE bridge doesn't broadcast activity
 * events today.
 */
export type ActivityBucket = {
  readonly bucket: string // "2026-05-12T13" hour mark, ISO-prefix sortable
  readonly turn_count: number
}

export type ActivityResponse = {
  readonly agent: string
  readonly windowHours: number
  readonly since: string
  readonly buckets: ReadonlyArray<ActivityBucket>
}

export function useAgentActivity(
  agentName: string | null,
  windowHours: number = 24,
): UseQueryResult<ActivityResponse> {
  return useQuery({
    queryKey: ['agent-activity', agentName, windowHours],
    queryFn: () =>
      fetchJson<ActivityResponse>(
        `/api/agents/${encodeURIComponent(agentName ?? '')}/activity?windowHours=${windowHours}`,
      ),
    enabled: agentName !== null && agentName !== '',
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

/**
 * Phase 124 Plan 04 T-03 — fleet-wide heartbeat-status snapshot, including
 * per-agent `session_tokens` and `last_compaction_at`. Polled at the same
 * 30s cadence as the latency surface (operator-acceptable for the slow-
 * moving telemetry the tile sparkline visualises). Component-side ring
 * buffer in `AgentTile` derives the sparkline data from successive polls.
 */
export type HeartbeatAgentBlock = {
  readonly zone?: string
  readonly fillPercentage?: number
  readonly session_tokens?: number | null
  readonly last_compaction_at?: string | null
  readonly checks?: Readonly<Record<string, unknown>>
  readonly overall?: string
}

// ---------------------------------------------------------------------------
// Phase 138 Plan 02 — fleet credit-telemetry types. Client-local mirrors
// of `CreditTelemetryEntrySchema` / `CreditTelemetryPayloadSchema` from
// `src/ipc/protocol.ts`. The dashboard SPA is a separate tsconfig + vite
// build and cannot import daemon-side modules, so the shape is duplicated
// here as plain TS interfaces (same pattern as HeartbeatAgentBlock).
// ---------------------------------------------------------------------------

export type CreditTelemetryModel = {
  readonly model: string
  readonly tokens_in: number
  readonly tokens_out: number
  readonly cost_usd: number
}

export type CreditTelemetryEntry = {
  readonly provider: 'anthropic' | 'openai'
  readonly cost_usd: number
  readonly cap_usd: number
  /** cost/cap × 100 — can exceed 100 (overage); UI clamps for display. */
  readonly pct: number
  readonly tokens_in: number
  readonly tokens_out: number
  readonly turn_count: number
  readonly models: readonly CreditTelemetryModel[]
  /** Daily cost, last 24 UTC days (oldest first, today at index 23). */
  readonly sparkline: readonly number[]
  readonly agents: readonly string[]
}

export type CreditTelemetryPayload = {
  /** UTC `YYYY-MM-DD`. */
  readonly date: string
  readonly providers: readonly CreditTelemetryEntry[]
}

export type HeartbeatStatusPayload = {
  readonly agents: Readonly<Record<string, HeartbeatAgentBlock>>
  /**
   * Phase 138 Plan 02 — fleet-aggregate per-provider credit telemetry.
   * Optional + additive: pre-138 daemons omit it. Pushed on the `health`
   * SSE event (which broadcasts the full heartbeat-status payload) so the
   * panel updates at the existing heartbeat cadence — no new SSE event.
   */
  readonly creditTelemetry?: CreditTelemetryPayload
}

export function useHeartbeatStatus(): UseQueryResult<HeartbeatStatusPayload> {
  return useQuery({
    queryKey: ['heartbeat-status'],
    queryFn: () => fetchJson<HeartbeatStatusPayload>('/api/heartbeat-status'),
    refetchInterval: 30_000,
    staleTime: 15_000,
  })
}

/**
 * Phase 116-postdeploy 2026-05-12 — main-dashboard tile sort.
 *
 * Returns per-agent turn counts (24h + 7d) and last-turn timestamp,
 * filtered server-side to non-ephemeral agents (no -sub- / -thread-).
 *
 * Separate query from `useAgentActivity` (which the per-tile sparkline
 * already runs) so the AgentTileGrid sort doesn't thrash the per-tile
 * Recharts mounts on every refetch — different cache keys, different
 * cadence. Polled every 60s, stale-time 30s, matches the sparkline.
 */
export type FleetActivityAgent = {
  readonly agent: string
  readonly turns_24h: number
  readonly turns_7d: number
  readonly last_turn_at: string | null
}

export type FleetActivitySummary = {
  readonly since_24h: string
  readonly since_7d: string
  readonly agents: ReadonlyArray<FleetActivityAgent>
}

export function useFleetActivitySummary(): UseQueryResult<FleetActivitySummary> {
  return useQuery({
    queryKey: ['fleet-activity-summary'],
    queryFn: () =>
      fetchJson<FleetActivitySummary>('/api/fleet-activity-summary'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

/**
 * Per-agent prompt cache + per-model SLO bundle (Plan 116-00 T02 surface).
 *
 * Hits `/api/agents/:name/cache?since=24h`. The response carries the augmented
 * `slos: { first_token_p50_ms, source, model, model_defaults }` field added
 * in T02 plus the existing prompt_cache / tool_cache fields.
 */
export function useAgentCache(
  agentName: string | null,
  since: string = '24h',
): UseQueryResult<unknown> {
  return useQuery({
    queryKey: ['agent-cache', agentName, since],
    queryFn: () =>
      fetchJson(
        `/api/agents/${encodeURIComponent(agentName ?? '')}/cache?since=${encodeURIComponent(since)}`,
      ),
    enabled: agentName !== null && agentName !== '',
    staleTime: 30_000, // 30s — cache panel updates frequently but not push-driven
  })
}

/** Schedules — populated by SSE `schedules` event. */
export function useSchedules(): UseQueryResult<unknown> {
  return useQuery({
    queryKey: ['schedules'],
    queryFn: () => fetchJson('/api/schedules'),
    staleTime: Infinity,
  })
}

/** Fleet health rollup — SSE `health` event. */
export function useHealth(): UseQueryResult<unknown> {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => fetchJson('/api/health'),
    staleTime: Infinity,
  })
}

/** Cross-agent delivery queue — SSE `delivery-queue` event. */
export function useDeliveryQueue(): UseQueryResult<unknown> {
  return useQuery({
    queryKey: ['delivery-queue'],
    queryFn: () => fetchJson('/api/delivery-queue'),
    staleTime: Infinity,
  })
}

/**
 * Per-agent memory tier counts — SSE `memory-stats` event ONLY (no REST
 * fallback; daemon doesn't expose a /api/memory-stats endpoint). Component
 * will see `data: undefined` until the first SSE tick lands (typically <3s).
 */
export function useMemoryStats(): UseQueryResult<unknown> {
  return useQuery({
    queryKey: ['memory-stats'],
    queryFn: () => Promise.resolve(undefined),
    staleTime: Infinity,
    enabled: false, // SSE-only — initial REST fetch disabled
  })
}

/** Task store snapshot — SSE `task-state-change` event + /api/tasks REST. */
export function useTasks(): UseQueryResult<unknown> {
  return useQuery({
    queryKey: ['task-state-change'],
    queryFn: () => fetchJson('/api/tasks'),
    staleTime: Infinity,
  })
}

/**
 * Fleet-level statistics (cgroup memory, claude proc count, MCP rollup).
 * Hits the existing `/api/fleet-stats` endpoint. Not SSE-pushed; refetches
 * every 5s as polling fallback for the few non-push metrics.
 */
export function useFleetStats(): UseQueryResult<unknown> {
  return useQuery({
    queryKey: ['fleet-stats'],
    queryFn: () => fetchJson('/api/fleet-stats'),
    refetchInterval: 5_000,
  })
}

// ---------------------------------------------------------------------------
// Phase 116-02 — new query/mutation surfaces for F09 migrations + F10 MCP
// health. Polling-only (no SSE event today); 10s for migrations because
// re-embed progress moves over minutes, 30s for MCP because server health
// flips on the 60s heartbeat cycle.
// ---------------------------------------------------------------------------

export type MigrationRow = {
  readonly agent: string
  readonly phase: string // idle | dual-write | re-embedding | re-embed-complete | cutover | v1-dropped | rolled-back | no-store | error
  readonly progressProcessed: number
  readonly progressTotal: number
  readonly lastCursor: string | null
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly paused: boolean
  readonly error?: string
}

export type MigrationsPayload = {
  readonly results: readonly MigrationRow[]
}

/** F09 — fleet migration phase snapshot. Polls every 10s. */
export function useMigrations(): UseQueryResult<MigrationsPayload> {
  return useQuery({
    queryKey: ['migrations'],
    queryFn: () => fetchJson<MigrationsPayload>('/api/migrations'),
    refetchInterval: 10_000,
    staleTime: 10_000,
  })
}

/**
 * 116-postdeploy 2026-05-12 — operator-fired phase advance.
 *
 * Routes to `POST /api/migrations/:agent/transition` with `{ toPhase }` body
 * — the dashboard server proxies to the daemon's `embedding-migration-
 * transition` IPC, which validates legality against LEGAL_TRANSITIONS in
 * src/memory/migrations/embedding-v2.ts. Illegal transitions surface as a
 * thrown Error with the daemon's reason verbatim.
 */
export async function transitionMigration(
  agent: string,
  toPhase: string,
): Promise<{ ok: boolean; phase?: string; error?: string }> {
  const res = await fetch(
    `/api/migrations/${encodeURIComponent(agent)}/transition`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toPhase }),
    },
  )
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string }
      detail = body?.error ?? ''
    } catch {
      /* swallow — non-JSON */
    }
    throw new Error(
      `POST /api/migrations/${agent}/transition → ${res.status}${
        detail ? ` — ${detail}` : ''
      }`,
    )
  }
  return (await res.json()) as { ok: boolean; phase?: string; error?: string }
}

export type McpServerStatus =
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'unknown'
  | string

export type McpServerEntry = {
  readonly name: string
  readonly status: McpServerStatus
  readonly lastSuccessAt: string | null
  readonly lastFailureAt: string | null
  readonly failureCount: number
  readonly optional: boolean
  readonly lastError: string | null
  readonly capabilityProbe?: {
    readonly lastRunAt: string
    readonly status: string
    readonly toolCount?: number
    readonly error?: string
  }
  readonly alternatives?: readonly string[]
}

export type McpAgentSnapshot = {
  readonly agent: string
  readonly servers: readonly McpServerEntry[]
}

/**
 * F10 — per-agent live MCP runtime state (status, lastSuccessAt, capability
 * probe). Polls every 30s; MCP health doesn't broadcast over SSE today.
 */
export function useMcpServers(
  agentName: string | null,
): UseQueryResult<McpAgentSnapshot> {
  return useQuery({
    queryKey: ['mcp-servers', agentName],
    queryFn: () =>
      fetchJson<McpAgentSnapshot>(
        `/api/mcp-servers/${encodeURIComponent(agentName ?? '')}`,
      ),
    enabled: agentName !== null && agentName !== '',
    refetchInterval: 30_000,
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// Phase 116-03 — Tier 1.5 operator workflow query/mutation hooks.
// F26 config editor, F27 conversations view, F28 Kanban task board.
// ---------------------------------------------------------------------------

export type AgentConfigResponse = {
  readonly agent: string
  readonly resolved: Record<string, unknown>
  readonly raw: Record<string, unknown> | null
  readonly hotReloadableFields: readonly string[]
  readonly restartRequiredFields: readonly string[]
}

/** F26 — fetch one agent's resolved + raw config for the editor. */
export function useAgentConfig(
  agentName: string | null,
): UseQueryResult<AgentConfigResponse> {
  return useQuery({
    queryKey: ['agent-config', agentName],
    queryFn: () =>
      fetchJson<AgentConfigResponse>(
        `/api/config/agents/${encodeURIComponent(agentName ?? '')}`,
      ),
    enabled: agentName !== null && agentName !== '',
    staleTime: 5_000,
  })
}

export type UpdateAgentConfigResponse = {
  readonly written: boolean
  readonly sha256?: string
  readonly reason?: string
  readonly hotReloaded: readonly string[]
  readonly agentsNeedingRestart: readonly string[]
  readonly restartRequiredFields?: readonly string[]
}

/** F26 — PUT a partial update to clawcode.yaml; returns hot-reload status. */
export async function updateAgentConfig(
  agentName: string,
  partial: Record<string, unknown>,
): Promise<UpdateAgentConfigResponse> {
  const res = await fetch(
    `/api/config/agents/${encodeURIComponent(agentName)}`,
    {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partial }),
    },
  )
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `update-agent-config ${res.status}`)
  }
  return (await res.json()) as UpdateAgentConfigResponse
}

/** F26 — force chokidar to re-read clawcode.yaml on demand (no debounce wait). */
export async function triggerHotReload(): Promise<{ ok: boolean; touchedAt?: number }> {
  const res = await fetch('/api/config/hot-reload', {
    method: 'POST',
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `hot-reload-now ${res.status}`)
  }
  return (await res.json()) as { ok: boolean; touchedAt?: number }
}

// ---------------------------------------------------------------------------
// F27 — conversations view
// ---------------------------------------------------------------------------

export type ConversationSearchHit = {
  readonly turnId: string
  readonly sessionId: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: string
  readonly bm25Score: number
  readonly createdAt: string
  readonly channelId: string | null
  readonly isTrustedChannel: boolean
  readonly agent: string
}

export type ConversationSearchResult = {
  readonly hits: readonly ConversationSearchHit[]
  readonly totalMatches: number
  readonly agentsQueried: readonly string[]
}

/** F27 — FTS5 search across one or all agents. */
export function useConversationSearch(
  query: string,
  agent: string | null,
  enabled: boolean,
): UseQueryResult<ConversationSearchResult> {
  return useQuery({
    queryKey: ['conversation-search', query, agent],
    queryFn: () => {
      const params = new URLSearchParams({ q: query })
      if (agent) params.set('agent', agent)
      return fetchJson<ConversationSearchResult>(
        `/api/conversations/search?${params.toString()}`,
      )
    },
    enabled: enabled && query.length > 0,
    staleTime: 60_000,
  })
}

export type ConversationSessionRow = {
  readonly id: string
  readonly agentName: string
  readonly startedAt: string
  readonly endedAt: string | null
  readonly turnCount: number
  readonly totalTokens: number | null
  readonly status: string
}

export type RecentConversationsResponse = {
  readonly agent: string
  readonly sessions: readonly ConversationSessionRow[]
}

/** F27 — recent session metadata for one agent. */
export function useRecentConversations(
  agentName: string | null,
): UseQueryResult<RecentConversationsResponse> {
  return useQuery({
    queryKey: ['recent-conversations', agentName],
    queryFn: () =>
      fetchJson<RecentConversationsResponse>(
        `/api/conversations/${encodeURIComponent(agentName ?? '')}/recent?limit=50`,
      ),
    enabled: agentName !== null && agentName !== '',
    refetchInterval: 30_000,
    staleTime: 15_000,
  })
}

// ---------------------------------------------------------------------------
// F28 — Kanban task board
// ---------------------------------------------------------------------------

export type KanbanRow = {
  readonly task_id: string
  readonly task_type: string
  readonly caller_agent: string
  readonly target_agent: string
  readonly status: string
  readonly started_at: number
  readonly ended_at: number | null
  readonly heartbeat_at: number
  readonly chain_token_cost: number
  readonly error: string | null
}

export type KanbanColumns = {
  readonly Backlog: readonly KanbanRow[]
  readonly Scheduled: readonly KanbanRow[]
  readonly Running: readonly KanbanRow[]
  readonly Waiting: readonly KanbanRow[]
  readonly Failed: readonly KanbanRow[]
  readonly Done: readonly KanbanRow[]
}

export type KanbanResponse = {
  readonly columns: KanbanColumns
  readonly total: number
}

/** F28 — fleet task kanban grouped by 6 columns. Polls 10s + SSE invalidates. */
export function useKanbanTasks(): UseQueryResult<KanbanResponse> {
  return useQuery({
    queryKey: ['tasks-kanban'],
    queryFn: () => fetchJson<KanbanResponse>('/api/tasks/kanban'),
    refetchInterval: 10_000,
    staleTime: 5_000,
  })
}

// ---------------------------------------------------------------------------
// Phase 116-postdeploy 2026-05-12 — GSD planning artefacts on the Tasks
// Kanban. Sourced from `.planning/{todos,quick,ROADMAP.md}` server-side
// (see src/manager/planning-tasks.ts) so the frontend only needs to read
// the stable virtual-task shape. Production installs running outside
// the repo get an empty response — render placeholders, don't error.
// ---------------------------------------------------------------------------

export type PlanningTaskSource = 'todo' | 'phase' | 'quick'
export type PlanningTaskStatus = 'pending' | 'running' | 'complete' | 'failed'

export type PlanningTask = {
  readonly id: string
  readonly source: PlanningTaskSource
  readonly title: string
  readonly description?: string
  readonly status: PlanningTaskStatus
  readonly tags: readonly string[]
  readonly createdAt?: string
  readonly filePath?: string
  // 116-postdeploy 2026-05-12 — short clarifier rendered as a subtitle so
  // operators don't conflate planning "in-progress" with live agent execution.
  readonly subtitle?: string
}

export type PlanningTasksResponse = {
  readonly tasks: readonly PlanningTask[]
  readonly sourceCount: {
    readonly todo: number
    readonly phase: number
    readonly quick: number
  }
}

export function usePlanningTasks(): UseQueryResult<PlanningTasksResponse> {
  return useQuery({
    queryKey: ['planning-tasks'],
    queryFn: () => fetchJson<PlanningTasksResponse>('/api/planning/tasks'),
    // Filesystem scan — refresh on visibility change + every 60s to keep
    // edits in .planning/ reflected without thrashing readdir.
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

/** F28 — operator-fired task transition. Optimistic UI flips before this returns. */
export async function transitionTask(
  taskId: string,
  status: string,
  patch: Record<string, unknown> = {},
): Promise<{ task_id: string; row: KanbanRow }> {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/transition`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, patch }),
    },
  )
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `transition-task ${res.status}`)
  }
  return (await res.json()) as { task_id: string; row: KanbanRow }
}

/** F28 — operator-created task. Lands as status='pending' in Backlog. */
export async function createTask(input: {
  title: string
  description?: string
  target_agent: string
}): Promise<{ task_id: string; row: KanbanRow }> {
  const res = await fetch('/api/tasks', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `create-task ${res.status}`)
  }
  return (await res.json()) as { task_id: string; row: KanbanRow }
}

// ---------------------------------------------------------------------------
// Phase 116-04 — Tier 2 deep-dive hooks (F11-F15).
// Drawer transcript, trace waterfall, IPC inboxes, memory snapshot,
// dream-pass queue. All read-mostly except veto-dream-run which is a
// fire-and-forget operator action.
// ---------------------------------------------------------------------------

export type RecentTurnRow = {
  readonly turnId: string
  readonly sessionId: string
  readonly turnIndex: number
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: string
  readonly tokenCount: number | null
  readonly channelId: string | null
  readonly discordUserId: string | null
  readonly discordMessageId: string | null
  readonly isTrustedChannel: boolean
  readonly origin: string | null
  readonly createdAt: string
}

export type RecentTurnsResponse = {
  readonly agent: string
  readonly turns: readonly RecentTurnRow[]
}

/** F11 — last N conversation turns for the drawer's center column. */
export function useRecentTurns(
  agentName: string | null,
  limit: number = 50,
): UseQueryResult<RecentTurnsResponse> {
  return useQuery({
    queryKey: ['recent-turns', agentName, limit],
    queryFn: () =>
      fetchJson<RecentTurnsResponse>(
        `/api/agents/${encodeURIComponent(agentName ?? '')}/recent-turns?limit=${limit}`,
      ),
    enabled: agentName !== null && agentName !== '',
    // Manual refetch — SSE conversation-turn events push individual turns
    // via subscribeConversationTurns. No polling; refetch only on agent
    // change.
    staleTime: Infinity,
  })
}

/**
 * 116-postdeploy Bug 2 — F27 transcript pane.
 *
 * Fetches the full ordered turn list for one session (chronological
 * ASC). Reuses the F11 `list-recent-turns` IPC handler with an optional
 * `sessionId` param (added in the same fix) — no new daemon surface.
 *
 * Live updates: ConversationsView wires a `subscribeConversationTurns`
 * listener that calls `queryClient.invalidateQueries(['session-turns',
 * agent, sessionId])` whenever a turn event lands for the open agent.
 * The SSE payload does not carry sessionId today, so we refetch on every
 * matching-agent event rather than filter; the per-session refetch is
 * cheap (single agent × LIMIT 500 against an FTS-indexed table).
 */
export const SESSION_TURNS_QUERY_KEY = 'session-turns' as const

export function useSessionTurns(
  agentName: string | null,
  sessionId: string | null,
  limit: number = 500,
): UseQueryResult<RecentTurnsResponse> {
  return useQuery({
    queryKey: [SESSION_TURNS_QUERY_KEY, agentName, sessionId, limit],
    queryFn: () => {
      const qs = new URLSearchParams({
        limit: String(limit),
        sessionId: sessionId ?? '',
      })
      return fetchJson<RecentTurnsResponse>(
        `/api/agents/${encodeURIComponent(
          agentName ?? '',
        )}/recent-turns?${qs.toString()}`,
      )
    },
    enabled:
      agentName !== null &&
      agentName !== '' &&
      sessionId !== null &&
      sessionId !== '',
    staleTime: Infinity,
  })
}

export type TraceSpan = {
  readonly name: string
  readonly startedAt: string
  readonly durationMs: number
  readonly metadata: string | null
}

export type TraceTurnRow = {
  readonly id: string
  readonly agent: string
  readonly startedAt: string
  readonly endedAt: string
  readonly totalMs: number
  readonly discordChannelId: string | null
  readonly status: string
  readonly cacheEvictionExpected: boolean
}

export type TurnTraceResponse = {
  readonly turn: TraceTurnRow
  readonly spans: readonly TraceSpan[]
}

/** F12 — trace_spans for one turn_id. */
export function useTurnTrace(
  agentName: string | null,
  turnId: string | null,
): UseQueryResult<TurnTraceResponse> {
  return useQuery({
    queryKey: ['turn-trace', agentName, turnId],
    queryFn: () =>
      fetchJson<TurnTraceResponse>(
        `/api/agents/${encodeURIComponent(agentName ?? '')}/traces/${encodeURIComponent(turnId ?? '')}`,
      ),
    enabled:
      agentName !== null && agentName !== '' && turnId !== null && turnId !== '',
    // Traces are immutable per turn; cache forever once fetched.
    staleTime: Infinity,
  })
}

export type IpcInboxRow = {
  readonly agent: string
  readonly pending: number
  readonly lastModified: string | null
  readonly inboxDir: string
  readonly error?: string
}

export type DeliveryStats = {
  readonly pending: number
  readonly inFlight: number
  readonly failed: number
  readonly delivered: number
  readonly totalEnqueued: number
}

export type DeliveryFailureEntry = {
  readonly id: string | number
  readonly agentName?: string
  readonly channelId?: string
  readonly content?: string
  readonly status?: string
  readonly errorMessage?: string | null
  readonly createdAt?: number
  readonly lastAttemptAt?: number | null
  readonly attempts?: number
  readonly [key: string]: unknown
}

export type IpcInboxesResponse = {
  readonly inboxes: readonly IpcInboxRow[]
  readonly deliveryStats: DeliveryStats | null
  readonly recentFailures: readonly DeliveryFailureEntry[]
}

/** F13 — cross-agent IPC inbox state + fleet delivery snapshot. */
export function useIpcInboxes(): UseQueryResult<IpcInboxesResponse> {
  return useQuery({
    queryKey: ['ipc-inboxes'],
    queryFn: () => fetchJson<IpcInboxesResponse>('/api/ipc/inboxes'),
    refetchInterval: 10_000,
    staleTime: 5_000,
  })
}

export type MemoryFilePreview = {
  readonly name: string
  readonly path: string
  readonly preview: string | null
  readonly totalChars: number
  readonly lastModified: string | null
  readonly error?: string
}

export type MemoryTierCounts = {
  readonly hot: number
  readonly warm: number
  readonly cold: number
  readonly total: number
}

export type MemoryMigrationDelta = {
  readonly vecMemoriesRows: number | null
  readonly vecMemoriesV2Rows: number | null
  readonly phase: string | null
}

export type ConsolidationEntry = {
  readonly file: string
  readonly lastModified: string
  readonly sizeBytes: number
}

export type MemorySnapshotResponse = {
  readonly agent: string
  readonly memoryPath: string | null
  readonly files: readonly MemoryFilePreview[]
  readonly tierCounts: MemoryTierCounts
  readonly migrationDelta: MemoryMigrationDelta
  readonly consolidations: readonly ConsolidationEntry[]
  readonly editAffordance: { readonly available: boolean; readonly hint: string }
}

/** F14 — memory subsystem snapshot (READ-ONLY in v1 per 116-DEFERRED). */
export function useMemorySnapshot(
  agentName: string | null,
): UseQueryResult<MemorySnapshotResponse> {
  return useQuery({
    queryKey: ['memory-snapshot', agentName],
    queryFn: () =>
      fetchJson<MemorySnapshotResponse>(
        `/api/agents/${encodeURIComponent(agentName ?? '')}/memory-snapshot`,
      ),
    enabled: agentName !== null && agentName !== '',
    refetchInterval: 30_000,
    staleTime: 15_000,
  })
}

export type DreamEvent = {
  readonly file: string
  readonly lastModified: string
  readonly headerCount: number
}

export type DreamVetoWindow = {
  readonly runId: string
  readonly agentName: string
  readonly candidateCount: number
  readonly deadline: number
  readonly isPriorityPass: boolean
  readonly status: string
  readonly scheduledAt: string
}

export type DreamQueueResponse = {
  readonly agent: string
  readonly events: readonly DreamEvent[]
  readonly pendingVetoWindows: readonly DreamVetoWindow[]
  readonly dreamConfig: {
    readonly enabled: boolean
    readonly idleMinutes: number
    readonly model: string
    readonly retentionDays: number | null
  } | null
}

/** F15 — dream-pass events + pending D-10 veto windows. */
export function useDreamQueue(
  agentName: string | null,
): UseQueryResult<DreamQueueResponse> {
  return useQuery({
    queryKey: ['dream-queue', agentName],
    queryFn: () =>
      fetchJson<DreamQueueResponse>(
        `/api/agents/${encodeURIComponent(agentName ?? '')}/dream-queue`,
      ),
    enabled: agentName !== null && agentName !== '',
    refetchInterval: 15_000,
    staleTime: 10_000,
  })
}

// ---------------------------------------------------------------------------
// Phase 116-05 — Fleet-scale + cost (F16/F17).
// ---------------------------------------------------------------------------

/**
 * F17 — one cost row aggregated across the configured `period`.
 * Shape mirrors the daemon's existing `costs` IPC handler (period →
 * Date(start-of-{today,week,month}) inclusive through now).
 */
export type CostRow = {
  readonly agent: string
  readonly model: string
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cost_usd: number
}

export type CostsResponse = {
  readonly period: 'today' | 'week' | 'month' | string
  readonly costs: readonly CostRow[]
}

/** F17 — costs for a window. Periods: today / week / month. */
export function useCosts(
  period: 'today' | 'week' | 'month' = 'today',
): UseQueryResult<CostsResponse> {
  return useQuery({
    queryKey: ['costs', period],
    queryFn: () =>
      fetchJson<CostsResponse>(
        `/api/costs?period=${encodeURIComponent(period)}`,
      ),
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
}

/** F17 — per-day cost trend rows (daemon costs-daily IPC). */
export type CostByDay = {
  readonly date: string
  readonly agent: string
  readonly model: string
  readonly tokens_in: number
  readonly tokens_out: number
  readonly cost_usd: number
}

export type CostsDailyResponse = {
  readonly days: number
  readonly since: string
  readonly until: string
  readonly rows: readonly CostByDay[]
}

export function useCostsDaily(
  days: number = 30,
  agent: string | null = null,
): UseQueryResult<CostsDailyResponse> {
  const search = new URLSearchParams({ days: String(days) })
  if (agent) search.set('agent', agent)
  return useQuery({
    queryKey: ['costs-daily', days, agent ?? ''],
    queryFn: () =>
      fetchJson<CostsDailyResponse>(`/api/costs/daily?${search.toString()}`),
    refetchInterval: 60_000,
    staleTime: 45_000,
  })
}

/** F17 — EscalationBudget gauges. TOKEN units. */
export type BudgetRow = {
  readonly agent: string
  readonly model: string
  readonly period: 'daily' | 'weekly'
  readonly tokens_used: number
  readonly tokens_limit: number
  readonly pct: number
  readonly status: 'ok' | 'warning' | 'exceeded'
}

export type BudgetsResponse = {
  readonly rows: readonly BudgetRow[]
}

export function useBudgets(): UseQueryResult<BudgetsResponse> {
  return useQuery({
    queryKey: ['budgets'],
    queryFn: () => fetchJson<BudgetsResponse>('/api/budgets'),
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
}

// ---------------------------------------------------------------------------
// Phase 116-postdeploy — Usage page (subscription utilisation).
//
// Shape mirrors Phase 103 RateLimitSnapshot exactly. `rateLimitType` is
// `string` (not the SDK union) per Pitfall 10 — future SDK releases may
// emit new types and the dashboard must still render them under a
// fallback label rather than dropping them.
// ---------------------------------------------------------------------------

export type RateLimitSnapshot = {
  readonly rateLimitType: string
  readonly status: 'allowed' | 'allowed_warning' | 'rejected'
  readonly utilization: number | undefined
  readonly resetsAt: number | undefined
  readonly surpassedThreshold: number | undefined
  readonly overageStatus:
    | 'allowed'
    | 'allowed_warning'
    | 'rejected'
    | undefined
  readonly overageResetsAt: number | undefined
  readonly overageDisabledReason: string | undefined
  readonly isUsingOverage: boolean | undefined
  readonly recordedAt: number
}

export type UsageAgentEntry = {
  readonly agent: string
  readonly snapshots: readonly RateLimitSnapshot[]
}

export type UsageFleetResponse = {
  readonly agents: readonly UsageAgentEntry[]
}

/** Phase 116-postdeploy — fleet-wide subscription utilisation snapshots. */
export function useFleetUsage(): UseQueryResult<UsageFleetResponse> {
  return useQuery({
    queryKey: ['usage', 'fleet'],
    queryFn: () => fetchJson<UsageFleetResponse>('/api/usage'),
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
}

export type UsageAgentResponse = {
  readonly agent: string
  readonly snapshots: readonly RateLimitSnapshot[]
}

/** Phase 116-postdeploy — single-agent subscription utilisation snapshots. */
export function useAgentUsage(
  agent: string | null,
): UseQueryResult<UsageAgentResponse> {
  return useQuery({
    queryKey: ['usage', 'agent', agent ?? ''],
    queryFn: () =>
      fetchJson<UsageAgentResponse>(
        `/api/usage/${encodeURIComponent(agent ?? '')}`,
      ),
    refetchInterval: 30_000,
    staleTime: 20_000,
    enabled: agent !== null && agent.length > 0,
  })
}

// ---------------------------------------------------------------------------
// Phase 116-postdeploy 2026-05-12 — OpenAI endpoint config page.
// Wraps the daemon's `openai-endpoint-info` + `openai-key-{list,create,revoke}`
// IPC methods exposed as REST under /api/openai/*.
// ---------------------------------------------------------------------------

export type OpenAiEndpointInfo =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly host: string | null
      readonly port: number | null
    }

export type OpenAiKeyRow = {
  readonly key_hash: string
  readonly agent_name: string
  readonly label: string | null
  readonly created_at: number
  readonly last_used_at: number | null
  readonly expires_at: number | null
  readonly disabled_at: number | null
  readonly scope: string
}

export type OpenAiKeyListResponse = { readonly rows: ReadonlyArray<OpenAiKeyRow> }

export type OpenAiKeyCreateResponse = {
  readonly key: string
  readonly keyHash: string
  readonly agent: string
  readonly label: string | null
  readonly expiresAt: number | null
  readonly createdAt: number
}

export function useOpenAiInfo(): UseQueryResult<OpenAiEndpointInfo> {
  return useQuery({
    queryKey: ['openai-info'],
    queryFn: () => fetchJson<OpenAiEndpointInfo>('/api/openai/info'),
    // Endpoint config rarely changes — staleTime keeps the SPA from
    // hammering it; the page also doesn't need real-time updates.
    staleTime: 60_000,
  })
}

export function useOpenAiKeys(
  enabled = true,
): UseQueryResult<OpenAiKeyListResponse> {
  return useQuery({
    queryKey: ['openai-keys'],
    queryFn: () => fetchJson<OpenAiKeyListResponse>('/api/openai/keys'),
    enabled,
    staleTime: 30_000,
  })
}

export async function createOpenAiKey(
  body:
    | { readonly agent: string; readonly label?: string }
    | { readonly all: true; readonly label?: string },
): Promise<OpenAiKeyCreateResponse> {
  const res = await fetch('/api/openai/keys', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `openai-key-create ${res.status}`)
  }
  return (await res.json()) as OpenAiKeyCreateResponse
}

export async function revokeOpenAiKey(
  identifier: string,
): Promise<{ readonly revoked: boolean }> {
  const res = await fetch(
    `/api/openai/keys/${encodeURIComponent(identifier)}`,
    { method: 'DELETE', credentials: 'same-origin' },
  )
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `openai-key-revoke ${res.status}`)
  }
  return (await res.json()) as { revoked: boolean }
}

/** F15 — operator-fired veto on a pending D-10 window. */
export async function vetoDreamRun(
  agentName: string,
  runId: string,
  reason: string,
): Promise<{ runId: string; vetoed: boolean; recordedAt: string }> {
  const res = await fetch(
    `/api/agents/${encodeURIComponent(agentName)}/dream-veto/${encodeURIComponent(runId)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
  )
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `dream-veto ${res.status}`)
  }
  return (await res.json()) as {
    runId: string
    vetoed: boolean
    recordedAt: string
  }
}

// ---------------------------------------------------------------------------
// Phase 116-postdeploy 2026-05-12 — Memory + dreams page (/dashboard/v2/memory).
// Wraps `run-dream-pass`, `list-dream-artifacts`, and
// `tier-maintenance-tick` IPC methods exposed under /api/agents/*/dream-*
// and /api/(agents/*)?/memory/consolidate.
// ---------------------------------------------------------------------------

export type DreamArtifact = {
  readonly file: string
  readonly path: string
  readonly date: string | null
  readonly sizeBytes: number
  readonly mtime: string | null
  readonly preview: string
}

export type DreamArtifactsResponse = {
  readonly artifacts: ReadonlyArray<DreamArtifact>
  readonly memoryPath: string | null
}

export function useDreamArtifacts(
  agentName: string | null,
  limit = 20,
): UseQueryResult<DreamArtifactsResponse> {
  return useQuery({
    queryKey: ['dream-artifacts', agentName, limit],
    queryFn: () =>
      fetchJson<DreamArtifactsResponse>(
        `/api/agents/${encodeURIComponent(agentName ?? '')}/dreams?limit=${limit}`,
      ),
    enabled: agentName !== null && agentName.length > 0,
    staleTime: 30_000,
  })
}

export type RunDreamPassRequest = {
  readonly modelOverride?: 'haiku' | 'sonnet' | 'opus'
  readonly force?: boolean
  readonly idleBypass?: boolean
}

export type RunDreamPassResponse = {
  readonly agent: string
  readonly startedAt: string
  readonly outcome: { readonly kind: string; readonly reason?: string }
  readonly applied: { readonly kind: string; readonly reason?: string }
}

export async function runDreamPass(
  agentName: string,
  req: RunDreamPassRequest = {},
): Promise<RunDreamPassResponse> {
  const res = await fetch(
    `/api/agents/${encodeURIComponent(agentName)}/dream-run`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    },
  )
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `run-dream-pass ${res.status}`)
  }
  return (await res.json()) as RunDreamPassResponse
}

export type TierMaintenanceResponse = {
  readonly results: Record<
    string,
    { promoted: number; demoted: number; archived: number }
  >
  readonly skipped: ReadonlyArray<string>
}

export async function runTierMaintenance(
  agentName: string | null,
): Promise<TierMaintenanceResponse> {
  const url = agentName
    ? `/api/agents/${encodeURIComponent(agentName)}/memory/consolidate`
    : '/api/memory/consolidate'
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `tier-maintenance ${res.status}`)
  }
  return (await res.json()) as TierMaintenanceResponse
}

// 116-postdeploy 2026-05-12 — orphan cleanup. Backed by the Phase 107
// `memory-cleanup-orphans` IPC + the new dashboard REST route. Returns
// per-agent counts so the UI can surface "removed N orphans across M
// agents". `agentName: null` triggers fleet-wide cleanup.
//
// Why this exists: orphan vec_memories rows (vec row exists, memory row
// gone) inflate the migration percentage denominator on the dashboard,
// so a fully-migrated agent appears stuck at 59% etc. Fix 1 wires the
// cron to clean automatically on re-embed-complete; Fix 2 (this) gives
// operators a manual trigger for the pre-existing residue.
export type CleanupOrphansResponse = {
  readonly results: ReadonlyArray<{
    readonly agent: string
    readonly removed: number
    readonly totalAfter: number
  }>
}

export async function runCleanupOrphans(
  agentName: string | null,
): Promise<CleanupOrphansResponse> {
  const url = agentName
    ? `/api/agents/${encodeURIComponent(agentName)}/memory/cleanup-orphans`
    : '/api/memory/cleanup-orphans'
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `cleanup-orphans ${res.status}`)
  }
  return (await res.json()) as CleanupOrphansResponse
}

// ---------------------------------------------------------------------------
// 116-postdeploy 2026-05-13 — Benchmarks page hooks.
//
// Per-agent tool latency rollup (Section 1), benchmark trigger (Section 2),
// cross-agent comparison (Section 3). Memory section reuses the rollup with
// a client-side filter — no separate hook needed.
// ---------------------------------------------------------------------------

export type ToolPercentileRow = {
  readonly tool: string
  readonly count: number
  readonly p50_ms: number | null
  readonly p95_ms: number | null
  readonly p99_ms: number | null
  readonly slo_status?: 'ok' | 'warn' | 'breach' | 'unknown'
  readonly slo_threshold_ms?: number | null
  readonly slo_metric?: string | null
}

export type ToolsReport = {
  readonly agent: string
  readonly since: string
  readonly tools: ReadonlyArray<ToolPercentileRow>
}

/**
 * Per-agent tool latency rollup. Hits `/api/agents/:name/tools`.
 */
export function useAgentTools(
  agentName: string | null,
  since: string = '24h',
): UseQueryResult<ToolsReport> {
  return useQuery({
    queryKey: ['agent-tools', agentName, since],
    queryFn: () =>
      fetchJson<ToolsReport>(
        `/api/agents/${encodeURIComponent(agentName ?? '')}/tools?since=${encodeURIComponent(since)}`,
      ),
    enabled: agentName !== null && agentName.length > 0,
    staleTime: 30_000,
  })
}

export type BenchmarkScenario =
  | 'discord-ack'
  | 'tool-heavy'
  | 'memory-recall'
  | 'extended-thinking'

export type BenchmarkRow = {
  readonly index: number
  readonly turnId: string | null
  readonly headline_ms: number | null
  readonly segments: Record<string, number>
  readonly error: string | null
}

export type BenchmarkResult = {
  readonly agent: string
  readonly scenario: BenchmarkScenario
  readonly iterations: number
  readonly headlineSpan: string
  readonly path: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly rows: ReadonlyArray<BenchmarkRow>
  readonly aggregate: {
    readonly runs: number
    readonly errored: number
    readonly p50_ms: number | null
    readonly p95_ms: number | null
    readonly mean_ms: number | null
    readonly min_ms: number | null
    readonly max_ms: number | null
  }
}

export async function runBenchmark(
  agentName: string,
  scenario: BenchmarkScenario,
  iterations: number,
): Promise<BenchmarkResult> {
  const res = await fetch(
    `/api/agents/${encodeURIComponent(agentName)}/benchmark`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario, iterations }),
    },
  )
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `benchmark ${res.status}`)
  }
  return (await res.json()) as BenchmarkResult
}

// dashboard-rework P2 — Phase 142 agent optimizer (operator-fired run).
export type AgentOptimizationResult = {
  readonly agent: string
  readonly status: 'completed' | 'skipped'
  readonly reason?: string
  readonly outcome?: string
  readonly baselineScore?: number
  readonly candidateScore?: number
  readonly stagedDraftCount?: number
  readonly removeCount?: number
  readonly summary?: string
  readonly startedAt: string
}

export async function runAgentOptimization(
  agentName: string,
): Promise<AgentOptimizationResult> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/optimize`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `optimize ${res.status}`)
  }
  return (await res.json()) as AgentOptimizationResult
}

// dashboard-rework P4 — create a new agent (admin-gated). Provisions a Discord
// channel + scaffolds the workspace; the agent boots on `clawcode start <name>`
// or the next daemon restart.
export type CreateAgentInput = {
  readonly name: string
  readonly soul: string
  readonly model?: string
  readonly parentChannelId: string
}
export type CreateAgentResult = {
  readonly ok?: boolean
  readonly name: string
  readonly model?: string
  readonly channelId?: string
  readonly channelUrl?: string
  readonly workspace?: string
}
export async function createAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
  const res = await fetch('/api/agents', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `create agent ${res.status}`)
  }
  return (await res.json()) as CreateAgentResult
}

// dashboard-rework — native Claude Code plugin marketplace (Anthropic-verified).
export type PluginCatalogEntry = {
  readonly name: string
  readonly marketplace: string
  readonly ref: string
  readonly description: string
  readonly author: string | null
  readonly category: string | null
  readonly verified: boolean
  readonly firstParty: boolean
  readonly installed: boolean
  readonly homepage: string | null
}
export type PluginMarketplaceSummary = {
  readonly name: string
  readonly source: string
  readonly verified: boolean
  readonly pluginCount: number
}
export type PluginMarketplacesResponse = {
  readonly marketplaces: readonly PluginMarketplaceSummary[]
  readonly plugins: readonly PluginCatalogEntry[]
}
export function usePluginMarketplaces(): UseQueryResult<PluginMarketplacesResponse> {
  return useQuery({
    queryKey: ['plugin-marketplaces'],
    queryFn: () => fetchJson<PluginMarketplacesResponse>('/api/plugins/marketplaces'),
    staleTime: 60_000,
  })
}
export type PluginCliResult = { readonly ok: boolean; readonly stdout: string; readonly stderr: string }
async function pluginMutate(url: string, body: Record<string, string>): Promise<PluginCliResult> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Partial<PluginCliResult> & { error?: string }
  if (typeof data.ok === 'boolean') {
    return { ok: data.ok, stdout: data.stdout ?? '', stderr: data.stderr ?? '' }
  }
  return { ok: false, stdout: '', stderr: data.error ?? `HTTP ${res.status}` }
}
export const installPluginRef = (ref: string): Promise<PluginCliResult> =>
  pluginMutate('/api/plugins/install', { ref })
export const uninstallPluginRef = (ref: string): Promise<PluginCliResult> =>
  pluginMutate('/api/plugins/uninstall', { ref })
export const addPluginMarketplace = (source: string): Promise<PluginCliResult> =>
  pluginMutate('/api/plugins/marketplace/add', { source })
export const removePluginMarketplace = (name: string): Promise<PluginCliResult> =>
  pluginMutate('/api/plugins/marketplace/remove', { name })

// dashboard-rework P3 — marketplace (skills), per-agent.
export type MarketplaceSource =
  | 'local'
  | { readonly path: string; readonly label?: string }
  | { readonly kind: 'clawhub'; readonly baseUrl: string; readonly version: string }
export type MarketplaceEntry = {
  readonly name: string
  readonly description: string
  readonly category: 'acme' | 'personal' | 'fleet'
  readonly source: MarketplaceSource
}
export type MarketplaceListResponse = {
  readonly agent: string
  readonly installed: readonly string[]
  readonly available: readonly MarketplaceEntry[]
}
export function useMarketplace(
  agent: string | null,
): UseQueryResult<MarketplaceListResponse> {
  return useQuery({
    queryKey: ['marketplace', agent],
    queryFn: () =>
      fetchJson<MarketplaceListResponse>(
        `/api/marketplace?agent=${encodeURIComponent(agent ?? '')}`,
      ),
    enabled: agent !== null && agent !== '',
    staleTime: 30_000,
  })
}
export type MarketplaceActionResult = {
  readonly outcome?: string
  readonly [k: string]: unknown
}
async function marketplaceAction(
  action: 'install' | 'remove',
  agent: string,
  skill: string,
): Promise<MarketplaceActionResult> {
  const res = await fetch(`/api/marketplace/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, skill }),
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? `${action} ${res.status}`)
  }
  return (await res.json()) as MarketplaceActionResult
}
export const installSkill = (agent: string, skill: string): Promise<MarketplaceActionResult> =>
  marketplaceAction('install', agent, skill)
export const removeSkill = (agent: string, skill: string): Promise<MarketplaceActionResult> =>
  marketplaceAction('remove', agent, skill)

export type BenchmarkComparePoint = {
  readonly agent: string
  readonly value_ms: number | null
  readonly count: number | null
  readonly model: string | null
  readonly error: string | null
}

export type BenchmarkCompareResponse = {
  readonly metric: string
  readonly since: string
  readonly points: ReadonlyArray<BenchmarkComparePoint>
}

export function useBenchmarkCompare(
  agents: ReadonlyArray<string>,
  metric: string,
  since: string = '24h',
): UseQueryResult<BenchmarkCompareResponse> {
  const key = [...agents].sort().join(',')
  return useQuery({
    queryKey: ['benchmark-compare', key, metric, since],
    queryFn: () =>
      fetchJson<BenchmarkCompareResponse>(
        `/api/benchmarks/compare?agents=${encodeURIComponent(key)}&metric=${encodeURIComponent(metric)}&since=${encodeURIComponent(since)}`,
      ),
    enabled: agents.length > 0 && metric.length > 0,
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// dash-redesign (Mission Control) — right-rail hooks.
//
// useActivityFeed: live operator-visible event stream for the
// dashboard home's right rail. The kit assumes four event types
// (advisor, escalation, discord, memory); production SSE
// (src/dashboard/client/src/hooks/useSse.ts) only fans these names:
//   agent-status, schedules, health, delivery-queue, memory-stats,
//   task-state-change, error, conversation-turn
//
// None of those carry the operator-narrative shape the kit's feed
// renders ("agent X consulted advisor", "agent Y escalated context").
// Shipping a placeholder that returns an empty array — the right-
// rail component renders the empty-state and the operator gets a
// degraded-but-honest experience instead of fake data.
//
// TODO (follow-up phase): wire a new daemon-side SSE event
// `operator-activity` that emits the four narrative event types
// from the existing daemon hooks (advisor service, escalation,
// Discord bot, memory consolidator). Spec sketch:
//   { type: 'advisor'|'escalation'|'discord'|'memory',
//     agent: string, text: string, ts: number }
// and a REST seed at GET /api/activity?limit=N for first paint.
// ---------------------------------------------------------------------------

export type ActivityFeedItem = {
  readonly type: 'advisor' | 'escalation' | 'discord' | 'memory'
  readonly agent: string
  readonly text: string
  readonly when: string // relative time string ("2m", "6m", etc.)
}

/**
 * Placeholder while the operator-activity SSE channel does not exist.
 * Returns an empty list. The rail renders an empty state until the
 * daemon-side feed lands.
 */
export function useActivityFeed(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _limit: number = 8,
): { readonly data: ReadonlyArray<ActivityFeedItem>; readonly isLoading: boolean; readonly isError: boolean } {
  return { data: [], isLoading: false, isError: false }
}

// ---------------------------------------------------------------------------
// useRecentTasks: top-N active tasks across the fleet, flattened from
// the existing /api/tasks/kanban endpoint that TaskKanban consumes.
//
// State mapping for the kit's three-state pill:
//   Running               → 'run'
//   Backlog/Scheduled/    → 'queue'
//     Waiting
//   Done/Failed           → 'done'
//
// Ordering: by started_at DESC, recent first. The kit's TaskRow shows
// 5 items.
// ---------------------------------------------------------------------------

export type RecentTask = {
  readonly id: string
  readonly agent: string
  readonly title: string
  readonly meta: string
  readonly state: 'run' | 'queue' | 'done'
}

function mapKanbanState(status: string): 'run' | 'queue' | 'done' {
  if (status === 'Running' || status === 'running') return 'run'
  if (status === 'Done' || status === 'done' || status === 'Failed' || status === 'failed') return 'done'
  return 'queue'
}

function formatRelShort(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return ''
  const delta = Date.now() - epochMs
  if (delta < 0) return 'just now'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export function useRecentTasks(limit: number = 5): {
  readonly data: ReadonlyArray<RecentTask>
  readonly isLoading: boolean
  readonly isError: boolean
} {
  const q = useKanbanTasks()
  const cols = q.data?.columns
  if (!cols) {
    return { data: [], isLoading: q.isLoading, isError: q.isError }
  }
  // Flatten and sort. Done/Failed land at the bottom even when freshly
  // ended — operators primarily care about live + queued.
  const all: KanbanRow[] = [
    ...cols.Running,
    ...cols.Scheduled,
    ...cols.Waiting,
    ...cols.Backlog,
    ...cols.Failed,
    ...cols.Done,
  ]
  const sorted = all
    .slice()
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, limit)
  const data: RecentTask[] = sorted.map((r) => ({
    id: r.task_id,
    agent: r.target_agent || r.caller_agent || '?',
    title: r.task_type || '(untitled)',
    meta: `${r.caller_agent} → ${r.target_agent} · ${formatRelShort(r.started_at)}`,
    state: mapKanbanState(r.status),
  }))
  return { data, isLoading: q.isLoading, isError: q.isError }
}
