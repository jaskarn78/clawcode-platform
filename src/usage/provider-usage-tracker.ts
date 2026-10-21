/**
 * Phase 138 Plan 01 T-01 — `ProviderUsageTracker`.
 *
 * Per-agent, per-day, per-provider cost telemetry persisted to SQLite.
 * Every successful turn on either backend (Anthropic Agent SDK or
 * Codex CLI) upserts one row keyed by `(date, provider, model)`.
 *
 * **Connection model (CONTEXT D2):** this class does NOT open its own
 * SQLite file. It takes the SHARED `DatabaseType` handle from the
 * existing per-agent `UsageTracker.getDatabase()` — exactly one
 * `usage.db` per agent. Mirrors the `RateLimitTracker` precedent
 * (`src/usage/rate-limit-tracker.ts`) and the `AdvisorBudget`
 * constructor shape (`src/usage/advisor-budget.ts`). Creating the
 * `provider_usage` table is additive — Phase 72's `usage_events.backend`
 * column (image-gen backend) is UNTOUCHED.
 *
 * **`provider` is the LLM provider, NOT the backend ID** — verbatim
 * `'anthropic'` or `'openai'`, NEVER `'anthropic-agent-sdk'` /
 * `'codex-cli'` (those are backend IDs). The caller maps backend → provider
 * at the hook site (`session-manager.ts` usage-callback, Phase 138 T-04).
 *
 * **Table ownership:** this file owns ONLY `provider_usage` (per-agent
 * data). The fleet-level `provider_alert_state` (Plan 03) and
 * `failover_state` (Plan 04) tables are owned by their respective
 * consumers against a separate `fleet-alerts.db` — they are deliberately
 * NOT created here.
 *
 * See:
 *   - `src/usage/advisor-budget.ts` — constructor-shape template.
 *   - `src/usage/pricing.ts` — `estimateCost` cost derivation.
 *   - `.planning/phases/138-.../138-CONTEXT.md` §D2 — schema source.
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { estimateCost } from "./pricing.js";

/**
 * Default per-provider daily cost cap in USD.
 *
 * `200 / 30 ≈ 6.67` — a Pro/Max monthly subscription cap divided by 30
 * (CONTEXT D6). Applied at the CONSUMER call site (Plans 02-04) via
 * `agents[].providers.<name>.dailyCapUsd ?? defaults.providers.<name>.dailyCapUsd
 * ?? DEFAULT_DAILY_CAP_USD` — NOT baked into the Zod schema default so a
 * genuinely-missing config is distinguishable from an explicit `6.67`.
 */
export const DEFAULT_DAILY_CAP_USD = 6.67;

/** A fully-materialised `provider_usage` row. */
export interface ProviderUsageRow {
  /** UTC `YYYY-MM-DD`. */
  readonly date: string;
  /** LLM provider — `'anthropic'` | `'openai'`. NOT a backend ID. */
  readonly provider: string;
  /** Model name as reported by the backend's result message. */
  readonly model: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
  /** Locally-derived cost (token counts × `pricing.ts` rates). */
  readonly cost_usd: number;
  readonly turn_count: number;
  /** Unix millis — set once on first insert of the day's row. */
  readonly created_at: number;
  /** Unix millis — refreshed on every upsert. */
  readonly updated_at: number;
}

/** Arguments for {@link ProviderUsageTracker.recordTurn}. */
export interface RecordTurnArgs {
  /** Agent name — kept for caller symmetry; not stored (per-agent DB). */
  readonly agent: string;
  /** LLM provider — `'anthropic'` | `'openai'`. */
  readonly provider: string;
  /** Model name as reported by the backend. */
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Optional UTC `YYYY-MM-DD` override; defaults to the clock's today. */
  readonly date?: string;
}

/** Per-provider rollup returned by {@link ProviderUsageTracker.getDailyAggregate}. */
export interface ProviderDailyAggregate {
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_usd: number;
  readonly turn_count: number;
}

/** Prepared statements for `provider_usage` operations. */
type ProviderUsageStatements = {
  readonly upsert: Statement;
  readonly getRow: Statement;
  readonly getByDate: Statement;
};

/**
 * ProviderUsageTracker — SQLite-backed per-provider per-day cost
 * telemetry. All methods are synchronous (better-sqlite3).
 */
export class ProviderUsageTracker {
  private readonly stmts: ProviderUsageStatements;
  private readonly clock: () => number;

