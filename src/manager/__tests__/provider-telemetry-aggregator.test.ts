/**
 * Phase 138 Plan 02 T-01 — `ProviderTelemetryAggregator` behavior pinning.
 *
 * The aggregator reads ALL agent `usage.db` files at IPC-status request
 * time, sums `provider_usage` rows by provider for the current UTC day,
 * and returns a frozen fleet-aggregate `CreditTelemetryPayload`.
 *
 * Proves the 9 cases (the 8 from the PLAN T-01 `<action>` block plus the
 * advisor-flagged missing-table case):
 *   (a) Empty fleet → `{date, providers: []}`.
 *   (b) Single agent, single provider, one turn → cost matches.
 *   (c) Two agents, same provider → costs sum.
 *   (d) Two agents, different providers → 2 entries.
 *   (e) Missing db FILE for one agent → warning logged, other included.
 *   (f) Sparkline length exactly 24, zero-padded for empty days.
 *   (g) Cap resolution — per-provider cap = max across agents.
 *   (h) Frozen return value (providers + sparkline).
 *   (i) db file EXISTS but `provider_usage` table absent → warning
 *       logged, agent skipped, snapshot still returned. (Advisor flag —
 *       the table is created lazily on first turn, so a running agent
 *       that has not taken a turn yet has a usage.db with no table.)
 *
 * All I/O is dependency-injected: `dbFactory` returns seeded in-memory
 * dbs; `loggerFactory` returns a recording stub so warnings can be
 * asserted. No real filesystem access in any test.
 *
 * See:
 *   - `src/manager/provider-telemetry-aggregator.ts`
 *   - `.planning/phases/138-.../138-02-PLAN.md` T-01 <behavior>
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  ProviderTelemetryAggregator,
  type AggregatorAgent,
} from "../provider-telemetry-aggregator.js";

/** Fixed wall clock — 2026-05-20T12:00:00Z → UTC date "2026-05-20". */
const FIXED_MILLIS = Date.parse("2026-05-20T12:00:00.000Z");
const FIXED_DATE = "2026-05-20";

/** Recording logger stub — captures `warn` + `debug` calls for assertion. */
function makeLogger() {
  const warnings: Array<{ obj: unknown; msg?: string }> = [];
  const debugs: Array<{ obj: unknown; msg?: string }> = [];
  return {
    warnings,
    debugs,
    logger: {
      warn: (obj: unknown, msg?: string) => warnings.push({ obj, msg }),
      info: () => {},
      debug: (obj: unknown, msg?: string) => debugs.push({ obj, msg }),
      error: () => {},
    },
  };
}

/**
 * Create an in-memory db with the `provider_usage` table created.
 * Optionally skip table creation to simulate a fresh (no-turn-yet) db.
 */
function makeDb(opts?: { withTable?: boolean }): DatabaseType {
  const db = new Database(":memory:");
  if (opts?.withTable !== false) {
    db.exec(`
      CREATE TABLE provider_usage (
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
    `);
  }
  return db;
}

/** Seed one `provider_usage` row. */
function seedRow(
  db: DatabaseType,
  row: {
    date: string;
    provider: string;
    model: string;
    tokens_in?: number;
    tokens_out?: number;
    cost_usd?: number;
    turn_count?: number;
  },
): void {
  db.prepare(
    `INSERT INTO provider_usage
       (date, provider, model, tokens_in, tokens_out, cost_usd, turn_count, created_at, updated_at)
     VALUES (@date, @provider, @model, @tokens_in, @tokens_out, @cost_usd, @turn_count, 0, 0)`,
  ).run({
    date: row.date,
    provider: row.provider,
    model: row.model,
    tokens_in: row.tokens_in ?? 0,
    tokens_out: row.tokens_out ?? 0,
    cost_usd: row.cost_usd ?? 0,
    turn_count: row.turn_count ?? 0,
  });
}

/**
 * Build an aggregator whose `dbFactory` returns the supplied per-path
 * db map. A path absent from the map throws ENOENT-like (simulating a
 * missing file).
 */
