/**
 * ClawCode Dashboard — Client-side application.
 * Handles SSE events, agent card rendering, panel rendering, and control actions.
 */

/** @type {EventSource | null} */
let eventSource = null;

/** @type {{ delivered: number; totalEnqueued: number } | null} */
let lastDeliveryStats = null;

/** @type {string} */
let lastAgentHash = "";

/** @type {number | null} — guard so the 30s latency poll is only scheduled once */
let latencyPollIntervalId = null;

/** @type {number | null} — guard so the 30s cache poll is only scheduled once */
let cachePollIntervalId = null;

/** @type {number | null} — guard so the 30s tools poll is only scheduled once (Phase 55) */
let toolsPollIntervalId = null;

/**
 * Phase 55 Plan 03 — Tool Call Latency panel collapse thresholds. When more
 * than EXPAND_THRESHOLD distinct tools appear in the window, only the top
 * COLLAPSED_LIMIT rows render initially (slowest first via SQL p95 DESC
 * sort); a "Show all N tools" button reveals the rest on click.
 */
const TOOLS_PANEL_COLLAPSED_LIMIT = 5;
const TOOLS_PANEL_EXPAND_THRESHOLD = 10;

/**
 * Canonical display order for the latency percentile table. Mirrors
 * SEGMENT_DISPLAY_ORDER in src/cli/commands/latency.ts so the CLI table
 * and dashboard table never disagree on segment ordering.
 *
 * Phase 54 Plan 04: expanded from 4 to 6 names — first_visible_token and
 * typing_indicator appear in their canonical slots (after first_token and at
 * the tail respectively). Matches CONTEXT Specifics #1.
 * @type {ReadonlyArray<string>}
 */
const SEGMENT_DISPLAY_ORDER = Object.freeze([
  "end_to_end",
  "first_token",
  "first_visible_token",
  "context_assemble",
  "tool_call",
  "typing_indicator",
]);

/**
 * Map an slo_status string to a CSS cell class.
 *
 * Threshold values and metric labels come from the server response
 * (`row.slo_threshold_ms` and `row.slo_metric`) — there is intentionally
 * NO client-side threshold mirror constant. Single source of truth lives
 * in `src/performance/slos.ts` and flows through the daemon's latency
 * handler; the dashboard is a dumb renderer. Keeping it that way means
 * per-agent `perf.slos?` overrides always surface in BOTH the cell color
 * AND the subtitle text — no client/server drift.
 *
 * @param {string | undefined} status - The slo_status value from the row.
 * @returns {string} - A CSS class name.
 */
function sloCellClass(status) {
  if (status === "healthy") return "latency-cell-healthy";
  if (status === "breach") return "latency-cell-breach";
  return "latency-cell-no-data";
}

/**
 * Phase 54 Plan 04 — render the First Token headline card at the TOP of each
 * agent tile. Large p50 number, SLO color (cyan/red/gray), subtitle showing
 * either the SLO target, the cold-start "warming up" copy, or a neutral
 * "first user-visible token" fallback.
 *
 * Reads `slo_status` / `slo_threshold_ms` / `slo_metric` / `count` from the
 * server-emitted `first_token_headline` object — ZERO client-side SLO
 * threshold mirror (Phase 51 Plan 03 invariant). The server's cold-start
 * guard sets `slo_status === "no_data"` whenever `count < 5`, so the gray
 * tint flows through verbatim.
 *
 * @param {string} agentName
 * @param {{p50: number|null, p95: number|null, p99: number|null, count: number,
 *          slo_status: "healthy"|"breach"|"no_data",
 *          slo_threshold_ms: number|null,
 *          slo_metric: "p50"|"p95"|"p99"|null} | null | undefined} headline
 * @returns {string} HTML — empty string when headline is absent (backward-compat).
 */
function renderFirstTokenHeadline(agentName, headline) {
  if (!headline) return ""; // pre-Phase-54 daemon response — omit the card
  const statusClass = sloCellClass(headline.slo_status);
  const msText = headline.p50 === null ? "—" : `${headline.p50.toLocaleString()} ms`;
  let subtitle;
  if (headline.slo_status === "no_data" && headline.count < 5) {
    // Cold-start: operator sees a neutral gray card with the warming-up copy.
    subtitle = `warming up — ${headline.count.toLocaleString()} turn${headline.count === 1 ? "" : "s"}`;
  } else if (
    typeof headline.slo_threshold_ms === "number" &&
    typeof headline.slo_metric === "string"
  ) {
    subtitle = `SLO target: ${headline.slo_threshold_ms.toLocaleString()} ms ${escapeHtml(headline.slo_metric)}`;
  } else {
    subtitle = "first user-visible token";
  }
  return `
    <div class="first-token-card ${statusClass}" id="first-token-${escapeAttr(agentName)}">
      <div class="first-token-heading">First Token</div>
      <div class="first-token-value">${escapeHtml(msText)}</div>
      <div class="first-token-subtitle">${escapeHtml(subtitle)}</div>
    </div>
  `;
}

/**
 * Phase 52 Plan 03: map a CacheHitRateStatus string to a CSS cell class.
 *
 * Healthy = cyan (accent-secondary token), breach = red (status-error),
 * no_data = gray (text-secondary). Mirrors sloCellClass naming convention so
 * the two panels stay visually parallel in the per-agent card.
 *
 * @param {string | undefined} status - The status value from the cache report.
 * @returns {string} - A CSS class name.
 */
function cacheCellClass(status) {
  if (status === "healthy") return "cache-cell-healthy";
  if (status === "breach") return "cache-cell-breach";
  return "cache-cell-no-data";
}

/**
 * Phase 52 Plan 03: format a ratio [0..1] as a percentage with one decimal.
 * `0.723` -> "72.3%". Null/undefined/NaN renders as "—" (em dash, matching
 * the latency formatter's null convention).
 *
 * @param {number | null | undefined} value
 * @returns {string}
 */
function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Format a millisecond value with thousand separators and " ms" suffix.
 * Null / undefined renders as `—` (em dash), matching the CLI.
 * @param {number | null | undefined} value
 * @returns {string}
 */
function formatMs(value) {
  if (value === null || value === undefined) return "—";
  return `${value.toLocaleString()} ms`;
}

/**
 * Format uptime from a startedAt timestamp.
 * @param {number | null} startedAt - Unix timestamp in ms
 * @returns {string}
 */
