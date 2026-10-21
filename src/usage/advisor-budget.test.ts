import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { AdvisorBudget } from "./advisor-budget.js";

describe("AdvisorBudget", () => {
  let db: InstanceType<typeof Database>;
  let budget: AdvisorBudget;

  beforeEach(() => {
    db = new Database(":memory:");
    budget = new AdvisorBudget(db);
  });

  describe("canCall", () => {
    it("returns true when no calls have been made today", () => {
      expect(budget.canCall("agent-a")).toBe(true);
    });

    it("returns true when calls_used < max_calls", () => {
      for (let i = 0; i < 9; i++) {
        budget.recordCall("agent-a");
      }
      expect(budget.canCall("agent-a")).toBe(true);
    });

    it("returns false when calls_used >= max_calls", () => {
      for (let i = 0; i < 10; i++) {
        budget.recordCall("agent-a");
      }
      expect(budget.canCall("agent-a")).toBe(false);
    });
  });

  describe("recordCall", () => {
    it("increments calls_used for today", () => {
      budget.recordCall("agent-a");
      expect(budget.getRemaining("agent-a")).toBe(9);
    });

    it("increments correctly across multiple calls", () => {
      budget.recordCall("agent-a");
      budget.recordCall("agent-a");
      budget.recordCall("agent-a");
      expect(budget.getRemaining("agent-a")).toBe(7);
    });
  });

  describe("getRemaining", () => {
    it("returns 10 (default max) when no calls have been made", () => {
      expect(budget.getRemaining("agent-a")).toBe(10);
    });

    it("returns 0 when all calls exhausted", () => {
      for (let i = 0; i < 10; i++) {
        budget.recordCall("agent-a");
      }
      expect(budget.getRemaining("agent-a")).toBe(0);
    });
  });

  describe("per-agent isolation", () => {
    it("tracks budgets independently per agent", () => {
      budget.recordCall("agent-a");
      budget.recordCall("agent-a");
      budget.recordCall("agent-b");

      expect(budget.getRemaining("agent-a")).toBe(8);
      expect(budget.getRemaining("agent-b")).toBe(9);
    });
  });

  describe("daily reset", () => {
    it("uses date-based primary key so new dates get fresh budget", () => {
      // Directly insert a row for yesterday to simulate passage of time
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      db.prepare(
        "INSERT INTO advisor_budget (agent, date, calls_used, max_calls) VALUES (?, ?, ?, ?)",
      ).run("agent-a", yesterday, 10, 10);

      // Today should still have full budget
      expect(budget.canCall("agent-a")).toBe(true);
      expect(budget.getRemaining("agent-a")).toBe(10);
    });
  });
});
