import { describe, it, expect, vi, beforeEach } from "vitest";
import { EscalationMonitor } from "./escalation.js";
import type { EscalationConfig } from "./escalation.js";
import type { SessionManager } from "./session-manager.js";
import type { EscalationBudget } from "../usage/budget.js";

function createMockSessionManager() {
  return {
    forkSession: vi.fn().mockResolvedValue({
      forkName: "agent-fork-abc123",
      parentAgent: "agent",
      sessionId: "sess-1",
    }),
    dispatchTurn: vi.fn().mockResolvedValue("escalated response"),
    stopAgent: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager;
}

const defaultConfig: EscalationConfig = {
  errorThreshold: 3,
  escalationModel: "sonnet",
  keywordTriggers: ["this needs opus"],
};

describe("EscalationMonitor", () => {
  let mockManager: SessionManager;
  let monitor: EscalationMonitor;

  beforeEach(() => {
    mockManager = createMockSessionManager();
    monitor = new EscalationMonitor(mockManager, defaultConfig);
  });

  describe("shouldEscalate", () => {
    it("returns false when errorCount < threshold", () => {
      expect(monitor.shouldEscalate("agent", "some response", true)).toBe(false);
      expect(monitor.shouldEscalate("agent", "some response", true)).toBe(false);
    });

    it("returns true when errorCount reaches threshold", () => {
      monitor.shouldEscalate("agent", "error response", true);
      monitor.shouldEscalate("agent", "error response", true);
      const result = monitor.shouldEscalate("agent", "error response", true);
      expect(result).toBe(true);
    });

    it("returns true when message contains keyword trigger", () => {
      const result = monitor.shouldEscalate("agent", "I think this needs opus for this task", false);
      expect(result).toBe(true);
    });

    it("keyword trigger is case-insensitive", () => {
      const result = monitor.shouldEscalate("agent", "THIS NEEDS OPUS please", false);
      expect(result).toBe(true);
    });

    it("returns false for fork sessions (name contains '-fork-')", () => {
      monitor.shouldEscalate("agent-fork-abc123", "error", true);
      monitor.shouldEscalate("agent-fork-abc123", "error", true);
      const result = monitor.shouldEscalate("agent-fork-abc123", "error", true);
      expect(result).toBe(false);
    });

    it("returns false when escalation is already in progress", async () => {
      // Trigger 3 errors to make it escalatable
      monitor.shouldEscalate("agent", "error", true);
      monitor.shouldEscalate("agent", "error", true);
      monitor.shouldEscalate("agent", "error", true);

      // Start escalation (don't await - keeps lock held)
      const slowManager = createMockSessionManager();
      (slowManager.dispatchTurn as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve("done"), 100)),
      );
      const slowMonitor = new EscalationMonitor(slowManager, defaultConfig);
      slowMonitor.shouldEscalate("agent", "error", true);
      slowMonitor.shouldEscalate("agent", "error", true);
      slowMonitor.shouldEscalate("agent", "error", true);

      // Start escalation without awaiting
      const escalatePromise = slowMonitor.escalate("agent", "help");

      // While escalation is in progress, shouldEscalate returns false
      expect(slowMonitor.shouldEscalate("agent", "error", true)).toBe(false);

      await escalatePromise;
    });

    it("resets error count on non-error response without keyword", () => {
      monitor.shouldEscalate("agent", "error", true);
      monitor.shouldEscalate("agent", "error", true);
      // Non-error resets the count
      monitor.shouldEscalate("agent", "all good", false);
      // Third error after reset is not at threshold
      expect(monitor.shouldEscalate("agent", "error", true)).toBe(false);
    });
  });

  describe("escalate", () => {
    it("calls forkSession with modelOverride, sends message, stops fork", async () => {
      const result = await monitor.escalate("agent", "complex task");

      expect((mockManager.forkSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "agent",
        { modelOverride: "sonnet" },
      );
      expect((mockManager.dispatchTurn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "agent-fork-abc123",
        "complex task",
      );
      expect((mockManager.stopAgent as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "agent-fork-abc123",
      );
      expect(result).toBe("escalated response");
    });

    it("resets error count after successful escalation", async () => {
      // Build up errors
      monitor.shouldEscalate("agent", "error", true);
      monitor.shouldEscalate("agent", "error", true);
      monitor.shouldEscalate("agent", "error", true);

      await monitor.escalate("agent", "help");

      // Error count should be reset - next errors don't trigger immediately
      expect(monitor.shouldEscalate("agent", "error", true)).toBe(false);
      expect(monitor.shouldEscalate("agent", "error", true)).toBe(false);
    });

    // The fork stop lives in a `finally` — before that, a dispatchTurn throw
    // skipped it and leaked the forked session until the fork reaper (off by
    // default) ran. Prod evidence: resident fork sessions alive ~50min.
    it("stops the fork and re-throws when dispatchTurn rejects", async () => {
      (mockManager.dispatchTurn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("dispatchTurn boom"),
      );

      await expect(monitor.escalate("agent", "help")).rejects.toThrow("dispatchTurn boom");

      expect((mockManager.stopAgent as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      expect((mockManager.stopAgent as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "agent-fork-abc123",
      );
    });

    it("surfaces the dispatch error, not the stop error, when both fail", async () => {
      (mockManager.dispatchTurn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("dispatchTurn boom"),
      );
      (mockManager.stopAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("stopAgent failed"),
      );

      await expect(monitor.escalate("agent", "help")).rejects.toThrow("dispatchTurn boom");
    });

    it("leaves the error count and budget untouched when the turn fails", async () => {
      const budget = {
        canEscalate: vi.fn().mockReturnValue(true),
        checkAlerts: vi.fn().mockReturnValue(null),
        shouldAlert: vi.fn().mockReturnValue(false),
        recordUsage: vi.fn(),
      } as unknown as EscalationBudget;
      const budgetMonitor = new EscalationMonitor(mockManager, defaultConfig, {
        budget,
        budgetConfigs: new Map([["agent", { daily: { sonnet: 100_000 } }]]),
      });
      (mockManager.dispatchTurn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("dispatchTurn boom"),
      );

      // Reach the threshold, then fail the escalation it triggered.
      budgetMonitor.shouldEscalate("agent", "error", true);
      budgetMonitor.shouldEscalate("agent", "error", true);
      budgetMonitor.shouldEscalate("agent", "error", true);
      await expect(budgetMonitor.escalate("agent", "help")).rejects.toThrow("dispatchTurn boom");

      // Counter not reset (a reset would need 3 fresh errors to trip again),
      // and a failed escalation is never charged.
      expect(budgetMonitor.shouldEscalate("agent", "error", true)).toBe(true);
      expect(budget.recordUsage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it("releases lock even if fork throws", async () => {
      const failManager = createMockSessionManager();
      (failManager.forkSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fork failed"));
      const failMonitor = new EscalationMonitor(failManager, defaultConfig);

      await expect(failMonitor.escalate("agent", "help")).rejects.toThrow("fork failed");

      // Lock should be released - shouldEscalate should work
      failMonitor.shouldEscalate("agent", "error", true);
      failMonitor.shouldEscalate("agent", "error", true);
      expect(failMonitor.shouldEscalate("agent", "error", true)).toBe(true);
    });
  });

  describe("resetErrorCount", () => {
    it("clears the error counter for a specific agent", () => {
      monitor.shouldEscalate("agent", "error", true);
      monitor.shouldEscalate("agent", "error", true);
      monitor.resetErrorCount("agent");
      // After reset, need 3 more errors
      expect(monitor.shouldEscalate("agent", "error", true)).toBe(false);
      expect(monitor.shouldEscalate("agent", "error", true)).toBe(false);
      expect(monitor.shouldEscalate("agent", "error", true)).toBe(true);
    });
  });

  // Quick task 260419-p51 — fork-escalation parity check.
  // Phase 73 introduced a persistent SDK query on each running agent (via
  // streamInput). This suite pins the invariant: `escalate()` MUST NOT
  // teardown the parent's persistent query when spawning an ephemeral opus
  // fork. The fork gets its OWN SDK query — the parent's streamInput handle
  // is untouched. If a future refactor accidentally stops the parent during
  // escalation, this test catches it before the change ships.
  describe("fork-escalation: parent persistent query survives fork spawn", () => {
    it("calls forkSession + dispatchTurn(fork) + stopAgent(fork) — NEVER stopAgent(parent)", async () => {
      const parentAgent = "clawdy";
      const forkName = `${parentAgent}-fork-abc123`;

      // Capture a snapshot of the parent's "persistent query" as a stable
      // session id — if escalate() teardown touched the parent we'd observe
      // a reset. Use a closure-bound getter that tracks reads.
      let parentSessionId: string | undefined = "parent-sess-persistent-v1";

      const manager = {
        forkSession: vi.fn().mockResolvedValue({
          forkName,
          parentAgent,
          sessionId: "fork-sess-ephemeral",
        }),
        dispatchTurn: vi.fn().mockResolvedValue("opus fork response"),
        stopAgent: vi.fn().mockResolvedValue(undefined),
        // Parent-state probes that a real SessionManager exposes. The mock
        // implementation asserts that these never observe mutation during
        // escalate().
        isRunning: vi.fn((name: string) => name === parentAgent),
        getActiveConversationSessionId: vi.fn(() => parentSessionId),
      } as unknown as SessionManager;

      const monitor = new EscalationMonitor(manager, defaultConfig);

      // Capture parent state BEFORE escalate.
      const beforeRunning = (manager as unknown as { isRunning: (n: string) => boolean }).isRunning(
        parentAgent,
      );
      const beforeSessionId = (
        manager as unknown as { getActiveConversationSessionId: (n: string) => string | undefined }
      ).getActiveConversationSessionId(parentAgent);

      await monitor.escalate(parentAgent, "deeply research this");

      // Method-call set: fork + dispatchTurn(fork) + stopAgent(fork).
      expect(manager.forkSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        parentAgent,
        { modelOverride: "sonnet" },
      );
      expect(manager.dispatchTurn as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        forkName,
        "deeply research this",
      );
      expect(manager.stopAgent as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(forkName);

      // The parent is NEVER stopped during escalation — the Phase 73
      // persistent-subprocess invariant.
      const stopCalls = (manager.stopAgent as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0],
      );
      expect(stopCalls).not.toContain(parentAgent);
      expect(stopCalls).toEqual([forkName]);

      // Parent state survives the escalate: same isRunning, same session id.
      const afterRunning = (manager as unknown as { isRunning: (n: string) => boolean }).isRunning(
        parentAgent,
      );
      const afterSessionId = (
        manager as unknown as { getActiveConversationSessionId: (n: string) => string | undefined }
      ).getActiveConversationSessionId(parentAgent);

      expect(afterRunning).toBe(beforeRunning);
      expect(afterSessionId).toBe(beforeSessionId);
    });

    it("only spawns ONE fork per escalate call (no extra forkSession on the parent)", async () => {
      const manager = createMockSessionManager();
      const monitor = new EscalationMonitor(manager, defaultConfig);

      await monitor.escalate("clawdy", "help");

      expect(manager.forkSession as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
      expect(manager.dispatchTurn as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
      expect(manager.stopAgent as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    });
  });
});
