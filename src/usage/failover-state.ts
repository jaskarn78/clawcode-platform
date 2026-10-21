/**
 * Phase 138 Plan 05 T-01 — `FailoverStateStore`.
 *
 * CRUD against the `failover_state` table — the SQLite runtime-state
 * channel that lets a cross-provider failover bypass the Phase 137 D5
 * NON_RELOADABLE `llmRuntime.backend` config invariant WITHOUT mutating
 * clawcode.yaml (CONTEXT D3).
 *
 * **Table ownership.** This store OWNS `failover_state` — its constructor
 * creates the table idempotently (`CREATE TABLE IF NOT EXISTS`). Plan 01
 * deliberately does NOT create it. In production the `db` handle is the
 * shared fleet-level `fleet-alerts.db` from Plan 03 (the same connection
 * that owns `provider_alert_state`) — one fleet-coordination db, two
 * tables. Construction order in the daemon: `ThresholdAlerter` first
 * (creates `provider_alert_state`), then `FailoverStateStore` (creates
 * `failover_state`), both against `fleetAlertDb`.
 *
 * **Expiry semantics (CONTEXT D8).** A row's `expires_at` is either:
 *   - a unix-millis instant — a `threshold-95` auto-failover, expiring at
 *     the next UTC midnight (so a saturated provider's failover lifts
 *     when the daily cap rolls over), OR
 *   - `NULL` — a `manual` operator override (`clawcode failover set`)
 *     that persists until explicitly cleared (operator agency).
 * `get` / `listActive` / `getActiveBackend` all filter on
 * `expires_at IS NULL OR expires_at > now` — an expired row is invisible
 * to readers even before the controller's `expired-cleanup` tick deletes
 * it.
 *
 * **`FailoverStateReader`.** The read-only subset (`getActiveBackend`)
 * the LlmRuntime factory injects via `LlmRuntimeDeps.failoverStateReader`
 * (T-03 / T-04). `FailoverStateStore implements FailoverStateReader` so
 * the daemon wires the same live instance as both the cron's write
 * surface and the factory's read surface.
 *
 * See:
 *   - `.planning/phases/138-.../138-CONTEXT.md` D2 (schema), D3, D8
 *   - `.planning/phases/138-.../138-03-SUMMARY.md` (fleet-alerts.db)
 *   - `src/usage/threshold-alerter.ts` — the sibling table owner
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";
import type { LlmRuntimeBackend } from "../llm-runtime/types.js";

/**
 * `failover_state` schema — verbatim from CONTEXT D2 lines 85-92.
 * One row per agent (`agent` PRIMARY KEY). Created idempotently by the
 * {@link FailoverStateStore} constructor.
 */
const FAILOVER_STATE_DDL = `
CREATE TABLE IF NOT EXISTS failover_state (
  agent           TEXT PRIMARY KEY,
  active_backend  TEXT NOT NULL,
  reason          TEXT NOT NULL,
  triggered_at    INTEGER NOT NULL,
  expires_at      INTEGER
);
`;

/** Upsert — replaces the single row for an agent (PK conflict → update). */
const UPSERT_SQL = `
INSERT INTO failover_state (agent, active_backend, reason, triggered_at, expires_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (agent) DO UPDATE SET
  active_backend = excluded.active_backend,
  reason         = excluded.reason,
  triggered_at   = excluded.triggered_at,
  expires_at     = excluded.expires_at
`;

/** One persisted failover row. */
export interface FailoverRow {
  readonly agent: string;
  readonly active_backend: LlmRuntimeBackend;
  readonly reason: string;
  readonly triggered_at: number;
  /** `null` → never expires (manual override); else unix-millis instant. */
  readonly expires_at: number | null;
}

/**
 * Read-only subset injected into the LlmRuntime factory via
 * `LlmRuntimeDeps.failoverStateReader` (T-03). `FailoverStateStore`
 * implements this; tests stub it with a plain object.
 */
export interface FailoverStateReader {
  /**
   * Return the active (non-expired) override backend for an agent, or
   * `undefined` when there is no override or it has expired. `now` is
   * the wall-clock instant the caller is evaluating against.
   */
  getActiveBackend(
    agent: string,
    now: number,
  ): LlmRuntimeBackend | undefined;
}

/** Constructor dependencies for {@link FailoverStateStore}. */
export interface FailoverStateStoreDeps {
  /** SQLite connection. Production: the shared `fleet-alerts.db` handle. */
  readonly db: DatabaseType;
  /** Wall-clock source (unix millis). Defaults to `Date.now`. */
  readonly clock?: () => number;
}

