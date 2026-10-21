/**
 * Dashboard HTTP server using Node.js built-in http module.
 * Serves static files, SSE endpoint, and REST API for agent control.
 * No external HTTP framework dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { sendIpcRequest } from "../ipc/client.js";
import { SseManager } from "./sse.js";
import { PreviewStore, renderPreviewDocument } from "./preview-store.js";
import { isAdminAuthorized, isGatedRequest } from "./auth.js";
import { readPluginMarketplaces } from "./plugin-marketplace.js";
import {
  installPlugin,
  uninstallPlugin,
  addMarketplace,
  removeMarketplace,
} from "./plugin-cli.js";
import type { DashboardServerConfig } from "./types.js";

// Runtime lives in dist/cli/ after bundling; static assets are copied to
// dist/dashboard/static by the build script.
const STATIC_DIR = join(import.meta.dirname, "..", "dashboard", "static");

// Phase 116 — Vite-built React SPA root. Output ships to dist/dashboard/spa/
// via `npm run build:spa` (vite.config.ts → build.outDir). Served at
// `/dashboard/v2/*` so the v1 dashboard at `/` stays byte-identical while
// the rewrite incrementally lands.
const STATIC_SPA_DIR = join(import.meta.dirname, "..", "dashboard", "spa");

// An agent's trace store is torn down when it stops/idles, so the daemon throws
// e.g. "Trace store not found for agent '…' (agent may not be running)". For the
// per-agent telemetry routes that is an EXPECTED empty state, not a server
// error — callers should render "no data", not an error panel + a console 500.
function isAgentAbsentError(message: string): boolean {
  // Match ONLY the daemon's trace-store-absent messages (e.g. "Trace store not
  // found for agent '…' (agent may not be running)") — not a broad "not found"
  // that could mask unrelated failures (skill/file/config not found).
  const m = message.toLowerCase();
  return (
    m.includes("trace store not found") ||
    m.includes("trace collector not found") ||
    m.includes("agent may not be running")
  );
}

const DEFAULT_POLL_INTERVAL_MS = 3000;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  // Phase 116 — SPA asset MIME extensions. Self-hosted WOFF2 fonts (Cabinet
  // Grotesk / Geist / JetBrains Mono) land under /dashboard/v2/fonts/ in T06;
  // PNGs ship from public/ via vite's asset pipeline; .map files are
  // sourcemaps that Vite emits when build.sourcemap is on (off in v1).
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Phase 116 — infer the MIME type for a SPA static file from its extension.
 * Falls back to application/octet-stream when the extension is unknown
 * (defensive — Vite only emits the extensions in MIME_TYPES above).
 */
function inferMimeType(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 0) return "application/octet-stream";
  const ext = filename.slice(dotIndex).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Phase 116 — serve a SPA asset from dist/dashboard/spa.
 *
 * Reads the file as a Buffer (binary-safe — WOFF2 / PNG / sourcemaps would
 * corrupt if read as utf-8). 404s on missing files rather than falling
 * through to the SPA index — Vite-built asset paths are content-hashed and
 * a 404 here means the build is out of sync with the page, which the
 * operator should see, not paper over.
 */
