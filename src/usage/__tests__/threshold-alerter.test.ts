/**
 * Phase 138 Plan 03 T-02 — `ThresholdAlerter` unit tests.
 *
 * Proves per-day dedup, atomicity, the Plan-04 failover signal, and
 * webhook-failure isolation against an in-memory `fleet-alerts.db` with
 * a `vi.fn()`-stubbed `WebhookManager`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { WebhookManager } from "../../discord/webhook-manager.js";
import type { CreditTelemetryPayload } from "../../ipc/protocol.js";
import {
  ThresholdAlerter,
  ALERT_CHANNEL,
  type AlerterLogger,
} from "../threshold-alerter.js";

/** Build an in-memory fleet-alerts.db. */
function makeDb(): DatabaseType {
  return new Database(":memory:");
}

/** A recording logger — captures every `info` / `warn` payload. */
function makeLogger(): AlerterLogger & {
  infos: unknown[];
  warns: unknown[];
} {
  const infos: unknown[] = [];
  const warns: unknown[] = [];
  return {
    infos,
    warns,
    info: (obj: unknown) => infos.push(obj),
    warn: (obj: unknown) => warns.push(obj),
  };
}

/** A stub WebhookManager exposing only the `send` the alerter calls. */
function makeWebhookStub(): {
  webhookManager: WebhookManager;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue(undefined);
  return { webhookManager: { send } as unknown as WebhookManager, send };
}

/** One provider entry with a tunable `pct`. */
function providerEntry(
  provider: "openai" | "anthropic",
  pct: number,
  agents: string[] = ["research"],
): CreditTelemetryPayload["providers"][number] {
  return {
    provider,
    cost_usd: (6.67 * pct) / 100,
    cap_usd: 6.67,
    pct,
    tokens_in: 1000,
    tokens_out: 500,
    turn_count: 3,
    models: [],
    sparkline: new Array<number>(24).fill(0),
    agents,
  };
}

/** A telemetry payload for a fixed UTC date. */
function payload(
  date: string,
  providers: CreditTelemetryPayload["providers"][number][],
): CreditTelemetryPayload {
  return { date, providers };
}

/** A fixed clock at a given ISO instant. */
function fixedClock(iso: string): () => number {
  return () => Date.parse(iso);
}

/** Count rows in provider_alert_state for a date. */
function rowCount(db: DatabaseType, date: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM provider_alert_state WHERE date = ?",
      )
      .get(date) as { n: number }
  ).n;
}

const DAY1 = "2026-05-20T12:00:00.000Z";
const DAY1_DATE = "2026-05-20";
const DAY2 = "2026-05-21T12:00:00.000Z";
const DAY2_DATE = "2026-05-21";

