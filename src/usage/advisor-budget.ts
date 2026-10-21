import type { Database as DatabaseType, Statement } from "better-sqlite3";

/**
 * Default maximum advisor calls per agent per day.
 */
const DEFAULT_MAX_CALLS = 10;

/**
 * Maximum character length for advisor responses.
 */
export const ADVISOR_RESPONSE_MAX_LENGTH = 2000;

/** Prepared statements for advisor budget operations. */
type BudgetStatements = {
  readonly getRow: Statement;
  readonly upsert: Statement;
};

/** Raw row from the advisor_budget table. */
type BudgetRow = {
  readonly agent: string;
  readonly date: string;
  readonly calls_used: number;
  readonly max_calls: number;
};

/**
 * AdvisorBudget -- SQLite-backed daily call budget tracking for opus advisor.
 *
 * Enforces a per-agent daily limit on advisor (opus) consultations.
 * Budget resets automatically each day via composite (agent, date) primary key.
 * All methods are synchronous (better-sqlite3).
 */
export class AdvisorBudget {
  private readonly stmts: BudgetStatements;

  constructor(db: DatabaseType) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS advisor_budget (
        agent TEXT NOT NULL,
        date TEXT NOT NULL,
        calls_used INTEGER NOT NULL DEFAULT 0,
        max_calls INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_CALLS},
        PRIMARY KEY (agent, date)
      );
    `);

    this.stmts = {
      getRow: db.prepare(
        "SELECT agent, date, calls_used, max_calls FROM advisor_budget WHERE agent = ? AND date = ?",
      ),
      upsert: db.prepare(`
        INSERT INTO advisor_budget (agent, date, calls_used, max_calls)
        VALUES (?, ?, 1, ${DEFAULT_MAX_CALLS})
        ON CONFLICT (agent, date) DO UPDATE SET calls_used = calls_used + 1
      `),
    };
  }

  /**
   * Check whether the agent can make another advisor call today.
   */
  canCall(agent: string): boolean {
    const row = this.stmts.getRow.get(agent, todayDate()) as BudgetRow | undefined;
    if (!row) return true;
    return row.calls_used < row.max_calls;
  }

  /**
   * Record a successful advisor call for the agent today.
   */
  recordCall(agent: string): void {
    this.stmts.upsert.run(agent, todayDate());
  }

  /**
   * Get remaining advisor calls for the agent today.
   */
  getRemaining(agent: string): number {
    const row = this.stmts.getRow.get(agent, todayDate()) as BudgetRow | undefined;
    if (!row) return DEFAULT_MAX_CALLS;
    return row.max_calls - row.calls_used;
  }
}

/**
 * Get today's date as YYYY-MM-DD string.
 */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}
