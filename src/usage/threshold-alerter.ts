/**
 * Phase 138 Plan 03 T-02/T-03 — `ThresholdAlerter`.
 *
 * Fires ONE Discord webhook to the `admin-clawdy` channel per provider
 * per threshold (75 / 90 / 95 / 99%) per UTC day. The dedup table
 * `provider_alert_state` (created idempotently by this class's
 * constructor in the fleet-level `fleet-alerts.db`) is the single
 * source of truth for whether an alert has already fired.
 *
 * **Strict layering (138-03 objective).** This class OBSERVES + ALERTS;
 * it never decides or performs a failover. Plan 04's failover controller
 * polls `provider_alert_state` for `threshold=95` rows on its own cron
 * tick. The signal from Plan 03 to Plan 04 is that row + the
 * `phase138-failover-triggerable` log line.
 *
 * **Atomic dedup (Threat T-138-03-01).** Each crossing is recorded with
 * a single SQL statement —
 *   `INSERT ... ON CONFLICT (date, provider, threshold) DO NOTHING`.
 * `Statement.run(...).changes` is `1` for the first fire today and `0`
 * when the row already exists. better-sqlite3's synchronous API makes
 * the SELECT-or-INSERT a single, race-free statement: ZERO window
 * between "is it already fired" and "record that it fired". A daemon
 * crash-loop re-running `evaluate` re-reads the same rows and gets
 * `changes=0` — AT MOST 4 webhook pings per provider per UTC day.
 *
 * **Webhook failure isolation (Threat T-138-03-04).** A failed
 * `webhookManager.send` (Discord 404, network error, or a missing
 * `admin-clawdy` webhook identity) is CAUGHT and logged with the
 * `phase138-threshold-alert-failure` tag. The dedup row is recorded
 * REGARDLESS — the intent is "alert attempted", not "alert delivered".
 * `evaluate` never rejects on a delivery error. An operator re-fires a
 * deduped alert by deleting the row (see 138-03-SUMMARY runbook).
 *
 * **Log payload allow-list (Threat T-138-03-06).** `phase138-threshold-
 * crossed` carries only `{provider, threshold, cost_usd, cap_usd, pct,
 * date, agents_affected, fired, dedup_skipped}`. No secrets, no message
 * bodies.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { WebhookManager } from "../discord/webhook-manager.js";
import type { CreditTelemetryPayload } from "../ipc/protocol.js";
import {
  THRESHOLDS,
  FAILOVER_SUMMARY_PLACEHOLDER,
  interpolate,
  formatAgentsList,
  messageForThreshold,
  type Threshold,
} from "./alert-messages.js";

/** Discord channel (agent name) fleet-level credit alerts are sent to. */
/**
 * INC-2026-08-08 — KNOWN DEAD LEG, not yet fixed here.
 *
 * This is a WEBHOOK identity name, and no `admin-clawdy` webhook is configured
 * on the production fleet. `WebhookManager.send` THROWS when the identity is
 * missing (webhook-manager.ts), so every credit-threshold alert is caught by
 * the try/catch below and downgraded to a pino warn — invisible in Discord.
 *
 * `postToAdminClawdy` (daemon.ts) hit the same wall and now falls back to a
 * bot-direct send whose channel is resolved via `resolveAdminAlertTarget`
 * (manager/admin-alert-target.ts). This surface still needs the same
 * treatment, which requires injecting a BotDirectSender here. Until then,
 * assume credit-threshold alerts reach journald only.
 */
export const ALERT_CHANNEL = "admin-clawdy";

/**
 * `provider_alert_state` schema — verbatim from CONTEXT D2 lines 77-84.
 * Owned by `ThresholdAlerter`: Plan 01 deliberately does NOT create this
 * table (it lives in the fleet-level `fleet-alerts.db`, not a per-agent
 * `usage.db`). `CREATE TABLE IF NOT EXISTS` makes construction idempotent
 * across daemon restarts.
 */
const PROVIDER_ALERT_STATE_DDL = `
CREATE TABLE IF NOT EXISTS provider_alert_state (
  date         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  threshold    INTEGER NOT NULL,
  fired_at     INTEGER NOT NULL,
  PRIMARY KEY (date, provider, threshold)
);
`;

/**
 * Atomic dedup write. `changes === 1` → first fire of this
 * `(date, provider, threshold)` triple today. `changes === 0` → already
 * fired (the ON CONFLICT clause swallowed the duplicate).
 */
const DEDUP_INSERT_SQL = `
INSERT INTO provider_alert_state (date, provider, threshold, fired_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (date, provider, threshold) DO NOTHING
`;

/** Minimal logger surface — daemon passes its pino child, tests a stub. */
export interface AlerterLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/** Constructor dependencies for {@link ThresholdAlerter}. */
export interface ThresholdAlerterDeps {
  /**
   * Fleet-level SQLite connection (`fleet-alerts.db`). The constructor
   * creates `provider_alert_state` on it. Plan 04 shares the SAME
   * connection for `failover_state`.
   */
  readonly db: DatabaseType;
  /** Discord delivery surface. `send(ALERT_CHANNEL, message)`. */
  readonly webhookManager: WebhookManager;
  /** Wall-clock source (unix millis). Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Logger. Defaults to a no-op. */
  readonly logger?: AlerterLogger;
}