  /**
   * @param db    Shared per-agent `usage.db` handle (from
   *              `UsageTracker.getDatabase()`). The constructor creates
   *              the `provider_usage` table idempotently.
   * @param clock Wall-clock source (unix millis). Defaults to `Date.now`;
   *              tests inject a fixed value for determinism.
   */
  constructor(db: DatabaseType, clock: () => number = Date.now) {
    this.clock = clock;

    // Verbatim from CONTEXT.md D2 — the `provider_usage` block ONLY.
    // `provider_alert_state` + `failover_state` are owned by Plans 03/04.
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_usage (
        date         TEXT NOT NULL,
        provider     TEXT NOT NULL,
        model        TEXT NOT NULL,
        tokens_in    INTEGER NOT NULL DEFAULT 0,
        tokens_out   INTEGER NOT NULL DEFAULT 0,
        cost_usd     REAL NOT NULL DEFAULT 0,
        turn_count   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (date, provider, model)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_usage_date_provider
        ON provider_usage (date, provider);
    `);

    this.stmts = {
      // Upsert: insert a fresh row OR accumulate onto the existing one.
      // `created_at` is set only on insert (ON CONFLICT leaves it).
      upsert: db.prepare(`
        INSERT INTO provider_usage
          (date, provider, model, tokens_in, tokens_out, cost_usd, turn_count, created_at, updated_at)
        VALUES
          (@date, @provider, @model, @tokensIn, @tokensOut, @costUsd, 1, @now, @now)
        ON CONFLICT (date, provider, model) DO UPDATE SET
          tokens_in  = tokens_in  + @tokensIn,
          tokens_out = tokens_out + @tokensOut,
          cost_usd   = cost_usd   + @costUsd,
          turn_count = turn_count + 1,
          updated_at = @now
      `),
      getRow: db.prepare(`
        SELECT date, provider, model, tokens_in, tokens_out, cost_usd,
               turn_count, created_at, updated_at
        FROM provider_usage
        WHERE date = ? AND provider = ? AND model = ?
      `),
      getByDate: db.prepare(`
        SELECT date, provider, model, tokens_in, tokens_out, cost_usd,
               turn_count, created_at, updated_at
        FROM provider_usage
        WHERE date = ?
        ORDER BY provider ASC, model ASC
      `),
    };
  }

  /**
   * Record one completed turn. Upserts the `(date, provider, model)`
   * row: tokens + cost + `turn_count` accumulate; `updated_at` is
   * refreshed; `created_at` is set only on the first insert.
   *
   * Cost-USD is derived locally via `estimateCost` — an unknown model
   * contributes 0 cost but still increments `turn_count` and tokens.
   *
   * @returns the fully-materialised row AFTER the upsert.
   */
  recordTurn(args: RecordTurnArgs): ProviderUsageRow {
    const now = this.clock();
    const date = args.date ?? new Date(now).toISOString().slice(0, 10);
    const costUsd = estimateCost(args.model, args.tokensIn, args.tokensOut);

    this.stmts.upsert.run({
      date,
      provider: args.provider,
      model: args.model,
      tokensIn: args.tokensIn,
      tokensOut: args.tokensOut,
      costUsd,
      now,
    });

    const row = this.stmts.getRow.get(
      date,
      args.provider,
      args.model,
    ) as ProviderUsageRow;
    return Object.freeze(row);
  }

  /**
   * Per-provider rollup for `date`, summed across all models.
   *
   * @returns `Map<provider, {tokens_in, tokens_out, cost_usd, turn_count}>`.
   */
  getDailyAggregate(date: string): Map<string, ProviderDailyAggregate> {
    const rows = this.stmts.getByDate.all(date) as ProviderUsageRow[];
    const out = new Map<string, ProviderDailyAggregate>();
    for (const row of rows) {
      const existing = out.get(row.provider);
      if (existing) {
        out.set(row.provider, {
          tokens_in: existing.tokens_in + row.tokens_in,
          tokens_out: existing.tokens_out + row.tokens_out,
          cost_usd: existing.cost_usd + row.cost_usd,
          turn_count: existing.turn_count + row.turn_count,
        });
      } else {
        out.set(row.provider, {
          tokens_in: row.tokens_in,
          tokens_out: row.tokens_out,
          cost_usd: row.cost_usd,
          turn_count: row.turn_count,
        });
      }
    }
    return out;
  }

  /**
   * All `provider_usage` rows for `date`, ordered `(provider, model)`.
   * Used by the Plan 02 IPC handler for the `clawcode status` widening.
   *
   * @returns frozen array of frozen {@link ProviderUsageRow}s.
   */
  getDailyByProviderModel(date: string): readonly ProviderUsageRow[] {
    const rows = this.stmts.getByDate.all(date) as ProviderUsageRow[];
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  }

  /**
   * No-op — the SQLite connection is shared (owned by `UsageTracker`).
   * Present for interface symmetry with `UsageTracker.close()`.
   */
  close(): void {
    // intentional no-op — shared connection, not owned here.
  }
}
