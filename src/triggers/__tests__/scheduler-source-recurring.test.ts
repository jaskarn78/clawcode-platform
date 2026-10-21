/**
 * Phase 999.99 — SchedulerSource.addRecurringSchedule() tests.
 *
 * Backs the `schedule_recurring` MCP tool: an agent told "poll X every 5 min"
 * registers a DELIVERED recurring schedule whose every tick routes
 * SchedulerSource → TriggerEngine → the f984008 trigger-delivery callback, so
 * each tick posts a standalone message in the agent's bound channel instead of
 * self-firing a turn whose plain text output buffers in the shared driverIter
 * and drains one-per-inbound-message (the confirmed root cause in CONTEXT §2c).
 *
 * This file is the recurring twin of scheduler-source-reminder.test.ts (R1-R6)
 * and adds the SC-3 fail-open proof + the SC-4 list/cancel loop the reminder
 * path does not need.
 *
 * Test plan:
 *   REC1 — addRecurringSchedule with a valid cron returns a scheduleId and
 *          listRecurring() length grows by 1.
 *   REC2 — (SC-3 landmine) an invalid cron (the slash-90 '* / 90 * * * *'
 *          pattern) is a CLEAN throw, not a process crash — and the source is
 *          still usable afterward (a subsequent valid add succeeds → fail-open
 *          at construction).
 *   REC3 — a sub-60s effective interval (a 6-field second-level cron croner
 *          parses as <60s) throws ("min 60s").
 *   REC4 — the 9th add for one agent throws (cap 8); a DIFFERENT agent still
 *          succeeds.
 *   REC5 — _triggerRecurringForTest fires the schedule with the EXACT
 *          production event shape: sourceId='recurring:<id>', payload matches,
 *          targetAgent matches, and a PER-TICK idempotencyKey
 *          (recurring:<id>:<ts>, prefix-matched — the timestamp varies).
 *   REC6 — when the agent is locked by another schedule, the recurring tick
 *          SKIPS + does NOT call ingestFn (per-agent lock honored).
 *   REC7 — (SC-4 loop) cancelRecurring(id) returns true + removes from
 *          listRecurring(); a second cancel returns false.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SchedulerSource } from "../scheduler-source.js";
import { RecurringScheduleStore } from "../recurring-schedule-store.js";
import type { TriggerEvent } from "../types.js";
import type { ScheduleEntry } from "../../scheduler/types.js";

function makeStubOptions(overrides: {
  resolvedAgents?: Array<{ name: string; schedules: readonly ScheduleEntry[] }>;
  ingest?: (event: TriggerEvent) => Promise<void>;
} = {}) {
  const ingestFn =
    overrides.ingest ??
    vi.fn<(event: TriggerEvent) => Promise<void>>().mockResolvedValue(undefined);
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

describe("SchedulerSource.addRecurringSchedule", () => {
  let source: SchedulerSource;

  afterEach(() => {
    if (source) source.stop();
  });

  it("REC1 — returns a scheduleId and grows listRecurring() by 1", async () => {
    const opts = makeStubOptions();
    source = new SchedulerSource(opts);
    source.start();

    const before = source.listRecurring().length;
    const result = await source.addRecurringSchedule({
      cron: "*/5 * * * *",
      agentName: "agent-a",
      prompt: "poll X",
    });

    expect(result.scheduleId).toBeTruthy();
    expect(typeof result.scheduleId).toBe("string");
    expect(result.scheduleId.length).toBeGreaterThanOrEqual(4);
    expect(source.listRecurring().length).toBe(before + 1);
    expect(
      source.listRecurring().some((s) => s.scheduleId === result.scheduleId),
    ).toBe(true);
  });

  it("REC2 — (SC-3) an invalid cron `*/90` throws cleanly + source stays usable (fail-open)", async () => {
    const opts = makeStubOptions();
    source = new SchedulerSource(opts);
    source.start();

    // croner throws SYNCHRONOUSLY on `*/90` (steps > 60) — the slash-90 June
    // crash-loop precedent. The construction guard must turn that into a clean
    // rejection, NOT a process crash.
    await expect(
      source.addRecurringSchedule({
        cron: "*/90 * * * *",
        agentName: "agent-a",
        prompt: "bad",
      }),
    ).rejects.toThrow();

    // Fail-open proof: the SchedulerSource is still fully usable after the bad
    // pattern — a subsequent valid add succeeds.
    const ok = await source.addRecurringSchedule({
      cron: "*/5 * * * *",
      agentName: "agent-a",
      prompt: "good",
    });
    expect(ok.scheduleId).toBeTruthy();
    expect(source.listRecurring().length).toBe(1);
  });

  it("REC3 — a sub-60s interval throws (min 60s)", async () => {
    const opts = makeStubOptions();
    source = new SchedulerSource(opts);
    source.start();

    // A 6-field second-level cron croner parses as a 30s interval — constructs
    // OK but the nextRun-diff guard rejects it (<60s). (If a croner version
    // rejected the 6-field form outright, the assertion still holds: rejected,
    // not crashed — SC-3.)
    await expect(
      source.addRecurringSchedule({
        cron: "*/30 * * * * *",
        agentName: "agent-a",
        prompt: "too tight",
      }),
    ).rejects.toThrow(/60s/);
    expect(source.listRecurring().length).toBe(0);
  });

  it("REC4 — the 9th add for one agent throws (cap 8); a different agent still succeeds", async () => {
    const opts = makeStubOptions();
    source = new SchedulerSource(opts);
    source.start();

    // 8 valid adds for agent-a succeed.
    for (let i = 0; i < 8; i++) {
      await source.addRecurringSchedule({
        cron: "*/5 * * * *",
        agentName: "agent-a",
        prompt: `poll ${i}`,
      });
    }
    expect(
      source.listRecurring().filter((s) => s.agentName === "agent-a").length,
    ).toBe(8);

    // The 9th throws.
    await expect(
      source.addRecurringSchedule({
        cron: "*/5 * * * *",
        agentName: "agent-a",
        prompt: "over cap",
      }),
    ).rejects.toThrow(/[Tt]oo many/);

    // A DIFFERENT agent is unaffected.
    const other = await source.addRecurringSchedule({
      cron: "*/5 * * * *",
      agentName: "agent-b",
      prompt: "fine",
    });
    expect(other.scheduleId).toBeTruthy();
  });

  it("REC5 — fires with the exact production event shape (per-tick idempotencyKey)", async () => {
    const ingestFn = vi
      .fn<(event: TriggerEvent) => Promise<void>>()
      .mockResolvedValue(undefined);
    const opts = makeStubOptions({ ingest: ingestFn });
    source = new SchedulerSource(opts);
    source.start();

    const result = await source.addRecurringSchedule({
      cron: "*/5 * * * *",
      agentName: "fin-client",
      prompt: "Poll the Schwab queue and post any new requests",
    });

    await source._triggerRecurringForTest(result.scheduleId);

    expect(ingestFn).toHaveBeenCalledTimes(1);
    const event = ingestFn.mock.calls[0]![0]!;
    expect(event.sourceId).toBe(`recurring:${result.scheduleId}`);
    // PER-TICK idempotencyKey — `recurring:<id>:<ts>`; the timestamp varies per
    // fire so this MUST be a prefix match, not an equality (a static key would
    // collapse the 3-layer dedup pipeline on every tick after the first).
    expect(event.idempotencyKey.startsWith(`recurring:${result.scheduleId}:`)).toBe(
      true,
    );
    expect(event.idempotencyKey).not.toBe(`recurring:${result.scheduleId}`);
    expect(event.targetAgent).toBe("fin-client");
    expect(event.payload).toBe("Poll the Schwab queue and post any new requests");
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it("REC6 — skips when the target agent is locked (per-agent lock honored)", async () => {
    let resolveBlocking: (() => void) | undefined;
    const blocking = new Promise<void>((r) => {
      resolveBlocking = r;
    });
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

    const result = await source.addRecurringSchedule({
      cron: "*/5 * * * *",
      agentName: "agent-locked",
      prompt: "recurring payload",
    });

    // Hold the lock by firing the config schedule first (it blocks on ingestFn).
    const first = source._triggerForTest("agent-locked", "block-me");
    // Let microtasks settle so the lock is in place.
    await new Promise((r) => setTimeout(r, 10));

    // Now fire the recurring schedule — it should see the lock and skip.
    await source._triggerRecurringForTest(result.scheduleId);

    // Only the config schedule's ingest call should have happened.
    expect(ingestFn).toHaveBeenCalledTimes(1);
    expect(ingestFn.mock.calls[0]![0]!.payload).toBe("blocker");

    // Cleanup: release the blocking call.
    resolveBlocking!();
    await first;
  });

  it("REC7 — (SC-4 loop) cancelRecurring removes from listRecurring; double-cancel returns false", async () => {
    const opts = makeStubOptions();
    source = new SchedulerSource(opts);
    source.start();

    const result = await source.addRecurringSchedule({
      cron: "*/5 * * * *",
      agentName: "agent-a",
      prompt: "poll X",
    });

    // register → list shows id
    expect(
      source.listRecurring().some((s) => s.scheduleId === result.scheduleId),
    ).toBe(true);

    // cancel → returns true, list no longer shows id
    expect(await source.cancelRecurring(result.scheduleId)).toBe(true);
    expect(
      source.listRecurring().some((s) => s.scheduleId === result.scheduleId),
    ).toBe(false);

    // second cancel of the same id → false (clean no-op)
    expect(await source.cancelRecurring(result.scheduleId)).toBe(false);
  });
});