/**
 * One detected crossing, log-friendly. Returned (as an array) from
 * `evaluate` so the caller / tests can assert what happened without
 * re-reading the db.
 */
export interface AlertResult {
  readonly provider: string;
  readonly threshold: Threshold;
  /** True when THIS call recorded the dedup row (first fire today). */
  readonly fired: boolean;
  /** True when the row already existed (a prior fire today deduped this). */
  readonly dedup_skipped: boolean;
  /** Present when the webhook send rejected. The row is still recorded. */
  readonly webhook_error?: string;
}

/** No-op logger used when the caller does not inject one. */
const NOOP_LOGGER: AlerterLogger = {
  info: () => {},
  warn: () => {},
};

/** UTC `YYYY-MM-DD` for a unix-millis instant. */
function utcDate(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

/**
 * ThresholdAlerter — evaluates a credit-telemetry snapshot, fires
 * deduped Discord alerts on threshold crossings, and records each
 * attempted alert in `provider_alert_state`.
 */
export class ThresholdAlerter {
  private readonly db: DatabaseType;
  private readonly webhookManager: WebhookManager;
  private readonly clock: () => number;
  private readonly logger: AlerterLogger;
  private readonly dedupInsert: import("better-sqlite3").Statement;

  constructor(deps: ThresholdAlerterDeps) {
    this.db = deps.db;
    this.webhookManager = deps.webhookManager;
    this.clock = deps.clock ?? Date.now;
    this.logger = deps.logger ?? NOOP_LOGGER;

    // ThresholdAlerter OWNS this table — create it idempotently.
    this.db.exec(PROVIDER_ALERT_STATE_DDL);
    this.dedupInsert = this.db.prepare(DEDUP_INSERT_SQL);
  }

  /**
   * Evaluate a credit-telemetry snapshot. For every provider entry, for
   * every threshold in {@link THRESHOLDS}, if `pct >= threshold` attempt
   * a deduped fire: record the row, and on a first-fire-today emit the
   * `phase138-threshold-crossed` log + dispatch the Discord webhook
   * (fire-and-forget — the returned promise resolves before the Discord
   * round-trip completes).
   *
   * Never rejects: a webhook delivery error is caught + logged; the
   * dedup row is still persisted.
   */
  async evaluate(payload: CreditTelemetryPayload): Promise<AlertResult[]> {
    const now = this.clock();
    const date = utcDate(now);
    const results: AlertResult[] = [];

    for (const provider of payload.providers) {
      for (const threshold of THRESHOLDS) {
        if (provider.pct < threshold) continue;

        // Atomic dedup write — `changes` is the verdict.
        const changes = this.dedupInsert.run(
          date,
          provider.provider,
          threshold,
          now,
        ).changes;
        const fired = changes === 1;
        const dedupSkipped = changes === 0;

        // T-06 — emit the crossing log line on EVERY detected crossing
        // (even a deduped one), with the static allow-list payload.
        this.logger.info(
          {
            tag: "phase138-threshold-crossed",
            provider: provider.provider,
            threshold,
            cost_usd: provider.cost_usd,
            cap_usd: provider.cap_usd,
            pct: provider.pct,
            date,
            agents_affected: provider.agents.length,
            fired,
            dedup_skipped: dedupSkipped,
          },
          "phase138-threshold-crossed",
        );

        if (!fired) {
          results.push({
            provider: provider.provider,
            threshold,
            fired: false,
            dedup_skipped: true,
          });
          continue;
        }

        // T-08 — a fresh 95% crossing emits the Plan-04 consumer signal.
        if (threshold === 95) {
          this.logger.info(
            {
              tag: "phase138-failover-triggerable",
              provider: provider.provider,
              threshold,
              date,
              agents_affected: provider.agents.length,
            },
            "phase138-failover-triggerable",
          );
        }

        // Build + dispatch the Discord alert. Fire-and-forget: the
        // webhook round-trip does NOT block `evaluate`'s resolution.
        const message = this.buildMessage(threshold, provider);
        let webhookError: string | undefined;
        try {
          await this.webhookManager.send(ALERT_CHANNEL, message);
        } catch (err) {
          // Caught — never rejects evaluate. Row already recorded.
          webhookError = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            {
              tag: "phase138-threshold-alert-failure",
              provider: provider.provider,
              threshold,
              date,
              error: webhookError,
            },
            "phase138-threshold-alert-failure",
          );
        }

        results.push({
          provider: provider.provider,
          threshold,
          fired: true,
          dedup_skipped: false,
          ...(webhookError !== undefined ? { webhook_error: webhookError } : {}),
        });
      }
    }

    return results;
  }

  /** Interpolate the verbatim template for a crossing into a wire message. */
  private buildMessage(
    threshold: Threshold,
    provider: CreditTelemetryPayload["providers"][number],
  ): string {
    const template = messageForThreshold(threshold);
    return interpolate(template, {
      provider: provider.provider,
      cost_usd: provider.cost_usd.toFixed(2),
      cap_usd: provider.cap_usd.toFixed(2),
      timestamp: new Date(this.clock()).toISOString(),
      agents: formatAgentsList(provider.agents),
      // Plan 03 only ALERTS at 95%; Plan 04 overrides this at integration
      // time to enumerate the actually-failed-over agents.
      failover_summary: FAILOVER_SUMMARY_PLACEHOLDER,
    });
  }
}
