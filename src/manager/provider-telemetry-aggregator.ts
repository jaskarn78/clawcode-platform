/**
 * Phase 138 Plan 02 T-01 — `ProviderTelemetryAggregator`.
 *
 * Fleet-aggregate per-provider cost reader. On every `clawcode status`
 * IPC request (and every dashboard heartbeat poll), the daemon calls
 * `.snapshot()`; the aggregator reads ALL agent `usage.db` files
 * READ-ONLY, sums their `provider_usage` rows by provider for the
 * current UTC day, and returns a frozen `CreditTelemetryPayload`.
 *
 * **No central aggregation table (CONTEXT D2).** Read-amplification is
 * cheap — ≤ 14 agent dbs × one indexed query each. Computing on demand
 * eliminates a consistency-coordination problem. better-sqlite3 opens
 * are ~100µs each; a full fleet snapshot is ~1-2ms, negligible against
 * the 5-10s heartbeat cadence (Threat T-138-02-01).
 *
 * **Read-only opens.** Each db is opened with `{ readonly: true }` and
 * closed at the end of the snapshot — no long-lived read handles, so
 * the per-turn write path (`ProviderUsageTracker.recordTurn`) never
 * contends. WAL mode lets concurrent readers proceed without blocking
 * the writer.
 *
 * **Fail-soft per agent.** A missing db file, a db with no
 * `provider_usage` table (a running agent that has not taken a turn
 * yet — the table is created lazily on first turn), or a corrupt db
 * is logged with the `phase138-status-aggregation` tag and that agent
 * is SKIPPED. One bad agent never fails the whole snapshot.
 *
 * **Cap cascade (CONTEXT D6).** The per-provider cap is resolved by an
 * injected `resolveCap(provider, agent?)` callback — the aggregator
 * does NOT re-parse `clawcode.yaml`. The fleet-level cap for a provider
 * is `max(resolveCap(provider, agent))` across all agents: the cap is
 * the upper bound any single agent is policed against, and Plan 03
 * alerts on the fleet aggregate vs that bound.
 *
 * See:
 *   - `src/usage/provider-usage-tracker.ts` — the per-agent writer.
 *   - `src/ipc/protocol.ts` — `CreditTelemetryPayloadSchema` (T-02).
 *   - `.planning/phases/138-.../138-CONTEXT.md` §D2, §D6.
 */

import BetterSqlite3 from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type {
  CreditTelemetryEntry,
  CreditTelemetryPayload,
} from "../ipc/protocol.js";

/** Number of daily samples in a sparkline (last 24 UTC days, oldest first). */
const SPARKLINE_DAYS = 24;

/** One agent the aggregator should read. */
export interface AggregatorAgent {
  /** Agent name — surfaced in the per-provider `agents` contributor list. */
  readonly name: string;
  /** Absolute path to the agent's per-agent `usage.db`. */
  readonly usageDbPath: string;
}

/**
 * Minimal logger surface the aggregator needs. The daemon passes its
 * pino child logger; tests pass a recording stub.
 */
export interface AggregatorLogger {
  warn(obj: unknown, msg?: string): void;
  // M7 — benign "agent usage.db not yet initialized" conditions log at debug
  // (vs warn) to stop per-snapshot warn-spam for un-migrated agents.
  debug(obj: unknown, msg?: string): void;
}

/** Constructor dependencies for {@link ProviderTelemetryAggregator}. */
export interface ProviderTelemetryAggregatorDeps {
  /**
   * The fleet of agents to read. A FUNCTION (not a static array) so the
   * snapshot always reflects the current config after a hot-reload —
   * the daemon passes `() => configs.map(...)`. May also be a plain
   * array for tests / static fleets.
   */
  readonly agents: readonly AggregatorAgent[] | (() => readonly AggregatorAgent[]);
  /**
   * Resolve the daily cost cap (USD) for a provider, optionally scoped
   * to one agent. Caller computes the D6 cascade
   * (`agent ?? defaults ?? DEFAULT_DAILY_CAP_USD`).
   */
  readonly resolveCap: (provider: string, agent?: string) => number;
  /** Wall-clock source (unix millis). Defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
   * Open a SQLite db for the given path. Defaults to a read-only
   * better-sqlite3 open. Tests inject seeded in-memory dbs.
   */
  readonly dbFactory?: (path: string) => DatabaseType;
  /** Logger factory. Defaults to a no-op logger. */
  readonly loggerFactory?: () => AggregatorLogger;
}

/** A `provider_usage` row as read for the current day. */
interface DayRow {
  readonly provider: string;
  readonly model: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_usd: number;
  readonly turn_count: number;
}

/** A sparkline `(date, cost)` pair as read across the 24-day window. */
interface SparkRow {
  readonly date: string;
  readonly provider: string;
  readonly cost_usd: number;
}

