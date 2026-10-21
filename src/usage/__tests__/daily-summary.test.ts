/**
 * Phase 52 Plan 03 (CACHE-03) — daily-summary emitter tests.
 *
 * Coverage:
 *   - `💾 Cache:` line included when totalTurns > 0 (CONTEXT D-03 format)
 *   - `💾 Cache:` line OMITTED when totalTurns === 0 (BLOCKER-1 checker
 *     guidance: idle-day summaries stay clean)
 *   - Hit rate rendered with one decimal (72.3%, not 72.333%)
 *   - emitDailySummary uses webhookManager.send when configured
 *   - emitDailySummary logs info (not error) when no webhook — graceful drop
 */

import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import { buildDailySummaryEmbed, emitDailySummary } from "../daily-summary.js";
import type { TraceStore } from "../../performance/trace-store.js";
import type { CacheTelemetryReport } from "../../performance/types.js";
import type { UsageTracker } from "../tracker.js";
import type { UsageAggregate } from "../types.js";
import type { WebhookManager } from "../../discord/webhook-manager.js";

function makeCacheReport(
  overrides: Partial<CacheTelemetryReport> = {},
): CacheTelemetryReport {
  return Object.freeze({
    agent: "atlas",
    since: "2026-04-12T09:00:00.000Z",
    totalTurns: 50,
    avgHitRate: 0.72,
    p50HitRate: 0.75,
    p95HitRate: 0.50,
    totalCacheReads: 5000,
    totalCacheWrites: 1000,
    totalInputTokens: 1000,
    trendByDay: Object.freeze([]),
    ...overrides,
  });
}

function makeUsageAggregate(
  overrides: Partial<UsageAggregate> = {},
): UsageAggregate {
  return Object.freeze({
    tokens_in: 1000,
    tokens_out: 500,
    cost_usd: 1.23,
    turns: 50,
    duration_ms: 60000,
    event_count: 50,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    ...overrides,
  });
}

function stubTraceStore(cache: CacheTelemetryReport): TraceStore {
  return {
    getCacheTelemetry: vi.fn(() => cache),
  } as unknown as TraceStore;
}

function stubUsageTracker(usage: UsageAggregate): UsageTracker {
  return {
    getDailyUsage: vi.fn(() => usage),
  } as unknown as UsageTracker;
}

function stubLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => stubLogger()),
  } as unknown as Logger;
}

const FIXED_NOW = new Date("2026-04-13T09:00:00.000Z");

describe("buildDailySummaryEmbed", () => {
  it("includes 💾 Cache line when totalTurns > 0 (CONTEXT D-03 verbatim format)", () => {
    const traceStore = stubTraceStore(makeCacheReport());
    const usageTracker = stubUsageTracker(makeUsageAggregate());
    const embed = buildDailySummaryEmbed({
      agent: "atlas",
      traceStore,
      usageTracker,
      now: FIXED_NOW,
    });
    expect(embed.description).toContain("💾 Cache: 72.0% over 50 turns");
  });

  it("OMITS 💾 Cache line when totalTurns === 0 (idle-day — BLOCKER-1 checker guidance)", () => {
    const traceStore = stubTraceStore(
      makeCacheReport({ totalTurns: 0, avgHitRate: 0 }),
    );
    const usageTracker = stubUsageTracker(makeUsageAggregate({ turns: 0 }));
    const embed = buildDailySummaryEmbed({
      agent: "atlas",
      traceStore,
      usageTracker,
      now: FIXED_NOW,
    });
    expect(embed.description).not.toContain("💾");
    expect(embed.description).not.toContain("Cache:");
    // Cost line is still present — idle day suppresses cache only.
    expect(embed.description).toContain("💵 Cost:");
  });

  it("renders hit rate with one decimal (72.3% not 72.333%)", () => {
    const traceStore = stubTraceStore(
      makeCacheReport({ totalTurns: 10, avgHitRate: 0.7234 }),
    );
    const usageTracker = stubUsageTracker(makeUsageAggregate());
    const embed = buildDailySummaryEmbed({
      agent: "atlas",
      traceStore,
      usageTracker,
      now: FIXED_NOW,
    });
    expect(embed.description).toContain("💾 Cache: 72.3%");
    expect(embed.description).not.toContain("72.34");
    expect(embed.description).not.toContain("72.3400");
  });

  it("renders the cost line with cost_usd, tokens_in, tokens_out, turns", () => {
    const traceStore = stubTraceStore(makeCacheReport());
    const usageTracker = stubUsageTracker(
      makeUsageAggregate({
        tokens_in: 12345,
        tokens_out: 6789,
        cost_usd: 2.5,
        turns: 42,
      }),
    );
    const embed = buildDailySummaryEmbed({
      agent: "atlas",
      traceStore,
      usageTracker,
      now: FIXED_NOW,
    });
    expect(embed.description).toContain("💵 Cost: $2.50");
    expect(embed.description).toContain("12345 in / 6789 out");
    expect(embed.description).toContain("42 turns");
  });

  it("uses the day key derived from `now` (YYYY-MM-DD) for the title and daily usage lookup", () => {
    const traceStore = stubTraceStore(makeCacheReport());
    const usageTracker = stubUsageTracker(makeUsageAggregate());
    const embed = buildDailySummaryEmbed({
      agent: "atlas",
      traceStore,
      usageTracker,
      now: FIXED_NOW, // 2026-04-13
    });
    expect(embed.title).toContain("2026-04-13");
    expect(usageTracker.getDailyUsage).toHaveBeenCalledWith("2026-04-13");
  });

  it("queries cache telemetry with a 24h-ago ISO cutoff derived from `now`", () => {
    const traceStore = stubTraceStore(makeCacheReport());
    const usageTracker = stubUsageTracker(makeUsageAggregate());
    buildDailySummaryEmbed({
      agent: "atlas",
      traceStore,
      usageTracker,
      now: FIXED_NOW,
    });
    // 2026-04-13T09:00:00 minus 24h = 2026-04-12T09:00:00.000Z
    expect(traceStore.getCacheTelemetry).toHaveBeenCalledWith(
      "atlas",
      "2026-04-12T09:00:00.000Z",
    );
  });

  it("puts the agent name in the header line", () => {
    const traceStore = stubTraceStore(makeCacheReport({ agent: "beacon" }));
    const usageTracker = stubUsageTracker(makeUsageAggregate());
    const embed = buildDailySummaryEmbed({
      agent: "beacon",
      traceStore,
      usageTracker,
      now: FIXED_NOW,
    });
    expect(embed.description).toContain("📊 Daily summary for beacon");
  });
});

