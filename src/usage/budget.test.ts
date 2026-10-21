import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { EscalationBudget, BudgetExceededError } from "./budget.js";
import type { AgentBudgetConfig } from "./budget.js";

describe("EscalationBudget", () => {
  let db: InstanceType<typeof Database>;
  let budget: EscalationBudget;

  beforeEach(() => {
    db = new Database(":memory:");
    budget = new EscalationBudget(db);
  });

  describe("canEscalate", () => {
    it("returns true when no budget config provided (opt-in)", () => {
      expect(budget.canEscalate("agent-a", "sonnet")).toBe(true);
    });

    it("returns true when usage is below daily limit", () => {
      const config: AgentBudgetConfig = { daily: { sonnet: 10000 } };
      budget.recordUsage("agent-a", "sonnet", 5000);
      expect(budget.canEscalate("agent-a", "sonnet", config)).toBe(true);
    });

    it("returns false when daily token limit exceeded", () => {
      const config: AgentBudgetConfig = { daily: { sonnet: 10000 } };
      budget.recordUsage("agent-a", "sonnet", 10001);
      expect(budget.canEscalate("agent-a", "sonnet", config)).toBe(false);
    });

    it("returns false when weekly token limit exceeded", () => {
      const config: AgentBudgetConfig = { weekly: { sonnet: 50000 } };
      budget.recordUsage("agent-a", "sonnet", 50001);
      expect(budget.canEscalate("agent-a", "sonnet", config)).toBe(false);
    });

    it("returns true when daily limit not set for this model", () => {
      const config: AgentBudgetConfig = { daily: { opus: 10000 } };
      budget.recordUsage("agent-a", "sonnet", 99999);
      expect(budget.canEscalate("agent-a", "sonnet", config)).toBe(true);
    });

    it("returns true when budget config has no limits for period", () => {
      const config: AgentBudgetConfig = {};
      budget.recordUsage("agent-a", "sonnet", 99999);
      expect(budget.canEscalate("agent-a", "sonnet", config)).toBe(true);
    });
  });

  describe("recordUsage", () => {
    it("records tokens for both daily and weekly periods", () => {
      const config: AgentBudgetConfig = { daily: { sonnet: 10000 }, weekly: { sonnet: 50000 } };
      budget.recordUsage("agent-a", "sonnet", 3000);
      budget.recordUsage("agent-a", "sonnet", 2000);
      // 5000 total, still under daily 10000
      expect(budget.canEscalate("agent-a", "sonnet", config)).toBe(true);

      budget.recordUsage("agent-a", "sonnet", 5001);
      // 10001 total, over daily 10000
      expect(budget.canEscalate("agent-a", "sonnet", config)).toBe(false);
    });
  });

  describe("checkAlerts", () => {
    it("returns null when below 80%", () => {
      const config: AgentBudgetConfig = { daily: { sonnet: 10000 } };
      budget.recordUsage("agent-a", "sonnet", 7999);
      expect(budget.checkAlerts("agent-a", "sonnet", config)).toBeNull();
    });

    it("returns 'warning' when usage reaches 80% of limit", () => {
      const config: AgentBudgetConfig = { daily: { sonnet: 10000 } };
      budget.recordUsage("agent-a", "sonnet", 8000);
      expect(budget.checkAlerts("agent-a", "sonnet", config)).toBe("warning");
    });

    it("returns 'exceeded' when usage reaches 100% of limit", () => {
      const config: AgentBudgetConfig = { daily: { sonnet: 10000 } };
      budget.recordUsage("agent-a", "sonnet", 10000);
      expect(budget.checkAlerts("agent-a", "sonnet", config)).toBe("exceeded");
    });

    it("returns null when no limits configured for model", () => {
      const config: AgentBudgetConfig = { daily: { opus: 10000 } };
      budget.recordUsage("agent-a", "sonnet", 99999);
      expect(budget.checkAlerts("agent-a", "sonnet", config)).toBeNull();
    });

    it("checks weekly limit too", () => {
      const config: AgentBudgetConfig = { weekly: { sonnet: 50000 } };
      budget.recordUsage("agent-a", "sonnet", 40000);
      expect(budget.checkAlerts("agent-a", "sonnet", config)).toBe("warning");
    });

    it("returns highest threshold (exceeded > warning)", () => {
      const config: AgentBudgetConfig = {
        daily: { sonnet: 10000 },
        weekly: { sonnet: 50000 },
      };
      // Daily at 100%, weekly at 20%
      budget.recordUsage("agent-a", "sonnet", 10000);
      expect(budget.checkAlerts("agent-a", "sonnet", config)).toBe("exceeded");
    });
  });

  describe("shouldAlert", () => {
    it("returns true first time per threshold per period", () => {
      expect(budget.shouldAlert("agent-a", "sonnet", "warning")).toBe(true);
    });

    it("returns false for duplicate alert same threshold same period", () => {
      budget.shouldAlert("agent-a", "sonnet", "warning");
      expect(budget.shouldAlert("agent-a", "sonnet", "warning")).toBe(false);
    });

    it("returns true for different threshold same agent", () => {
      budget.shouldAlert("agent-a", "sonnet", "warning");
      expect(budget.shouldAlert("agent-a", "sonnet", "exceeded")).toBe(true);
    });

    it("returns true for same threshold different agent", () => {
      budget.shouldAlert("agent-a", "sonnet", "warning");
      expect(budget.shouldAlert("agent-b", "sonnet", "warning")).toBe(true);
    });
  });

  describe("BudgetExceededError", () => {
    it("has agent and model fields", () => {
      const error = new BudgetExceededError("agent-a", "opus");
      expect(error).toBeInstanceOf(Error);
      expect(error.agent).toBe("agent-a");
      expect(error.model).toBe("opus");
      expect(error.message).toContain("agent-a");
      expect(error.message).toContain("opus");
    });
  });

  describe("period boundary reset", () => {
    it("new day gets fresh budget (simulated via direct DB insert)", () => {
      const config: AgentBudgetConfig = { daily: { sonnet: 10000 } };
      // Insert yesterday's usage at limit
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      db.prepare(
        "INSERT INTO escalation_budget (agent, model, period_type, period_start, tokens_used) VALUES (?, ?, ?, ?, ?)",
      ).run("agent-a", "sonnet", "daily", yesterday, 10000);

      // Today should be fresh
      expect(budget.canEscalate("agent-a", "sonnet", config)).toBe(true);
    });
  });

  describe("per-agent isolation", () => {
    it("tracks budgets independently per agent", () => {
      const config: AgentBudgetConfig = { daily: { sonnet: 10000 } };
      budget.recordUsage("agent-a", "sonnet", 10001);
      budget.recordUsage("agent-b", "sonnet", 5000);

      expect(budget.canEscalate("agent-a", "sonnet", config)).toBe(false);
      expect(budget.canEscalate("agent-b", "sonnet", config)).toBe(true);
    });
  });
});