/** Shape of a raw `failover_state` SELECT row before typing. */
interface RawRow {
  agent: string;
  active_backend: string;
  reason: string;
  triggered_at: number;
  expires_at: number | null;
}

/** Narrow a raw SELECT row to the typed {@link FailoverRow}. */
function toFailoverRow(raw: RawRow): FailoverRow {
  return {
    agent: raw.agent,
    active_backend: raw.active_backend as LlmRuntimeBackend,
    reason: raw.reason,
    triggered_at: raw.triggered_at,
    expires_at: raw.expires_at,
  };
}

/**
 * FailoverStateStore — CRUD over the `failover_state` runtime-override
 * table. Implements {@link FailoverStateReader} so the same live
 * instance is the cron's write surface AND the factory's read surface.
 */
export class FailoverStateStore implements FailoverStateReader {
  private readonly db: DatabaseType;
  private readonly clock: () => number;
  private readonly upsertStmt: Statement;
  private readonly getStmt: Statement;
  private readonly clearStmt: Statement;
  private readonly listStmt: Statement;

  constructor(deps: FailoverStateStoreDeps) {
    this.db = deps.db;
    this.clock = deps.clock ?? Date.now;

    // FailoverStateStore OWNS this table — create it idempotently.
    this.db.exec(FAILOVER_STATE_DDL);

    this.upsertStmt = this.db.prepare(UPSERT_SQL);
    // Expiry filter applied in SQL so an expired row is invisible to
    // `get` even before the controller's cleanup tick deletes it.
    this.getStmt = this.db.prepare(
      `SELECT * FROM failover_state
       WHERE agent = ? AND (expires_at IS NULL OR expires_at > ?)`,
    );
    this.clearStmt = this.db.prepare(
      `DELETE FROM failover_state WHERE agent = ?`,
    );
    this.listStmt = this.db.prepare(
      `SELECT * FROM failover_state
       WHERE expires_at IS NULL OR expires_at > ?`,
    );
  }

  /**
   * Upsert the failover override for an agent. `triggered_at` is stamped
   * with the injected clock. `expiresAt` is `null` (manual — never
   * expires) by default, or a unix-millis instant (`threshold-95` —
   * next UTC midnight).
   */
  set(
    agent: string,
    backend: LlmRuntimeBackend,
    reason: string,
    expiresAt: number | null = null,
  ): void {
    this.upsertStmt.run(agent, backend, reason, this.clock(), expiresAt);
  }

  /**
   * Return the failover row for an agent, or `undefined` when absent or
   * expired. Expiry is evaluated against the injected clock.
   */
  get(agent: string): FailoverRow | undefined {
    const raw = this.getStmt.get(agent, this.clock()) as RawRow | undefined;
    return raw ? toFailoverRow(raw) : undefined;
  }

  /** Delete the failover row for an agent (idempotent — no-op if absent). */
  clear(agent: string): void {
    this.clearStmt.run(agent);
  }

  /**
   * Return every non-expired failover row, evaluated against `now`.
   * The controller uses this to know which agents currently carry an
   * override (duplicate-decision suppression + the CLI `status` surface).
   */
  listActive(now: number): readonly FailoverRow[] {
    const rows = this.listStmt.all(now) as RawRow[];
    return rows.map(toFailoverRow);
  }

  /**
   * Return EVERY failover row — including expired ones. The failover
   * controller's tick needs this for the expiry sweep: an expired row
   * must be visible so it can be `clear`ed, but it must NOT count toward
   * duplicate-decision suppression (that uses {@link listActive}).
   */
  listAll(): readonly FailoverRow[] {
    const rows = this.db
      .prepare("SELECT * FROM failover_state")
      .all() as RawRow[];
    return rows.map(toFailoverRow);
  }

  /**
   * {@link FailoverStateReader} — return the active override backend or
   * `undefined`. Thin wrapper over a `now`-filtered SELECT (does NOT
   * route through `get`, which uses the injected clock — the factory
   * passes its own `Date.now()` so the read is exact for that turn).
   */
  getActiveBackend(
    agent: string,
    now: number,
  ): LlmRuntimeBackend | undefined {
    const raw = this.getStmt.get(agent, now) as RawRow | undefined;
    return raw ? (raw.active_backend as LlmRuntimeBackend) : undefined;
  }
}
