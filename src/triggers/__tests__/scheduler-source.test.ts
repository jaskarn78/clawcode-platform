/**
 * Phase 60 Plan 03 Task 1 — SchedulerSource adapter tests.
 *
 * Tests the adapter that wraps prompt-based cron schedules as a
 * TriggerSource, routing fires through engine.ingest() instead of
 * directly through TurnDispatcher. Handler-based schedules (memory
 * consolidation, etc.) are NOT ingested — they bypass the engine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { SchedulerSource } from "../scheduler-source.js";
import type { TriggerEvent } from "../types.js";
import type { ScheduleEntry } from "../../scheduler/types.js";

/**
 * Minimal stub for the options SchedulerSource needs.
 */
function makeStubOptions(overrides: {
  resolvedAgents?: Array<{ name: string; schedules: readonly ScheduleEntry[] }>;
  ingest?: (event: TriggerEvent) => Promise<void>;
} = {}) {
  const ingestFn = overrides.ingest ?? vi.fn<(event: TriggerEvent) => Promise<void>>().mockResolvedValue(undefined);
  return {
    resolvedAgents: overrides.resolvedAgents ?? [],
    sessionManager: {} as any,
    turnDispatcher: {} as any,
    ingest: ingestFn,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as any,
  };
}

describe("SchedulerSource", () => {
  let source: SchedulerSource;

  afterEach(() => {
    if (source) source.stop();
  });

  it("has sourceId 'scheduler'", () => {
    const opts = makeStubOptions();
    source = new SchedulerSource(opts);
    expect(source.sourceId).toBe("scheduler");
  });

  it("start creates cron jobs and fires ingest on tick", async () => {
    const ingestFn = vi.fn<(event: TriggerEvent) => Promise<void>>().mockResolvedValue(undefined);
    const schedules: ScheduleEntry[] = [
      { name: "daily-report", cron: "0 9 * * *", prompt: "Generate daily report", enabled: true },
    ];
    const opts = makeStubOptions({
      resolvedAgents: [{ name: "agent-a", schedules }],
      ingest: ingestFn,
    });
    source = new SchedulerSource(opts);
    source.start();

    // Trigger manually via the test helper
    await source._triggerForTest("agent-a", "daily-report");

    expect(ingestFn).toHaveBeenCalledTimes(1);
    const event = ingestFn.mock.calls[0]![0]!;
    expect(event.sourceId).toBe("scheduler");
    expect(event.targetAgent).toBe("agent-a");
    expect(event.payload).toBe("Generate daily report");
    expect(event.idempotencyKey).toMatch(/^daily-report:/);
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it("handler-based schedules are not ingested", () => {
    const ingestFn = vi.fn<(event: TriggerEvent) => Promise<void>>().mockResolvedValue(undefined);
    const handlerSchedule: ScheduleEntry = {
      name: "memory-consolidation",
      cron: "0 3 * * *",
      enabled: true,
      handler: async () => {},
    };
    const promptSchedule: ScheduleEntry = {
      name: "daily-briefing",
      cron: "0 8 * * *",
      prompt: "Brief me",
      enabled: true,
    };
    const opts = makeStubOptions({
      resolvedAgents: [{ name: "agent-b", schedules: [handlerSchedule, promptSchedule] }],
      ingest: ingestFn,
    });
    source = new SchedulerSource(opts);
    source.start();

    // Only the prompt schedule should be registered
    expect(source.promptScheduleCount).toBe(1);
  });

  it("disabled schedules are not registered", () => {
    const ingestFn = vi.fn<(event: TriggerEvent) => Promise<void>>().mockResolvedValue(undefined);
    const disabled: ScheduleEntry = {
      name: "off",
      cron: "0 8 * * *",
      prompt: "Nope",
      enabled: false,
    };
    const opts = makeStubOptions({
      resolvedAgents: [{ name: "agent-c", schedules: [disabled] }],
      ingest: ingestFn,
    });
    source = new SchedulerSource(opts);
    source.start();
    expect(source.promptScheduleCount).toBe(0);
  });

  it("stop clears all cron jobs", async () => {
    const opts = makeStubOptions({
      resolvedAgents: [{
        name: "agent-d",
        schedules: [{ name: "s1", cron: "* * * * *", prompt: "p1", enabled: true }],
      }],
    });
    source = new SchedulerSource(opts);
    source.start();
    expect(source.promptScheduleCount).toBe(1);
    source.stop();
    // After stop, triggering should throw (no triggers left)
    await expect(source._triggerForTest("agent-d", "s1")).rejects.toThrow();
  });

  it("poll returns missed ticks since watermark", async () => {
    const twoMinAgo = Date.now() - 120_000;
    const opts = makeStubOptions({
      resolvedAgents: [{
        name: "agent-e",
        schedules: [{ name: "every-minute", cron: "* * * * *", prompt: "tick", enabled: true }],
      }],
    });
    source = new SchedulerSource(opts);
    source.start();

    const events = await source.poll(String(twoMinAgo));
    // With a 2-minute window and * * * * * cron, we expect ~2 events
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(3); // allow some wiggle
    for (const evt of events) {
      expect(evt.sourceId).toBe("scheduler");
      expect(evt.targetAgent).toBe("agent-e");
      expect(evt.idempotencyKey).toMatch(/^every-minute:/);
      expect(evt.timestamp).toBeGreaterThanOrEqual(twoMinAgo);
    }
  });

  it("poll returns empty when since is null", async () => {
    const opts = makeStubOptions({
      resolvedAgents: [{
        name: "agent-f",
        schedules: [{ name: "hourly", cron: "0 * * * *", prompt: "h", enabled: true }],
      }],
    });
    source = new SchedulerSource(opts);
    source.start();

    const events = await source.poll(null);
    // With null since, we start from now — no missed ticks
    expect(events).toEqual([]);
  });

  it("poll skips handler-based schedules", async () => {
    const twoMinAgo = Date.now() - 120_000;
    const opts = makeStubOptions({
      resolvedAgents: [{
        name: "agent-g",
        schedules: [
          { name: "handler-sched", cron: "* * * * *", enabled: true, handler: async () => {} },
        ],
      }],
    });
    source = new SchedulerSource(opts);
    source.start();

    const events = await source.poll(String(twoMinAgo));
    expect(events).toEqual([]);
  });

  it("per-agent lock prevents concurrent ingest", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstCallBlocking = new Promise<void>((r) => { resolveFirst = r; });
    let callCount = 0;
    const ingestFn = vi.fn<(event: TriggerEvent) => Promise<void>>(async () => {
      callCount++;
      if (callCount === 1) {
        await firstCallBlocking;
      }
    });

    const opts = makeStubOptions({
      resolvedAgents: [{
        name: "agent-h",
        schedules: [
          { name: "s1", cron: "0 9 * * *", prompt: "p1", enabled: true },
          { name: "s2", cron: "0 10 * * *", prompt: "p2", enabled: true },
        ],
      }],
      ingest: ingestFn,
    });
    source = new SchedulerSource(opts);
    source.start();

    // First trigger starts and blocks
    const first = source._triggerForTest("agent-h", "s1");
    // Let microtasks settle
    await new Promise((r) => setTimeout(r, 10));

    // Second trigger should be skipped (locked)
    await source._triggerForTest("agent-h", "s2");

    // s2 should have been skipped — ingest called only once so far
    expect(ingestFn).toHaveBeenCalledTimes(1);

    // Release first call
    resolveFirst!();
    await first;
  });
});
