/**
 * Phase 58 Plan 03 — runStartupReconciliation tests.
 *
 * Covers LIFE-04 (stale in-flight tasks transition to `orphaned` on daemon
 * startup). The reconciler is a pure function over TaskStore + optional Logger
 * — tests exercise it against a tmp-file-backed TaskStore so the scan path
 * hits real SQL (listStaleRunning) and the flip path hits real markOrphaned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

import { TaskStore } from "../store.js";
import {
  runStartupReconciliation,
  ORPHAN_THRESHOLD_MS,
} from "../reconciler.js";
import type { TaskRow } from "../schema.js";

/**
 * Minimal mock Logger with vi.fn() stubs on the methods the reconciler calls.
 * Satisfies the `pino.Logger` structural shape for the test caller.
 */
function mockLogger(): Logger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => log),
    level: "info",
  };
  return log as unknown as Logger;
}

/**
 * Build a minimal valid TaskRow with every one of the 15 LIFE-02 fields
 * populated. Tests override specific fields to exercise the reconciler's
 * scan + flip behaviour.
 */
function makeRow(overrides: Partial<TaskRow>): TaskRow {
  return {
    task_id: "t-x",
    task_type: "research.brief",
    caller_agent: "fin-client",
    target_agent: "fin-res",
    causation_id: "discord:abc",
    parent_task_id: null,
    depth: 0,
    input_digest: "sha256:x",
    status: "pending",
    started_at: Date.now() - 600_000,
    ended_at: null,
    heartbeat_at: Date.now(),
    result_digest: null,
    error: null,
    chain_token_cost: 0,
    ...overrides,
  };
}