function makeAggregator(
  agents: readonly AggregatorAgent[],
  dbByPath: Record<string, DatabaseType>,
  opts?: { resolveCap?: (provider: string, agent?: string) => number },
) {
  const { warnings, debugs, logger } = makeLogger();
  const aggregator = new ProviderTelemetryAggregator({
    agents,
    resolveCap: opts?.resolveCap ?? (() => 6.67),
    clock: () => FIXED_MILLIS,
    dbFactory: (path: string) => {
      const db = dbByPath[path];
      if (!db) {
        const err = new Error(
          `SQLITE_CANTOPEN: unable to open database file: ${path}`,
        );
        throw err;
      }
      return db;
    },
    loggerFactory: () => logger as never,
  });
  return { aggregator, warnings, debugs };
}

describe("ProviderTelemetryAggregator", () => {
  it("(a) empty fleet → {date, providers: []}", () => {
    const { aggregator } = makeAggregator([], {});
    const snap = aggregator.snapshot();
    expect(snap.date).toBe(FIXED_DATE);
    expect(snap.providers).toEqual([]);
  });

  it("(b) single agent, single provider → cost matches", () => {
    const db = makeDb();
    seedRow(db, {
      date: FIXED_DATE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      tokens_in: 1000,
      tokens_out: 500,
      cost_usd: 1.25,
      turn_count: 1,
    });
    const { aggregator } = makeAggregator(
      [{ name: "alpha", usageDbPath: "/agents/alpha/usage.db" }],
      { "/agents/alpha/usage.db": db },
    );
    const snap = aggregator.snapshot();
    expect(snap.providers).toHaveLength(1);
    const entry = snap.providers[0]!;
    expect(entry.provider).toBe("anthropic");
    expect(entry.cost_usd).toBeCloseTo(1.25);
    expect(entry.tokens_in).toBe(1000);
    expect(entry.tokens_out).toBe(500);
    expect(entry.turn_count).toBe(1);
    expect(entry.agents).toEqual(["alpha"]);
  });

  it("(c) two agents, same provider → costs sum", () => {
    const dbA = makeDb();
    const dbB = makeDb();
    seedRow(dbA, {
      date: FIXED_DATE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      tokens_in: 1000,
      tokens_out: 500,
      cost_usd: 1.0,
      turn_count: 1,
    });
    seedRow(dbB, {
      date: FIXED_DATE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      tokens_in: 2000,
      tokens_out: 800,
      cost_usd: 2.5,
      turn_count: 3,
    });
    const { aggregator } = makeAggregator(
      [
        { name: "alpha", usageDbPath: "/a/usage.db" },
        { name: "beta", usageDbPath: "/b/usage.db" },
      ],
      { "/a/usage.db": dbA, "/b/usage.db": dbB },
    );
    const snap = aggregator.snapshot();
    expect(snap.providers).toHaveLength(1);
    const entry = snap.providers[0]!;
    expect(entry.cost_usd).toBeCloseTo(3.5);
    expect(entry.tokens_in).toBe(3000);
    expect(entry.tokens_out).toBe(1300);
    expect(entry.turn_count).toBe(4);
    expect([...entry.agents].sort()).toEqual(["alpha", "beta"]);
  });

  it("(d) two agents, different providers → 2 entries", () => {
    const dbA = makeDb();
    const dbB = makeDb();
    seedRow(dbA, {
      date: FIXED_DATE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cost_usd: 1.0,
      turn_count: 1,
    });
    seedRow(dbB, {
      date: FIXED_DATE,
      provider: "openai",
      model: "gpt-5-codex",
      cost_usd: 2.0,
      turn_count: 1,
    });
    const { aggregator } = makeAggregator(
      [
        { name: "alpha", usageDbPath: "/a/usage.db" },
        { name: "beta", usageDbPath: "/b/usage.db" },
      ],
      { "/a/usage.db": dbA, "/b/usage.db": dbB },
    );
    const snap = aggregator.snapshot();
    expect(snap.providers).toHaveLength(2);
    const providers = snap.providers.map((p) => p.provider).sort();
    expect(providers).toEqual(["anthropic", "openai"]);
  });

  it("(e) missing db FILE for one agent → benign DEBUG (M7: not warn), other included", () => {
    const dbB = makeDb();
    seedRow(dbB, {
      date: FIXED_DATE,
      provider: "openai",
      model: "gpt-5-codex",
      cost_usd: 2.0,
      turn_count: 1,
    });
    const { aggregator, warnings, debugs } = makeAggregator(
      [
        { name: "alpha", usageDbPath: "/missing/usage.db" },
        { name: "beta", usageDbPath: "/b/usage.db" },
      ],
      { "/b/usage.db": dbB }, // alpha's path absent → factory throws CANTOPEN
    );
    const snap = aggregator.snapshot();
    expect(snap.providers).toHaveLength(1);
    expect(snap.providers[0]!.provider).toBe("openai");
    // M7 — a missing db FILE (uninitialized agent) is expected, not a fault:
    // it must NOT warn-spam. Logged at debug; the agent is still skipped.
    expect(
      warnings.some((w) =>
        JSON.stringify(w).includes("phase138-status-aggregation"),
      ),
    ).toBe(false);
    expect(
      debugs.some((d) =>
        JSON.stringify(d).includes("phase138-status-aggregation"),
      ),
    ).toBe(true);
  });

  it("(f) sparkline length exactly 24, zero-padded for empty days", () => {
    const db = makeDb();
    // Today + two earlier days within the 24-day window.
    seedRow(db, {
      date: FIXED_DATE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cost_usd: 3.0,
      turn_count: 1,
    });
    seedRow(db, {
      date: "2026-05-19",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cost_usd: 2.0,
      turn_count: 1,
    });
    seedRow(db, {
      date: "2026-05-10",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cost_usd: 1.0,
      turn_count: 1,
    });
    const { aggregator } = makeAggregator(
      [{ name: "alpha", usageDbPath: "/a/usage.db" }],
      { "/a/usage.db": db },
    );
    const snap = aggregator.snapshot();
    const entry = snap.providers[0]!;
    expect(entry.sparkline).toHaveLength(24);
    // Today is index 23.
    expect(entry.sparkline[23]).toBeCloseTo(3.0);
    // Yesterday is index 22.
    expect(entry.sparkline[22]).toBeCloseTo(2.0);
    // 2026-05-10 is 10 days before 2026-05-20 → index 13.
    expect(entry.sparkline[13]).toBeCloseTo(1.0);
    // Sum of the array equals the seeded total.
    const sum = entry.sparkline.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(6.0);
    // Days with no rows are 0.
    expect(entry.sparkline[0]).toBe(0);
  });

  it("(g) cap resolution — per-provider cap = max across agents", () => {
    const dbA = makeDb();
    const dbB = makeDb();
    seedRow(dbA, {
      date: FIXED_DATE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cost_usd: 1.0,
      turn_count: 1,
    });
    seedRow(dbB, {
      date: FIXED_DATE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cost_usd: 1.0,
      turn_count: 1,
    });
    const { aggregator } = makeAggregator(
      [
        { name: "alpha", usageDbPath: "/a/usage.db" },
        { name: "beta", usageDbPath: "/b/usage.db" },
      ],
      { "/a/usage.db": dbA, "/b/usage.db": dbB },
      {
        // alpha capped at 5, beta at 20 → fleet cap = max = 20.
        resolveCap: (_provider, agent) => (agent === "beta" ? 20 : 5),
      },
    );
    const snap = aggregator.snapshot();
    const entry = snap.providers[0]!;
    expect(entry.cap_usd).toBe(20);
    // pct = cost (2.0) / cap (20) * 100 = 10.
    expect(entry.pct).toBeCloseTo(10);
  });

  it("(h) frozen return value — providers + sparkline + entry", () => {
    const db = makeDb();
    seedRow(db, {
      date: FIXED_DATE,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cost_usd: 1.0,
      turn_count: 1,
    });
    const { aggregator } = makeAggregator(
      [{ name: "alpha", usageDbPath: "/a/usage.db" }],
      { "/a/usage.db": db },
    );
    const snap = aggregator.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.providers)).toBe(true);
    expect(Object.isFrozen(snap.providers[0])).toBe(true);
    expect(Object.isFrozen(snap.providers[0]!.sparkline)).toBe(true);
  });

  it("(i) db file exists but provider_usage table absent → benign DEBUG (M7: not warn), agent skipped", () => {
    // alpha's db has NO provider_usage table (fresh agent, no turn yet).
    const dbA = makeDb({ withTable: false });
    const dbB = makeDb();
    seedRow(dbB, {
      date: FIXED_DATE,
      provider: "openai",
      model: "gpt-5-codex",
      cost_usd: 2.0,
      turn_count: 1,
    });
    const { aggregator, warnings, debugs } = makeAggregator(
      [
        { name: "alpha", usageDbPath: "/a/usage.db" },
        { name: "beta", usageDbPath: "/b/usage.db" },
      ],
      { "/a/usage.db": dbA, "/b/usage.db": dbB },
    );
    const snap = aggregator.snapshot();
    // beta still aggregated; alpha skipped without failing the snapshot.
    expect(snap.providers).toHaveLength(1);
    expect(snap.providers[0]!.provider).toBe("openai");
    // M7 — un-migrated `provider_usage` table is the expected lazy-create
    // case (fin-tax etc.). It must NOT warn-spam on every snapshot; debug only.
    expect(
      warnings.some((w) =>
        JSON.stringify(w).includes("phase138-status-aggregation"),
      ),
    ).toBe(false);
    expect(
      debugs.some((d) =>
        JSON.stringify(d).includes("phase138-status-aggregation"),
      ),
    ).toBe(true);
  });

  it("(i-2) M7: a GENUINE corruption error still WARNS (discriminator)", () => {
    // A real fault (disk image malformed) is not the benign lazy-create case
    // and must still surface at warn — the M7 downgrade only silences the
    // expected un-initialized-db conditions, never real corruption.
    const { warnings, debugs, logger } = makeLogger();
    const aggregator = new ProviderTelemetryAggregator({
      agents: [{ name: "alpha", usageDbPath: "/a/usage.db" }],
      resolveCap: () => 6.67,
      clock: () => FIXED_MILLIS,
      dbFactory: () => {
        throw new Error("database disk image is malformed");
      },
      loggerFactory: () => logger as never,
    });
    const snap = aggregator.snapshot();
    expect(snap.providers).toHaveLength(0);
    expect(
      warnings.some((w) =>
        JSON.stringify(w).includes("phase138-status-aggregation"),
      ),
    ).toBe(true);
    expect(
      debugs.some((d) =>
        JSON.stringify(d).includes("phase138-status-aggregation"),
      ),
    ).toBe(false);
  });

  it("includes a per-model breakdown for the drawer", () => {
    const db = makeDb();
    seedRow(db, {
      date: FIXED_DATE,
      provider: "openai",
      model: "gpt-5-codex",
      tokens_in: 100,
      tokens_out: 50,
      cost_usd: 1.0,
      turn_count: 1,
    });
    seedRow(db, {
      date: FIXED_DATE,
      provider: "openai",
      model: "o3",
      tokens_in: 200,
      tokens_out: 80,
      cost_usd: 2.0,
      turn_count: 1,
    });
    const { aggregator } = makeAggregator(
      [{ name: "alpha", usageDbPath: "/a/usage.db" }],
      { "/a/usage.db": db },
    );
    const snap = aggregator.snapshot();
    const entry = snap.providers[0]!;
    expect(entry.models).toHaveLength(2);
    const models = entry.models.map((m) => m.model).sort();
    expect(models).toEqual(["gpt-5-codex", "o3"]);
    expect(entry.cost_usd).toBeCloseTo(3.0);
  });
});
