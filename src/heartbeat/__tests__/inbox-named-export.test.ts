// src/heartbeat/__tests__/inbox-named-export.test.ts
//
// Phase 999.8 Plan 03 — HB-03 regression guard.
//
// daemon.ts:2120 dynamically imports `setInboxSourceActive` from inbox.ts:
//   const { setInboxSourceActive } = await import("../heartbeat/checks/inbox.js");
//
// The new static check-registry consumes only the DEFAULT export. If a future
// refactor accidentally drops the named export (assuming the registry covers
// everything), the daemon crashes at boot when InboxSource registers.
//
// This test is intentionally "born green" — it pins the contract so any
// removal of either export trips the suite.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import inboxCheck, { setInboxSourceActive } from "../checks/inbox.js";
import type { CheckContext, HeartbeatConfig } from "../types.js";

describe("inbox.ts export surface (HB-03 regression guard)", () => {
  it("retains the named export `setInboxSourceActive` for daemon.ts:2120", () => {
    expect(typeof setInboxSourceActive).toBe("function");
  });

  it("retains the default export for the heartbeat registry", () => {
    expect(inboxCheck).toBeDefined();
    expect(typeof inboxCheck.name).toBe("string");
    expect(inboxCheck.name).toBe("inbox");
    expect(typeof inboxCheck.execute).toBe("function");
  });
});

/**
 * Phase 999.12 HB-02 — active-turn skip in the inbox check.
 *
 * The check must short-circuit (return healthy with metadata.skipped=true)
 * when sessionManager.hasActiveTurn(agentName) is true. Mid-turn the inbox
 * is in active drain by design; running the check generates false-positive
 * critical timeouts.
 */
describe("inbox check active-turn skip (Phase 999.12 HB-02)", () => {
  function buildConfig(): HeartbeatConfig {
    return {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    };
  }

  function buildContext(opts: {
    hasActiveTurn: boolean;
    inboxDir: string;
  }): CheckContext {
    const dispatchTurn = vi.fn();
    const getAgentConfig = vi.fn().mockReturnValue({
      memoryPath: opts.inboxDir.replace(/\/inbox$/, ""),
    });
    const sessionManager = {
      hasActiveTurn: vi.fn().mockReturnValue(opts.hasActiveTurn),
      getAgentConfig,
      dispatchTurn,
      // Quick task 260521-4sa (999.64) — stale-lock watchdog reads these.
      // Returning null routes the active-turn branch through the
      // "cannot measure → keep healthy skip" path, preserving the HB-02
      // short-circuit semantics this test pins (fresh turn, no activity data).
      getLastTurnActivityAt: vi.fn().mockReturnValue(null),
      getTurnStartedAt: vi.fn().mockReturnValue(null),
      forceReleaseTurn: vi.fn().mockReturnValue(false),
      // Spread other commonly-required surfaces to avoid TypeError in
      // unrelated code paths the check might touch.
      getRunningAgents: vi.fn().mockReturnValue(["test-agent"]),
      getContextFillProvider: vi.fn().mockReturnValue(undefined),
      getCompactionManager: vi.fn().mockReturnValue(undefined),
    } as never;

    return {
      agentName: "test-agent",
      sessionManager,
      registry: { entries: [], updatedAt: Date.now() },
      config: buildConfig(),
    };
  }

  it("skips when sessionManager.hasActiveTurn(agentName) returns true (HB-02)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "inbox-skip-"));
    try {
      const context = buildContext({ hasActiveTurn: true, inboxDir: join(tmp, "inbox") });
      const result = await inboxCheck.execute(context);

      expect(result.status).toBe("healthy");
      expect(result.message.toLowerCase()).toContain("skipped");
      expect(result.metadata).toMatchObject({ skipped: true, reason: "active-turn" });

      // dispatchTurn must NOT have been called.
      expect(
        (context.sessionManager as unknown as { dispatchTurn: ReturnType<typeof vi.fn> })
          .dispatchTurn,
      ).not.toHaveBeenCalled();
      // getAgentConfig should also be skipped — short-circuit happens first.
      expect(
        (context.sessionManager as unknown as { getAgentConfig: ReturnType<typeof vi.fn> })
          .getAgentConfig,
      ).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs normally when hasActiveTurn returns false (HB-02b)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "inbox-run-"));
    try {
      // Build a real inbox dir with no messages.
      const context = buildContext({ hasActiveTurn: false, inboxDir: join(tmp, "inbox") });
      const result = await inboxCheck.execute(context);

      // Either reconciler or primary mode → healthy with no pending.
      expect(result.status).toBe("healthy");
      expect(
        (context.sessionManager as unknown as { getAgentConfig: ReturnType<typeof vi.fn> })
          .getAgentConfig,
      ).toHaveBeenCalled();
      // The skipped/active-turn metadata MUST NOT be present on the run path.
      expect((result.metadata as Record<string, unknown> | undefined)?.skipped).not.toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