/** Mutable per-provider accumulator used while summing across agents. */
interface ProviderAccumulator {
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  turn_count: number;
  /** Per-model rollup keyed by model name. */
  readonly models: Map<
    string,
    { tokens_in: number; tokens_out: number; cost_usd: number }
  >;
  /** Set of contributing agent names. */
  readonly agents: Set<string>;
  /** Sparkline accumulator — 24 daily cost buckets, index 23 = today. */
  readonly sparkline: number[];
}

/** Default read-only better-sqlite3 opener. */
function defaultDbFactory(path: string): DatabaseType {
  return new BetterSqlite3(path, { readonly: true, fileMustExist: true });
}

/** Default no-op logger. */
function defaultLoggerFactory(): AggregatorLogger {
  return { warn: () => {}, debug: () => {} };
}

/** UTC `YYYY-MM-DD` for a unix-millis instant. */
function utcDate(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` exactly `daysBack` UTC days before `millis`. Uses
 * `Date.UTC` arithmetic so it never drifts across DST or month edges.
 */
function utcDateDaysBack(millis: number, daysBack: number): string {
  const d = new Date(millis);
  const back = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysBack,
  );
  return new Date(back).toISOString().slice(0, 10);
}

/**
 * Whole-day difference `later - earlier` (both `YYYY-MM-DD` UTC).
 * Returns a non-negative integer when `later >= earlier`.
 */
function dayDiff(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00.000Z`);
  const b = Date.parse(`${later}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * ProviderTelemetryAggregator — reads the fleet's per-agent
 * `usage.db` files and produces a fleet-aggregate per-provider
 * `CreditTelemetryPayload`. Synchronous (better-sqlite3).
 */
export class ProviderTelemetryAggregator {
  private readonly agentsSource:
    | readonly AggregatorAgent[]
    | (() => readonly AggregatorAgent[]);
  private readonly resolveCap: (provider: string, agent?: string) => number;
  private readonly clock: () => number;
  private readonly dbFactory: (path: string) => DatabaseType;
  private readonly loggerFactory: () => AggregatorLogger;

  constructor(deps: ProviderTelemetryAggregatorDeps) {
    this.agentsSource = deps.agents;
    this.resolveCap = deps.resolveCap;
    this.clock = deps.clock ?? Date.now;
    this.dbFactory = deps.dbFactory ?? defaultDbFactory;
    this.loggerFactory = deps.loggerFactory ?? defaultLoggerFactory;
  }

  /** Resolve the current fleet (handles the function-or-array source). */
  private currentAgents(): readonly AggregatorAgent[] {
    return typeof this.agentsSource === "function"
      ? this.agentsSource()
      : this.agentsSource;
  }

  /**
   * Read every agent's `usage.db` read-only, sum `provider_usage` rows
   * for the current UTC day, and return the frozen fleet-aggregate
   * payload. A per-agent read failure is logged + skipped — the
   * snapshot still succeeds for the remaining agents.
   */
  snapshot(): CreditTelemetryPayload {
    const now = this.clock();
    const today = utcDate(now);
    const startDate = utcDateDaysBack(now, SPARKLINE_DAYS - 1);
    const log = this.loggerFactory();

    // provider → accumulator
    const acc = new Map<string, ProviderAccumulator>();

    for (const agent of this.currentAgents()) {
      let db: DatabaseType | undefined;
      try {
        db = this.dbFactory(agent.usageDbPath);
        const dayRows = db
          .prepare(
            `SELECT provider, model,
                    SUM(tokens_in)  AS tokens_in,
                    SUM(tokens_out) AS tokens_out,
                    SUM(cost_usd)   AS cost_usd,
                    SUM(turn_count) AS turn_count
               FROM provider_usage
              WHERE date = ?
              GROUP BY provider, model`,
          )
          .all(today) as DayRow[];

        const sparkRows = db
          .prepare(
            `SELECT date, provider, SUM(cost_usd) AS cost_usd
               FROM provider_usage
              WHERE date >= ? AND date <= ?
              GROUP BY date, provider`,
          )
          .all(startDate, today) as SparkRow[];

        this.foldAgent(acc, agent.name, dayRows, sparkRows, startDate);
      } catch (err) {
        // M7 — distinguish the BENIGN expected case (an agent whose
        // `usage.db` has not yet lazy-created the `provider_usage` table, or
        // whose db file does not exist — e.g. fin-tax, an agent that has
        // taken no turns) from a GENUINE corruption / read fault. The benign
        // case fired on EVERY snapshot for un-migrated agents → recurring
        // warn-spam. Downgrade it to debug; keep warn for real faults.
        const message = err instanceof Error ? err.message : String(err);
        const benign =
          /no such table: provider_usage/i.test(message) ||
          /unable to open database file/i.test(message) ||
          /SQLITE_CANTOPEN/i.test(message) ||
          /ENOENT/i.test(message);
        const logFields = {
          tag: "phase138-status-aggregation",
          agent: agent.name,
          usageDbPath: agent.usageDbPath,
          error: message,
        };
        if (benign) {
          log.debug(
            logFields,
            "phase138-status-aggregation: agent usage.db not yet initialized (expected)",
          );
        } else {
          log.warn(
            logFields,
            "phase138-status-aggregation: skipped agent usage.db",
          );
        }
      } finally {
        try {
          db?.close();
        } catch {
          // best-effort close — nothing actionable on a close failure.
        }
      }
    }

    return this.materialise(acc, today);
  }

  /** Fold one agent's rows into the cross-agent accumulator. */
  private foldAgent(
    acc: Map<string, ProviderAccumulator>,
    agentName: string,
    dayRows: readonly DayRow[],
    sparkRows: readonly SparkRow[],
    startDate: string,
  ): void {
    for (const row of dayRows) {
      const entry = this.ensureAccumulator(acc, row.provider);
      entry.cost_usd += row.cost_usd;
      entry.tokens_in += row.tokens_in;
      entry.tokens_out += row.tokens_out;
      entry.turn_count += row.turn_count;
      entry.agents.add(agentName);

      const model = entry.models.get(row.model);
      if (model) {
        model.cost_usd += row.cost_usd;
        model.tokens_in += row.tokens_in;
        model.tokens_out += row.tokens_out;
      } else {
        entry.models.set(row.model, {
          cost_usd: row.cost_usd,
          tokens_in: row.tokens_in,
          tokens_out: row.tokens_out,
        });
      }
    }

    for (const row of sparkRows) {
      const idx = dayDiff(startDate, row.date);
      if (idx < 0 || idx >= SPARKLINE_DAYS) continue;
      const entry = this.ensureAccumulator(acc, row.provider);
      entry.sparkline[idx]! += row.cost_usd;
    }
  }

  /** Get-or-create the accumulator for a provider. */
  private ensureAccumulator(
    acc: Map<string, ProviderAccumulator>,
    provider: string,
  ): ProviderAccumulator {
    let entry = acc.get(provider);
    if (!entry) {
      entry = {
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
        turn_count: 0,
        models: new Map(),
        agents: new Set(),
        sparkline: new Array<number>(SPARKLINE_DAYS).fill(0),
      };
      acc.set(provider, entry);
    }
    return entry;
  }

  /** Materialise the accumulator into the frozen wire payload. */
  private materialise(
    acc: Map<string, ProviderAccumulator>,
    today: string,
  ): CreditTelemetryPayload {
    const providers: CreditTelemetryEntry[] = [];

    // Stable provider ordering — alphabetical so the CLI / dashboard
    // render deterministically.
    const sortedProviders = [...acc.keys()].sort();
    for (const provider of sortedProviders) {
      const entry = acc.get(provider)!;
      const cap = this.resolveCapForProvider(provider, entry.agents);
      const pct = cap > 0 ? (entry.cost_usd / cap) * 100 : 0;

      const models = [...entry.models.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([model, m]) =>
          Object.freeze({
            model,
            tokens_in: m.tokens_in,
            tokens_out: m.tokens_out,
            cost_usd: m.cost_usd,
          }),
        );

      providers.push(
        Object.freeze({
          provider: provider as CreditTelemetryEntry["provider"],
          cost_usd: entry.cost_usd,
          cap_usd: cap,
          pct,
          tokens_in: entry.tokens_in,
          tokens_out: entry.tokens_out,
          turn_count: entry.turn_count,
          models: Object.freeze(models),
          sparkline: Object.freeze([...entry.sparkline]),
          agents: Object.freeze([...entry.agents].sort()),
        }) as CreditTelemetryEntry,
      );
    }

    return Object.freeze({
      date: today,
      providers: Object.freeze(providers),
    }) as CreditTelemetryPayload;
  }

  /**
   * Fleet-level cap for a provider = `max(resolveCap(provider, agent))`
   * across the contributing agents. When no agent contributed (cannot
   * happen for a provider that is in the accumulator), fall back to the
   * agent-less resolution.
   */
  private resolveCapForProvider(
    provider: string,
    contributors: ReadonlySet<string>,
  ): number {
    if (contributors.size === 0) {
      return this.resolveCap(provider);
    }
    let max = -Infinity;
    for (const agent of contributors) {
      const cap = this.resolveCap(provider, agent);
      if (cap > max) max = cap;
    }
    return max;
  }
}