describe("SchedulerSource — durable recurring schedules (Phase 999.99 follow-up)", () => {
  let source: SchedulerSource | undefined;
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (source) {
      source.stop();
      source = undefined;
    }
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  function storePath(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), "clawcode-sched-dur-"));
    return join(tmpRoot, "recurring-schedules.json");
  }

  function makeSourceWithStore(store: RecurringScheduleStore, agents: string[] = []): SchedulerSource {
    const base = makeStubOptions({
      resolvedAgents: agents.map((name) => ({ name, schedules: [] })),
    });
    const s = new SchedulerSource({ ...base, recurringStore: store });
    s.start();
    return s;
  }

  it("REC8 — addRecurringSchedule persists to the durable store", async () => {
    const store = new RecurringScheduleStore({ filePath: storePath() });
    source = makeSourceWithStore(store);
    const r = await source.addRecurringSchedule({
      cron: "*/18 * * * *",
      agentName: "personal",
      prompt: "regulate bedroom temp",
    });
    const persisted = await store.load();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.scheduleId).toBe(r.scheduleId);
    expect(persisted[0]!.agentName).toBe("personal");
    expect(persisted[0]!.cron).toBe("*/18 * * * *");
  });

  it("REC9 — cancelRecurring removes the entry from the durable store", async () => {
    const store = new RecurringScheduleStore({ filePath: storePath() });
    source = makeSourceWithStore(store);
    const r = await source.addRecurringSchedule({
      cron: "*/18 * * * *",
      agentName: "personal",
      prompt: "x",
    });
    expect(await store.load()).toHaveLength(1);
    expect(await source.cancelRecurring(r.scheduleId)).toBe(true);
    expect(await store.load()).toHaveLength(0);
  });

  it("REC10 — restoreFromStore re-registers persisted schedules with their original id (survives restart)", async () => {
    const filePath = storePath();
    // Pre-seed the store (a prior daemon session).
    const seed = new RecurringScheduleStore({ filePath });
    await seed.add({
      scheduleId: "keep1234",
      agentName: "personal",
      cron: "*/18 * * * *",
      prompt: "regulate temp",
      createdAt: "2026-06-19T22:00:00.000Z",
    });

    // Fresh "boot": a new source + store that restores from disk.
    const store = new RecurringScheduleStore({ filePath });
    source = makeSourceWithStore(store, ["personal"]);
    expect(source.listRecurring()).toHaveLength(0);

    const res = await source.restoreFromStore(new Set(["personal"]));
    expect(res).toEqual({ restored: 1, skipped: 0 });
    const live = source.listRecurring();
    expect(live).toHaveLength(1);
    expect(live[0]!.scheduleId).toBe("keep1234"); // id preserved → cancel-by-id survives restart

    // cancel-by-id works post-restore + clears the store.
    expect(await source.cancelRecurring("keep1234")).toBe(true);
    expect(await store.load()).toHaveLength(0);
  });

  it("REC11 — restore skips a malformed (bad-cron */90) entry WITHOUT crashing boot; valid ones still load", async () => {
    const filePath = storePath();
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-06-19T22:00:00.000Z",
        schedules: [
          { scheduleId: "good5678", agentName: "personal", cron: "*/18 * * * *", prompt: "ok", createdAt: "2026-06-19T22:00:00.000Z" },
          { scheduleId: "bad90000", agentName: "personal", cron: "*/90 * * * *", prompt: "boom", createdAt: "2026-06-19T22:00:00.000Z" },
        ],
      }),
    );
    const store = new RecurringScheduleStore({ filePath });
    source = makeSourceWithStore(store, ["personal"]);

    // MUST NOT throw — the dominant failure lineage is a bad cron crashing boot.
    const res = await source.restoreFromStore(new Set(["personal"]));
    expect(res.restored).toBe(1);
    expect(res.skipped).toBe(1);
    expect(source.listRecurring().map((s) => s.scheduleId)).toEqual(["good5678"]);
  });

  it("REC12 — restore skips a schedule whose agent no longer exists", async () => {
    const filePath = storePath();
    const seed = new RecurringScheduleStore({ filePath });
    await seed.add({
      scheduleId: "ghost111",
      agentName: "deleted-agent",
      cron: "*/18 * * * *",
      prompt: "x",
      createdAt: "2026-06-19T22:00:00.000Z",
    });
    const store = new RecurringScheduleStore({ filePath });
    source = makeSourceWithStore(store, ["personal"]);
    const res = await source.restoreFromStore(new Set(["personal"]));
    expect(res).toEqual({ restored: 0, skipped: 1 });
    expect(source.listRecurring()).toHaveLength(0);
  });

  it("REC13 — a persist failure rolls back the in-memory registration and throws", async () => {
    const throwingStore = {
      load: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockRejectedValue(new Error("disk full")),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as RecurringScheduleStore;
    const base = makeStubOptions();
    source = new SchedulerSource({ ...base, recurringStore: throwingStore });
    source.start();

    await expect(
      source.addRecurringSchedule({ cron: "*/18 * * * *", agentName: "personal", prompt: "x" }),
    ).rejects.toThrow(/persist/i);

    // Rolled back — no live schedule leaked from the failed add.
    expect(source.listRecurring()).toHaveLength(0);
  });

  it("REC15 — a RESTORED schedule actually DELIVERS on tick (not merely re-registered)", async () => {
    const filePath = storePath();
    const seed = new RecurringScheduleStore({ filePath });
    await seed.add({
      scheduleId: "fire1234",
      agentName: "personal",
      cron: "*/18 * * * *",
      prompt: "regulate temp",
      createdAt: "2026-06-19T22:00:00.000Z",
    });

    const ingestFn = vi
      .fn<(event: TriggerEvent) => Promise<void>>()
      .mockResolvedValue(undefined);
    const store = new RecurringScheduleStore({ filePath });
    const base = makeStubOptions({
      ingest: ingestFn,
      resolvedAgents: [{ name: "personal", schedules: [] }],
    });
    source = new SchedulerSource({ ...base, recurringStore: store });
    source.start();
    await source.restoreFromStore(new Set(["personal"]));

    // Fire the RESTORED schedule — it must route to ingest with the production
    // event shape, proving "survives restart" means "and still fires".
    await source._triggerRecurringForTest("fire1234");
    expect(ingestFn).toHaveBeenCalledTimes(1);
    const ev = ingestFn.mock.calls[0]![0]!;
    expect(ev.sourceId).toBe("recurring:fire1234");
    expect(ev.targetAgent).toBe("personal");
    expect(ev.payload).toBe("regulate temp");
  });

  it("REC14 — stop() clears in-memory state but leaves the durable store intact", async () => {
    const filePath = storePath();
    const store = new RecurringScheduleStore({ filePath });
    source = makeSourceWithStore(store);
    await source.addRecurringSchedule({ cron: "*/18 * * * *", agentName: "personal", prompt: "x" });
    expect(source.listRecurring()).toHaveLength(1);

    source.stop();
    expect(source.listRecurring()).toHaveLength(0); // in-memory cleared
    expect(existsSync(filePath)).toBe(true);
    expect(await store.load()).toHaveLength(1); // durability survives shutdown
  });
});
