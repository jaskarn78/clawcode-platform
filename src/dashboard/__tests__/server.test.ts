import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IncomingMessage } from "node:http";

vi.mock("../../ipc/client.js", () => ({
  sendIpcRequest: vi.fn(),
}));

// Suppress pino output during tests
vi.mock("pino", () => {
  const noop = () => undefined;
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  };
  return { default: () => logger };
});

import { startDashboardServer } from "../server.js";
import { sendIpcRequest } from "../../ipc/client.js";

const mockedSendIpcRequest = vi.mocked(sendIpcRequest);

function makeStatusResponse() {
  return {
    entries: [
      {
        name: "atlas",
        status: "running",
        startedAt: Date.now() - 60_000,
        restartCount: 0,
        lastError: null,
        sessionId: "sess-1",
        consecutiveFailures: 0,
        lastStableAt: null,
      },
    ],
  };
}

// Phase 56 Plan 02 — registry entry with warm-path fields present.
function makeStatusResponseWithWarmPath() {
  return {
    entries: [
      {
        name: "atlas",
        status: "running",
        startedAt: Date.now() - 60_000,
        restartCount: 0,
        lastError: null,
        sessionId: "sess-1",
        consecutiveFailures: 0,
        lastStableAt: null,
        warm_path_ready: true,
        warm_path_readiness_ms: 150,
      },
    ],
  };
}

function makeZoneResponse() {
  return {
    agents: {
      atlas: { zone: "green", fillPercentage: 35 },
    },
  };
}

describe("Dashboard Server", () => {
  let closeServer: (() => Promise<void>) | null = null;
  let port: number;

  beforeEach(() => {
    // Use a random high port to avoid collisions
    port = 30_000 + Math.floor(Math.random() * 10_000);

    mockedSendIpcRequest.mockImplementation(async (_socketPath, method) => {
      if (method === "status") return makeStatusResponse();
      if (method === "context-zone-status") return makeZoneResponse();
      if (method === "start" || method === "stop" || method === "restart") return { ok: true };
      throw new Error(`Unknown method: ${method}`);
    });
  });

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
    vi.restoreAllMocks();
  });

  it("starts and accepts connections", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000, // Slow poll for tests
    });
    closeServer = result.close;

    expect(result.server).toBeDefined();
    expect(result.sseManager).toBeDefined();

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.ok).toBe(true);
  });

  it("GET / returns HTML with correct content-type", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("ClawCode");
  });

  it("GET /api/status returns JSON agent data", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(res.headers.get("content-type")).toContain("application/json");

    const data = (await res.json()) as { agents: Array<{ name: string }> };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0]!.name).toBe("atlas");
  });

  // -------------------------------------------------------------------------
  // Phase 56 Plan 02 — warm-path passthrough
  // -------------------------------------------------------------------------

  it("GET /api/status passes through warm_path_ready + warm_path_readiness_ms", async () => {
    // Swap the mock to return entries with the Phase 56 fields present so we
    // can verify the dashboard server threads them through verbatim.
    mockedSendIpcRequest.mockImplementation(async (_socketPath, method) => {
      if (method === "status") return makeStatusResponseWithWarmPath();
      if (method === "context-zone-status") return makeZoneResponse();
      throw new Error(`Unknown method: ${method}`);
    });

    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    const data = (await res.json()) as {
      agents: Array<{
        name: string;
        warm_path_ready?: boolean;
        warm_path_readiness_ms?: number | null;
      }>;
    };
    expect(data.agents[0]!.warm_path_ready).toBe(true);
    expect(data.agents[0]!.warm_path_readiness_ms).toBe(150);
  });

  it("GET /api/status parses legacy entries (warm-path fields undefined) cleanly", async () => {
    // Default mock — no warm-path fields in the registry entry.
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as {
      agents: Array<{
        name: string;
        warm_path_ready?: boolean;
        warm_path_readiness_ms?: number | null;
      }>;
    };
    // Legacy entries flow through with both warm-path fields undefined.
    expect(data.agents[0]!.name).toBe("atlas");
    expect(data.agents[0]!.warm_path_ready).toBeUndefined();
    expect(data.agents[0]!.warm_path_readiness_ms).toBeUndefined();
  });

  it("returns 404 for unknown routes", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("POST /api/agents/:name/restart calls IPC", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/agents/atlas/restart`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);

    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith("/tmp/test.sock", "restart", {
      name: "atlas",
    });
  });

  it("GET /styles.css returns CSS", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/styles.css`);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("GET /app.js returns JavaScript", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    expect(res.headers.get("content-type")).toContain("application/javascript");
  });

  // Phase 999.8 Plan 02 follow-up — graph-color.js is the ESM module
  // imported by graph.html. The script type="module" import resolves to
  // /graph-color.js (relative to /graph). Without this server route the
  // entire graph script block silently 404s, leaving the canvas blank
  // and the menu wiring inert. Caught in prod 2026-04-30.
  it("GET /graph-color.js returns JavaScript with nodeClr export", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/graph-color.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    const body = await res.text();
    expect(body).toContain("export function nodeClr");
  });
});