describe("emitDailySummary", () => {
  it("calls webhookManager.send with the embed content when webhook is configured", async () => {
    const traceStore = stubTraceStore(makeCacheReport());
    const usageTracker = stubUsageTracker(makeUsageAggregate());
    const log = stubLogger();
    const sendSpy = vi.fn<(agentName: string, content: string) => Promise<void>>(async () => undefined);
    const webhookManager = {
      hasWebhook: vi.fn(() => true),
      send: sendSpy,
    } as unknown as WebhookManager;

    await emitDailySummary({
      agent: "atlas",
      traceStore,
      usageTracker,
      now: FIXED_NOW,
      webhookManager,
      log,
    });

    expect(webhookManager.hasWebhook).toHaveBeenCalledWith("atlas");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [sentAgent, sentContent] = sendSpy.mock.calls[0]!;
    expect(sentAgent).toBe("atlas");
    expect(sentContent).toContain("📊 Daily summary for atlas");
    expect(sentContent).toContain("💾 Cache:");
  });

  it("logs info (not error) when no webhook configured — graceful drop", async () => {
    const traceStore = stubTraceStore(makeCacheReport());
    const usageTracker = stubUsageTracker(makeUsageAggregate());
    const log = stubLogger();
    const sendSpy = vi.fn<(agentName: string, content: string) => Promise<void>>(async () => undefined);
    const webhookManager = {
      hasWebhook: vi.fn(() => false),
      send: sendSpy,
    } as unknown as WebhookManager;

    await emitDailySummary({
      agent: "atlas",
      traceStore,
      usageTracker,
      now: FIXED_NOW,
      webhookManager,
      log,
    });

    expect(sendSpy).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    const infoArgs = (log.info as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(infoArgs[0]).toMatchObject({ agent: "atlas" });
    expect(typeof infoArgs[1]).toBe("string");
    expect(infoArgs[1]).toContain("no webhook");
  });

  it("logs warn (not throw) when webhookManager.send rejects", async () => {
    const traceStore = stubTraceStore(makeCacheReport());
    const usageTracker = stubUsageTracker(makeUsageAggregate());
    const log = stubLogger();
    const webhookManager = {
      hasWebhook: vi.fn(() => true),
      send: vi.fn(async () => {
        throw new Error("discord 429");
      }),
    } as unknown as WebhookManager;

    // Must NOT throw — daemon cron keeps ticking even on a single agent's failure.
    await expect(
      emitDailySummary({
        agent: "atlas",
        traceStore,
        usageTracker,
        now: FIXED_NOW,
        webhookManager,
        log,
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("includes 💾 Cache line in the webhook content when turns > 0", async () => {
    const traceStore = stubTraceStore(
      makeCacheReport({ totalTurns: 25, avgHitRate: 0.65 }),
    );
    const usageTracker = stubUsageTracker(makeUsageAggregate());
    const log = stubLogger();
    const sendSpy = vi.fn<(agentName: string, content: string) => Promise<void>>(async () => undefined);
    const webhookManager = {
      hasWebhook: vi.fn(() => true),
      send: sendSpy,
    } as unknown as WebhookManager;

    await emitDailySummary({
      agent: "atlas",
      traceStore,
      usageTracker,
      now: FIXED_NOW,
      webhookManager,
      log,
    });

    const content = sendSpy.mock.calls[0]![1]!;
    expect(content).toContain("💾 Cache: 65.0% over 25 turns");
  });

  it("OMITS 💾 Cache line in the webhook content when turns === 0 (idle day)", async () => {
    const traceStore = stubTraceStore(
      makeCacheReport({ totalTurns: 0, avgHitRate: 0 }),
    );
    const usageTracker = stubUsageTracker(makeUsageAggregate({ turns: 0 }));
    const log = stubLogger();
    const sendSpy = vi.fn<(agentName: string, content: string) => Promise<void>>(async () => undefined);
    const webhookManager = {
      hasWebhook: vi.fn(() => true),
      send: sendSpy,
    } as unknown as WebhookManager;

    await emitDailySummary({
      agent: "atlas",
      traceStore,
      usageTracker,
      now: FIXED_NOW,
      webhookManager,
      log,
    });

    const content = sendSpy.mock.calls[0]![1]!;
    expect(content).not.toContain("💾");
    expect(content).toContain("💵 Cost:");
  });
});
