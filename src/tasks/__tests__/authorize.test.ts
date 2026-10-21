/**
 * Phase 59 Plan 01 Task 3 — authorize.ts pure-function tests.
 *
 * 16 tests covering checkSelfHandoff, checkDepth, checkAllowlist, checkCycle,
 * plus MAX_PAYLOAD_BYTES constant.
 */

import { describe, it, expect, vi } from "vitest";
import {
  checkSelfHandoff,
  checkDepth,
  checkAllowlist,
  checkCycle,
  MAX_PAYLOAD_BYTES,
} from "../authorize.js";
import {
  SelfHandoffBlockedError,
  DepthExceededError,
  UnauthorizedError,
  CycleDetectedError,
} from "../errors.js";
import type { TaskRow } from "../schema.js";

function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: "task_0",
    task_type: "research.brief",
    caller_agent: "caller",
    target_agent: "target",
    causation_id: "discord:root",
    parent_task_id: null,
    depth: 0,
    input_digest: "sha256:deadbeef",
    status: "running",
    started_at: 0,
    ended_at: null,
    heartbeat_at: 0,
    result_digest: null,
    error: null,
    chain_token_cost: 0,
    ...overrides,
  };
}

describe("checkSelfHandoff", () => {
  it("Test 1: throws SelfHandoffBlockedError when caller === target", () => {
    try {
      checkSelfHandoff("A", "A");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SelfHandoffBlockedError);
      expect((err as SelfHandoffBlockedError).agent).toBe("A");
    }
  });

  it("Test 2: returns undefined when caller !== target", () => {
    expect(checkSelfHandoff("A", "B")).toBeUndefined();
  });
});

describe("checkDepth", () => {
  it("Test 3: throws DepthExceededError when depth > max", () => {
    try {
      checkDepth(6, 5);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DepthExceededError);
      expect((err as DepthExceededError).depth).toBe(6);
      expect((err as DepthExceededError).max).toBe(5);
    }
  });

  it("Test 4: returns undefined at boundary (depth === max)", () => {
    expect(checkDepth(5, 5)).toBeUndefined();
  });

  it("Test 5: returns undefined at depth 0", () => {
    expect(checkDepth(0, 5)).toBeUndefined();
  });
});

describe("checkAllowlist", () => {
  it("Test 6: default deny when acceptsTasks undefined or empty", () => {
    expect(() =>
      checkAllowlist({ name: "B" }, "A", "research.brief"),
    ).toThrow(UnauthorizedError);
    expect(() =>
      checkAllowlist({ name: "B", acceptsTasks: {} }, "A", "research.brief"),
    ).toThrow(UnauthorizedError);
  });

  it("Test 7: explicit deny when caller not in list", () => {
    expect(() =>
      checkAllowlist(
        { name: "B", acceptsTasks: { "research.brief": ["C"] } },
        "A",
        "research.brief",
      ),
    ).toThrow(UnauthorizedError);
  });

  it("Test 8: allow when caller in list", () => {
    expect(
      checkAllowlist(
        { name: "B", acceptsTasks: { "research.brief": ["A", "C"] } },
        "A",
        "research.brief",
      ),
    ).toBeUndefined();
  });

  it("Test 9: wrong schema is deny (even if caller allowed elsewhere)", () => {
    expect(() =>
      checkAllowlist(
        { name: "B", acceptsTasks: { "other.schema": ["A"] } },
        "A",
        "research.brief",
      ),
    ).toThrow(UnauthorizedError);
  });
});

describe("checkCycle", () => {
  it("Test 10: returns undefined when parentTaskId is null", () => {
    const store = { get: vi.fn(() => null) };
    expect(checkCycle(store, "B", null, 5)).toBeUndefined();
    expect(store.get).not.toHaveBeenCalled();
  });

  it("Test 11: returns undefined when short chain has no target match", () => {
    const chain: Record<string, TaskRow> = {
      parent: makeRow({
        task_id: "parent",
        caller_agent: "X",
        target_agent: "Y",
        parent_task_id: null,
      }),
    };
    const store = { get: vi.fn((id: string) => chain[id] ?? null) };
    expect(checkCycle(store, "B", "parent", 5)).toBeUndefined();
  });

  it("Test 12: throws CycleDetectedError when target is caller_agent in chain", () => {
    const chain: Record<string, TaskRow> = {
      p1: makeRow({
        task_id: "p1",
        caller_agent: "B", // <-- target matches here
        target_agent: "Z",
        parent_task_id: null,
      }),
    };
    const store = { get: vi.fn((id: string) => chain[id] ?? null) };
    try {
      checkCycle(store, "B", "p1", 5);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CycleDetectedError);
      const cde = err as CycleDetectedError;
      expect(cde.target).toBe("B");
      expect(cde.foundAtTaskId).toBe("p1");
    }
  });

  it("Test 13: throws CycleDetectedError when target is target_agent in chain", () => {
    const chain: Record<string, TaskRow> = {
      p1: makeRow({
        task_id: "p1",
        caller_agent: "X",
        target_agent: "B", // <-- target matches here
        parent_task_id: null,
      }),
    };
    const store = { get: vi.fn((id: string) => chain[id] ?? null) };
    expect(() => checkCycle(store, "B", "p1", 5)).toThrow(CycleDetectedError);
  });

  it("Test 14: bounded walk — stops at maxDepth even on long chains", () => {
    // Build a chain of 100 rows: p0 -> p1 -> ... -> p99. Target never appears.
    const chain: Record<string, TaskRow> = {};
    for (let i = 0; i < 100; i += 1) {
      chain[`p${i}`] = makeRow({
        task_id: `p${i}`,
        caller_agent: "X",
        target_agent: "Y",
        parent_task_id: i < 99 ? `p${i + 1}` : null,
      });
    }
    const getSpy = vi.fn((id: string) => chain[id] ?? null);
    const store = { get: getSpy };

    expect(checkCycle(store, "never-present", "p0", 5)).toBeUndefined();
    expect(getSpy.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("Test 15: broken chain (missing parent) terminates gracefully", () => {
    const chain: Record<string, TaskRow> = {
      p1: makeRow({
        task_id: "p1",
        caller_agent: "X",
        target_agent: "Y",
        parent_task_id: "nonexistent",
      }),
    };
    const store = { get: vi.fn((id: string) => chain[id] ?? null) };
    expect(checkCycle(store, "B", "p1", 5)).toBeUndefined();
  });
});

describe("MAX_PAYLOAD_BYTES", () => {
  it("Test 16: equals 65536 exactly (64 KB per HAND-02)", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(65536);
    expect(MAX_PAYLOAD_BYTES).toBe(64 * 1024);
  });
});