describe("ThresholdAlerter", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = makeDb();
  });

  it("constructor creates provider_alert_state idempotently", () => {
    const { webhookManager } = makeWebhookStub();
    new ThresholdAlerter({ db, webhookManager });
    // Second construction on the same db must not throw.
    expect(
      () => new ThresholdAlerter({ db, webhookManager }),
    ).not.toThrow();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_alert_state'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("(a) first 75% crossing fires the webhook + inserts a row", async () => {
    const { webhookManager, send } = makeWebhookStub();
    const alerter = new ThresholdAlerter({
      db,
      webhookManager,
      clock: fixedClock(DAY1),
    });

    const results = await alerter.evaluate(
      payload(DAY1_DATE, [providerEntry("openai", 76)]),
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(ALERT_CHANNEL);
    expect(send.mock.calls[0]![1]).toContain("⚠️ openai usage at 75%");
    expect(rowCount(db, DAY1_DATE)).toBe(1);
    expect(results).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        threshold: 75,
        fired: true,
        dedup_skipped: false,
      }),
    );
  });

  it("(b) second 75% crossing same day does NOT fire the webhook", async () => {
    const { webhookManager, send } = makeWebhookStub();
    const alerter = new ThresholdAlerter({
      db,
      webhookManager,
      clock: fixedClock(DAY1),
    });

    await alerter.evaluate(payload(DAY1_DATE, [providerEntry("openai", 76)]));
    send.mockClear();

    const results = await alerter.evaluate(
      payload(DAY1_DATE, [providerEntry("openai", 80)]),
    );

    expect(send).not.toHaveBeenCalled();
    expect(rowCount(db, DAY1_DATE)).toBe(1);
    expect(results).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        threshold: 75,
        fired: false,
        dedup_skipped: true,
      }),
    );
  });

  it("(c) crossing 75 → dropping below → re-crossing same day does NOT re-fire", async () => {
    const { webhookManager, send } = makeWebhookStub();
    const alerter = new ThresholdAlerter({
      db,
      webhookManager,
      clock: fixedClock(DAY1),
    });

    // Cross 75.
    await alerter.evaluate(payload(DAY1_DATE, [providerEntry("openai", 76)]));
    // Drop to 60 — no threshold met, nothing fires.
    await alerter.evaluate(payload(DAY1_DATE, [providerEntry("openai", 60)]));
    send.mockClear();
    // Re-cross at 82 — still 75-threshold; per-DAY dedup, not per-edge.
    await alerter.evaluate(payload(DAY1_DATE, [providerEntry("openai", 82)]));

    expect(send).not.toHaveBeenCalled();
    expect(rowCount(db, DAY1_DATE)).toBe(1);
  });

  it("(d) crossing 90 fires independently of 75 (distinct rows)", async () => {
    const { webhookManager, send } = makeWebhookStub();
    const alerter = new ThresholdAlerter({
      db,
      webhookManager,
      clock: fixedClock(DAY1),
    });

    // pct=91 crosses BOTH 75 and 90 → two distinct rows, two sends.
    const results = await alerter.evaluate(
      payload(DAY1_DATE, [providerEntry("openai", 91)]),
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(rowCount(db, DAY1_DATE)).toBe(2);
    const thresholds = results
      .filter((r) => r.fired)
      .map((r) => r.threshold)
      .sort();
    expect(thresholds).toEqual([75, 90]);
  });

  it("(e) 95% crossing emits phase138-failover-triggerable alongside threshold-crossed", async () => {
    const { webhookManager } = makeWebhookStub();
    const logger = makeLogger();
    const alerter = new ThresholdAlerter({
      db,
      webhookManager,
      clock: fixedClock(DAY1),
      logger,
    });

    await alerter.evaluate(payload(DAY1_DATE, [providerEntry("openai", 96)]));

    const tags = logger.infos.map(
      (o) => (o as { tag?: string }).tag,
    );
    expect(tags).toContain("phase138-threshold-crossed");
    expect(tags).toContain("phase138-failover-triggerable");
    // The failover signal only fires for the 95 threshold, once.
    expect(
      tags.filter((t) => t === "phase138-failover-triggerable"),
    ).toHaveLength(1);
  });

  it("(f) webhook rejection is caught — evaluate resolves, row still persisted", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(
        new Error("No webhook identity configured for agent 'admin-clawdy'"),
      );
    const webhookManager = { send } as unknown as WebhookManager;
    const logger = makeLogger();
    const alerter = new ThresholdAlerter({
      db,
      webhookManager,
      clock: fixedClock(DAY1),
      logger,
    });

    // Must NOT throw despite the rejected send.
    const results = await alerter.evaluate(
      payload(DAY1_DATE, [providerEntry("openai", 76)]),
    );

    expect(send).toHaveBeenCalledTimes(1);
    // Dedup row persisted regardless of delivery outcome.
    expect(rowCount(db, DAY1_DATE)).toBe(1);
    const failures = logger.warns.filter(
      (o) => (o as { tag?: string }).tag === "phase138-threshold-alert-failure",
    );
    expect(failures).toHaveLength(1);
    expect(results[0]!.fired).toBe(true);
    expect(results[0]!.webhook_error).toContain("No webhook identity");
  });

  it("(g) a new UTC day does NOT block — previous day's rows are a different PK", async () => {
    const { webhookManager, send } = makeWebhookStub();

    const day1Alerter = new ThresholdAlerter({
      db,
      webhookManager,
      clock: fixedClock(DAY1),
    });
    await day1Alerter.evaluate(
      payload(DAY1_DATE, [providerEntry("openai", 76)]),
    );
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();

    // Same db, new day — re-fires.
    const day2Alerter = new ThresholdAlerter({
      db,
      webhookManager,
      clock: fixedClock(DAY2),
    });
    await day2Alerter.evaluate(
      payload(DAY2_DATE, [providerEntry("openai", 76)]),
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(rowCount(db, DAY1_DATE)).toBe(1);
    expect(rowCount(db, DAY2_DATE)).toBe(1);
  });

  it("(h) two providers crossing the same threshold both fire (independent rows)", async () => {
    const { webhookManager, send } = makeWebhookStub();
    const alerter = new ThresholdAlerter({
      db,
      webhookManager,
      clock: fixedClock(DAY1),
    });

    const results = await alerter.evaluate(
      payload(DAY1_DATE, [
        providerEntry("openai", 76),
        providerEntry("anthropic", 77),
      ]),
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(rowCount(db, DAY1_DATE)).toBe(2);
    const fired = results.filter((r) => r.fired);
    expect(fired.map((r) => r.provider).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
  });
});
