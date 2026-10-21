/**
 * Phase 138 Plan 03 T-03 — daemon heartbeat-status seam test.
 *
 * The `threshold-alerter.test.ts` unit suite proves the alerter LOGIC in
 * isolation. This file proves the SEAM: that the exact triad the
 * `daemon.ts` `heartbeat-status` IPC case runs —
 *
 *   1. `ProviderTelemetryAggregator.snapshot()` over real seeded
 *      per-agent `usage.db` files,
 *   2. `ThresholdAlerter.evaluate(snapshot)` fired against the SAME
 *      payload,
 *   3. `buildHeartbeatStatusPayload({ providerTelemetryAggregator:
 *      { snapshot: () => snapshot } })`,
 *
 * — actually dispatches a Discord webhook on a 75% crossing and records
 * the dedup row. Closes the silent-path-bifurcation gap (HARD CONSTRAINT
 * #4): without it, "the heartbeat path fires the alerter" would rest on
 * an unverified transitive argument (Plan 02's SUMMARY explicitly
 * flagged this daemon-wiring gap and deferred it — Plan 03 closes its
 * own analogue here).
 *
 * It does NOT boot the full daemon (too heavy for a unit test); it
 * reconstructs the heartbeat-status case body verbatim around seeded
 * in-process SQLite + a stubbed WebhookManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { ProviderTelemetryAggregator } from "../provider-telemetry-aggregator.js";
import { buildHeartbeatStatusPayload } from "../heartbeat-status-builder.js";
import { ThresholdAlerter } from "../../usage/threshold-alerter.js";
import type { WebhookManager } from "../../discord/webhook-manager.js";

/** provider_usage DDL — verbatim from CONTEXT D2 (Plan 01's per-agent table). */
const PROVIDER_USAGE_DDL = `
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
`;

