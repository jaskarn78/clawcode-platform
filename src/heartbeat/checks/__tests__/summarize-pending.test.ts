/**
 * Phase 99-C — unit tests for the summarize-pending heartbeat check.
 *
 * Verifies the check delegates to SessionManager.summarizePendingSessions,
 * surfaces the per-cycle counts in metadata, and respects the per-agent
 * concurrency lock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import summarizePendingCheck, {
  _resetLock,
} from "../summarize-pending.js";
import type { CheckContext, CheckResult } from "../../types.js";

function makeContext(overrides: {
  summarizePendingSessions: ReturnType<typeof vi.fn>;
  agentName?: string;
}): CheckContext {
  const sessionManager = {
    summarizePendingSessions: overrides.summarizePendingSessions,
  } as unknown as CheckContext["sessionManager"];

  return {
    agentName: overrides.agentName ?? "test-agent",
    sessionManager,
    registry: {} as CheckContext["registry"],
    config: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.8, criticalThreshold: 0.95 },
    },
  };
}

describe("summarize-pending heartbeat check", () => {
  beforeEach(() => {
    _resetLock();
  });

  it("returns healthy with counts in metadata when summarizePendingSessions resolves", async () => {
    const stub = vi.fn().mockResolvedValue({
      attempted: 5,
      summarized: 4,
      skipped: 1,
    });
    const result: CheckResult = await summarizePendingCheck.execute(
      makeContext({ summarizePendingSessions: stub }),
    );

    expect(result.status).toBe("healthy");
    expect(result.message).toContain("attempted 5");
    expect(result.message).toContain("summarized 4");
    expect(result.message).toContain("skipped 1");
    expect(result.metadata).toEqual({
      attempted: 5,
      summarized: 4,
      skipped: 1,
    });
    expect(stub).toHaveBeenCalledWith("test-agent", 5);
  });

  it("returns warning when SessionManager call rejects", async () => {
    const stub = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await summarizePendingCheck.execute(
      makeContext({ summarizePendingSessions: stub }),
    );

    expect(result.status).toBe("warning");
    expect(result.message).toContain("boom");
  });

  it("skips a second concurrent run for the same agent (per-agent lock)", async () => {
    let resolve!: (v: {
      attempted: number;
      summarized: number;
      skipped: number;
    }) => void;
    const slowStub = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );

    const context = makeContext({ summarizePendingSessions: slowStub });
    const first = summarizePendingCheck.execute(context);
    // Second invocation while the first is still pending should short-circuit.
    const second = await summarizePendingCheck.execute(context);

    expect(second.status).toBe("healthy");
    expect(second.metadata).toEqual({ skipped: true });
    expect(slowStub).toHaveBeenCalledTimes(1);

    // Let the first run finish so vitest doesn't keep the promise open.
    resolve({ attempted: 0, summarized: 0, skipped: 0 });
    await first;
  });

  it("releases the lock after the SessionManager call settles (next tick succeeds)", async () => {
    const stub = vi
      .fn()
      .mockResolvedValueOnce({ attempted: 1, summarized: 1, skipped: 0 })
      .mockResolvedValueOnce({ attempted: 2, summarized: 2, skipped: 0 });

    const ctx = makeContext({ summarizePendingSessions: stub });
    const r1 = await summarizePendingCheck.execute(ctx);
    const r2 = await summarizePendingCheck.execute(ctx);

    expect(r1.metadata).toEqual({ attempted: 1, summarized: 1, skipped: 0 });
    expect(r2.metadata).toEqual({ attempted: 2, summarized: 2, skipped: 0 });
    expect(stub).toHaveBeenCalledTimes(2);
  });
});

describe("summarize-pending — Phase 999.119 fork skip", () => {
  beforeEach(() => {
    _resetLock();
  });

  it("does not drain a fork's backlog — the parent's heartbeat owns that store", async () => {
    const stub = vi.fn().mockResolvedValue({ attempted: 0, summarized: 0, skipped: 0 });
    const result = await summarizePendingCheck.execute(
      makeContext({ summarizePendingSessions: stub, agentName: "personal-fork-GccQQp" }),
    );
    expect(result.status).toBe("healthy");
    expect(result.metadata).toEqual({ skipped: true, reason: "shared-parent-store" });
    expect(stub).not.toHaveBeenCalled();
  });
});