describe("runStartupReconciliation", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reconciler-"));
    store = new TaskStore({ dbPath: join(dir, "tasks.db") });
  });

  afterEach(async () => {
    try {
      store.close();
    } catch {
      // already closed — ignore
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("Test 1 (LIFE-04 flagship): 3-row mix — only stale running transitions to orphaned", () => {
    const now = Date.now();
    // row A: fresh running (heartbeat 1min ago — within threshold)
    store.insert(
      makeRow({
        task_id: "A",
        status: "running",
        heartbeat_at: now - 60_000,
      }),
    );
    // row B: stale running (heartbeat 10min ago — past threshold)
    store.insert(
      makeRow({
        task_id: "B",
        status: "running",
        heartbeat_at: now - 10 * 60_000,
      }),
    );
    // row C: stale complete (heartbeat 10min ago but terminal — OUT of scope)
    store.insert(
      makeRow({
        task_id: "C",
        status: "complete",
        heartbeat_at: now - 10 * 60_000,
        ended_at: now - 10 * 60_000,
      }),
    );

    const result = runStartupReconciliation(store, 5 * 60 * 1000);

    expect(result.reconciledCount).toBe(1);
    expect([...result.reconciledTaskIds]).toEqual(["B"]);

    const a = store.get("A");
    const b = store.get("B");
    const c = store.get("C");
    expect(a?.status).toBe("running");
    expect(b?.status).toBe("orphaned");
    expect(b?.ended_at).not.toBeNull();
    // ended_at must be a recent millisecond timestamp.
    expect(b?.ended_at).toBeGreaterThanOrEqual(now - 1000);
    expect(c?.status).toBe("complete");
  });

  it("Test 2: awaiting_input is treated as in-flight — stale rows get orphaned", () => {
    const now = Date.now();
    store.insert(
      makeRow({
        task_id: "D",
        status: "awaiting_input",
        heartbeat_at: now - 10 * 60_000,
      }),
    );

    const result = runStartupReconciliation(store, 5 * 60 * 1000);

    expect(result.reconciledCount).toBe(1);
    expect([...result.reconciledTaskIds]).toEqual(["D"]);
    expect(store.get("D")?.status).toBe("orphaned");
  });

  it("Test 3 (idempotence): second pass reconciles zero rows after first pass flipped them", () => {
    const now = Date.now();
    store.insert(
      makeRow({
        task_id: "E",
        status: "running",
        heartbeat_at: now - 10 * 60_000,
      }),
    );

    const first = runStartupReconciliation(store, 5 * 60 * 1000);
    expect(first.reconciledCount).toBe(1);

    // Row E is now orphaned (terminal, not in IN_FLIGHT_STATUSES) — second
    // pass must transition zero rows.
    const second = runStartupReconciliation(store, 5 * 60 * 1000);
    expect(second.reconciledCount).toBe(0);
    expect([...second.reconciledTaskIds]).toEqual([]);
  });

  it("Test 4 (no stale rows): fresh DB with only pending rows reconciles zero", () => {
    store.insert(makeRow({ task_id: "F", status: "pending" }));

    const result = runStartupReconciliation(store, 5 * 60 * 1000);

    expect(result.reconciledCount).toBe(0);
    expect([...result.reconciledTaskIds]).toEqual([]);
  });

  it("Test 5 (logging): info called per reconciled row + once at the end", () => {
    const now = Date.now();
    store.insert(
      makeRow({
        task_id: "G",
        status: "running",
        heartbeat_at: now - 10 * 60_000,
      }),
    );
    store.insert(
      makeRow({
        task_id: "H",
        status: "awaiting_input",
        heartbeat_at: now - 10 * 60_000,
      }),
    );

    const log = mockLogger();
    const infoSpy = log.info as unknown as ReturnType<typeof vi.fn>;

    const result = runStartupReconciliation(store, 5 * 60 * 1000, log);

    expect(result.reconciledCount).toBe(2);
    // At least one info call per row + one summary call = >= 3 calls.
    expect(infoSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Every per-row call must carry taskId + priorStatus + heartbeatAgeMs.
    const perRowCalls = infoSpy.mock.calls.filter((call) => {
      const first = call[0] as Record<string, unknown> | undefined;
      return (
        first !== undefined &&
        typeof first === "object" &&
        "taskId" in first &&
        "priorStatus" in first &&
        "heartbeatAgeMs" in first
      );
    });
    expect(perRowCalls.length).toBe(2);

    // The summary call must carry reconciledCount.
    const summaryCalls = infoSpy.mock.calls.filter((call) => {
      const first = call[0] as Record<string, unknown> | undefined;
      return (
        first !== undefined &&
        typeof first === "object" &&
        "reconciledCount" in first
      );
    });
    expect(summaryCalls.length).toBe(1);
    expect((summaryCalls[0][0] as Record<string, unknown>).reconciledCount).toBe(2);
  });

  it("Test 6 (log-less is fine): calling without a logger must not throw", () => {
    const now = Date.now();
    store.insert(
      makeRow({
        task_id: "I",
        status: "running",
        heartbeat_at: now - 10 * 60_000,
      }),
    );

    // No third arg — reconciler must not throw.
    expect(() => runStartupReconciliation(store, 5 * 60 * 1000)).not.toThrow();
    // And the row was still reconciled.
    expect(store.get("I")?.status).toBe("orphaned");
  });

  it("Test 7 (threshold semantics): 4min-old row skipped at 5min threshold, caught at 3min", () => {
    const now = Date.now();
    store.insert(
      makeRow({
        task_id: "J",
        status: "running",
        heartbeat_at: now - 4 * 60_000,
      }),
    );

    // 5min threshold — 4min-old heartbeat is within threshold, NOT reconciled.
    const within = runStartupReconciliation(store, 5 * 60 * 1000);
    expect(within.reconciledCount).toBe(0);
    expect(store.get("J")?.status).toBe("running");

    // 3min threshold — 4min-old heartbeat is now stale, gets reconciled.
    const past = runStartupReconciliation(store, 3 * 60 * 1000);
    expect(past.reconciledCount).toBe(1);
    expect(store.get("J")?.status).toBe("orphaned");
  });

  it("Test 8: reconciledTaskIds is frozen", () => {
    const now = Date.now();
    store.insert(
      makeRow({
        task_id: "K",
        status: "running",
        heartbeat_at: now - 10 * 60_000,
      }),
    );

    const result = runStartupReconciliation(store, 5 * 60 * 1000);
    expect(Object.isFrozen(result.reconciledTaskIds)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("Test 9: ORPHAN_THRESHOLD_MS is exported as 5 * 60 * 1000", () => {
    expect(ORPHAN_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });
});
