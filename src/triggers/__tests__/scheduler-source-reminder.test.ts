/**
 * Phase 100 follow-up — SchedulerSource.addOneShotReminder() tests.
 *
 * Backs the `schedule_reminder` MCP tool (set ad-hoc one-off reminders that
 * fire as standalone turns and post via the trigger-delivery callback wired
 * in commit f984008). Operator surfaced 2026-04-27: agents promise "ping me
 * at 7:58 PM" but have no scheduling primitive — the reminder gets stuck in
 * conversation context and bleeds into the next inbound turn instead of
 * firing as its own message.
 *
 * Test plan:
 *   R1 — addOneShotReminder with future date returns reminderId + registers
 *        a cron job (cronJobs array length grows by 1).
 *   R2 — past date throws "must be in the future".
 *   R3 — >30 days out throws.
 *   R4 — NaN date throws "Invalid fireAt".
 *   R5 — Firing the reminder (via _triggerReminderForTest) calls ingestFn
 *        with the right event shape: sourceId='reminder:<id>', payload
 *        matches prompt, targetAgent matches, idempotencyKey scoped per
 *        reminder.
 *   R6 — When the agent is locked by another schedule, the reminder skips +
 *        does NOT call ingestFn (mirrors per-agent lock behavior of the
 *        recurring scheduler-source path).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { SchedulerSource } from "../scheduler-source.js";
import type { TriggerEvent } from "../types.js";
import type { ScheduleEntry } from "../../scheduler/types.js";

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

describe("SchedulerSource.addOneShotReminder", () => {
  let source: SchedulerSource;

  afterEach(() => {
    if (source) source.stop();
  });

  it("R1 — returns reminderId and schedules a cron job for a future date", async () => {
    const opts = makeStubOptions();
    source = new SchedulerSource(opts);
    source.start();

    const beforeCount = (source as any).cronJobs.length;
    const result = await source.addOneShotReminder({
      fireAt: new Date(Date.now() + 60_000),
      agentName: "agent-a",
      prompt: "Ping check",
    });

    expect(result.reminderId).toBeTruthy();
    expect(typeof result.reminderId).toBe("string");
    expect(result.reminderId.length).toBeGreaterThanOrEqual(4);
    // A new cron job must have been added.
    expect((source as any).cronJobs.length).toBe(beforeCount + 1);
  });

  it("R2 — throws when fireAt is in the past", async () => {
    const opts = makeStubOptions();
    source = new SchedulerSource(opts);
    source.start();

    await expect(
      source.addOneShotReminder({
        fireAt: new Date(Date.now() - 5_000),
        agentName: "agent-a",
        prompt: "too late",
      }),
    ).rejects.toThrow(/must be in the future/);
  });

  it("R3 — throws when fireAt is more than 30 days in the future", async () => {
    const opts = makeStubOptions();
    source = new SchedulerSource(opts);
    source.start();

    await expect(
      source.addOneShotReminder({
        fireAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
        agentName: "agent-a",
        prompt: "too far",
      }),
    ).rejects.toThrow(/30 days/);
  });

  it("R4 — throws when fireAt is an invalid Date (NaN)", async () => {
    const opts = makeStubOptions();
    source = new SchedulerSource(opts);
    source.start();

    await expect(
      source.addOneShotReminder({
        fireAt: new Date("not a date"),
        agentName: "agent-a",
        prompt: "garbage",
      }),
    ).rejects.toThrow(/Invalid fireAt/);
  });

  it("R5 — fires reminder with correct event shape via _triggerReminderForTest", async () => {
    const ingestFn = vi.fn<(event: TriggerEvent) => Promise<void>>().mockResolvedValue(undefined);
    const opts = makeStubOptions({ ingest: ingestFn });
    source = new SchedulerSource(opts);
    source.start();

    const result = await source.addOneShotReminder({
      fireAt: new Date(Date.now() + 60_000),
      agentName: "fin-client",
      prompt: "Reset — pinging you at 7:58 PM PT (status check)",
    });

    // Manually fire the reminder.
    await source._triggerReminderForTest(result.reminderId);

    expect(ingestFn).toHaveBeenCalledTimes(1);
    const event = ingestFn.mock.calls[0]![0]!;
    expect(event.sourceId).toBe(`reminder:${result.reminderId}`);
    expect(event.idempotencyKey).toBe(`reminder:${result.reminderId}`);
    expect(event.targetAgent).toBe("fin-client");
    expect(event.payload).toBe("Reset — pinging you at 7:58 PM PT (status check)");
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it("R6 — skips when the target agent is locked (per-agent lock honored)", async () => {
    let resolveBlocking: (() => void) | undefined;
    const blocking = new Promise<void>((r) => { resolveBlocking = r; });
    let callCount = 0;
    const ingestFn = vi.fn<(event: TriggerEvent) => Promise<void>>(async () => {
      callCount++;
      if (callCount === 1) {
        await blocking;
      }
    });

    const baseSchedule: ScheduleEntry = {
      name: "block-me",
      cron: "0 9 * * *",
      prompt: "blocker",
      enabled: true,
    };
    const opts = makeStubOptions({
      resolvedAgents: [{ name: "agent-locked", schedules: [baseSchedule] }],
      ingest: ingestFn,
    });
    source = new SchedulerSource(opts);
    source.start();

    // Add a reminder for the same agent.
    const result = await source.addOneShotReminder({
      fireAt: new Date(Date.now() + 60_000),
      agentName: "agent-locked",
      prompt: "reminder payload",
    });

    // Hold the lock by firing the recurring schedule first (it blocks on
    // ingestFn pending resolution).
    const first = source._triggerForTest("agent-locked", "block-me");
    // Let microtasks settle so the lock is in place.
    await new Promise((r) => setTimeout(r, 10));

    // Now fire the reminder — it should see the lock and skip.
    await source._triggerReminderForTest(result.reminderId);

    // Only the recurring schedule's ingest call should have happened.
    expect(ingestFn).toHaveBeenCalledTimes(1);
    expect(ingestFn.mock.calls[0]![0]!.payload).toBe("blocker");

    // Cleanup: release the blocking call.
    resolveBlocking!();
    await first;
  });
});