// ── APPENDED BY Phase 50-00 Wave 0 scaffolding ───────────────────────────────
// New "latency endpoint" describe block. Existing tests above remain untouched.

function makeLatencyReport() {
  // Phase 51 Plan 03: the daemon's `latency` IPC handler now augments every
  // segment row with `slo_status`, `slo_threshold_ms`, and `slo_metric`. The
  // REST endpoint is a passthrough so the fields flow through to the client
  // unchanged. Fixture mirrors that shape so tests assert the augmented
  // contract, not the stale Phase 50 one.
  //
  // Phase 54 Plan 04: adds first_visible_token + typing_indicator segments
  // (6 total) AND a top-level first_token_headline object. The REST endpoint
  // continues to passthrough — fields flow through unchanged.
  return {
    agent: "alpha",
    since: "2026-04-12T00:00:00.000Z",
    segments: [
      {
        segment: "end_to_end",
        p50: 1000,
        p95: 2000,
        p99: 3000,
        count: 10,
        slo_status: "healthy",
        slo_threshold_ms: 6000,
        slo_metric: "p95",
      },
      {
        segment: "first_token",
        p50: 400,
        p95: 800,
        p99: 1200,
        count: 10,
        slo_status: "healthy",
        slo_threshold_ms: 2000,
        slo_metric: "p50",
      },
      {
        segment: "first_visible_token",
        p50: 450,
        p95: 900,
        p99: 1300,
        count: 10,
        slo_threshold_ms: null,
        slo_metric: null,
      },
      {
        segment: "context_assemble",
        p50: 50,
        p95: 100,
        p99: 150,
        count: 10,
        slo_status: "healthy",
        slo_threshold_ms: 300,
        slo_metric: "p95",
      },
      {
        segment: "tool_call",
        p50: 75,
        p95: 150,
        p99: 225,
        count: 20,
        slo_status: "healthy",
        slo_threshold_ms: 1500,
        slo_metric: "p95",
      },
      {
        segment: "typing_indicator",
        p50: 80,
        p95: 200,
        p99: 350,
        count: 15,
        slo_status: "healthy",
        slo_threshold_ms: 500,
        slo_metric: "p95",
      },
    ],
    first_token_headline: {
      p50: 400,
      p95: 800,
      p99: 1200,
      count: 10,
      slo_status: "healthy",
      slo_threshold_ms: 2000,
      slo_metric: "p50",
    },
  };
}

