/**
 * Phase 999.130 — the report-card collector against stubbed stores, and the
 * tick that posts to the admin channel.
 */

import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { collectFleetReportCard, runReportCardTick, scheduleReportCardCron } from "../report-card-cron.js";
import type { ReportCardDeps } from "../report-card-cron.js";

const log = pino({ level: "silent" });
const NOW = Date.UTC(2026, 8, 7, 16, 10, 0);

function stubDeps(overrides: Partial<ReportCardDeps> = {}): ReportCardDeps {
  const trace = {
    getTurnSummarySince: vi.fn((_a: string, since: string) => ({
      // 140 this week, 120 the week before (260 over 14 days).
      n: Date.parse(since) < NOW - 8 * 86_400_000 ? 260 : 140,
      last_at: null,
    })),
    getFirstTokenPercentiles: vi.fn(() => ({ segment: "first_token", p50: 18_000, p95: 61_000, p99: 90_000, count: 140 })),
    getCacheTelemetry: vi.fn(() => ({ totalTurns: 140, avgHitRate: 0.72 })),
  };
  const usage = {
    getUsageInRange: vi.fn((start: string) => ({ cost_usd: Date.parse(start) < NOW - 8 * 86_400_000 ? 13.6 : 12.4 })),
  };
  const integrity = {
    danglingLinks: 0, danglingSessionSummaries: 0, orphanVecV1: 0, orphanVecV2: 0,
    orphanChunkVecV1: 0, orphanChunkVecV2: 0, orphanChunkFts: 0, fkViolations: 0,
    memoriesWithoutEmbedding: 0, total: 0,
  };
  const store = {
    countInRange: vi.fn((since: string) => (Date.parse(since) < NOW - 8 * 86_400_000 ? 30 : 37)),
    checkIntegrity: () => integrity,
    getDatabase: () => ({ prepare: () => ({ all: () => [{ tier: "hot", n: 10 }] }) }),
    getEmbeddingReadVersion: () => "v2",
    countMemoriesMissingV2Embedding: () => 0,
    countChunksMissingV2Embedding: () => 0,
  };
  return {
    manager: {
      getRunningAgents: () => ["fin-client", "fin-client-fork-abc123", "projects"],
      getTraceStore: (a: string) => (a === "projects" ? undefined : (trace as never)),
      getUsageTracker: () => usage as never,
      getMemoryStore: (a: string) => (a === "projects" ? undefined : (store as never)),
      getTierManager: () => ({ coldArchiveFileCount: () => 0 }) as never,
      getConversationStore: () => undefined,
    },
    incidents: () => ({
      since: "x",
      transitions: [],
      byAgent: { projects: { warning: 1, critical: 1, recovered: 0, open: ["auto-linker"] } },
    }),
    workflowStats: async (a: string) => (a === "fin-client" ? { run: 3, failed: 0 } : { run: 0, failed: 0 }),
    log,
    now: () => NOW,
    ...overrides,
  };
}

describe("collectFleetReportCard", () => {
  it("collects one graded row per top-level running agent from the live stores", async () => {
    const card = await collectFleetReportCard(stubDeps());
    expect(card.agents.map((a) => a.metrics.agent)).toEqual(["fin-client", "projects"]);
    const fin = card.agents[0]!;
    expect(fin.metrics).toMatchObject({
      turns: 140,
      turnsPrev: 120,
      costUsd: 12.4,
      costUsdPrev: 13.6,
      firstTokenP50Ms: 18_000,
      cacheHitRate: 0.72,
      memoriesNew: 37,
      memoriesNewPrev: 30,
      memoryProblems: [],
      incidentsWarning: 0,
      workflowsRun: 3,
    });
    expect(fin.grade.grade).toBe("green");
    const projects = card.agents[1]!;
    expect(projects.metrics).toMatchObject({ turns: 0, firstTokenP50Ms: null, cacheHitRate: null, incidentsCritical: 1, openChecks: ["auto-linker"] });
    expect(projects.grade.grade).toBe("red");
  });

  it("a throwing store skips that agent only", async () => {
    const deps = stubDeps();
    (deps.manager as { getTraceStore: unknown }).getTraceStore = (a: string) => {
      if (a === "fin-client") throw new Error("db locked");
      return undefined;
    };
    const card = await collectFleetReportCard(deps);
    expect(card.agents.map((a) => a.metrics.agent)).toEqual(["projects"]);
  });
});

describe("runReportCardTick / schedule", () => {
  it("posts the rendered card to the admin channel", async () => {
    const posted: string[] = [];
    const r = await runReportCardTick({ ...stubDeps(), postToAdmin: async (t) => void posted.push(t) });
    expect(r).toEqual({ posted: true, agents: 2 });
    expect(posted[0]).toContain("📋 **Agent report card**");
    expect(posted[0]).toContain("🔴 **projects**");
    expect(posted[0]).toContain("🟢 **fin-client**");
  });

  it("posts nothing when there are no agents and survives a failing post", async () => {
    const none = await runReportCardTick({
      ...stubDeps({ manager: { ...stubDeps().manager, getRunningAgents: () => [] } }),
      postToAdmin: async () => {
        throw new Error("nope");
      },
    });
    expect(none).toEqual({ posted: false, agents: 0 });
    const failed = await runReportCardTick({
      ...stubDeps(),
      postToAdmin: async () => {
        throw new Error("Missing Permissions");
      },
    });
    expect(failed).toEqual({ posted: false, agents: 2 });
  });

  it("schedules Mondays 09:10 Pacific by default", () => {
    const factory = vi.fn(() => ({ stop: vi.fn() }));
    scheduleReportCardCron({ ...stubDeps(), postToAdmin: async () => {}, cronFactory: factory });
    expect(factory).toHaveBeenCalledWith("10 9 * * 1", { name: "report-card", timezone: "America/Los_Angeles" }, expect.any(Function));
  });
});