async function serveSpaAsset(
  res: ServerResponse,
  relativePath: string,
  contentType: string,
): Promise<void> {
  // 999.136 — defence in depth: `join` does not normalise away `..`, so a
  // traversal segment would escape the SPA root and could read arbitrary files
  // (e.g. the link-signing secret) for ANY caller, not only forwarded ones.
  // Reject it here, one level below the public-edge allowlist.
  if (relativePath.includes("..")) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  try {
    const filePath = join(STATIC_SPA_DIR, relativePath);
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

/**
 * Parse URL pathname and extract route segments.
 */
function parseRoute(url: string | undefined): { pathname: string; segments: readonly string[] } {
  const pathname = (url ?? "/").split("?")[0] ?? "/";
  const segments = pathname.split("/").filter(Boolean);
  return { pathname, segments };
}

/**
 * Send a JSON response.
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Read a JSON-encoded request body. Phase 116-03 added the first non-empty
 * POST/PUT routes to the dashboard (F26 config edits + F28 task creation /
 * transitions). 1 MiB cap is generous for any agent-config partial; an
 * over-cap stream throws so we surface 413 → 400 to the operator instead of
 * accumulating an attacker-controlled allocation.
 */
const MAX_BODY_BYTES = 1024 * 1024;
async function readJsonBody(
  req: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    throw new Error("Empty request body");
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid JSON";
    throw new Error(`Invalid JSON body: ${msg}`);
  }
}

/**
 * Serve a static file from the static directory.
 */
async function serveStatic(
  res: ServerResponse,
  filename: string,
  contentType: string,
): Promise<void> {
  try {
    const filePath = join(STATIC_DIR, filename);
    const content = await readFile(filePath, "utf-8");
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(content),
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

/**
 * Start the dashboard HTTP server.
 *
 * @returns Object with server, sseManager, and close function
 */
export async function startDashboardServer(config: DashboardServerConfig): Promise<{
  readonly server: ReturnType<typeof createServer>;
  readonly sseManager: SseManager;
  readonly close: () => Promise<void>;
}> {
  const log = pino({ name: "dashboard", level: "info" });
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const sseManager = new SseManager({
    socketPath: config.socketPath,
    pollIntervalMs,
    log,
  });

  const server = createServer((req, res) => {
    void handleRequest(
      req,
      res,
      sseManager,
      config.socketPath,
      log,
      config.webhookHandler,
      config.cutoverRedirectEnabled,
      config.auditTrail,
      config.previewStore,
    );
  });

  sseManager.start();

  const host = config.host ?? "127.0.0.1";
  const listen = (srv: ReturnType<typeof createServer>, port: number, bindHost: string) =>
    new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, bindHost, () => resolve());
    });

  await listen(server, config.port, host);
  log.info({ port: config.port, host }, "Dashboard server started");

  return {
    server,
    sseManager,
    close: async () => {
      sseManager.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * Route incoming HTTP requests.
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sseManager: SseManager,
  socketPath: string,
  log: Logger,
  webhookHandler?: DashboardServerConfig["webhookHandler"],
  cutoverRedirectEnabled?: DashboardServerConfig["cutoverRedirectEnabled"],
  dashboardAuditTrail?: DashboardServerConfig["auditTrail"],
  previewStore?: DashboardServerConfig["previewStore"],
): Promise<void> {
  const method = req.method ?? "GET";
  const { pathname, segments } = parseRoute(req.url);

  try {
    // dashboard-rework P4 — admin auth gate. When CLAWCODE_DASHBOARD_TOKEN is
    // set, gated requests (mutations + the OpenAI key surface) require the token
    // (Authorization: Bearer <token> / X-Clawcode-Token). Fail-OPEN when unset
    // so existing loopback installs are unchanged. Single chokepoint, evaluated
    // before any route so no sensitive handler can be reached unauthenticated.
    if (isGatedRequest(method, pathname) && !isAdminAuthorized(req)) {
      sendJson(res, 401, {
        error: "Admin token required for this action.",
        authRequired: true,
      });
      return;
    }

    // -----------------------------------------------------------------
    // Phase 116 — /dashboard/v2 SPA routes (Vite-built React shell).
    //
    // Three patterns to handle:
    //   1. /dashboard/v2  or  /dashboard/v2/        → serve index.html
    //   2. /dashboard/v2/assets/<filename>          → serve from spa/assets/
    //   3. /dashboard/v2/<other-static-path>        → serve from spa/ (fonts,
    //                                                  favicon, sub-public)
    //
    // These MUST be evaluated before the v1 `/` route so /dashboard/v2/ does
    // not accidentally fall through. They are ALSO evaluated before /api/*
    // so a future /api/v2/* namespace cannot collide with the SPA root.
    //
    // Old /  /index.html / /app.js / /styles.css / /graph / /tasks routes
    // below are UNCHANGED — operator can still hit the v1 dashboard
    // byte-identical to the pre-Phase-116 deploy while v2 lands.
    // -----------------------------------------------------------------
    // dashboard-rework (decision 4) — the SPA now serves at the ROOT '/'.
    // Legacy '/dashboard/v2' + '/dashboard/v2/*' deep-links 301-redirect to the
    // stripped root path so old bookmarks keep working. Root SPA serving
    // (index.html, /assets/*, /fonts/*, favicon, and the client-route fallback)
    // is handled by the SPA root fallback at the END of this handler — AFTER
    // every /api route — so it can never shadow the API surface.
    if (
      method === "GET" &&
      (pathname === "/dashboard/v2" || pathname.startsWith("/dashboard/v2/"))
    ) {
      const stripped = pathname.slice("/dashboard/v2".length) || "/";
      const queryString = (req.url ?? "").split("?")[1];
      const location = queryString ? `${stripped}?${queryString}` : stripped;
      res.writeHead(301, { Location: location });
      res.end();
      return;
    }

    // dashboard-rework (decision 4) — the legacy v1 dashboard is RETIRED.
    // The former v1 routes ('/', '/index.html', '/styles.css', '/app.js',
    // '/graph-color.js', '/graph', '/tasks') were removed: '/', '/graph', and
    // '/tasks' are now SPA client routes served by the root fallback at the end
    // of this handler; the orphaned v1 asset files are no longer referenced.
    // `cutoverRedirectEnabled` is consequently no longer consulted (the SPA is
    // unconditionally the root). The dist/dashboard/static tree can be dropped
    // in a later cleanup.

    // Message history: GET /api/messages/:agent?date=YYYY-MM-DD
    if (
      method === "GET" &&
      segments.length === 3 &&
      segments[0] === "api" &&
      segments[1] === "messages"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const queryParams = new URLSearchParams(queryString);
      const date = queryParams.get("date") ?? undefined;
      try {
        const data = await sendIpcRequest(socketPath, "message-history", { agent: agentName, date });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message, messages: [], dates: [] });
      }
      return;
    }

    // Latency percentiles: GET /api/agents/:name/latency?since=24h
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "latency"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const queryParams = new URLSearchParams(queryString);
      const since = queryParams.get("since") ?? "24h";
      try {
        const data = await sendIpcRequest(socketPath, "latency", {
          agent: agentName,
          since,
        });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (isAgentAbsentError(message)) {
          sendJson(res, 200, { unavailable: true });
          return;
        }
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // Prompt cache hit-rate: GET /api/agents/:name/cache?since=24h
    // Phase 52 Plan 03: proxies to the daemon's `cache` IPC method which
    // returns the augmented CacheTelemetryReport (report + status +
    // cache_effect_ms). The dashboard renders a per-agent Prompt Cache
    // panel adjacent to the Latency panel from this payload.
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "cache"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const queryParams = new URLSearchParams(queryString);
      const since = queryParams.get("since") ?? "24h";
      try {
        const data = await sendIpcRequest(socketPath, "cache", {
          agent: agentName,
          since,
        });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (isAgentAbsentError(message)) {
          sendJson(res, 200, { unavailable: true });
          return;
        }
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // Tool-call latency: GET /api/agents/:name/tools?since=24h
    // Phase 55 Plan 03: proxies to the daemon's `tools` IPC method which
    // returns a ToolsReport with augmented ToolPercentileRow[] (each row
    // carries slo_status + slo_threshold_ms + slo_metric). The dashboard
    // renders a per-agent Tool Call Latency panel adjacent to the Prompt
    // Cache panel from this payload.
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "tools"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const queryParams = new URLSearchParams(queryString);
      const since = queryParams.get("since") ?? "24h";
      try {
        const data = await sendIpcRequest(socketPath, "tools", {
          agent: agentName,
          since,
        });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (isAgentAbsentError(message)) {
          sendJson(res, 200, { unavailable: true });
          return;
        }
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // Phase 115 Plan 08 T03 — tool-latency audit: GET /api/tool-latency-audit?windowHours=24[&agent=name]
    // Surfaces sub-scope 17(a/b/c) split-latency + 6-A tool_use_rate + 6-B
    // gate decision for the dashboard panel rendered alongside the Cache /
    // Tools panels. Mirrors the CLI subcommand (src/cli/commands/tool-latency-audit.ts).
    if (
      method === "GET" &&
      pathname === "/api/tool-latency-audit"
    ) {
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const queryParams = new URLSearchParams(queryString);
      const windowHours = parseInt(queryParams.get("windowHours") ?? "24", 10);
      const agent = queryParams.get("agent") ?? undefined;
      const params: Record<string, unknown> = {
        windowHours: Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24,
      };
      if (agent) params.agent = agent;
      try {
        const data = await sendIpcRequest(socketPath, "tool-latency-audit", params);
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // Knowledge graph data: GET /api/graph/:agent
    if (
      method === "GET" &&
      segments.length === 3 &&
      segments[0] === "api" &&
      segments[1] === "graph"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      try {
        const data = await sendIpcRequest(socketPath, "memory-graph", { agent: agentName });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message, nodes: [], links: [] });
      }
      return;
    }

    // SSE endpoint
    if (method === "GET" && pathname === "/api/events") {
      sseManager.addClient(res);
      return;
    }

    // === 999.95 live-preview routes ===
    // Proxied + cookie-gated by the clawdy-activity Embedded App (it forwards
    // /preview* to this server). Read-only here — pushes arrive over IPC only
    // (the `show-preview` daemon handler calls previewStore.set()), never HTTP.
    // Ordering: /preview/current before the generic /preview/:id ("current" is
    // excluded from valid ids by the regex, but explicit ordering avoids a 404).

    // GET /preview/current → { id: string | null } (Activity self-resolves the
    // most-recent fresh preview on launch — see PreviewStore.currentId()).
    if (method === "GET" && pathname === "/preview/current") {
      if (!previewStore) {
        sendJson(res, 503, { error: "preview store unavailable" });
        return;
      }
      // 999.95-fu3 — scope to the asking channel. The Activity client already
      // sends `?channel=<discordSdk.channelId>` (it has since the Unraid build
      // that is live today) and simply fell back to the unscoped call because
      // this route ignored the param. Unscoped now resolves to null rather
      // than the global most-recent, so that fallback cannot re-open the
      // cross-channel leak.
      const channel = new URL(
        req.url ?? "/",
        "http://localhost",
      ).searchParams.get("channel");
      sendJson(res, 200, { id: previewStore.currentId(channel) });
      return;
    }

    // GET /preview/:id/events → per-id SSE stream (fires `reload` on change).
    if (
      method === "GET" &&
      segments.length === 3 &&
      segments[0] === "preview" &&
      segments[2] === "events"
    ) {
      const id = decodeURIComponent(segments[1]!);
      if (!previewStore) {
        sendJson(res, 503, { error: "preview store unavailable" });
        return;
      }
      if (!PreviewStore.isValidId(id)) {
        sendJson(res, 400, { error: "invalid preview id" });
        return;
      }
      previewStore.addListener(id, res); // owns the response lifecycle from here
      return;
    }

    // GET /preview/:id → stored content + injected live-reload client.
    if (method === "GET" && segments.length === 2 && segments[0] === "preview") {
      const id = decodeURIComponent(segments[1]!);
      if (!previewStore) {
        sendJson(res, 503, { error: "preview store unavailable" });
        return;
      }
      if (!PreviewStore.isValidId(id)) {
        sendJson(res, 400, { error: "invalid preview id" });
        return;
      }
      const entry = previewStore.get(id);
      if (entry === null) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Preview not found");
        return;
      }
      const body = renderPreviewDocument(entry, id);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store", // always re-fetch on reload
      });
      res.end(body);
      return;
    }
    // === end 999.95 live-preview routes ===

    // One-shot status endpoint
    if (method === "GET" && pathname === "/api/status") {
      try {
        const state = await sseManager.fetchCurrentState();
        sendJson(res, 200, state);
      } catch {
        sendJson(res, 503, { error: "Daemon not reachable" });
      }
      return;
    }

    // One-shot schedules endpoint
    if (method === "GET" && pathname === "/api/schedules") {
      try {
        const data = await sseManager.fetchSchedules();
        sendJson(res, 200, data);
      } catch {
        sendJson(res, 503, { error: "Daemon not reachable" });
      }
      return;
    }

    // Phase 109-D — fleet-wide observability snapshot. Cgroup memory pressure,
    // claude proc drift, per-MCP-pattern RSS aggregate. Read-only; safe to
    // poll. Adjacent to /api/status (which keeps its byte-stable shape) so
    // existing dashboard JS keeps rendering unchanged.
    if (method === "GET" && pathname === "/api/fleet-stats") {
      try {
        const data = await sendIpcRequest(socketPath, "fleet-stats", {});
        sendJson(res, 200, data);
      } catch {
        sendJson(res, 503, { error: "Daemon not reachable" });
      }
      return;
    }

    // Phase 124 Plan 04 T-03 — heartbeat-status proxy for the dashboard.
    // Surfaces per-agent zone, fillPercentage, session_tokens, and
    // last_compaction_at. Read-only; safe to poll. The AgentTile's
    // tokens sparkline derives its time series from successive polls
    // via the `useHeartbeatStatus` hook + a component-side ring buffer.
    if (method === "GET" && pathname === "/api/heartbeat-status") {
      try {
        const data = await sendIpcRequest(socketPath, "heartbeat-status", {});
        sendJson(res, 200, data);
      } catch {
        sendJson(res, 503, { error: "Daemon not reachable" });
      }
      return;
    }

    // One-shot health endpoint
    if (method === "GET" && pathname === "/api/health") {
      try {
        const data = await sseManager.fetchHealth();
        sendJson(res, 200, data);
      } catch {
        sendJson(res, 503, { error: "Daemon not reachable" });
      }
      return;
    }

    // One-shot costs endpoint
    if (method === "GET" && pathname === "/api/costs") {
      try {
        const queryString = (req.url ?? "").split("?")[1] ?? "";
        const params = new URLSearchParams(queryString);
        const period = params.get("period") ?? "today";
        const data = await sendIpcRequest(socketPath, "costs", { period });
        sendJson(res, 200, data);
      } catch {
        sendJson(res, 503, { error: "Daemon not reachable" });
      }
      return;
    }

    // One-shot delivery queue endpoint
    if (method === "GET" && pathname === "/api/delivery-queue") {
      try {
        const data = await sseManager.fetchDeliveryQueue();
        sendJson(res, 200, data);
      } catch {
        sendJson(res, 503, { error: "Daemon not reachable" });
      }
      return;
    }

    // One-shot task graph endpoint (Phase 63 OBS-03)
    if (method === "GET" && pathname === "/api/tasks") {
      try {
        const data = await sendIpcRequest(socketPath, "list-tasks", {});
        sendJson(res, 200, data);
      } catch {
        sendJson(res, 503, { error: "Daemon not reachable" });
      }
      return;
    }

    // Agent control: POST /api/agents/:name/:action
    // Phase 116-postdeploy 2026-05-12: this used to 400 on ANY action not in
    // {start, stop, restart}, which made it a catch-all gate that intercepted
    // every downstream agent-scoped POST route (dream-run, dream-veto,
    // memory/consolidate, etc.) before they got a chance to match. Fix:
    // only ENGAGE this handler for the three known agent-control actions;
    // for anything else, fall through to the more specific handlers below.
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      (segments[3] === "start" ||
        segments[3] === "stop" ||
        segments[3] === "restart")
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const action = segments[3];

      try {
        await sendIpcRequest(socketPath, action, { name: agentName });
        // 116-06 T04: audit log the operator action AFTER it succeeded.
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: `agent-${action}`,
            target: agentName,
          });
        }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err, agentName, action }, "Agent control failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // dashboard-rework P2 — operator-fired agent optimizer. Phase 142 shipped
    // the `run-agent-optimization` IPC (Discord/CLI only); this is its first
    // REST/dashboard surface. POST /api/agents/:name/optimize → returns the run
    // summary (status/outcome/baseline+candidate score/stagedDraftCount/...).
    // The optimizer never auto-applies — improvements are staged for review.
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "optimize"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      try {
        const data = await sendIpcRequest(socketPath, "run-agent-optimization", {
          agent: agentName,
        });
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "agent-optimize",
            target: agentName,
          });
        }
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err, agentName }, "Agent optimize failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // dashboard-rework P4 — create a new agent. POST /api/agents
    // { name, soul, model?, parentChannelId } → IPC `agent-create` (provisions a
    // Discord channel under parentChannelId's category + scaffolds the workspace).
    // The dashboard is already admin-token-gated (the auth chokepoint above), so
    // we satisfy the IPC's Discord-admin check by supplying the daemon's first
    // configured admin id as invokerUserId — the dashboard token IS the
    // authorization here. Provisions real Discord state; there is no dry-run.
    if (
      method === "POST" &&
      segments.length === 2 &&
      segments[0] === "api" &&
      segments[1] === "agents"
    ) {
      try {
        const body = (await readJsonBody(req)) as {
          name?: unknown;
          soul?: unknown;
          model?: unknown;
          parentChannelId?: unknown;
        };
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const soul = typeof body.soul === "string" ? body.soul.trim() : "";
        const parentChannelId =
          typeof body.parentChannelId === "string" ? body.parentChannelId.trim() : "";
        const model =
          typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;
        if (!name || !soul || !parentChannelId) {
          sendJson(res, 400, {
            error: "name, soul, and parentChannelId are required",
          });
          return;
        }
        // Server-side validation — never trust the client form. Mirrors the
        // daemon's own name rule + bounds the free-text fields.
        if (!/^[a-z][a-z0-9-]{1,31}$/.test(name)) {
          sendJson(res, 400, {
            error: "Agent name must be 2–32 chars: lowercase letter first, then letters/digits/hyphens.",
          });
          return;
        }
        if (soul.length > 8000) {
          sendJson(res, 400, { error: "Soul exceeds the 8000-character maximum." });
          return;
        }
        if (model !== undefined && !["sonnet", "opus", "haiku"].includes(model)) {
          sendJson(res, 400, { error: `Unknown model '${model}'.` });
          return;
        }
        const adminId = (process.env.CLAWCODE_ADMIN_DISCORD_USER_IDS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)[0];
        if (!adminId) {
          sendJson(res, 400, {
            error:
              "Agent creation requires CLAWCODE_ADMIN_DISCORD_USER_IDS to be configured on the daemon.",
          });
          return;
        }
        const data = await sendIpcRequest(socketPath, "agent-create", {
          name,
          soul,
          model,
          parentChannelId,
          invokerUserId: adminId,
        });
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({ action: "agent-create", target: name });
        }
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err }, "Agent create failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // dashboard-rework P3 — marketplace (skills). Browse the per-agent catalog
    // (available = catalog − installed), install, remove. Install runs the
    // daemon's secret-scan + scope-tag gates; refusals come back as outcomes.
    //   GET  /api/marketplace?agent=<name>   → marketplace-list
    //   POST /api/marketplace/install        { agent, skill, force? }
    //   POST /api/marketplace/remove         { agent, skill }
    if (
      method === "GET" &&
      segments.length === 2 &&
      segments[0] === "api" &&
      segments[1] === "marketplace"
    ) {
      const agentName =
        new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("agent") ?? "";
      if (!agentName) {
        sendJson(res, 400, { error: "agent query param required" });
        return;
      }
      try {
        const data = await sendIpcRequest(socketPath, "marketplace-list", {
          agent: agentName,
        });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message });
      }
      return;
    }
    if (
      method === "POST" &&
      segments.length === 3 &&
      segments[0] === "api" &&
      segments[1] === "marketplace" &&
      (segments[2] === "install" || segments[2] === "remove")
    ) {
      const action = segments[2];
      try {
        const body = (await readJsonBody(req)) as {
          agent?: unknown;
          skill?: unknown;
          force?: unknown;
        };
        const agent = typeof body.agent === "string" ? body.agent.trim() : "";
        const skill = typeof body.skill === "string" ? body.skill.trim() : "";
        if (!agent || !skill) {
          sendJson(res, 400, { error: "agent and skill are required" });
          return;
        }
        const ipc = action === "install" ? "marketplace-install" : "marketplace-remove";
        const data = await sendIpcRequest(socketPath, ipc, {
          agent,
          skill,
          force: body.force === true,
        });
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: `marketplace-${action}`,
            target: `${agent}/${skill}`,
          });
        }
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err, action }, "Marketplace action failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // dashboard-rework — native Claude Code plugin marketplace BROWSE (the real
    // Anthropic-verified marketplaces). Read-only: reads the daemon user's
    // ~/.claude/plugins state. GET /api/plugins/marketplaces.
    if (
      method === "GET" &&
      segments.length === 3 &&
      segments[0] === "api" &&
      segments[1] === "plugins" &&
      segments[2] === "marketplaces"
    ) {
      try {
        sendJson(res, 200, readPluginMarketplaces());
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // Plugin install/uninstall (admin-gated by the chokepoint). Shells the
    // `claude plugin` CLI (validated args). POST /api/plugins/{install,uninstall}
    // { ref:"<plugin>@<marketplace>" }.
    if (
      method === "POST" &&
      segments.length === 3 &&
      segments[0] === "api" &&
      segments[1] === "plugins" &&
      (segments[2] === "install" || segments[2] === "uninstall")
    ) {
      const action = segments[2];
      try {
        const body = (await readJsonBody(req)) as { ref?: unknown };
        const ref = typeof body.ref === "string" ? body.ref.trim() : "";
        if (!ref) {
          sendJson(res, 400, { error: "ref (<plugin>@<marketplace>) is required" });
          return;
        }
        const result =
          action === "install" ? await installPlugin(ref) : await uninstallPlugin(ref);
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({ action: `plugin-${action}`, target: ref });
        }
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err, action }, "Plugin action failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // Marketplace add/remove (admin-gated). POST /api/plugins/marketplace/{add,remove}
    // add { source:"owner/repo"|https-url } · remove { name }.
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "plugins" &&
      segments[2] === "marketplace" &&
      (segments[3] === "add" || segments[3] === "remove")
    ) {
      const action = segments[3];
      try {
        const body = (await readJsonBody(req)) as { source?: unknown; name?: unknown };
        let result;
        let target: string;
        if (action === "add") {
          const source = typeof body.source === "string" ? body.source.trim() : "";
          if (!source) {
            sendJson(res, 400, { error: "source (owner/repo or https url) is required" });
            return;
          }
          target = source;
          result = await addMarketplace(source);
        } else {
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name) {
            sendJson(res, 400, { error: "name is required" });
            return;
          }
          target = name;
          result = await removeMarketplace(name);
        }
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({ action: `marketplace-${action}`, target });
        }
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err, action }, "Marketplace action failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // =====================================================================
    // Phase 116-02 routes — keep grouped to minimize 116-03 merge surface.
    //
    // F09 — embedding migration tracker:
    //   GET  /api/migrations            -> proxies daemon `embedding-migration-status` (no agent filter)
    //   POST /api/migrations/:agent/pause     -> daemon `embedding-migration-pause`
    //   POST /api/migrations/:agent/resume    -> daemon `embedding-migration-resume`
    //   POST /api/migrations/:agent/rollback  -> daemon `embedding-migration-transition` with toPhase=rolled-back
    //
    // F10 — MCP server health panel:
    //   GET  /api/mcp-servers                          -> proxies daemon `mcp-servers` (config-derived list w/ healthy=null)
    //   GET  /api/mcp-servers/:agent                   -> proxies daemon `list-mcp-status` (live runtime status + capability probe)
    //   POST /api/mcp-servers/:agent/:server/reconnect -> proxies daemon `mcp-probe` (re-runs readiness handshake + capability probe)
    //
    // The migration `list-migrations` IPC method name in the plan doesn't exist;
    // daemon ships `embedding-migration-status` which returns the same shape.
    // Aliased at the REST layer rather than adding a duplicate handler.
    //
    // Reconnect maps to `mcp-probe` because the daemon has no operator-fired
    // reconnect IPC — the heartbeat does reconnects internally; `mcp-probe`
    // re-runs the readiness handshake which is the equivalent of "kick this
    // server now". Status flips through degraded → ready as a side effect.
    // =====================================================================

    // GET /api/migrations  (fleet-wide migration phase snapshot)
    if (method === "GET" && pathname === "/api/migrations") {
      try {
        const data = await sendIpcRequest(
          socketPath,
          "embedding-migration-status",
          {},
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // POST /api/migrations/:agent/{pause,resume,rollback,transition}
    //
    // 116-postdeploy 2026-05-12 — `transition` action added so operators can
    // advance the state machine phase-by-phase from the dashboard Memory page
    // (eight agents stranded at dual-write since 2026-05-08). Body shape:
    //   { toPhase: "dual-write" | "re-embedding" | "re-embed-complete" |
    //              "cutover" | "v1-dropped" | "rolled-back" }
    // Daemon's `embedding-migration-transition` IPC is the same handler
    // already used for the rollback action — it validates legality via
    // LEGAL_TRANSITIONS in src/memory/migrations/embedding-v2.ts. Illegal
    // transitions surface as 500 with the daemon's error message.
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "migrations"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const action = segments[3];
      let ipcMethod: string | null = null;
      let ipcParams: Record<string, unknown> = { agent: agentName };
      if (action === "pause") {
        ipcMethod = "embedding-migration-pause";
      } else if (action === "resume") {
        ipcMethod = "embedding-migration-resume";
      } else if (action === "rollback") {
        // Rollback is a legal transition from every phase except v1-dropped
        // (see src/memory/migrations/embedding-v2.ts LEGAL_TRANSITIONS).
        ipcMethod = "embedding-migration-transition";
        ipcParams = { agent: agentName, toPhase: "rolled-back" };
      } else if (action === "transition") {
        // Operator-fired phase advance. Body MUST include `toPhase`.
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof Error ? err.message : "invalid body",
          });
          return;
        }
        const toPhase = (body as { toPhase?: unknown })?.toPhase;
        if (typeof toPhase !== "string" || toPhase.length === 0) {
          sendJson(res, 400, {
            error: "Missing required body field: toPhase (string)",
          });
          return;
        }
        ipcMethod = "embedding-migration-transition";
        ipcParams = { agent: agentName, toPhase };
      } else {
        sendJson(res, 400, {
          error: `Unknown migration action: ${action} (expected pause|resume|rollback|transition)`,
        });
        return;
      }
      try {
        const result = await sendIpcRequest(socketPath, ipcMethod, ipcParams);
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: `migration-${action}`,
            target: agentName,
            ...(action === "transition"
              ? {
                  metadata: {
                    toPhase: (ipcParams as { toPhase?: string }).toPhase,
                  },
                }
              : {}),
          });
        }
        sendJson(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err, agentName, action }, "Migration action failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // GET /api/mcp-servers  (config-derived list across all agents; healthy=null)
    if (method === "GET" && pathname === "/api/mcp-servers") {
      try {
        const data = await sendIpcRequest(socketPath, "mcp-servers", {});
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // GET /api/mcp-servers/:agent  (live runtime status from McpServerState)
    if (
      method === "GET" &&
      segments.length === 3 &&
      segments[0] === "api" &&
      segments[1] === "mcp-servers"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      try {
        const data = await sendIpcRequest(socketPath, "list-mcp-status", {
          agent: agentName,
        });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // POST /api/mcp-servers/:agent/:server/reconnect
    if (
      method === "POST" &&
      segments.length === 5 &&
      segments[0] === "api" &&
      segments[1] === "mcp-servers" &&
      segments[4] === "reconnect"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      // Server name retained in URL for parity with future per-server retry
      // IPC. Today daemon `mcp-probe` re-runs the readiness handshake for ALL
      // servers of the agent; per-server kick lands when daemon ships it.
      try {
        const data = await sendIpcRequest(socketPath, "mcp-probe", {
          agent: agentName,
        });
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "mcp-reconnect",
            target: agentName,
          });
        }
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err, agentName }, "MCP reconnect (mcp-probe) failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }
    // === end Phase 116-02 routes ===

    // =====================================================================
    // Phase 116-03 routes — Tier 1.5 operator workflow (F26/F27/F28).
    // Grouped contiguously after 116-02 so sibling plans can append their
    // own block without touching this diff. All routes proxy daemon IPC
    // methods added in the closure-intercept block in daemon.ts (search for
    // "Phase 116-03 — Tier 1.5 operator workflow IPC handlers").
    //
    // F26 — agent config editor:
    //   GET  /api/config/agents/:name           -> daemon `get-agent-config`
    //   PUT  /api/config/agents/:name           -> daemon `update-agent-config`
    //   POST /api/config/hot-reload             -> daemon `hot-reload-now`
    //
    // F27 — conversations view:
    //   GET  /api/conversations/search          -> daemon `search-conversations`
    //   GET  /api/conversations/:agent/recent   -> daemon `list-recent-conversations`
    //
    // F28 — Kanban task board:
    //   GET  /api/tasks/kanban                  -> daemon `list-tasks-kanban`
    //   POST /api/tasks                         -> daemon `create-task`
    //   POST /api/tasks/:id/transition          -> daemon `transition-task`
    // =====================================================================

    // F26 — GET /api/config/agents/:name
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "config" &&
      segments[2] === "agents"
    ) {
      const agentName = decodeURIComponent(segments[3]!);
      try {
        const data = await sendIpcRequest(socketPath, "get-agent-config", {
          agent: agentName,
        });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 404, { error: message });
      }
      return;
    }

    // F26 — PUT /api/config/agents/:name
    if (
      method === "PUT" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "config" &&
      segments[2] === "agents"
    ) {
      const agentName = decodeURIComponent(segments[3]!);
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : "bad request body";
        sendJson(res, 400, { error: message });
        return;
      }
      if (typeof body !== "object" || body === null) {
        sendJson(res, 400, { error: "Body must be a JSON object with `partial`" });
        return;
      }
      const partial = (body as { partial?: unknown }).partial;
      if (typeof partial !== "object" || partial === null) {
        sendJson(res, 400, {
          error: "Body must contain `partial` (object of agent-block fields)",
        });
        return;
      }
      try {
        const result = await sendIpcRequest(socketPath, "update-agent-config", {
          agent: agentName,
          partial,
        });
        if (dashboardAuditTrail) {
          // Carry the partial as metadata so the F23 viewer can render a
          // before/after-style row. Daemon already validated the partial
          // via zod before patching, so what we log is the schema-clean
          // shape that actually landed on disk.
          await dashboardAuditTrail.recordAction({
            action: "update-agent-config",
            target: agentName,
            metadata: { partial: partial as Record<string, unknown> },
          });
        }
        sendJson(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err, agentName }, "F26 update-agent-config failed");
        // Distinguish validation failures (Zod / missing) from server errors.
        // Daemon throws ManagerError with the validation reason; surface as 400
        // unless it's a transport failure (in which case 500 is fine).
        const status =
          message.includes("not found") || message.includes("Cannot patch")
            ? 400
            : 500;
        sendJson(res, status, { error: message });
      }
      return;
    }

    // F26 — POST /api/config/hot-reload  (no body; forces chokidar tick)
    if (method === "POST" && pathname === "/api/config/hot-reload") {
      try {
        const data = await sendIpcRequest(socketPath, "hot-reload-now", {});
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "hot-reload-now",
            target: null,
          });
        }
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err }, "F26 hot-reload-now failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // F27 — GET /api/conversations/search?q=&agent=&since=&limit=
    if (method === "GET" && pathname === "/api/conversations/search") {
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const queryParams = new URLSearchParams(queryString);
      const q = queryParams.get("q");
      if (!q || q.length === 0) {
        sendJson(res, 400, { error: "Missing required query param: q" });
        return;
      }
      const agent = queryParams.get("agent") ?? null;
      const limitRaw = queryParams.get("limit");
      const limit = limitRaw ? Math.min(Number(limitRaw) || 50, 200) : 50;
      const sinceMs = queryParams.get("since");
      try {
        const data = await sendIpcRequest(socketPath, "search-conversations", {
          q,
          agent,
          limit,
          sinceMs: sinceMs ? Number(sinceMs) : null,
        });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err, q, agent }, "F27 conversation search failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // F27 — GET /api/conversations/:agent/recent?limit=50
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "conversations" &&
      segments[3] === "recent"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const queryParams = new URLSearchParams(queryString);
      const limitRaw = queryParams.get("limit");
      const limit = limitRaw ? Math.min(Number(limitRaw) || 50, 200) : 50;
      try {
        const data = await sendIpcRequest(
          socketPath,
          "list-recent-conversations",
          { agent: agentName, limit },
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // F28 — GET /api/tasks/kanban
    if (method === "GET" && pathname === "/api/tasks/kanban") {
      try {
        const data = await sendIpcRequest(socketPath, "list-tasks-kanban", {});
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // F28 — POST /api/tasks  (create a new operator-authored task)
    if (method === "POST" && pathname === "/api/tasks") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : "bad request body";
        sendJson(res, 400, { error: message });
        return;
      }
      if (typeof body !== "object" || body === null) {
        sendJson(res, 400, { error: "Body must be a JSON object" });
        return;
      }
      try {
        const result = await sendIpcRequest(
          socketPath,
          "create-task",
          body as Record<string, unknown>,
        );
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "create-task",
            target:
              typeof (body as { target_agent?: unknown }).target_agent === "string"
                ? ((body as { target_agent: string }).target_agent)
                : null,
            metadata: body as Record<string, unknown>,
          });
        }
        sendJson(res, 201, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err }, "F28 create-task failed");
        sendJson(res, 400, { error: message });
      }
      return;
    }

    // F28 — POST /api/tasks/:id/transition
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "tasks" &&
      segments[3] === "transition"
    ) {
      const taskId = decodeURIComponent(segments[2]!);
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : "bad request body";
        sendJson(res, 400, { error: message });
        return;
      }
      if (typeof body !== "object" || body === null) {
        sendJson(res, 400, {
          error: "Body must include { status, patch? }",
        });
        return;
      }
      const status = (body as { status?: unknown }).status;
      if (typeof status !== "string") {
        sendJson(res, 400, { error: "Body.status is required (string)" });
        return;
      }
      const patch = (body as { patch?: unknown }).patch ?? {};
      try {
        const result = await sendIpcRequest(socketPath, "transition-task", {
          task_id: taskId,
          status,
          patch,
        });
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "transition-task",
            target: taskId,
            metadata: { status, patch: patch as Record<string, unknown> },
          });
        }
        sendJson(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err, taskId, status }, "F28 transition-task failed");
        // Illegal transition vs. not found vs. other → operator-actionable.
        const code =
          message.includes("not found") ||
          message.includes("Illegal") ||
          message.includes("transition")
            ? 400
            : 500;
        sendJson(res, code, { error: message });
      }
      return;
    }
    // === end Phase 116-03 routes ===

    // =====================================================================
    // Phase 116-04 routes — Tier 2 deep-dive (F11/F12/F13/F14/F15).
    // Same contiguous-block convention as 116-02 + 116-03 so 116-05 can
    // append its own fence without touching this diff. Every route proxies
    // a daemon IPC method registered in the "Phase 116-04" closure-
    // intercept block in src/manager/daemon.ts.
    //
    // F11 — per-agent detail drawer transcript:
    //   GET  /api/agents/:name/recent-turns       -> daemon `list-recent-turns`
    //
    // F12 — per-turn trace waterfall:
    //   GET  /api/agents/:name/traces/:turnId     -> daemon `get-turn-trace`
    //
    // F13 — cross-agent IPC inbox + fleet delivery snapshot:
    //   GET  /api/ipc/inboxes                     -> daemon `list-ipc-inboxes`
    //
    // F14 — memory subsystem (READ-ONLY in v1 per 116-DEFERRED):
    //   GET  /api/agents/:name/memory-snapshot    -> daemon `get-memory-snapshot`
    //
    // F15 — dream-pass queue + D-10 veto windows:
    //   GET  /api/agents/:name/dream-queue        -> daemon `get-dream-queue`
    //   POST /api/agents/:name/dream-veto/:runId  -> daemon `veto-dream-run`
    //                                                ({ reason: string } body)
    //
    // Naming note: F15 URL says `:runId` for parity with VetoStore.vetoRun()
    // (the canonical identifier in the store). The plan referred to this
    // as `:windowId` but it's the same value — see 116-04-SUMMARY.md.
    // =====================================================================

    // GET /api/agents/:name/recent-turns?limit=50&includeUntrusted=false&sessionId=…
    //
    // 116-postdeploy Bug 2 — when `sessionId` is supplied the result is
    // restricted to that one session's turns in chronological order (used
    // by the F27 conversations transcript pane). When absent the original
    // F11 drawer behaviour applies (recent N turns across all sessions,
    // reverse-chronological).
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "recent-turns"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const queryParams = new URLSearchParams(queryString);
      const limitParam = queryParams.get("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : 50;
      const includeUntrustedChannels =
        queryParams.get("includeUntrusted") === "true";
      const sessionIdParam = queryParams.get("sessionId");
      const ipcParams: Record<string, unknown> = {
        agent: agentName,
        limit: Number.isFinite(limit) ? limit : 50,
        includeUntrustedChannels,
      };
      if (sessionIdParam && sessionIdParam.length > 0) {
        ipcParams.sessionId = sessionIdParam;
      }
      try {
        const data = await sendIpcRequest(
          socketPath,
          "list-recent-turns",
          ipcParams,
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // GET /api/agents/:name/traces/:turnId
    if (
      method === "GET" &&
      segments.length === 5 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "traces"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const turnId = decodeURIComponent(segments[4]!);
      try {
        const data = await sendIpcRequest(socketPath, "get-turn-trace", {
          agent: agentName,
          turnId,
        });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        // 404 for "Turn not found"; everything else is 500. The daemon
        // surfaces the exact reason in `message`, so the SPA can render it
        // verbatim in the waterfall's error slot.
        const code = message.startsWith("Turn not found") ? 404 : 500;
        sendJson(res, code, { error: message });
      }
      return;
    }

    // GET /api/ipc/inboxes
    if (
      method === "GET" &&
      segments.length === 3 &&
      segments[0] === "api" &&
      segments[1] === "ipc" &&
      segments[2] === "inboxes"
    ) {
      try {
        const data = await sendIpcRequest(socketPath, "list-ipc-inboxes", {});
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // GET /api/agents/:name/memory-snapshot
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "memory-snapshot"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      try {
        const data = await sendIpcRequest(socketPath, "get-memory-snapshot", {
          agent: agentName,
        });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const code = message.startsWith("Agent not found") ? 404 : 500;
        sendJson(res, code, { error: message });
      }
      return;
    }

    // GET /api/agents/:name/dream-queue
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "dream-queue"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      try {
        const data = await sendIpcRequest(socketPath, "get-dream-queue", {
          agent: agentName,
        });
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const code = message.startsWith("Agent not found") ? 404 : 500;
        sendJson(res, code, { error: message });
      }
      return;
    }

    // POST /api/agents/:name/dream-veto/:runId  body: { reason: string }
    if (
      method === "POST" &&
      segments.length === 5 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "dream-veto"
    ) {
      // agentName is currently unused by the IPC handler (VetoStore is keyed
      // by runId only), but we keep it in the URL for symmetry with the
      // other agent-scoped routes + to future-proof a per-agent ACL.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _agentName = decodeURIComponent(segments[2]!);
      const runId = decodeURIComponent(segments[4]!);
      try {
        const body = await readJsonBody(req);
        const reason =
          body && typeof (body as { reason?: unknown }).reason === "string"
            ? (body as { reason: string }).reason
            : "";
        if (reason.length === 0) {
          sendJson(res, 400, { error: "reason is required (non-empty string)" });
          return;
        }
        const data = await sendIpcRequest(socketPath, "veto-dream-run", {
          runId,
          reason,
        });
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "veto-dream-run",
            target: _agentName,
            metadata: { runId, reason },
          });
        }
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message });
      }
      return;
    }
    // === end Phase 116-04 routes ===

    // =====================================================================
    // Phase 116-05 routes — Fleet-scale + cost (F16/F17).
    // Same contiguous-block convention as 116-02/116-03/116-04 so 116-06
    // can append its own fence without touching this diff. Both routes
    // proxy daemon IPC methods registered in the "Phase 116-05" closure-
    // intercept block in src/manager/daemon.ts.
    //
    // F16 — fleet comparison table:
    //   No new backend — the page aggregates over the existing per-agent
    //   /api/agents/:name/cache + /api/agents/:name/latency + /api/costs
    //   endpoints. CSV serialization is client-side (Blob + download).
    //
    // F17 — cost dashboard:
    //   GET /api/costs/daily?days=30&agent=X  -> daemon `costs-daily`
    //   GET /api/budgets                      -> daemon `budget-status`
    //
    // Note: `/api/costs` (Phase 1.5) already covers today/week/month
    // totals; 116-05 builds on top of it without replacing.
    // =====================================================================

    // GET /api/costs/daily?days=30&agent=X
    // F17 — per-day cost trend rows for the dashboard's trend chart +
    // anomaly detection + linear projection.
    if (method === "GET" && pathname === "/api/costs/daily") {
      try {
        const queryString = (req.url ?? "").split("?")[1] ?? "";
        const params = new URLSearchParams(queryString);
        const daysRaw = params.get("days");
        const days = daysRaw ? Number.parseInt(daysRaw, 10) : 30;
        const agent = params.get("agent");
        const ipcParams: Record<string, unknown> = {};
        if (Number.isFinite(days)) ipcParams.days = days;
        if (agent) ipcParams.agent = agent;
        const data = await sendIpcRequest(socketPath, "costs-daily", ipcParams);
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // GET /api/budgets
    // F17 — EscalationBudget gauges. Units are TOKENS by schema; the
    // dashboard renders these alongside (not inside) the USD spend cards.
    if (method === "GET" && pathname === "/api/budgets") {
      try {
        const data = await sendIpcRequest(socketPath, "budget-status", {});
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }
    // === end Phase 116-05 routes ===

    // =====================================================================
    // Phase 116-06 routes — Tier 3 polish + cutover gate (F18/F20/F22/F23
    // + telemetry). Same contiguous-block convention as the earlier 116-XX
    // fences. All routes proxy daemon IPC methods registered in the
    // "Phase 116-06" closure-intercept block in src/manager/daemon.ts.
    //
    // F18 + F22 — activity heatmap:
    //   GET /api/activity?days=30&agent=X   -> daemon `activity-by-day`
    //
    // F20 notification feed — derives entirely from existing SSE +
    //   /api/fleet-stats; no new backend.
    // F21 theme toggle — pure client state (localStorage); no backend.
    //
    // F23 + T07 audit log:
    //   GET  /api/audit?since=&action=&agent=&limit=  -> daemon `list-dashboard-audit`
    //   POST /api/dashboard-telemetry                  -> append to dashboard-audit.jsonl
    //   GET  /api/dashboard-telemetry/summary          -> daemon `dashboard-telemetry-summary`
    //
    // F24 graph re-skin — SPA-side React route; no new backend (re-uses
    //   the existing `memory-graph` IPC via /api/graph/:agent).
    //
    // F25 already absorbed into F28 (Kanban) in Plan 116-03; no work here.
    // T08 cutover gate — wired at GET / above (calls cutoverRedirectEnabled
    //   closure injected by daemon.ts; 301 to /dashboard/v2/ when true).
    // =====================================================================

    // GET /api/activity?days=30&agent=X
    // F18 (per-agent in F11 drawer) + F22 (fleet aggregate on /dashboard/v2/fleet).
    if (method === "GET" && pathname === "/api/activity") {
      try {
        const queryString = (req.url ?? "").split("?")[1] ?? "";
        const params = new URLSearchParams(queryString);
        const daysRaw = params.get("days");
        const days = daysRaw ? Number.parseInt(daysRaw, 10) : 30;
        const agent = params.get("agent");
        const ipcParams: Record<string, unknown> = {};
        if (Number.isFinite(days)) ipcParams.days = days;
        if (agent) ipcParams.agent = agent;
        const data = await sendIpcRequest(socketPath, "activity-by-day", ipcParams);
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // GET /api/audit?since=&action=&agent=&limit=
    // F23 — read the dashboard audit log JSONL (tail with filters).
    if (method === "GET" && pathname === "/api/audit") {
      try {
        const queryString = (req.url ?? "").split("?")[1] ?? "";
        const qp = new URLSearchParams(queryString);
        const ipcParams: Record<string, unknown> = {};
        const since = qp.get("since");
        const action = qp.get("action");
        const agent = qp.get("agent");
        const limit = qp.get("limit");
        if (since) ipcParams.since = since;
        if (action) ipcParams.action = action;
        if (agent) ipcParams.agent = agent;
        if (limit) {
          const n = Number.parseInt(limit, 10);
          if (Number.isFinite(n)) ipcParams.limit = n;
        }
        const data = await sendIpcRequest(socketPath, "list-dashboard-audit", ipcParams);
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // POST /api/dashboard-telemetry { event: "page-view" | "error", path?, message?, stack? }
    // T07 — SPA-emitted telemetry. The audit-trail acts as the sink so we
    // don't multiply on-disk JSONL files. Body bounded by MAX_BODY_BYTES.
    if (method === "POST" && pathname === "/api/dashboard-telemetry") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : "bad request body";
        sendJson(res, 400, { error: message });
        return;
      }
      if (typeof body !== "object" || body === null) {
        sendJson(res, 400, { error: "Body must be a JSON object" });
        return;
      }
      const event = (body as { event?: unknown }).event;
      if (event !== "page-view" && event !== "error") {
        sendJson(res, 400, { error: "event must be 'page-view' or 'error'" });
        return;
      }
      if (dashboardAuditTrail) {
        await dashboardAuditTrail.recordAction({
          action: event === "page-view" ? "dashboard_v2_page_view" : "dashboard_v2_error",
          target: null,
          metadata: body as Record<string, unknown>,
        });
      }
      sendJson(res, 204, {});
      return;
    }

    // GET /api/dashboard-telemetry/summary  — T07 badge counts (24h).
    if (method === "GET" && pathname === "/api/dashboard-telemetry/summary") {
      try {
        const data = await sendIpcRequest(
          socketPath,
          "dashboard-telemetry-summary",
          {},
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }
    // === end Phase 116-06 routes ===

    // =====================================================================
    // Phase 116-postdeploy routes — Usage page (subscription utilisation).
    //
    // The Costs page over-emphasised theoretical API-equivalent USD on an
    // operator who runs on Claude Max ($200/mo flat). The real constraint
    // is subscription rate limits (5h session window + 7d weekly + per-
    // model carve-outs), already captured by Phase 103's RateLimitTracker.
    // These routes expose that data so the redesigned Usage view can lead
    // with utilisation bars instead of dollar totals.
    //
    //   GET /api/usage          -> daemon `list-rate-limit-snapshots-fleet`
    //                              returns `{agents: [{agent, snapshots}]}`
    //   GET /api/usage/:agent   -> daemon `list-rate-limit-snapshots`
    //                              returns `{agent, snapshots}`
    //
    // Backwards compat: /api/costs and /api/costs/daily are untouched.
    // =====================================================================

    // GET /api/usage — fleet aggregate.
    if (method === "GET" && pathname === "/api/usage") {
      try {
        const data = await sendIpcRequest(
          socketPath,
          "list-rate-limit-snapshots-fleet",
          {},
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // GET /api/usage/:agent — single-agent snapshots.
    if (
      method === "GET" &&
      segments.length === 3 &&
      segments[0] === "api" &&
      segments[1] === "usage"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      try {
        const data = await sendIpcRequest(
          socketPath,
          "list-rate-limit-snapshots",
          { agent: agentName },
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // GET /api/agents/:name/activity?windowHours=24
    // Phase 116-postdeploy 2026-05-12 — F03 tile 24h activity sparkline.
    // Proxies to the daemon's `agent-activity` IPC handler. The route
    // mirrors the per-agent latency shape (`/api/agents/:name/latency`).
    // windowHours is forwarded as a number; the daemon clamps to 1..168.
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "activity"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const queryParams = new URLSearchParams(queryString);
      const windowHoursRaw = queryParams.get("windowHours");
      const windowHoursParsed = windowHoursRaw
        ? Number.parseInt(windowHoursRaw, 10)
        : NaN;
      const ipcParams: { agent: string; windowHours?: number } = {
        agent: agentName,
      };
      if (Number.isFinite(windowHoursParsed)) {
        ipcParams.windowHours = windowHoursParsed;
      }
      try {
        const data = await sendIpcRequest(
          socketPath,
          "agent-activity",
          ipcParams,
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 500, { error: message });
      }
      return;
    }
    // GET /api/fleet-activity-summary
    // Phase 116-postdeploy 2026-05-12 — main-dashboard tile sort.
    // Proxies the daemon's `fleet-activity-summary` IPC. Response shape:
    //   { since_24h, since_7d, agents: [{ agent, turns_24h, turns_7d, last_turn_at }, ...] }
    // The SPA's AgentTileGrid uses this to order tiles by most-used 24h.
    // Light query — single-row aggregate per agent — but cache 30s on
    // the client to avoid polling the daemon on every dashboard re-render.
    if (method === "GET" && pathname === "/api/fleet-activity-summary") {
      try {
        const data = await sendIpcRequest(
          socketPath,
          "fleet-activity-summary",
          {},
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // GET /api/planning/tasks
    // Phase 116-postdeploy 2026-05-12 — GSD planning artefacts surfaced
    // on the Tasks Kanban. Proxies the daemon's `list-planning-tasks`
    // IPC which scans `.planning/{todos,quick,ROADMAP.md}` from
    // process.cwd() and returns a stable virtual-task shape. Production
    // installs running from /opt/clawcode return the empty response —
    // not an error — so the frontend can render its placeholders.
    if (method === "GET" && pathname === "/api/planning/tasks") {
      try {
        const data = await sendIpcRequest(
          socketPath,
          "list-planning-tasks",
          {},
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // =====================================================================
    // Phase 116-postdeploy 2026-05-12 — OpenAI endpoint config page.
    //
    // Operator asked: "a page to configure the OpenAI-style endpoint we set
    // up for this project." Backend IPC for key CRUD already shipped in
    // Phase 69 (openai-key-{create,list,revoke}); this block wraps them as
    // REST + adds an endpoint-info read for the base-URL/curl-example
    // surface on /dashboard/v2/openai.
    //
    //   GET    /api/openai/info          -> daemon `openai-endpoint-info`
    //                                       returns `{enabled, host?, port?}`
    //   GET    /api/openai/keys          -> daemon `openai-key-list`
    //                                       returns `{rows: [...]}`
    //   POST   /api/openai/keys          body: { agent? | all? : true,
    //                                            label? } → key create.
    //                                       Returns plaintext key once.
    //   DELETE /api/openai/keys/:ident   -> daemon `openai-key-revoke`
    //                                       :ident is full key, hex prefix,
    //                                       or label (same semantics as CLI).
    //
    // The IPC handlers throw a structured ManagerError when the endpoint is
    // disabled — this surface returns 503 with the message so the SPA can
    // render an "endpoint disabled, edit config to enable" empty state.
    // =====================================================================
    if (method === "GET" && pathname === "/api/openai/info") {
      try {
        const data = await sendIpcRequest(
          socketPath,
          "openai-endpoint-info",
          {},
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    if (method === "GET" && pathname === "/api/openai/keys") {
      try {
        const data = await sendIpcRequest(
          socketPath,
          "openai-key-list",
          {},
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    if (method === "POST" && pathname === "/api/openai/keys") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : "bad request body";
        sendJson(res, 400, { error: message });
        return;
      }
      if (typeof body !== "object" || body === null) {
        sendJson(res, 400, {
          error:
            "Body must be { agent: string } or { all: true } with optional label",
        });
        return;
      }
      try {
        const data = await sendIpcRequest(
          socketPath,
          "openai-key-create",
          body as Record<string, unknown>,
        );
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "openai-key-create",
            target:
              typeof (body as { agent?: unknown }).agent === "string"
                ? ((body as { agent: string }).agent)
                : (body as { all?: unknown }).all === true
                ? "*"
                : null,
            metadata: {
              label: (body as { label?: unknown }).label ?? null,
              scope:
                (body as { all?: unknown }).all === true ? "all" : "agent",
            },
          });
        }
        sendJson(res, 201, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err }, "POST /api/openai/keys failed");
        sendJson(res, 400, { error: message });
      }
      return;
    }

    if (
      method === "DELETE" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "openai" &&
      segments[2] === "keys"
    ) {
      const identifier = decodeURIComponent(segments[3]!);
      try {
        const data = await sendIpcRequest(socketPath, "openai-key-revoke", {
          identifier,
        });
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "openai-key-revoke",
            target: identifier,
            metadata: { identifier },
          });
        }
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err }, "DELETE /api/openai/keys failed");
        sendJson(res, 400, { error: message });
      }
      return;
    }

    // POST /api/daemon/restart
    // Phase 116-postdeploy 2026-05-12 — Basic-mode "Restart daemon" quick
    // action. Proxies to the daemon's `restart-daemon` IPC, which sends
    // SIGHUP to itself; systemd RestartForceExitStatus=129 rebuilds the
    // process from scratch. Phase 999.6 snapshot preserves the running
    // fleet across the restart.
    //
    // History: an earlier draft routed to `restart-discord-bot` (bridge
    // stop→start). Withdrawn because client.destroy() invalidated every
    // captured discordClient reference in dependent managers; full
    // daemon restart is the safe path. See protocol.ts for the rationale.
    if (method === "POST" && pathname === "/api/daemon/restart") {
      try {
        const data = await sendIpcRequest(
          socketPath,
          "restart-daemon",
          {},
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        sendJson(res, 503, { error: message });
      }
      return;
    }

    // =====================================================================
    // Phase 116-postdeploy 2026-05-12 — Memory + dreams page (/memory).
    //
    // Operator asked: "a view to see and trigger agent dreaming and memory
    // consolidation, etc." Most of the IPC surface already exists from
    // Phase 95 (dream-pass) + Phase 999.8 (tier-maintenance) + 116-04
    // (dream-queue/memory-snapshot). This block wraps the trigger surfaces
    // as REST so the SPA can fire them.
    //
    //   POST /api/agents/:name/dream-run     body: { modelOverride?, force?,
    //                                              idleBypass? }
    //                                       → daemon `run-dream-pass`
    //   GET  /api/agents/:name/dreams        ?limit=20  → daemon
    //                                       `list-dream-artifacts`
    //   POST /api/agents/:name/memory/consolidate (or POST /api/memory/consolidate
    //                                       for fleet-wide) → daemon
    //                                       `tier-maintenance-tick`
    //
    // The existing dream-queue + memory-snapshot routes (116-04) are NOT
    // re-declared here — they're already wired and the SPA reuses them.
    // =====================================================================
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "dream-run"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      let body: unknown = {};
      try {
        body = await readJsonBody(req).catch(() => ({}));
      } catch {
        body = {};
      }
      const params: Record<string, unknown> = { agent: agentName };
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        if (typeof b.modelOverride === "string") {
          params.modelOverride = b.modelOverride;
        }
        if (typeof b.force === "boolean") params.force = b.force;
        if (typeof b.idleBypass === "boolean") params.idleBypass = b.idleBypass;
      }
      try {
        const data = await sendIpcRequest(socketPath, "run-dream-pass", params);
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "run-dream-pass",
            target: agentName,
            metadata: params,
          });
        }
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err }, "POST /api/agents/:name/dream-run failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "dreams"
    ) {
      const agentName = decodeURIComponent(segments[2]!);
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const queryParams = new URLSearchParams(queryString);
      const limitRaw = queryParams.get("limit");
      const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
      const params: { agent: string; limit?: number } = { agent: agentName };
      if (Number.isFinite(limitParsed) && limitParsed > 0) {
        params.limit = limitParsed;
      }
      try {
        const data = await sendIpcRequest(
          socketPath,
          "list-dream-artifacts",
          params,
        );
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const code = message.startsWith("Agent not found") ? 404 : 500;
        sendJson(res, code, { error: message });
      }
      return;
    }

    // 116-postdeploy 2026-05-12 — orphan cleanup REST surface. Mirrors the
    // memory/consolidate route shape exactly so the dashboard reuses the
    // single-vs-fleet branching idiom from useApi.ts.
    //
    //   POST /api/agents/:name/memory/cleanup-orphans  (single-agent)
    //   POST /api/memory/cleanup-orphans               (fleet-wide)
    //
    // Backed by the Phase 107 `memory-cleanup-orphans` IPC (no new IPC).
    // Daemon-side iterates resolvedAgents or scopes to one agent based on
    // the optional `agent` param — same shape consolidate uses.
    if (
      method === "POST" &&
      ((segments.length === 5 &&
        segments[0] === "api" &&
        segments[1] === "agents" &&
        segments[3] === "memory" &&
        segments[4] === "cleanup-orphans") ||
        (segments.length === 3 &&
          segments[0] === "api" &&
          segments[1] === "memory" &&
          segments[2] === "cleanup-orphans"))
    ) {
      const isFleet = segments[1] === "memory";
      const agentName = isFleet ? null : decodeURIComponent(segments[2]!);
      const params: Record<string, unknown> = {};
      if (agentName) params.agent = agentName;
      try {
        const data = await sendIpcRequest(
          socketPath,
          "memory-cleanup-orphans",
          params,
        );
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "memory-cleanup-orphans",
            target: agentName ?? "*",
            metadata: params,
          });
        }
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err }, "POST memory/cleanup-orphans failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // POST /api/agents/:name/memory/consolidate  (single-agent)
    // POST /api/memory/consolidate               (fleet-wide)
    if (
      method === "POST" &&
      ((segments.length === 5 &&
        segments[0] === "api" &&
        segments[1] === "agents" &&
        segments[3] === "memory" &&
        segments[4] === "consolidate") ||
        (segments.length === 3 &&
          segments[0] === "api" &&
          segments[1] === "memory" &&
          segments[2] === "consolidate"))
    ) {
      const isFleet = segments[1] === "memory";
      const agentName = isFleet ? null : decodeURIComponent(segments[2]!);
      const params: Record<string, unknown> = {};
      if (agentName) params.agent = agentName;
      try {
        const data = await sendIpcRequest(
          socketPath,
          "tier-maintenance-tick",
          params,
        );
        if (dashboardAuditTrail) {
          await dashboardAuditTrail.recordAction({
            action: "tier-maintenance-tick",
            target: agentName ?? "*",
            metadata: params,
          });
        }
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error({ err }, "POST memory/consolidate failed");
        sendJson(res, 500, { error: message });
      }
      return;
    }
    // =====================================================================
    // Phase 116-postdeploy 2026-05-12 — Benchmarks page routes.
    //
    //   POST /api/agents/:name/benchmark    -> loops `bench-run-prompt` N times
    //   GET  /api/benchmarks/compare        -> per-agent `latency` snapshots
    //                                          combined into one payload
    //
    // The trigger endpoint refuses
    // `cold-start` scenarios entirely — those require stop/start cycles that
    // are unsafe to trigger from the dashboard while operator threads are
    // active. CLI is the only path for cold-start.
    //
    // The four supported scenarios use the same canonical fixture prompts the
    // CLI runner uses, ported inline to avoid pulling scripts/ into the SPA
    // server bundle. End-to-end timing comes from `bench-run-prompt` which
    // calls dispatchTurn directly (NOT the Discord ask-agent path). This is
    // SAFER (no real Discord side effects) but produces NUMBERS that differ
    // from the CLI baseline which goes through send-message. The UI surfaces
    // this divergence explicitly so operators don't false-compare.
    // =====================================================================

    // Canonical fixture prompts — kept in sync with
    // scripts/bench/115-perf-runner.ts DEFAULT_FIXTURE_PROMPTS. Cold-start
    // omitted: it's intentionally not exposed via the UI (see the
    // commentary above the route block).
    const BENCH_PROMPTS: Record<string, string> = {
      "discord-ack": "ok thx",
      "tool-heavy":
        "Query mysql for the latest 5 rows in acme_clients then summarize and search the web for related news",
      "memory-recall":
        "What did we discuss about Ana Bencker on May 6 2026?",
      "extended-thinking":
        "Think step by step about the architecture of this multi-agent system and propose three improvements.",
    };

    // Per-scenario span name the runner harvests after each turn. Mirrors
    // SCENARIO_SPAN_NAMES in 115-perf-runner.ts but ONLY the "first" span for
    // each scenario — the UI surface uses a single headline number per run.
    const BENCH_HEADLINE_SPAN: Record<string, string> = {
      "discord-ack": "first_token",
      "tool-heavy": "end_to_end",
      "memory-recall": "end_to_end",
      "extended-thinking": "first_visible_token",
    };

    function nearestRankPercentile(
      values: readonly number[],
      percentile: number,
    ): number | null {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const n = sorted.length;
      const idx = Math.max(0, Math.min(Math.ceil(percentile * n) - 1, n - 1));
      return sorted[idx] ?? null;
    }

    // POST /api/agents/:name/benchmark   { scenario, iterations }
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "agents" &&
      segments[3] === "benchmark"
    ) {
      const agentName = decodeURIComponent(segments[2]!);

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "invalid body";
        sendJson(res, 400, { error: msg });
        return;
      }
      const b = body as {
        scenario?: unknown;
        iterations?: unknown;
      };
      const scenario =
        typeof b.scenario === "string" ? b.scenario : "";
      if (!(scenario in BENCH_PROMPTS)) {
        sendJson(res, 400, {
          error: `Unknown scenario '${scenario}'. Supported: ${Object.keys(BENCH_PROMPTS).join(", ")}. (cold-start is CLI-only — see scripts/bench/115-perf.ts.)`,
        });
        return;
      }
      const iterationsRaw =
        typeof b.iterations === "number" ? b.iterations : 3;
      const iterations = Math.max(1, Math.min(10, Math.floor(iterationsRaw)));

      const prompt = BENCH_PROMPTS[scenario]!;
      const headlineSpan = BENCH_HEADLINE_SPAN[scenario]!;
      const turnIdPrefix = `bench:dashboard:${scenario}:`;

      // Run iterations sequentially. dispatchTurn is single-flight per agent
      // (it serializes on the session lock anyway), so parallel calls would
      // queue rather than overlap. Sequential keeps the timings clean.
      type BenchIterationRow = {
        readonly index: number;
        readonly turnId: string | null;
        readonly headline_ms: number | null;
        readonly segments: Record<string, number>;
        readonly error: string | null;
      };
      const rows: BenchIterationRow[] = [];
      const startedAt = new Date().toISOString();

      for (let i = 0; i < iterations; i++) {
        try {
          const result = (await sendIpcRequest(
            socketPath,
            "bench-run-prompt",
            {
              agent: agentName,
              prompt,
              turnIdPrefix,
            },
          )) as {
            readonly turnId?: string;
            readonly response?: {
              readonly segments?: Record<string, number>;
            };
          };
          const segments = (result.response?.segments ?? {}) as Record<
            string,
            number
          >;
          const headlineMs = segments[headlineSpan];
          rows.push({
            index: i,
            turnId: result.turnId ?? null,
            headline_ms:
              typeof headlineMs === "number" ? headlineMs : null,
            segments,
            error: null,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          rows.push({
            index: i,
            turnId: null,
            headline_ms: null,
            segments: {},
            error: msg,
          });
        }
      }

      const headlineValues = rows
        .map((r) => r.headline_ms)
        .filter((v): v is number => typeof v === "number");
      const aggregate = {
        runs: headlineValues.length,
        errored: rows.filter((r) => r.error !== null).length,
        p50_ms: nearestRankPercentile(headlineValues, 0.5),
        p95_ms: nearestRankPercentile(headlineValues, 0.95),
        mean_ms:
          headlineValues.length === 0
            ? null
            : headlineValues.reduce((a, b) => a + b, 0) / headlineValues.length,
        min_ms:
          headlineValues.length === 0 ? null : Math.min(...headlineValues),
        max_ms:
          headlineValues.length === 0 ? null : Math.max(...headlineValues),
      };

      if (dashboardAuditTrail) {
        await dashboardAuditTrail.recordAction({
          action: "benchmark-run",
          target: agentName,
          metadata: { scenario, iterations, errored: aggregate.errored },
        });
      }

      sendJson(res, 200, {
        agent: agentName,
        scenario,
        iterations,
        headlineSpan,
        path: "bench-run-prompt (in-process; NOT Discord ask-agent path)",
        startedAt,
        finishedAt: new Date().toISOString(),
        rows,
        aggregate,
      });
      return;
    }

    // GET /api/benchmarks/compare?agents=A,B,C&metric=first_token_p50
    //
    // Loops over the per-agent `latency` IPC and pulls the requested metric.
    // Supported metric formats:
    //   - <segment>_p50 / _p95 / _p99   e.g. first_token_p50, end_to_end_p95
    //   - tool:<name>_p50 / _p95 / _p99 (per-tool, sourced from `tools` IPC)
    if (method === "GET" && pathname === "/api/benchmarks/compare") {
      const queryString = (req.url ?? "").split("?")[1] ?? "";
      const params = new URLSearchParams(queryString);
      const agentsRaw = params.get("agents") ?? "";
      const agents = agentsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const metric = params.get("metric") ?? "first_token_p50";
      const since = params.get("since") ?? "24h";

      if (agents.length === 0) {
        sendJson(res, 400, { error: "Missing required query param: agents" });
        return;
      }
      if (agents.length > 6) {
        sendJson(res, 400, {
          error: "Too many agents (max 6) — comparison plot becomes unreadable",
        });
        return;
      }

      const toolMatch = /^tool:(.+)_(p50|p95|p99)$/.exec(metric);
      const segMatch = /^([a-z_]+)_(p50|p95|p99)$/.exec(metric);

      type ComparePoint = {
        readonly agent: string;
        readonly value_ms: number | null;
        readonly count: number | null;
        readonly model: string | null;
        readonly error: string | null;
      };

      const results = await Promise.all(
        agents.map(async (agent): Promise<ComparePoint> => {
          try {
            if (toolMatch) {
              const toolName = toolMatch[1]!;
              const percentile = toolMatch[2]!;
              const data = (await sendIpcRequest(socketPath, "tools", {
                agent,
                since,
              })) as {
                readonly tools?: ReadonlyArray<{
                  readonly tool: string;
                  readonly count: number;
                  readonly p50_ms: number | null;
                  readonly p95_ms: number | null;
                  readonly p99_ms: number | null;
                }>;
              };
              const row = (data.tools ?? []).find((t) => t.tool === toolName);
              if (!row) {
                return {
                  agent,
                  value_ms: null,
                  count: null,
                  model: null,
                  error: `tool '${toolName}' not seen in window`,
                };
              }
              const value =
                percentile === "p50"
                  ? row.p50_ms
                  : percentile === "p95"
                    ? row.p95_ms
                    : row.p99_ms;
              return {
                agent,
                value_ms: value ?? null,
                count: row.count,
                model: null,
                error: null,
              };
            }
            if (segMatch) {
              const segName = segMatch[1]!;
              const percentile = segMatch[2]!;
              const data = (await sendIpcRequest(socketPath, "latency", {
                agent,
                since,
              })) as {
                readonly segments?: ReadonlyArray<{
                  readonly segment: string;
                  readonly count: number;
                  readonly p50_ms: number | null;
                  readonly p95_ms: number | null;
                  readonly p99_ms: number | null;
                }>;
              };
              const row = (data.segments ?? []).find(
                (s) => s.segment === segName,
              );
              if (!row) {
                return {
                  agent,
                  value_ms: null,
                  count: null,
                  model: null,
                  error: `segment '${segName}' not seen in window`,
                };
              }
              const value =
                percentile === "p50"
                  ? row.p50_ms
                  : percentile === "p95"
                    ? row.p95_ms
                    : row.p99_ms;
              return {
                agent,
                value_ms: value ?? null,
                count: row.count,
                model: null,
                error: null,
              };
            }
            return {
              agent,
              value_ms: null,
              count: null,
              model: null,
              error: `unsupported metric '${metric}' (expected <segment>_p{50,95,99} or tool:<name>_p{50,95,99})`,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown error";
            return {
              agent,
              value_ms: null,
              count: null,
              model: null,
              error: msg,
            };
          }
        }),
      );

      sendJson(res, 200, {
        metric,
        since,
        points: results,
      });
      return;
    }
    // === end Phase 116-postdeploy benchmarks routes ===

    // Phase 61 TRIG-03: Webhook trigger endpoint
    if (method === "POST" && segments[0] === "webhook" && segments.length === 2) {
      const triggerId = decodeURIComponent(segments[1]!);
      if (webhookHandler) {
        await webhookHandler(triggerId, req, res);
        return;
      }
      sendJson(res, 404, { error: "Webhook handler not configured" });
      return;
    }

    // dashboard-rework (decision 4) — SPA root fallback. Runs AFTER every
    // /api, /preview, and /webhook route so it never shadows them. Extension-
    // less GET paths are SPA client routes ('/', '/agents', '/insights/fleet',
    // '/network', …) → index.html; paths with an extension (/assets/*,
    // /fonts/*, /favicon.svg) → the matching file under spa/ (404 on miss
    // surfaces stale-build issues).
    if (
      method === "GET" &&
      !pathname.startsWith("/api") &&
      !pathname.startsWith("/preview") &&
      !pathname.startsWith("/webhook")
    ) {
      const relativePath = pathname.replace(/^\/+/, "");
      const lastSegment = relativePath.split("/").pop() ?? "";
      if (lastSegment.includes(".")) {
        await serveSpaAsset(res, relativePath, inferMimeType(relativePath));
      } else {
        await serveSpaAsset(res, "index.html", MIME_TYPES[".html"]!);
      }
      return;
    }

    // 404 for everything else
    res.writeHead(404);
    res.end("Not Found");
  } catch (err) {
    log.error({ err, pathname }, "Request handler error");
    res.writeHead(500);
    res.end("Internal Server Error");
  }
}

type Logger = pino.Logger;

export type { DashboardServerConfig };