describe("latency endpoint", () => {
  let closeServer: (() => Promise<void>) | null = null;
  let port: number;

  beforeEach(() => {
    port = 30_000 + Math.floor(Math.random() * 10_000);

    mockedSendIpcRequest.mockImplementation(async (_socketPath, method) => {
      if (method === "status") return { entries: [] };
      if (method === "context-zone-status") return { agents: {} };
      if (method === "latency") return makeLatencyReport();
      if (method === "start" || method === "stop" || method === "restart") return { ok: true };
      throw new Error(`Unknown method: ${method}`);
    });
  });

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
    vi.restoreAllMocks();
  });

  it("latency: returns 200 with LatencyReport json for valid agent", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/agents/alpha/latency`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(body).toEqual(makeLatencyReport());
  });

  it("latency: segment rows carry slo_threshold_ms (number|null) and slo_metric (string|null) alongside slo_status", async () => {
    // Phase 51 Plan 03 contract: the REST endpoint is a passthrough over the
    // augmented IPC response. Each segment row MUST carry the three new
    // fields so the dashboard renders cell color + "SLO target" subtitle
    // directly from the response (no client-side SLO mirror). We assert the
    // field types permissively (number OR null, string OR null) to stay
    // forward-compatible with segments that have no configured SLO.
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/agents/alpha/latency`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      segments: Array<{
        segment: string;
        slo_status?: string;
        slo_threshold_ms: number | null;
        slo_metric: string | null;
      }>;
    };

    expect(Array.isArray(body.segments)).toBe(true);
    expect(body.segments.length).toBeGreaterThan(0);

    for (const seg of body.segments) {
      expect(seg).toEqual(
        expect.objectContaining({
          segment: expect.any(String),
        }),
      );
      // Phase 54 Plan 01: `first_visible_token` has no default SLO (debug
      // metric) — its row carries slo_threshold_ms=null and slo_metric=null
      // with slo_status intentionally left undefined. Other segments must
      // match a healthy/breach/no_data state.
      if (seg.slo_threshold_ms !== null) {
        expect(seg.slo_status).toMatch(/^(healthy|breach|no_data)$/);
      }
      expect(
        typeof seg.slo_threshold_ms === "number" || seg.slo_threshold_ms === null,
      ).toBe(true);
      expect(
        typeof seg.slo_metric === "string" || seg.slo_metric === null,
      ).toBe(true);
    }
  });

  it("latency: defaults since to 24h when query param absent", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    await fetch(`http://127.0.0.1:${port}/api/agents/alpha/latency`);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test.sock",
      "latency",
      expect.objectContaining({ agent: "alpha", since: "24h" }),
    );
  });

  it("latency: passes ?since=7d through to IPC method", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    await fetch(`http://127.0.0.1:${port}/api/agents/alpha/latency?since=7d`);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test.sock",
      "latency",
      expect.objectContaining({ agent: "alpha", since: "7d" }),
    );
  });

  it("latency: response includes first_token_headline (Phase 54 passthrough)", async () => {
    // Phase 54 Plan 04: the daemon now emits a top-level first_token_headline
    // object on the latency response. The REST endpoint is a passthrough so
    // the object flows through to the client unchanged.
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/agents/alpha/latency`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      first_token_headline: {
        p50: number | null;
        p95: number | null;
        p99: number | null;
        count: number;
        slo_status: string;
        slo_threshold_ms: number | null;
        slo_metric: string | null;
      };
    };
    expect(body.first_token_headline).toBeDefined();
    expect(body.first_token_headline.slo_status).toMatch(
      /^(healthy|breach|no_data)$/,
    );
    expect(typeof body.first_token_headline.count).toBe("number");
    expect(
      typeof body.first_token_headline.slo_threshold_ms === "number" ||
        body.first_token_headline.slo_threshold_ms === null,
    ).toBe(true);
  });

  it("latency: segments array contains 6 rows (Phase 54 expansion)", async () => {
    // Phase 54 Plan 04: segments expands from 4 to 6 canonical rows.
    // Regression guard: the response shape must carry all 6 so the dashboard
    // panel renders first_visible_token + typing_indicator without gaps.
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/agents/alpha/latency`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      segments: Array<{ segment: string }>;
    };
    expect(body.segments).toHaveLength(6);
    const names = body.segments.map((s) => s.segment);
    expect(names).toContain("end_to_end");
    expect(names).toContain("first_token");
    expect(names).toContain("first_visible_token");
    expect(names).toContain("context_assemble");
    expect(names).toContain("tool_call");
    expect(names).toContain("typing_indicator");
  });

  it("latency: returns 500 with error message when IPC throws", async () => {
    mockedSendIpcRequest.mockImplementation(async (_socketPath, method) => {
      if (method === "latency") throw new Error("daemon unreachable");
      return {};
    });

    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/agents/alpha/latency`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("daemon unreachable");
  });
});

// ── APPENDED BY Phase 52-03 (Cache endpoint) ─────────────────────────────────
// New "cache endpoint" describe block. Existing tests above remain untouched.

function makeCacheReport() {
  // Phase 52 Plan 03: the daemon's `cache` IPC handler augments the raw
  // CacheTelemetryReport with `status` (from evaluateCacheHitRateStatus) and
  // `cache_effect_ms` (from computeCacheEffectMs / getCacheEffectStats). The
  // REST endpoint is a passthrough so both fields flow through unchanged.
  return {
    agent: "alpha",
    since: "2026-04-12T00:00:00.000Z",
    totalTurns: 50,
    avgHitRate: 0.72,
    p50HitRate: 0.75,
    p95HitRate: 0.50,
    totalCacheReads: 5000,
    totalCacheWrites: 1000,
    totalInputTokens: 1000,
    trendByDay: [],
    status: "healthy",
    cache_effect_ms: -650,
  };
}

describe("cache endpoint", () => {
  let closeServer: (() => Promise<void>) | null = null;
  let port: number;

  beforeEach(() => {
    port = 30_000 + Math.floor(Math.random() * 10_000);

    mockedSendIpcRequest.mockImplementation(async (_socketPath, method) => {
      if (method === "status") return { entries: [] };
      if (method === "context-zone-status") return { agents: {} };
      if (method === "cache") return makeCacheReport();
      if (method === "start" || method === "stop" || method === "restart") return { ok: true };
      throw new Error(`Unknown method: ${method}`);
    });
  });

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
    vi.restoreAllMocks();
  });

  it("GET /api/agents/:name/cache?since=24h proxies to the cache IPC method", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(
      `http://127.0.0.1:${port}/api/agents/alpha/cache?since=24h`,
    );
    expect(res.status).toBe(200);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test.sock",
      "cache",
      expect.objectContaining({ agent: "alpha", since: "24h" }),
    );
    const body = (await res.json()) as unknown;
    expect(body).toEqual(makeCacheReport());
  });

  it("GET /api/agents/:name/cache defaults since to 24h when query missing", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    await fetch(`http://127.0.0.1:${port}/api/agents/alpha/cache`);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test.sock",
      "cache",
      expect.objectContaining({ agent: "alpha", since: "24h" }),
    );
  });

  it("GET /api/agents/:name/cache passes ?since=7d through to IPC method", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    await fetch(`http://127.0.0.1:${port}/api/agents/alpha/cache?since=7d`);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test.sock",
      "cache",
      expect.objectContaining({ agent: "alpha", since: "7d" }),
    );
  });

  it("GET /api/agents/:name/cache handles IPC errors with 500", async () => {
    mockedSendIpcRequest.mockImplementation(async (_socketPath, method) => {
      if (method === "cache") throw new Error("daemon unreachable");
      return {};
    });

    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/agents/alpha/cache`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("daemon unreachable");
  });

  it("GET /api/agents/:name/cache carries augmented fields (status + cache_effect_ms)", async () => {
    // Phase 52 Plan 03 contract: the REST endpoint is a passthrough. The
    // response MUST carry the two daemon-added fields verbatim so the
    // dashboard Prompt Cache panel can render cell color (healthy/breach)
    // and the cache-effect subtitle directly from the response.
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/agents/alpha/cache`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      cache_effect_ms: number | null;
      avgHitRate: number;
      totalTurns: number;
    };
    expect(body.status).toMatch(/^(healthy|breach|no_data)$/);
    expect(
      typeof body.cache_effect_ms === "number" || body.cache_effect_ms === null,
    ).toBe(true);
    expect(typeof body.avgHitRate).toBe("number");
    expect(typeof body.totalTurns).toBe("number");
  });
});

