/**
 * Phase 52 Plan 03 (CACHE-03) — daemon daily-summary cron tests.
 *
 * Exercises the `scheduleDailySummaryCron` factory that daemon bootstrap
 * wires into croner. These tests verify the cron CALLBACK semantics (not the
 * real schedule) — we trigger the callback synchronously via a stub.
 *
 * Coverage:
 *   - cron callback fires `emitDailySummary` once per running agent
 *   - agents without a trace store OR usage tracker are skipped (cron
 *     keeps ticking for healthy agents even if one is mid-startup)
 *   - cron `.stop()` is returned by the factory so the shutdown path can
 *     stop the timer cleanly
 */

import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import { scheduleDailySummaryCron } from "../daily-summary-cron.js";
import type { TraceStore } from "../../performance/trace-store.js";
import type { UsageTracker } from "../../usage/tracker.js";
import type { WebhookManager } from "../../discord/webhook-manager.js";
import type { SessionManager } from "../session-manager.js";

function stubLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => stubLogger()),
  } as unknown as Logger;
}

function stubTraceStore(): TraceStore {
  return {
    getCacheTelemetry: vi.fn(() => ({
      agent: "atlas",
      since: "2026-04-12T09:00:00.000Z",
      totalTurns: 10,
      avgHitRate: 0.5,
      p50HitRate: 0.5,
      p95HitRate: 0.5,
      totalCacheReads: 100,
      totalCacheWrites: 50,
      totalInputTokens: 50,
      trendByDay: [],
    })),
  } as unknown as TraceStore;
}

function stubUsageTracker(): UsageTracker {
  return {
    getDailyUsage: vi.fn(() => ({
      tokens_in: 100,
      tokens_out: 50,
      cost_usd: 0.25,
      turns: 10,
      duration_ms: 5000,
      event_count: 10,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    })),
  } as unknown as UsageTracker;
}

function stubWebhookManager(): WebhookManager {
  return {
    hasWebhook: vi.fn(() => false),
    send: vi.fn(async () => undefined),
  } as unknown as WebhookManager;
}

describe("scheduleDailySummaryCron", () => {
  it("invokes emitDailySummary for each running agent when the cron callback fires", async () => {
    const traceStore = stubTraceStore();
    const usageTracker = stubUsageTracker();
    const webhookManager = stubWebhookManager();
    const log = stubLogger();

    const manager = {
      getRunningAgents: vi.fn(() => ["atlas", "beacon"]),
      getTraceStore: vi.fn(() => traceStore),
      getUsageTracker: vi.fn(() => usageTracker),
    } as unknown as SessionManager;

    const cron = scheduleDailySummaryCron({
      manager,
      webhookManager,
      log,
      // Inject a stub Cron so the cron doesn't actually schedule.
      cronFactory: (_pattern, _opts, callback) => ({
        stop: vi.fn(),
        // Expose callback for test-driven trigger.
        trigger: callback,
      }),
    });

    // Trigger the callback directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (cron as any).trigger();

    expect(manager.getRunningAgents).toHaveBeenCalledTimes(1);
    expect(webhookManager.hasWebhook).toHaveBeenCalledWith("atlas");
    expect(webhookManager.hasWebhook).toHaveBeenCalledWith("beacon");
    expect(log.info).toHaveBeenCalled();
  });

  it("skips agents whose trace store is missing (mid-startup race)", async () => {
    const usageTracker = stubUsageTracker();
    const webhookManager = stubWebhookManager();
    const log = stubLogger();

    const manager = {
      getRunningAgents: vi.fn(() => ["atlas", "missing"]),
      getTraceStore: vi.fn((name: string) =>
        name === "missing" ? undefined : stubTraceStore(),
      ),
      getUsageTracker: vi.fn(() => usageTracker),
    } as unknown as SessionManager;

    const cron = scheduleDailySummaryCron({
      manager,
      webhookManager,
      log,
      cronFactory: (_pattern, _opts, callback) => ({
        stop: vi.fn(),
        trigger: callback,
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (cron as any).trigger();

    // Only "atlas" reached hasWebhook (missing was skipped early).
    expect(webhookManager.hasWebhook).toHaveBeenCalledWith("atlas");
    expect(webhookManager.hasWebhook).not.toHaveBeenCalledWith("missing");
  });

  it("skips agents whose usage tracker is missing", async () => {
    const traceStore = stubTraceStore();
    const webhookManager = stubWebhookManager();
    const log = stubLogger();

    const manager = {
      getRunningAgents: vi.fn(() => ["atlas", "no-tracker"]),
      getTraceStore: vi.fn(() => traceStore),
      getUsageTracker: vi.fn((name: string) =>
        name === "no-tracker" ? undefined : stubUsageTracker(),
      ),
    } as unknown as SessionManager;

    const cron = scheduleDailySummaryCron({
      manager,
      webhookManager,
      log,
      cronFactory: (_pattern, _opts, callback) => ({
        stop: vi.fn(),
        trigger: callback,
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (cron as any).trigger();

    expect(webhookManager.hasWebhook).toHaveBeenCalledWith("atlas");
    expect(webhookManager.hasWebhook).not.toHaveBeenCalledWith("no-tracker");
  });

  it("returns a handle with a .stop() method so shutdown can clean up", () => {
    const log = stubLogger();
    const manager = {
      getRunningAgents: vi.fn(() => []),
      getTraceStore: vi.fn(),
      getUsageTracker: vi.fn(),
    } as unknown as SessionManager;

    const stopSpy = vi.fn();
    const cron = scheduleDailySummaryCron({
      manager,
      webhookManager: stubWebhookManager(),
      log,
      cronFactory: () => ({ stop: stopSpy, trigger: () => {} }),
    });

    cron.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the '0 9 * * *' cron pattern by default (09:00 daily)", () => {
    const log = stubLogger();
    const manager = {
      getRunningAgents: vi.fn(() => []),
      getTraceStore: vi.fn(),
      getUsageTracker: vi.fn(),
    } as unknown as SessionManager;

    let capturedPattern = "";
    scheduleDailySummaryCron({
      manager,
      webhookManager: stubWebhookManager(),
      log,
      cronFactory: (pattern, _opts, _callback) => {
        capturedPattern = pattern;
        return { stop: vi.fn(), trigger: () => {} };
      },
    });
    expect(capturedPattern).toBe("0 9 * * *");
  });
});