function formatUptime(startedAt) {
  if (startedAt === null || startedAt === undefined) return "--";

  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const days = Math.floor(elapsed / 86400);
  const hours = Math.floor((elapsed % 86400) / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Format a timestamp as relative time (e.g. "in 3m", "2h ago").
 * @param {number | string | null} ts - Unix timestamp in ms or ISO string
 * @returns {string}
 */
function formatRelativeTime(ts) {
  if (ts === null || ts === undefined) return "--";
  const now = Date.now();
  const target = typeof ts === "string" ? new Date(ts).getTime() : ts;
  const diffMs = target - now;
  const absDiff = Math.abs(diffMs);

  const minutes = Math.floor(absDiff / 60000);
  const hours = Math.floor(absDiff / 3600000);
  const days = Math.floor(absDiff / 86400000);

  let label;
  if (days > 0) label = `${days}d`;
  else if (hours > 0) label = `${hours}h`;
  else if (minutes > 0) label = `${minutes}m`;
  else label = "<1m";

  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

/**
 * Get the CSS color variable for a context zone.
 * @param {string | null} zone
 * @returns {string}
 */
function zoneColor(zone) {
  switch (zone) {
    case "green": return "var(--zone-green)";
    case "yellow": return "var(--zone-yellow)";
    case "orange": return "var(--zone-orange)";
    case "red": return "var(--zone-red)";
    default: return "var(--text-secondary)";
  }
}

/**
 * Get the CSS class for a status badge.
 * @param {string} status
 * @returns {string}
 */
function statusClass(status) {
  switch (status) {
    case "running": return "running";
    case "stopped": return "stopped";
    case "crashed":
    case "failed": return "crashed";
    case "starting":
    case "restarting": return "starting";
    case "stopping": return "stopping";
    default: return "stopped";
  }
}

/**
 * Phase 56 Plan 02 — render warm-path badge from SERVER-EMITTED fields only.
 *
 * Server-emit invariant: the dashboard performs ZERO threshold computation.
 * The registry (via daemon `status` IPC) carries warm_path_ready and
 * warm_path_readiness_ms; this function maps them to a CSS class + label.
 * If either field is absent (legacy agents pre-Phase-56), render a neutral
 * badge so the card layout stays aligned.
 * @param {object} agent
 * @returns {string}
 */
function renderWarmPathBadge(agent) {
  if (
    agent.warm_path_readiness_ms === undefined ||
    agent.warm_path_readiness_ms === null
  ) {
    return '<span class="warm-path-badge unknown">\u2014</span>';
  }
  if (
    typeof agent.lastError === "string" &&
    agent.lastError.startsWith("warm-path:")
  ) {
    return '<span class="warm-path-badge cold">warm-path error</span>';
  }
  if (agent.warm_path_ready === true) {
    const ms = Math.round(agent.warm_path_readiness_ms);
    return `<span class="warm-path-badge warm">warm ${ms}ms</span>`;
  }
  return '<span class="warm-path-badge warming">warming</span>';
}

/**
 * Create an agent card HTML string.
 * @param {object} agent
 * @param {number} index
 * @returns {string}
 */
function createAgentCard(agent, index) {
  const uptime = formatUptime(agent.startedAt);
  const fillPct = agent.fillPercentage !== null ? agent.fillPercentage : 0;
  const fillLabel = agent.fillPercentage !== null ? `${Math.round(fillPct)}%` : "--";
  const zoneClr = zoneColor(agent.zone);
  const channels = (agent.channels || [])
    .map((ch) => `<span class="channel-tag">${escapeHtml(ch)}</span>`)
    .join("");
  const errorBlock = agent.lastError
    ? `<div class="agent-error">${escapeHtml(agent.lastError)}</div>`
    : "";

  return `
    <div class="agent-card" style="animation-delay: ${index * 0.05}s">
      <div class="agent-card-header">
        <span class="agent-name">${escapeHtml(agent.name)}</span>
        <span class="status-badge ${statusClass(agent.status)}">${escapeHtml(agent.status)}</span>
        ${renderWarmPathBadge(agent)}
      </div>
      <div class="agent-meta">
        <div class="agent-meta-row">
          <span class="meta-label">uptime</span>
          <span class="meta-value">${uptime}</span>
        </div>
        <div class="agent-meta-row">
          <span class="meta-label">restarts</span>
          <span class="meta-value">${agent.restartCount}</span>
        </div>
      </div>
      <div class="zone-bar-container">
        <div class="zone-bar-label">
          <span class="zone-bar-label-text">context</span>
          <span class="zone-bar-pct" style="color: ${zoneClr}">${fillLabel}</span>
        </div>
        <div class="zone-bar">
          <div class="zone-bar-fill" style="width: ${fillPct}%; background: ${zoneClr}"></div>
        </div>
      </div>
      <div class="first-token-slot" id="first-token-slot-${escapeAttr(agent.name)}"></div>
      <div class="latency-panel" id="latency-${escapeAttr(agent.name)}">
        <div class="latency-heading">Latency (24h)</div>
        <div class="latency-body panel-placeholder">Loading latency…</div>
      </div>
      <div class="cache-panel" id="cache-${escapeAttr(agent.name)}">
        <div class="cache-heading">Prompt Cache (24h)</div>
        <div class="cache-body panel-placeholder">Loading cache…</div>
      </div>
      <div class="tools-panel" id="tools-${escapeAttr(agent.name)}">
        <div class="tools-heading">Tool Call Latency (24h)</div>
        <div class="tools-body panel-placeholder">Loading tools…</div>
      </div>
      ${channels ? `<div class="channel-tags">${channels}</div>` : ""}
      ${errorBlock}
      <div class="agent-actions">
        <button class="action-btn" onclick="agentAction('${escapeAttr(agent.name)}', 'start')">Start</button>
        <button class="action-btn danger" onclick="agentAction('${escapeAttr(agent.name)}', 'stop')">Stop</button>
        <button class="action-btn" onclick="agentAction('${escapeAttr(agent.name)}', 'restart')">Restart</button>
        <button class="action-btn" onclick="openMsgModal('${escapeAttr(agent.name)}')" style="border-color:rgba(255,51,102,0.3);color:var(--accent-primary)">Messages</button>
      </div>
    </div>
  `;
}

/**
 * Render all agent cards into the grid.
 * @param {Array} agents
 */
function renderAgentCards(agents) {
  const grid = document.getElementById("agent-grid");
  if (!grid) return;

  if (!agents || agents.length === 0) {
    if (lastAgentHash !== "empty") {
      grid.innerHTML = '<div class="panel-placeholder">No agents registered</div>';
      lastAgentHash = "empty";
    }
    return;
  }

  // Only re-render when data actually changes (prevents flicker from SSE polling)
  // Phase 56 Plan 02 — include warm-path fields in the hash so the badge
  // refreshes when the server flips ready state.
  const hash = JSON.stringify(agents.map(a => ({
    n: a.name, s: a.status, r: a.restartCount, z: a.zone,
    f: a.fillPercentage, e: a.lastError,
    wr: a.warm_path_ready, wm: a.warm_path_readiness_ms,
  })));
  if (hash === lastAgentHash) return;
  lastAgentHash = hash;

  grid.innerHTML = agents.map((agent, i) => createAgentCard(agent, i)).join("");

  // After the DOM is rebuilt, prime the latency AND cache panels for every
  // visible agent. The 30s intervals started by startLatencyPolling /
  // startCachePolling keep things fresh; this pass just avoids waiting for
  // the first tick.
  agents.forEach((a) => {
    if (a && typeof a.name === "string") {
      fetchAgentLatency(a.name);
      fetchAgentCache(a.name);
      fetchAgentTools(a.name);
    }
  });
  startLatencyPolling();
  startCachePolling();
  startToolsPolling();
}

/**
 * Fetch and render latency percentiles for a single agent.
 * Never throws to the console on network/IPC errors — shows a placeholder
 * message in the panel body instead so the 30s loop is resilient.
 * @param {string} agentName
 */
async function fetchAgentLatency(agentName) {
  const container = document.getElementById(`latency-${agentName}`);
  if (!container) return;
  const body = container.querySelector(".latency-body");
  if (!body) return;
  // Phase 54 Plan 04: the First Token headline card shares the same 30s poll
  // as the Latency panel — we render both from the one /api/agents/:name/latency
  // response so the card + table stay in sync and we don't double the HTTP load.
  const headlineSlot = document.getElementById(`first-token-slot-${agentName}`);
  try {
    const resp = await fetch(
      `/api/agents/${encodeURIComponent(agentName)}/latency?since=24h`,
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    /** @type {{ agent: string, since: string, segments: Array<{ segment: string, p50: number|null, p95: number|null, p99: number|null, count: number, slo_status?: "healthy"|"breach"|"no_data", slo_threshold_ms?: number|null, slo_metric?: "p50"|"p95"|"p99"|null }>, first_token_headline?: {p50: number|null, p95: number|null, p99: number|null, count: number, slo_status: "healthy"|"breach"|"no_data", slo_threshold_ms: number|null, slo_metric: "p50"|"p95"|"p99"|null} }} */
    const report = await resp.json();
    // Phase 54 Plan 04: render the First Token headline card from the server-
    // emitted first_token_headline object. Backward-compat: when the daemon
    // predates Phase 54 the field is absent and the slot stays empty.
    if (headlineSlot) {
      headlineSlot.innerHTML = renderFirstTokenHeadline(
        agentName,
        report.first_token_headline,
      );
    }
    const bySeg = new Map((report.segments || []).map((r) => [r.segment, r]));
    const rows = SEGMENT_DISPLAY_ORDER.map((seg) => {
      const row = bySeg.get(seg) || {
        segment: seg,
        p50: null,
        p95: null,
        p99: null,
        count: 0,
        slo_status: undefined,
        slo_threshold_ms: null,
        slo_metric: null,
      };
      // If the server didn't compute slo_status (old daemon / unknown
      // segment), fall back to "no_data" when the count is 0 — keeps the
      // gray tint consistent with the "no data yet" visual language.
      const status = row.slo_status || (row.count === 0 ? "no_data" : undefined);
      const cellClass = sloCellClass(status);
      // Subtitle is driven EXCLUSIVELY by server-emitted fields. Per-agent
      // overrides already merged by the daemon, so color + text always agree.
      const hasSloInfo =
        typeof row.slo_threshold_ms === "number" &&
        typeof row.slo_metric === "string";
      const subtitle = hasSloInfo
        ? `<div class="latency-subtitle">SLO target: ${row.slo_threshold_ms.toLocaleString()} ms ${escapeHtml(row.slo_metric)}</div>`
        : "";
      // Tint ONLY the cell whose percentile matches the server-reported SLO
      // metric. Other percentile columns render plain so the eye is drawn to
      // the one metric the SLO actually watches.
      const p50Class = row.slo_metric === "p50" ? cellClass : "";
      const p95Class = row.slo_metric === "p95" ? cellClass : "";
      const p99Class = row.slo_metric === "p99" ? cellClass : "";
      return `<tr>
        <td><div class="latency-segment-name">${escapeHtml(row.segment)}</div>${subtitle}</td>
        <td class="${p50Class}">${escapeHtml(formatMs(row.p50))}</td>
        <td class="${p95Class}">${escapeHtml(formatMs(row.p95))}</td>
        <td class="${p99Class}">${escapeHtml(formatMs(row.p99))}</td>
        <td>${row.count.toLocaleString()}</td>
      </tr>`;
    }).join("");
    body.classList.remove("panel-placeholder");
    body.innerHTML = `<table class="latency-table">
      <thead><tr><th>Segment</th><th>p50</th><th>p95</th><th>p99</th><th>Count</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } catch {
    body.classList.add("panel-placeholder");
    body.textContent = "Latency data unavailable";
  }
}

/**
 * Start the 30-second latency polling interval. Idempotent — guards against
 * double-registration via the module-level latencyPollIntervalId.
 */
function startLatencyPolling() {
  if (latencyPollIntervalId !== null) return;
  const pollAll = () => {
    const panels = document.querySelectorAll('[id^="latency-"]');
    panels.forEach((el) => {
      const agentName = el.id.replace(/^latency-/, "");
      if (agentName) fetchAgentLatency(agentName);
    });
  };
  latencyPollIntervalId = setInterval(pollAll, 30_000);
}

/**
 * Phase 52 Plan 03: fetch and render the Prompt Cache panel for a single
 * agent. Never throws to the console on network/IPC errors — shows a
 * placeholder in the panel body instead so the 30s loop is resilient.
 *
 * Contract: GET /api/agents/:name/cache?since=24h returns the daemon's
 * augmented CacheTelemetryReport shape:
 *   { agent, since, totalTurns, avgHitRate, p50HitRate, p95HitRate,
 *     totalCacheReads, totalCacheWrites, totalInputTokens, trendByDay[],
 *     status: "healthy"|"breach"|"no_data", cache_effect_ms: number|null }
 *
 * @param {string} agentName
 */
async function fetchAgentCache(agentName) {
  const container = document.getElementById(`cache-${agentName}`);
  if (!container) return;
  const body = container.querySelector(".cache-body");
  if (!body) return;
  try {
    const resp = await fetch(
      `/api/agents/${encodeURIComponent(agentName)}/cache?since=24h`,
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    /** @type {{ agent: string, since: string, totalTurns: number, avgHitRate: number, p50HitRate: number, p95HitRate: number, totalCacheReads: number, totalCacheWrites: number, totalInputTokens: number, trendByDay: Array<{date:string,turns:number,hitRate:number}>, status: "healthy"|"breach"|"no_data", cache_effect_ms: number|null }} */
    const report = await resp.json();
    renderCachePanel(body, report);
  } catch {
    body.classList.add("panel-placeholder");
    body.textContent = "Cache data unavailable";
  }
}

/**
 * Phase 52 Plan 03: render the augmented CacheTelemetryReport into the
 * panel body. Three stacked subtitle lines below the single-row table:
 *   1. Formula disclosure: "Hit rate = cache reads / (cache reads + cache
 *      writes + input tokens)"
 *   2. SLO band: "SLO: healthy ≥ 60%, breach < 30%"
 *   3. Cache effect: "Cache effect: {X}ms faster first-token on hits" when
 *      non-null, else "Cache effect: insufficient data (< 20 turns)"
 *
 * @param {Element} body
 * @param {{
 *   agent: string,
 *   totalTurns: number,
 *   avgHitRate: number,
 *   p50HitRate: number,
 *   p95HitRate: number,
 *   totalCacheReads: number,
 *   totalCacheWrites: number,
 *   totalInputTokens: number,
 *   trendByDay: Array<{date:string,turns:number,hitRate:number}>,
 *   status: "healthy"|"breach"|"no_data",
 *   cache_effect_ms: number|null,
 * }} report
 */
function renderCachePanel(body, report) {
  // Empty-window fallback: no cache-aware turns in the last 24h.
  if (!report || typeof report.totalTurns !== "number" || report.totalTurns === 0) {
    body.classList.add("panel-placeholder");
    body.textContent = "No cache data yet (warming up)";
    return;
  }

  const cellClass = cacheCellClass(report.status);
  const hitRateText = formatPercent(report.avgHitRate);
  const p50Text = formatPercent(report.p50HitRate);
  const p95Text = formatPercent(report.p95HitRate);

  // Eviction-marker detection: annotate any trendByDay bucket whose hit rate
  // dropped >30% vs the prior day. Small red dot + tooltip "prefix changed".
  const trend = Array.isArray(report.trendByDay) ? report.trendByDay : [];
  const evictionMarkers = [];
  for (let i = 1; i < trend.length; i++) {
    const prev = trend[i - 1];
    const curr = trend[i];
    if (prev && curr && typeof prev.hitRate === "number" && typeof curr.hitRate === "number") {
      if (curr.hitRate - prev.hitRate < -0.3) {
        evictionMarkers.push(escapeHtml(curr.date));
      }
    }
  }
  const evictionAnnotation =
    evictionMarkers.length > 0
      ? `<span class="cache-eviction-marker" title="prefix changed on ${evictionMarkers.join(", ")}">●</span>`
      : "";

  // Cache-effect subtitle: suppress absolute number below noise floor.
  const effectSubtitle =
    report.cache_effect_ms === null || report.cache_effect_ms === undefined
      ? "Cache effect: insufficient data (< 20 turns)"
      : `Cache effect: ${Math.round(report.cache_effect_ms)} ms faster first-token on hits`;

  // Phase 115 Plan 07 T04 (sub-scope 16(c)) — tool cache metrics rendered
  // alongside prompt_cache_hit_rate. Both signals live in the same panel
  // so operators can compare LLM prompt-cache health against MCP
  // tool-response cache health at a glance.
  //
  // The daemon's case "cache" augmented report includes:
  //   tool_cache_hit_rate (number|null) — rolling avg over the window
  //   tool_cache_size_mb  (number|null) — fleet-wide cache size sample
  //   tool_cache_turns    (number)      — turns with ≥1 cache event
  //
  // Rendered as a single `tool cache` subtitle line (intentionally tucked
  // below the prompt-cache row to keep the existing layout intact).
  const toolCacheHitRate =
    report && typeof report.tool_cache_hit_rate === "number"
      ? report.tool_cache_hit_rate
      : null;
  const toolCacheSizeMb =
    report && typeof report.tool_cache_size_mb === "number"
      ? report.tool_cache_size_mb
      : report && typeof report.tool_cache_size_mb_live === "number"
        ? report.tool_cache_size_mb_live
        : null;
  const toolCacheTurns =
    report && typeof report.tool_cache_turns === "number"
      ? report.tool_cache_turns
      : 0;
  let toolCacheSubtitle;
  if (toolCacheHitRate === null && toolCacheTurns === 0) {
    toolCacheSubtitle = "tool cache: no events yet";
  } else {
    const hitRateText =
      toolCacheHitRate === null ? "—" : formatPercent(toolCacheHitRate);
    const sizeText =
      toolCacheSizeMb === null ? "—" : `${toolCacheSizeMb.toFixed(1)} MB`;
    toolCacheSubtitle = `tool cache: ${hitRateText} · ${sizeText} (${toolCacheTurns} turn${toolCacheTurns === 1 ? "" : "s"})`;
  }

  // Phase 115 Plan 08 T03 (sub-scope 17 a/b/c + 6-A) — tool-latency audit
  // metrics rendered alongside the cache panel. The four subtitle lines
  // surface the per-turn split-latency columns landed in T01 + the
  // tool_use_rate measurement landed in T02. Operator can compare
  // "tool itself slow" (tool_execution_ms_p50) vs "prompt-bloat-tax slow"
  // (tool_roundtrip_ms_p50) at a glance, and see the parallel rate that
  // the PARALLEL-TOOL-01 directive (sub-scope 17c) is intended to lift.
  //
  // The metrics travel on the same `report` object — the daemon's case
  // "cache" handler (src/manager/daemon.ts) folds them in via
  // `computeSplitLatencyFields(agentName, sinceIso)` next to the
  // tool_cache_size_mb_live field already added by Plan 115-07. When
  // the underlying agent has no signal (e.g., no in-window turns), the
  // four fields are absent on `report` and the render falls back to "—".
  const toolExecP50 =
    report && typeof report.tool_execution_ms_p50 === "number"
      ? report.tool_execution_ms_p50
      : null;
  const toolRoundtripP50 =
    report && typeof report.tool_roundtrip_ms_p50 === "number"
      ? report.tool_roundtrip_ms_p50
      : null;
  const parallelToolCallRate =
    report && typeof report.parallel_tool_call_rate === "number"
      ? report.parallel_tool_call_rate
      : null;
  const toolUseRate =
    report && typeof report.tool_use_rate === "number"
      ? report.tool_use_rate
      : null;
  const splitLatencyText =
    toolExecP50 === null && toolRoundtripP50 === null
      ? "split latency: no signal"
      : `split latency: exec p50 ${toolExecP50 === null ? "—" : `${toolExecP50} ms`} · roundtrip p50 ${toolRoundtripP50 === null ? "—" : `${(toolRoundtripP50 / 1000).toFixed(1)} s`}`;
  const useRateText =
    toolUseRate === null
      ? "tool_use_rate: no signal"
      : `tool_use_rate: ${formatPercent(toolUseRate)} (sub-scope 6-A gate · 30% threshold)`;
  const parallelRateText =
    parallelToolCallRate === null
      ? "parallel_tool_call_rate: no signal"
      : `parallel_tool_call_rate: ${formatPercent(parallelToolCallRate)} (turns with batch ≥ 2)`;

  // Phase 115 Plan 09 T04 (sub-scope 16(c)) — four new dashboard metric
  // subtitle lines for the per-agent cache panel. Surfaces:
  //   - tier1_inject_chars + tier1_budget_pct (115-02 sub-scope 1 cap)
  //   - lazy_recall_call_count (115-05 sub-scope 7 lazy recall tools)
  //   - prompt_bloat_warnings_24h (115-02 sub-scope 13 observability)
  //
  // Trace segments stay byte-identical (per ROADMAP line 877) — this
  // adds new SUBTITLE lines alongside the existing layout, doesn't
  // rename anything. tier1_budget_pct over 90% renders as a warning
  // ("near cap") so operators see truncation pressure before it fires.
  // tier1-truncation event count would be a 7th subtitle line; today
  // the count is implicit in tier1_budget_pct — when truncation fires,
  // the budget pct stays pinned at 100%, which the warning surface
  // catches.
  const tier1InjectChars =
    report && typeof report.tier1_inject_chars === "number"
      ? report.tier1_inject_chars
      : null;
  const tier1BudgetPct =
    report && typeof report.tier1_budget_pct === "number"
      ? report.tier1_budget_pct
      : null;
  let tier1Subtitle;
  if (tier1InjectChars === null && tier1BudgetPct === null) {
    tier1Subtitle = "tier 1: no signal yet (115-02 writes pending)";
  } else {
    const charsText =
      tier1InjectChars === null
        ? "—"
        : `${tier1InjectChars.toLocaleString()} chars`;
    const pctText =
      tier1BudgetPct === null
        ? "—"
        : `${formatPercent(tier1BudgetPct)} of 16K cap`;
    const nearCap = tier1BudgetPct !== null && tier1BudgetPct > 0.9;
    tier1Subtitle = `tier 1: ${charsText} (${pctText})${nearCap ? " · near cap" : ""}`;
  }

  // tier1-truncation event count over 24h — defensive read of optional field
  // that 115-02 may surface in a follow-on patch. Today daemon doesn't
  // populate it; render only when present.
  const tier1TruncationCount =
    report && typeof report.tier1_truncation_count_24h === "number"
      ? report.tier1_truncation_count_24h
      : null;
  if (tier1TruncationCount !== null && tier1TruncationCount > 0) {
    tier1Subtitle += ` · ${tier1TruncationCount} truncations/24h`;
  }

  const lazyRecallCalls =
    report && typeof report.lazy_recall_call_count === "number"
      ? report.lazy_recall_call_count
      : null;
  const lazyRecallSubtitle =
    lazyRecallCalls === null
      ? "lazy recall (24h): no signal yet (115-05 writes pending)"
      : `lazy recall (24h): ${lazyRecallCalls.toLocaleString()} tool call${lazyRecallCalls === 1 ? "" : "s"}`;

  const promptBloatWarnings =
    report && typeof report.prompt_bloat_warnings_24h === "number"
      ? report.prompt_bloat_warnings_24h
      : null;
  const promptBloatSubtitle =
    promptBloatWarnings === null
      ? "prompt bloat warnings (24h): no signal yet (115-02 writes pending)"
      : `prompt bloat warnings (24h): ${promptBloatWarnings}${promptBloatWarnings > 0 ? " · classifier-triggered" : ""}`;

  body.classList.remove("panel-placeholder");
  body.innerHTML = `<table class="cache-table">
    <thead><tr><th>Hit Rate</th><th>Cache Reads</th><th>Cache Writes</th><th>Input Tokens</th><th>Turns</th></tr></thead>
    <tbody><tr>
      <td class="${cellClass}">${escapeHtml(hitRateText)}${evictionAnnotation}</td>
      <td>${report.totalCacheReads.toLocaleString()}</td>
      <td>${report.totalCacheWrites.toLocaleString()}</td>
      <td>${report.totalInputTokens.toLocaleString()}</td>
      <td>${report.totalTurns.toLocaleString()}</td>
    </tr></tbody>
  </table>
  <div class="cache-subtitle">Hit rate = cache reads / (cache reads + cache writes + input tokens)</div>
  <div class="cache-subtitle">SLO: healthy &ge; 60%, breach &lt; 30% · p50 ${escapeHtml(p50Text)} · p95 ${escapeHtml(p95Text)}</div>
  <div class="cache-subtitle">${escapeHtml(effectSubtitle)}</div>
  <div class="cache-subtitle">${escapeHtml(toolCacheSubtitle)}</div>
  <div class="cache-subtitle">${escapeHtml(splitLatencyText)}</div>
  <div class="cache-subtitle">${escapeHtml(useRateText)}</div>
  <div class="cache-subtitle">${escapeHtml(parallelRateText)}</div>
  <div class="cache-subtitle">${escapeHtml(tier1Subtitle)}</div>
  <div class="cache-subtitle">${escapeHtml(lazyRecallSubtitle)}</div>
  <div class="cache-subtitle">${escapeHtml(promptBloatSubtitle)}</div>`;
}

/**
 * Phase 52 Plan 03: start the 30-second Prompt Cache polling interval.
 * Idempotent — guards against double-registration via cachePollIntervalId.
 * Mirrors startLatencyPolling's shape.
 */
function startCachePolling() {
  if (cachePollIntervalId !== null) return;
  const pollAll = () => {
    const panels = document.querySelectorAll('[id^="cache-"]');
    panels.forEach((el) => {
      const agentName = el.id.replace(/^cache-/, "");
      if (agentName) fetchAgentCache(agentName);
    });
  };
  cachePollIntervalId = setInterval(pollAll, 30_000);
}

/**
 * Phase 55 Plan 03 — fetch and render the Tool Call Latency panel for a
 * single agent. Never throws to the console on network/IPC errors — shows
 * a placeholder in the panel body so the 30s loop is resilient.
 *
 * Contract: GET /api/agents/:name/tools?since=24h returns the daemon's
 * augmented ToolsReport shape:
 *   { agent, since, tools: [{ tool_name, p50, p95, p99, count,
 *     slo_status: "healthy"|"breach"|"no_data",
 *     slo_threshold_ms: number, slo_metric: "p50"|"p95"|"p99" }] }
 *
 * Rows are sorted slowest-first by the SQL layer — client renders verbatim.
 *
 * @param {string} agentName
 */
async function fetchAgentTools(agentName) {
  const container = document.getElementById(`tools-${agentName}`);
  if (!container) return;
  const body = container.querySelector(".tools-body");
  if (!body) return;
  try {
    const resp = await fetch(
      `/api/agents/${encodeURIComponent(agentName)}/tools?since=24h`,
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    /** @type {{ agent: string, since: string, tools: Array<{ tool_name: string, p50: number|null, p95: number|null, p99: number|null, count: number, slo_status: "healthy"|"breach"|"no_data", slo_threshold_ms: number, slo_metric: "p50"|"p95"|"p99" }> }} */
    const report = await resp.json();
    renderToolsPanel(body, agentName, report);
  } catch {
    body.classList.add("panel-placeholder");
    body.textContent = "Tools data unavailable";
  }
}

/**
 * Phase 55 Plan 03 — render the augmented ToolsReport into the panel body.
 *
 * Visual rules:
 *   - Per-row cell tinting via `tool-row-slow` (breach) / `tool-row-healthy`
 *     (healthy) / `tool-row-no-data` (cold window) CSS classes.
 *   - When tools.length > TOOLS_PANEL_EXPAND_THRESHOLD, render only the top
 *     TOOLS_PANEL_COLLAPSED_LIMIT rows plus a "Show all N tools" button that
 *     expands on click (sets `data-expanded` on the body to persist across
 *     subsequent 30s polls).
 *
 * @param {Element} body
 * @param {string} agentName
 * @param {{ agent: string, since: string, tools: Array<{ tool_name: string, p50: number|null, p95: number|null, p99: number|null, count: number, slo_status: string, slo_threshold_ms: number, slo_metric: string }> }} report
 */
function renderToolsPanel(body, agentName, report) {
  if (
    !report ||
    !Array.isArray(report.tools) ||
    report.tools.length === 0
  ) {
    body.classList.add("panel-placeholder");
    body.textContent = "No tool calls in window";
    return;
  }

  const allTools = report.tools;
  const expanded = body.dataset.expanded === "1";
  const isCollapsed =
    allTools.length > TOOLS_PANEL_EXPAND_THRESHOLD && !expanded;
  const visibleTools = isCollapsed
    ? allTools.slice(0, TOOLS_PANEL_COLLAPSED_LIMIT)
    : allTools;

  const rowHtml = visibleTools
    .map((t) => {
      const statusClass =
        t.slo_status === "breach"
          ? "tool-row-slow"
          : t.slo_status === "healthy"
          ? "tool-row-healthy"
          : "tool-row-no-data";
      const sigil = t.slo_status === "breach" ? ' <span class="tool-slow-sigil">[SLOW]</span>' : "";
      return `<tr class="${statusClass}">
        <td>${escapeHtml(t.tool_name)}${sigil}</td>
        <td>${escapeHtml(formatMs(t.p50))}</td>
        <td>${escapeHtml(formatMs(t.p95))}</td>
        <td>${escapeHtml(formatMs(t.p99))}</td>
        <td>${t.count.toLocaleString()}</td>
      </tr>`;
    })
    .join("");

  const expandAffordance = isCollapsed
    ? `<div class="tools-expand"><button type="button" data-agent="${escapeAttr(agentName)}">Show all ${allTools.length} tools</button></div>`
    : "";

  body.classList.remove("panel-placeholder");
  body.innerHTML = `<table class="tools-table">
    <thead><tr><th>Tool</th><th>p50</th><th>p95</th><th>p99</th><th>Count</th></tr></thead>
    <tbody>${rowHtml}</tbody>
  </table>${expandAffordance}`;

  const btn = body.querySelector(".tools-expand button");
  if (btn) {
    btn.addEventListener("click", () => {
      body.dataset.expanded = "1";
      renderToolsPanel(body, agentName, report);
    });
  }
}

/**
 * Phase 55 Plan 03 — start the 30-second Tool Call Latency polling interval.
 * Idempotent — guards against double-registration via toolsPollIntervalId.
 * Mirrors startLatencyPolling / startCachePolling shape.
 */
function startToolsPolling() {
  if (toolsPollIntervalId !== null) return;
  const pollAll = () => {
    const panels = document.querySelectorAll('[id^="tools-"]');
    panels.forEach((el) => {
      const agentName = el.id.replace(/^tools-/, "");
      if (agentName) fetchAgentTools(agentName);
    });
  };
  toolsPollIntervalId = setInterval(pollAll, 30_000);
}

/**
 * Render the schedules panel with a task table.
 * @param {{ schedules: Array }} data
 */
function renderSchedulesPanel(data) {
  const container = document.getElementById("schedules-content");
  if (!container) return;

  const schedules = data.schedules || [];
  if (schedules.length === 0) {
    container.innerHTML = '<div class="panel-placeholder">No scheduled tasks</div>';
    return;
  }

  const rows = schedules
    .map((s) => {
      const statusDot = s.lastStatus === "success"
        ? "dot-success"
        : s.lastStatus === "error"
        ? "dot-error"
        : "dot-pending";
      const disabledClass = s.enabled ? "" : " schedule-disabled";
      const errorTooltip = s.lastError ? ` title="${escapeAttr(s.lastError)}"` : "";
      const nextRun = formatRelativeTime(s.nextRun);

      return `<tr class="schedule-row${disabledClass}">
        <td class="schedule-agent">${escapeHtml(s.agentName)}</td>
        <td class="schedule-task">${escapeHtml(s.name)}</td>
        <td class="schedule-cron"><code>${escapeHtml(s.cron)}</code></td>
        <td class="schedule-next">${nextRun}</td>
        <td class="schedule-status"><span class="status-dot ${statusDot}"${errorTooltip}></span></td>
      </tr>`;
    })
    .join("");

  container.innerHTML = `
    <table class="schedules-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Task</th>
          <th>Cron</th>
          <th>Next Run</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/**
 * Render the health panel with per-agent health cards.
 * @param {{ agents: Object }} data
 */
function renderHealthPanel(data) {
  const container = document.getElementById("health-content");
  if (!container) return;

  const agents = data.agents || {};
  const names = Object.keys(agents);
  if (names.length === 0) {
    container.innerHTML = '<div class="panel-placeholder">No health data</div>';
    return;
  }

  const cards = names
    .map((name) => {
      const info = agents[name];
      const overallClass = info.overall === "healthy"
        ? "dot-success"
        : info.overall === "degraded"
        ? "dot-warning"
        : "dot-error";

      const zoneFill = info.fillPercentage != null ? info.fillPercentage : 0;
      const zoneLabel = info.zone || "unknown";
      const zoneClr = zoneColor(info.zone || null);

      const checks = Object.entries(info.checks || {})
        .map(([checkName, check]) => {
          const checkDot = check.status === "pass"
            ? "dot-success"
            : check.status === "warn"
            ? "dot-warning"
            : "dot-error";
          return `<div class="health-check-row">
            <span class="status-dot ${checkDot}"></span>
            <span class="health-check-name">${escapeHtml(checkName)}</span>
            <span class="health-check-msg">${escapeHtml(check.message)}</span>
          </div>`;
        })
        .join("");

      return `<div class="health-card">
        <div class="health-card-header">
          <span class="health-agent-name">${escapeHtml(name)}</span>
          <span class="status-dot ${overallClass}"></span>
        </div>
        <div class="zone-bar-container">
          <div class="zone-bar-label">
            <span class="zone-bar-label-text">${escapeHtml(zoneLabel)}</span>
            <span class="zone-bar-pct" style="color: ${zoneClr}">${Math.round(zoneFill)}%</span>
          </div>
          <div class="zone-bar zone-bar-lg">
            <div class="zone-bar-fill" style="width: ${zoneFill}%; background: ${zoneClr}"></div>
          </div>
        </div>
        <div class="health-checks">${checks}</div>
      </div>`;
    })
    .join("");

  container.innerHTML = cards;
}

/**
 * Render the delivery queue panel with stats and failed entries.
 * @param {{ stats: Object, failed: Array }} data
 */
function renderDeliveryPanel(data) {
  const container = document.getElementById("delivery-content");
  if (!container) return;

  const stats = data.stats || { pending: 0, inFlight: 0, failed: 0, delivered: 0, totalEnqueued: 0 };

  // Cache stats for messages panel
  lastDeliveryStats = { delivered: stats.delivered, totalEnqueued: stats.totalEnqueued };
  renderMessagesPanel();

  const failed = data.failed || [];

  const statsHtml = `
    <div class="delivery-stats">
      <div class="stat-card">
        <span class="stat-number">${stats.pending}</span>
        <span class="stat-label">Pending</span>
      </div>
      <div class="stat-card">
        <span class="stat-number">${stats.inFlight}</span>
        <span class="stat-label">In Flight</span>
      </div>
      <div class="stat-card">
        <span class="stat-number stat-failed">${stats.failed}</span>
        <span class="stat-label">Failed</span>
      </div>
      <div class="stat-card">
        <span class="stat-number stat-delivered">${stats.delivered}</span>
        <span class="stat-label">Delivered</span>
      </div>
    </div>
  `;

  let failedHtml = "";
  if (failed.length > 0) {
    const rows = failed
      .map((f) => {
        const truncId = (f.id || "").substring(0, 8);
        const truncContent = (f.content || "").substring(0, 40);
        return `<tr class="failed-row">
          <td class="failed-id"><code>${escapeHtml(truncId)}</code></td>
          <td class="failed-agent">${escapeHtml(f.agentName)}</td>
          <td class="failed-error">${escapeHtml(f.lastError || "--")}</td>
          <td class="failed-time">${formatRelativeTime(f.createdAt)}</td>
          <td class="failed-attempts">${f.attempts}</td>
        </tr>`;
      })
      .join("");

    failedHtml = `
      <table class="failed-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Agent</th>
            <th>Error</th>
            <th>Created</th>
            <th>Tries</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } else {
    failedHtml = '<div class="panel-placeholder">No failed deliveries</div>';
  }

  container.innerHTML = statsHtml + failedHtml;
}

/**
 * Render the memory panel with per-agent memory cards.
 * @param {{ agents: Object }} data
 */
function renderMemoryPanel(data) {
  const container = document.getElementById("memory-content");
  if (!container) return;

  const agents = data.agents || {};
  const names = Object.keys(agents);
  if (names.length === 0) {
    container.innerHTML = '<div class="panel-placeholder">No memory data</div>';
    return;
  }

  const cards = names
    .map((name) => {
      const info = agents[name];
      const tiers = info.tierDistribution || {};
      const total = Object.values(tiers).reduce((sum, v) => sum + v, 0) || info.entryCount || 0;

      // Build tier bar segments
      const hotPct = total > 0 ? ((tiers.hot || 0) / total) * 100 : 0;
      const warmPct = total > 0 ? ((tiers.warm || 0) / total) * 100 : 0;
      const coldPct = total > 0 ? ((tiers.cold || 0) / total) * 100 : 0;

      return `<div class="memory-card">
        <span class="memory-agent-name">${escapeHtml(name)}</span>
        <div class="memory-stats-row">
          <span class="memory-entry-count">${info.entryCount}</span>
          <span class="memory-stat-label">entries</span>
          <span class="memory-episode-count">${info.episodeCount}</span>
          <span class="memory-stat-label">episodes</span>
        </div>
        <div class="tier-bar">
          <div class="tier-segment tier-hot" style="width: ${hotPct}%" title="Hot: ${tiers.hot || 0}"></div>
          <div class="tier-segment tier-warm" style="width: ${warmPct}%" title="Warm: ${tiers.warm || 0}"></div>
          <div class="tier-segment tier-cold" style="width: ${coldPct}%" title="Cold: ${tiers.cold || 0}"></div>
        </div>
      </div>`;
    })
    .join("");

  container.innerHTML = cards;
}

/**
 * Render the messages panel using delivery queue stats.
 */
function renderMessagesPanel() {
  const container = document.getElementById("messages-content");
  if (!container) return;

  if (!lastDeliveryStats) {
    container.innerHTML = '<div class="panel-placeholder">Waiting for data...</div>';
    return;
  }

  container.innerHTML = `
    <div class="messages-stats">
      <div class="stat-card">
        <span class="stat-number stat-delivered">${lastDeliveryStats.delivered}</span>
        <span class="stat-label">Messages Sent</span>
      </div>
      <div class="stat-card">
        <span class="stat-number">${lastDeliveryStats.totalEnqueued}</span>
        <span class="stat-label">Total Queued</span>
      </div>
    </div>
  `;
}

/**
 * Escape HTML entities for safe rendering.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Escape a string for use in HTML attributes.
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

/**
 * Send an agent control action (start/stop/restart).
 * @param {string} name
 * @param {string} action
 */
async function agentAction(name, action) {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error(`Action ${action} failed:`, data);
    }
  } catch (err) {
    console.error(`Action ${action} error:`, err);
  }
}

/**
 * Set the connection status indicator.
 * @param {boolean} connected
 */
function setConnectionStatus(connected) {
  const dot = document.getElementById("connection-dot");
  if (!dot) return;

  if (connected) {
    dot.classList.remove("disconnected");
    dot.classList.add("connected");
  } else {
    dot.classList.remove("connected");
    dot.classList.add("disconnected");
  }
}

/**
 * Connect to the SSE endpoint.
 */
function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource("/api/events");

  eventSource.addEventListener("agent-status", (event) => {
    try {
      const state = JSON.parse(event.data);
      renderAgentCards(state.agents);
    } catch (err) {
      console.error("Failed to parse agent-status event:", err);
    }
  });

  eventSource.addEventListener("schedules", (event) => {
    try {
      renderSchedulesPanel(JSON.parse(event.data));
    } catch (err) {
      console.error("Failed to parse schedules event:", err);
    }
  });

  eventSource.addEventListener("health", (event) => {
    try {
      renderHealthPanel(JSON.parse(event.data));
    } catch (err) {
      console.error("Failed to parse health event:", err);
    }
  });

  eventSource.addEventListener("delivery-queue", (event) => {
    try {
      renderDeliveryPanel(JSON.parse(event.data));
    } catch (err) {
      console.error("Failed to parse delivery-queue event:", err);
    }
  });

  eventSource.addEventListener("memory-stats", (event) => {
    try {
      renderMemoryPanel(JSON.parse(event.data));
    } catch (err) {
      console.error("Failed to parse memory-stats event:", err);
    }
  });

  eventSource.addEventListener("error", (event) => {
    if (event.data) {
      try {
        const data = JSON.parse(event.data);
        console.warn("SSE error event:", data.message);
      } catch {
        // Not a JSON error event, just a connection error
      }
    }
    setConnectionStatus(false);
  });

  eventSource.addEventListener("open", () => {
    setConnectionStatus(true);
  });

  eventSource.onerror = () => {
    setConnectionStatus(false);
  };
}

/**
 * Initial load: fetch status and start SSE.
 */
async function init() {
  // Fetch initial status
  try {
    const res = await fetch("/api/status");
    if (res.ok) {
      const state = await res.json();
      renderAgentCards(state.agents);
      setConnectionStatus(true);
    }
  } catch {
    setConnectionStatus(false);
  }

  // Start SSE
  connectSSE();
}

// ─── Add Agent Modal ───

function openAddAgentModal() {
  const modal = document.getElementById("add-agent-modal");
  modal.style.display = "flex";
  document.getElementById("aa-name").value = "";
  document.getElementById("aa-channel").value = "";
  document.getElementById("aa-model").value = "sonnet";
  document.getElementById("aa-soul").value = "";
  document.getElementById("aa-result").style.display = "none";
}

function closeAddAgentModal() {
  document.getElementById("add-agent-modal").style.display = "none";
}

document.getElementById("add-agent-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const result = document.getElementById("aa-result");
  const name = document.getElementById("aa-name").value.trim();
  const channelId = document.getElementById("aa-channel").value.trim();
  const model = document.getElementById("aa-model").value;
  const soul = document.getElementById("aa-soul").value.trim();

  if (!name) { result.textContent = "Name is required."; result.style.color = "var(--status-error)"; result.style.display = "block"; return; }

  try {
    const res = await fetch("/api/agents/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, channelId, model, soul }),
    });
    const data = await res.json();
    if (data.ok) {
      result.textContent = data.message || "Agent created! Restart daemon to activate.";
      result.style.color = "var(--status-running)";
      result.style.display = "block";
      setTimeout(closeAddAgentModal, 2000);
    } else {
      result.textContent = data.error || "Failed to create agent.";
      result.style.color = "var(--status-error)";
      result.style.display = "block";
    }
  } catch (err) {
    result.textContent = "Request failed: " + err.message;
    result.style.color = "var(--status-error)";
    result.style.display = "block";
  }
});

// ─── Message History Modal ───

/** @type {string} */
let currentMsgAgent = "";

async function openMsgModal(agentName) {
  currentMsgAgent = agentName;
  const modal = document.getElementById("msg-modal");
  modal.style.display = "flex";
  document.getElementById("msg-title").textContent = `${agentName} — Messages`;
  document.getElementById("msg-body").innerHTML = '<div class="panel-placeholder">Loading...</div>';

  await loadMessages(agentName);
}

function closeMsgModal() {
  document.getElementById("msg-modal").style.display = "none";
}

async function loadMessages(agentName, date) {
  const url = date
    ? `/api/messages/${encodeURIComponent(agentName)}?date=${date}`
    : `/api/messages/${encodeURIComponent(agentName)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    // Populate date selector
    const dateSelect = document.getElementById("msg-date");
    dateSelect.innerHTML = (data.dates || []).map(d =>
      `<option value="${d}" ${d === data.currentDate ? "selected" : ""}>${d}</option>`
    ).join("");
    dateSelect.onchange = () => loadMessages(agentName, dateSelect.value);

    // Render messages
    const body = document.getElementById("msg-body");
    const messages = data.messages || [];

    if (messages.length === 0) {
      body.innerHTML = '<div class="panel-placeholder">No messages for this date</div>';
      return;
    }

    body.innerHTML = messages.map(m => {
      const isUser = m.role === "user";
      const align = isUser ? "flex-end" : "flex-start";
      const bg = isUser ? "rgba(0, 229, 255, 0.08)" : "rgba(255, 51, 102, 0.06)";
      const border = isUser ? "rgba(0, 229, 255, 0.2)" : "rgba(255, 51, 102, 0.15)";
      const roleColor = isUser ? "var(--accent-secondary)" : "var(--accent-primary)";
      const truncated = m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content;

      return `<div style="align-self:${align}; max-width:85%; background:${bg}; border:1px solid ${border}; border-radius:8px; padding:10px 14px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
          <span style="font-family:'JetBrains Mono',monospace; font-size:0.68rem; color:${roleColor}; font-weight:600; text-transform:uppercase;">${escapeHtml(m.role)}</span>
          <span style="font-family:'JetBrains Mono',monospace; font-size:0.65rem; color:var(--text-secondary);">${escapeHtml(m.time)}</span>
        </div>
        <div style="font-family:'IBM Plex Sans',sans-serif; font-size:0.8rem; color:var(--text-primary); line-height:1.5; white-space:pre-wrap; word-break:break-word;">${escapeHtml(truncated)}</div>
      </div>`;
    }).join("");

    // Scroll to bottom
    body.scrollTop = body.scrollHeight;
  } catch (err) {
    document.getElementById("msg-body").innerHTML =
      `<div class="panel-placeholder">Error: ${escapeHtml(err.message)}</div>`;
  }
}

document.addEventListener("DOMContentLoaded", init);