// ── APPENDED BY Phase 55-03 (Tools endpoint) ─────────────────────────────────
// New "tools endpoint" describe block. Existing tests above remain untouched.

function makeToolsReport() {
  // Phase 55 Plan 03: the daemon's `tools` IPC handler augments each
  // ToolPercentileRow with `slo_status`, `slo_threshold_ms`, and `slo_metric`
  // via augmentToolsWithSlo. The REST endpoint is a passthrough so all three
  // fields flow through unchanged. Rows sorted by p95 DESC (slowest first).
  return {
    agent: "alpha",
    since: "2026-04-13T00:00:00.000Z",
    tools: [
      {
        tool_name: "search_documents",
        p50: 400,
        p95: 800,
        p99: 1200,
        count: 12,
        slo_status: "healthy",
        slo_threshold_ms: 1500,
        slo_metric: "p95",
      },
      {
        tool_name: "memory_lookup",
        p50: 80,
        p95: 200,
        p99: 300,
        count: 35,
        slo_status: "healthy",
        slo_threshold_ms: 1500,
        slo_metric: "p95",
      },
    ],
  };
}

describe("tools endpoint (Phase 55)", () => {
  let closeServer: (() => Promise<void>) | null = null;
  let port: number;

  beforeEach(() => {
    port = 30_000 + Math.floor(Math.random() * 10_000);

    mockedSendIpcRequest.mockImplementation(async (_socketPath, method) => {
      if (method === "status") return { entries: [] };
      if (method === "context-zone-status") return { agents: {} };
      if (method === "tools") return makeToolsReport();
      if (method === "start" || method === "stop" || method === "restart") return { ok: true };
      throw new Error(`Unknown method: ${method}`);
    });
  });

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
    vi.restoreAllMocks();
  });

  it("GET /api/agents/:name/tools?since=24h proxies to the tools IPC method", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(
      `http://127.0.0.1:${port}/api/agents/alpha/tools?since=24h`,
    );
    expect(res.status).toBe(200);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test.sock",
      "tools",
      expect.objectContaining({ agent: "alpha", since: "24h" }),
    );
    const body = (await res.json()) as unknown;
    expect(body).toEqual(makeToolsReport());
  });

  it("GET /api/agents/:name/tools defaults since to 24h when query missing", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    await fetch(`http://127.0.0.1:${port}/api/agents/alpha/tools`);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test.sock",
      "tools",
      expect.objectContaining({ agent: "alpha", since: "24h" }),
    );
  });

  it("GET /api/agents/:name/tools passes ?since=7d through to IPC method", async () => {
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    await fetch(`http://127.0.0.1:${port}/api/agents/alpha/tools?since=7d`);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test.sock",
      "tools",
      expect.objectContaining({ agent: "alpha", since: "7d" }),
    );
  });

  it("GET /api/agents/:name/tools handles IPC errors with 500 + JSON error body", async () => {
    mockedSendIpcRequest.mockImplementation(async (_socketPath, method) => {
      if (method === "tools") throw new Error("daemon unreachable");
      return {};
    });

    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/agents/alpha/tools`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("daemon unreachable");
  });

  it("GET /api/agents/:name/tools carries augmented SLO fields per tool row", async () => {
    // Phase 55 contract: each tool row carries slo_status + slo_threshold_ms
    // + slo_metric so the dashboard renders slow/healthy cell tint directly
    // from the server response (no client-side SLO mirror — Phase 51 Plan 03
    // invariant preserved through Phase 55).
    const result = await startDashboardServer({
      port,
      socketPath: "/tmp/test.sock",
      pollIntervalMs: 60_000,
    });
    closeServer = result.close;

    const res = await fetch(`http://127.0.0.1:${port}/api/agents/alpha/tools`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: string;
      since: string;
      tools: Array<{
        tool_name: string;
        p50: number | null;
        p95: number | null;
        p99: number | null;
        count: number;
        slo_status: string;
        slo_threshold_ms: number;
        slo_metric: string;
      }>;
    };
    expect(body.agent).toBe("alpha");
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    for (const row of body.tools) {
      expect(typeof row.tool_name).toBe("string");
      expect(row.slo_status).toMatch(/^(healthy|breach|no_data)$/);
      expect(typeof row.slo_threshold_ms).toBe("number");
      expect(row.slo_metric).toMatch(/^p(50|95|99)$/);
    }
  });
});