/** Today's UTC YYYY-MM-DD — the aggregator only sums the current day. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Seed one agent's usage.db with a provider_usage row at the given cost. */
function seedAgentUsageDb(path: string, provider: string, costUsd: number): void {
  const db = new Database(path);
  try {
    db.exec(PROVIDER_USAGE_DDL);
    const now = Date.now();
    db.prepare(
      `INSERT INTO provider_usage
        (date, provider, model, tokens_in, tokens_out, cost_usd, turn_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(todayUtc(), provider, "gpt-5-codex", 1000, 500, costUsd, 3, now, now);
  } finally {
    db.close();
  }
}

/** A stub WebhookManager exposing only the `send` the alerter calls. */
function makeWebhookStub(): {
  webhookManager: WebhookManager;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue(undefined);
  return { webhookManager: { send } as unknown as WebhookManager, send };
}

describe("Phase 138-03 — heartbeat-status → ThresholdAlerter seam", () => {
  let tmp: string;
  let fleetDb: DatabaseType;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "p138-03-"));
    fleetDb = new Database(":memory:");
  });

  afterEach(() => {
    fleetDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Reconstruct the daemon `heartbeat-status` case body: build the
   * aggregator over the seeded agent dbs, snapshot ONCE, fire the
   * alerter against that payload, build the heartbeat payload from the
   * SAME snapshot.
   */
  async function runHeartbeatCase(
    agents: { name: string; usageDbPath: string }[],
    alerter: ThresholdAlerter,
  ) {
    const aggregator = new ProviderTelemetryAggregator({
      agents,
      // openai daily cap 6.67 — a $5.10 spend = 76.5% → crosses 75.
      resolveCap: () => 6.67,
    });
    const creditSnapshot = aggregator.snapshot();
    await alerter.evaluate(creditSnapshot);
    const payload = buildHeartbeatStatusPayload({
      results: new Map(),
      zoneStatuses: new Map(),
      getLastCompactionAt: () => null,
      getContextFillProvider: () => undefined,
      providerTelemetryAggregator: { snapshot: () => creditSnapshot },
    });
    return { creditSnapshot, payload };
  }

  it("fires ONE admin-clawdy webhook with verbatim ALERT_MSG_75 on a 75% crossing", async () => {
    const usageDbPath = join(tmp, "research-usage.db");
    seedAgentUsageDb(usageDbPath, "openai", 5.1); // 5.1 / 6.67 ≈ 76.5%

    const { webhookManager, send } = makeWebhookStub();
    const alerter = new ThresholdAlerter({ db: fleetDb, webhookManager });

    const { creditSnapshot } = await runHeartbeatCase(
      [{ name: "research", usageDbPath }],
      alerter,
    );

    // The aggregator actually saw the seeded spend.
    expect(creditSnapshot.providers).toHaveLength(1);
    expect(creditSnapshot.providers[0]!.provider).toBe("openai");
    expect(creditSnapshot.providers[0]!.pct).toBeGreaterThanOrEqual(75);
    expect(creditSnapshot.providers[0]!.pct).toBeLessThan(90);

    // Exactly one webhook, to admin-clawdy, with the verbatim 75 message.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("admin-clawdy");
    expect(send.mock.calls[0]![1]).toContain("⚠️ openai usage at 75%");

    // The dedup row landed in fleet-alerts.db.
    const rows = fleetDb
      .prepare(
        "SELECT * FROM provider_alert_state WHERE provider = 'openai' AND threshold = 75",
      )
      .all();
    expect(rows).toHaveLength(1);
  });

  it("second heartbeat the same day does NOT re-fire the webhook (dedup)", async () => {
    const usageDbPath = join(tmp, "research-usage.db");
    seedAgentUsageDb(usageDbPath, "openai", 5.1);

    const { webhookManager, send } = makeWebhookStub();
    const alerter = new ThresholdAlerter({ db: fleetDb, webhookManager });
    const agents = [{ name: "research", usageDbPath }];

    await runHeartbeatCase(agents, alerter);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();

    // A second heartbeat tick — same day, same crossing.
    await runHeartbeatCase(agents, alerter);
    expect(send).not.toHaveBeenCalled();
  });

  it("attaches the same snapshot to the heartbeat payload's creditTelemetry field", async () => {
    const usageDbPath = join(tmp, "research-usage.db");
    seedAgentUsageDb(usageDbPath, "openai", 5.1);

    const { webhookManager } = makeWebhookStub();
    const alerter = new ThresholdAlerter({ db: fleetDb, webhookManager });

    const { creditSnapshot, payload } = await runHeartbeatCase(
      [{ name: "research", usageDbPath }],
      alerter,
    );

    // The IPC client sees EXACTLY what the alerter evaluated.
    expect(payload.creditTelemetry).toBe(creditSnapshot);
  });

  it("a below-threshold spend fires no webhook and writes no row", async () => {
    const usageDbPath = join(tmp, "quiet-usage.db");
    seedAgentUsageDb(usageDbPath, "openai", 1.0); // 1.0 / 6.67 ≈ 15%

    const { webhookManager, send } = makeWebhookStub();
    const alerter = new ThresholdAlerter({ db: fleetDb, webhookManager });

    await runHeartbeatCase([{ name: "quiet", usageDbPath }], alerter);

    expect(send).not.toHaveBeenCalled();
    expect(
      fleetDb.prepare("SELECT COUNT(*) AS n FROM provider_alert_state").get(),
    ).toEqual({ n: 0 });
  });

  it("a missing admin-clawdy webhook identity does not crash the heartbeat path", async () => {
    const usageDbPath = join(tmp, "research-usage.db");
    seedAgentUsageDb(usageDbPath, "openai", 5.1);

    // Stub that throws the real WebhookManager "no identity" error.
    const send = vi
      .fn()
      .mockRejectedValue(
        new Error("No webhook identity configured for agent 'admin-clawdy'"),
      );
    const webhookManager = { send } as unknown as WebhookManager;
    const alerter = new ThresholdAlerter({ db: fleetDb, webhookManager });

    // Must resolve — a missing admin-clawdy binding cannot fail the
    // heartbeat-status IPC response.
    await expect(
      runHeartbeatCase([{ name: "research", usageDbPath }], alerter),
    ).resolves.toBeDefined();

    // Row still recorded — intent is "alert attempted".
    expect(
      fleetDb.prepare("SELECT COUNT(*) AS n FROM provider_alert_state").get(),
    ).toEqual({ n: 1 });
  });
});
