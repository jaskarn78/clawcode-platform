import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  AdvisorBudget,
  ADVISOR_RESPONSE_MAX_LENGTH,
} from "../../usage/advisor-budget.js";
import { DefaultAdvisorService } from "../service.js";
import type { AdvisorBackend, BackendId, AdvisorServiceDeps } from "../index.js";

/**
 * Service tests cover the four core guarantees of `DefaultAdvisorService.ask`:
 *
 *   A. Budget-exhausted short-circuit (backend.consult NOT called; recordCall NOT called).
 *   B. Truncation at ADVISOR_RESPONSE_MAX_LENGTH (2000 chars).
 *   C. Backend dispatch with correctly-resolved {agent, question, systemPrompt, advisorModel}.
 *   D. recordCall fires exactly once after a successful backend return.
 *
 * Pattern: real `AdvisorBudget` against `:memory:` SQLite + mocked backend
 * (per RESEARCH §5 and `src/usage/advisor-budget.test.ts:11`).
 */
describe("DefaultAdvisorService.ask", () => {
  let db: InstanceType<typeof Database>;
  let budget: AdvisorBudget;
  let mockConsult: ReturnType<typeof vi.fn<AdvisorBackend["consult"]>>;
  let mockBackend: AdvisorBackend;

  function buildService(overrides: Partial<AdvisorServiceDeps> = {}) {
    const deps: AdvisorServiceDeps = {
      budget,
      resolveBackend: () => ({ backend: mockBackend, id: "fork" as BackendId }),
      resolveSystemPrompt: () => "SYS",
      resolveAdvisorModel: () => "claude-opus-4-8",
      ...overrides,
    };
    return new DefaultAdvisorService(deps);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    budget = new AdvisorBudget(db);
    mockConsult = vi
      .fn<AdvisorBackend["consult"]>()
      .mockResolvedValue({ answer: "X" });
    mockBackend = { id: "fork" as BackendId, consult: mockConsult };
  });

  // Assertion A — budget exhausted
  describe("when budget is exhausted", () => {
    it("returns a fixed budget-exhausted message without dispatching to the backend", async () => {
      for (let i = 0; i < 10; i++) budget.recordCall("agent-a");
      expect(budget.canCall("agent-a")).toBe(false);

      const recordSpy = vi.spyOn(budget, "recordCall");
      const service = buildService();

      const res = await service.ask({ agent: "agent-a", question: "Q" });

      expect(res.answer).toMatch(/budget exhausted/i);
      expect(res.budgetRemaining).toBe(0);
      expect(res.backend).toBe("fork");
      expect(mockConsult).not.toHaveBeenCalled();
      expect(recordSpy).not.toHaveBeenCalled();
    });
  });

  // Assertion B — truncation
  describe("response truncation", () => {
    it("truncates answers longer than ADVISOR_RESPONSE_MAX_LENGTH (2000) to exactly the cap", async () => {
      const huge = "x".repeat(2500);
      mockConsult.mockResolvedValueOnce({ answer: huge });
      const service = buildService();

      const res = await service.ask({ agent: "agent-a", question: "Q" });

      expect(res.answer.length).toBe(ADVISOR_RESPONSE_MAX_LENGTH);
      expect(res.answer).toBe("x".repeat(ADVISOR_RESPONSE_MAX_LENGTH));
    });

    it("does NOT touch answers at or below the cap", async () => {
      const exact = "y".repeat(ADVISOR_RESPONSE_MAX_LENGTH);
      mockConsult.mockResolvedValueOnce({ answer: exact });
      const service = buildService();

      const res = await service.ask({ agent: "agent-a", question: "Q" });

      expect(res.answer).toBe(exact);
      expect(res.answer.length).toBe(ADVISOR_RESPONSE_MAX_LENGTH);
    });

    it("leaves short answers untouched", async () => {
      mockConsult.mockResolvedValueOnce({ answer: "short" });
      const service = buildService();

      const res = await service.ask({ agent: "agent-a", question: "Q" });

      expect(res.answer).toBe("short");
    });
  });

  // Assertion C — backend dispatch wiring
  describe("backend dispatch", () => {
    it("invokes backend.consult with the exact resolved {agent, question, systemPrompt, advisorModel}", async () => {
      const service = buildService({
        resolveSystemPrompt: () => "RESOLVED-SYSTEM-PROMPT",
        resolveAdvisorModel: () => "claude-opus-4-8",
      });

      await service.ask({ agent: "clawdy", question: "What now?" });

      expect(mockConsult).toHaveBeenCalledTimes(1);
      expect(mockConsult).toHaveBeenCalledWith({
        agent: "clawdy",
        question: "What now?",
        systemPrompt: "RESOLVED-SYSTEM-PROMPT",
        advisorModel: "claude-opus-4-8",
      });
    });

    it("returns the backend id from resolveBackend in the response", async () => {
      const nativeBackend: AdvisorBackend = {
        id: "native",
        consult: vi.fn().mockResolvedValue({ answer: "ok" }),
      };
      const service = buildService({
        resolveBackend: () => ({ backend: nativeBackend, id: "native" }),
      });

      const res = await service.ask({ agent: "agent-a", question: "Q" });

      expect(res.backend).toBe("native");
    });
  });

  // Assertion D — recordCall on success
  describe("budget recording", () => {
    it("calls recordCall exactly once after a successful backend return", async () => {
      const recordSpy = vi.spyOn(budget, "recordCall");
      const service = buildService();

      await service.ask({ agent: "agent-a", question: "Q" });

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy).toHaveBeenCalledWith("agent-a");
    });

    it("reports budgetRemaining after recording the call", async () => {
      const service = buildService();

      const res = await service.ask({ agent: "agent-a", question: "Q" });

      // Default cap is 10 → 1 used → 9 remaining
      expect(res.budgetRemaining).toBe(9);
    });

    it("does NOT record the call when the backend throws", async () => {
      const recordSpy = vi.spyOn(budget, "recordCall");
      mockConsult.mockRejectedValueOnce(new Error("backend boom"));
      const service = buildService();

      await expect(
        service.ask({ agent: "agent-a", question: "Q" }),
      ).rejects.toThrow(/backend boom/);
      expect(recordSpy).not.toHaveBeenCalled();
      expect(budget.getRemaining("agent-a")).toBe(10);
    });
  });
});
