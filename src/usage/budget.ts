import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { startOfDay, startOfWeek } from "date-fns";
import { deriveFamily, resolveModelId } from "../manager/model-resolver.js";

/**
 * Per-agent escalation budget configuration.
 * Limits are token counts per period per model.
 * All fields are optional -- absence means no limit for that model/period.
 */
export type AgentBudgetConfig = {
  readonly daily?: {
    readonly sonnet?: number;
    readonly opus?: number;
  };
  readonly weekly?: {
    readonly sonnet?: number;
    readonly opus?: number;
  };
};

/**
 * Error thrown when an agent's escalation budget is exceeded.
 */
export class BudgetExceededError extends Error {
  readonly agent: string;
  readonly model: string;

  constructor(agent: string, model: string) {
    super(`Escalation budget exceeded for ${agent} on model ${model}`);
    this.name = "BudgetExceededError";
    this.agent = agent;
    this.model = model;
  }
}

/** Prepared statements for budget operations. */
type BudgetStatements = {
  readonly getUsage: Statement;
  readonly upsert: Statement;
};

/** Raw row from the escalation_budget table. */
type BudgetRow = {
  readonly tokens_used: number;
};

/**
 * EscalationBudget -- SQLite-backed per-agent token budget enforcement
 * for model escalation with alert deduplication.
 *
 * Enforces configurable daily and weekly token limits per agent per model.
 * Budget is opt-in: agents without budget config escalate freely.
 * Alert deduplication ensures each threshold fires only once per period.
 */
export class EscalationBudget {
  private readonly stmts: BudgetStatements;
  private readonly firedAlerts: Set<string> = new Set();

  constructor(db: DatabaseType) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS escalation_budget (
        agent TEXT NOT NULL,
        model TEXT NOT NULL,
        period_type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent, model, period_type, period_start)
      );
    `);

    this.stmts = {
      getUsage: db.prepare(
        "SELECT tokens_used FROM escalation_budget WHERE agent = ? AND model = ? AND period_type = ? AND period_start = ?",
      ),
      upsert: db.prepare(`
        INSERT INTO escalation_budget (agent, model, period_type, period_start, tokens_used)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (agent, model, period_type, period_start)
        DO UPDATE SET tokens_used = tokens_used + excluded.tokens_used
      `),
    };
  }

  /**
   * Check whether the agent can escalate to the given model.
   * Returns true if no budget config (opt-in) or if under all limits.
   */
  canEscalate(agent: string, model: string, budgetConfig?: AgentBudgetConfig): boolean {
    if (!budgetConfig) return true;

    const dailyLimit = this.getLimit(budgetConfig, "daily", model);
    if (dailyLimit !== undefined) {
      const dailyUsage = this.getUsageForPeriod(agent, model, "daily");
      if (dailyUsage >= dailyLimit) return false;
    }

    const weeklyLimit = this.getLimit(budgetConfig, "weekly", model);
    if (weeklyLimit !== undefined) {
      const weeklyUsage = this.getUsageForPeriod(agent, model, "weekly");
      if (weeklyUsage >= weeklyLimit) return false;
    }

    return true;
  }

  /**
   * Record token usage for an agent and model.
   * Updates both daily and weekly period buckets.
   */
  recordUsage(agent: string, model: string, tokensUsed: number): void {
    const dailyStart = this.periodStart("daily");
    const weeklyStart = this.periodStart("weekly");

    this.stmts.upsert.run(agent, model, "daily", dailyStart, tokensUsed);
    this.stmts.upsert.run(agent, model, "weekly", weeklyStart, tokensUsed);
  }

  /**
   * Check if any alert threshold has been crossed.
   * Returns the highest threshold: "exceeded" (100%) > "warning" (80%) > null.
   */
  checkAlerts(
    agent: string,
    model: string,
    budgetConfig: AgentBudgetConfig,
  ): "warning" | "exceeded" | null {
    let highest: "warning" | "exceeded" | null = null;

    for (const periodType of ["daily", "weekly"] as const) {
      const limit = this.getLimit(budgetConfig, periodType, model);
      if (limit === undefined) continue;

      const usage = this.getUsageForPeriod(agent, model, periodType);
      const ratio = usage / limit;

      if (ratio >= 1.0) {
        return "exceeded"; // Can't get higher than exceeded
      }
      // highest is "warning" | null here (early return on "exceeded" above)
      if (ratio >= 0.8) {
        highest = "warning";
      }
    }

    return highest;
  }

  /**
   * Check if an alert should fire (deduplication).
   * Returns true the first time for a given agent+model+threshold+period.
   * Returns false for subsequent calls with the same key.
   */
  shouldAlert(agent: string, model: string, threshold: string): boolean {
    const periodStart = this.periodStart("daily");
    const key = `${agent}:${model}:${threshold}:${periodStart}`;

    if (this.firedAlerts.has(key)) return false;

    this.firedAlerts.add(key);
    return true;
  }

  /**
   * Get the token limit for a period type and model from config.
   * Returns undefined if no limit is configured.
   */
  private getLimit(
    config: AgentBudgetConfig,
    periodType: "daily" | "weekly",
    model: string,
  ): number | undefined {
    const periodConfig = config[periodType];
    if (!periodConfig) return undefined;
    // Phase 999.114 — look the limit up by FAMILY, not by the raw config value.
    // `AgentBudgetConfig` is keyed `sonnet` / `opus`, so a historical pin
    // ("opus-4-6") or a `<family>@latest` track missed every key and returned
    // undefined — which `canEscalate` reads as NO LIMIT and fails OPEN. Making
    // alias switching a one-click Discord action would have turned that latent
    // hole into a routine way to escape the escalation budget entirely.
    const family = deriveFamily(resolveModelId(model)) ?? model;
    const byFamily = (periodConfig as Record<string, number | undefined>)[family];
    // Exact-key lookup still wins when an operator pins a limit to the precise
    // value they wrote in clawcode.yaml.
    return (periodConfig as Record<string, number | undefined>)[model] ?? byFamily;
  }

  /**
   * Get current token usage for an agent+model in the specified period.
   */
  getUsageForPeriod(
    agent: string,
    model: string,
    periodType: "daily" | "weekly",
  ): number {
    const periodStart = this.periodStart(periodType);
    const row = this.stmts.getUsage.get(agent, model, periodType, periodStart) as BudgetRow | undefined;
    return row?.tokens_used ?? 0;
  }

  /**
   * Calculate the period start date string (ISO date, UTC).
   */
  private periodStart(periodType: "daily" | "weekly"): string {
    const now = new Date();
    if (periodType === "daily") {
      return startOfDay(now).toISOString().slice(0, 10);
    }
    return startOfWeek(now, { weekStartsOn: 1 }).toISOString().slice(0, 10);
  }
}
