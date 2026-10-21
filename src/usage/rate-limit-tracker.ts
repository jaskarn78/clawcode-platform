/**
 * Phase 103 OBS-04 — per-agent RateLimitTracker.
 *
 * Subscribes (via persistent-session-handle.iterateUntilResult dispatch)
 * to the SDK's `rate_limit_event` messages. Stores the latest snapshot
 * per `rateLimitType` in-memory for fast read AND in SQLite for restart
 * resilience.
 *
 * Per-rate-limit-type independence: 5-hour, 7-day, 7-day-opus,
 * 7-day-sonnet, and overage all reset on different cadences and never
 * fire in the same event. Each gets its own row.
 *
 * Snapshots are Object.freeze'd to honor the project immutability rule
 * (~/.claude/rules/coding-style.md). External mutation of stored
 * snapshots is impossible.
 *
 * Pitfall 10 closure — `rateLimitType` is stored as a string (NOT the
 * 5-value union) so an unrecognized type from a future SDK release is
 * still captured + rendered (with a fallback label). The SDK is pre-1.0;
 * the union may grow.
 */
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

export type RateLimitSnapshot = Readonly<{
  /** SDK rateLimitType value, or 'unknown' when SDK omitted the field. */
  rateLimitType: string;
  status: "allowed" | "allowed_warning" | "rejected";
  utilization: number | undefined;
  resetsAt: number | undefined;
  /** SDK field is OPTIONAL NUMBER (Pitfall 9). Carries the threshold crossed. */
  surpassedThreshold: number | undefined;
  overageStatus: "allowed" | "allowed_warning" | "rejected" | undefined;
  overageResetsAt: number | undefined;
  overageDisabledReason: string | undefined;
  isUsingOverage: boolean | undefined;
  /** Local Date.now() at record time. Operator diagnostic for staleness. */
  recordedAt: number;
}>;

type LoggerLike = { warn: (obj: unknown, msg?: string) => void };

/**
 * Phase 999.4 — normalize epoch values from the SDK.
 *
 * SDK `SDKRateLimitInfo.resetsAt` is documented as ms-epoch but the OAuth
 * Max session emits seconds-epoch (~1.78e9) instead of ms (~1.78e12). The
 * downstream `formatDistanceToNow(resetsAt)` treats whatever it gets as ms,
 * so a seconds value renders as "in 55 years."
 *
 * Heuristic: ms-epoch values from 2001+ are >= 1e12; seconds-epoch values
 * for any plausible reset window are << 1e12. Anything below 1e12 is
 * treated as seconds and multiplied by 1000. Values >= 1e12 pass through
 * unchanged so a future SDK fix that emits ms isn't double-converted.
 *
 * Returns undefined when input is undefined.
 */
function normalizeEpochToMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

/**
 * Phase 999.4 — derive utilization when SDK omits it.
 *
 * Some rate_limit_event payloads ship `status` + `resetsAt` + overage state
 * but no `utilization`. The status field is enough to bound utilization:
 *  - rejected           → 1.0   (limit hit, overage exhausted)
 *  - allowed_warning    → fall back to surpassedThreshold (lower bound)
 *  - allowed            → undefined (no signal — leave as-is)
 *
 * surpassedThreshold is the highest threshold last crossed (0.5, 0.8…), so
 * using it as utilization is a conservative lower bound when the SDK
 * doesn't provide a precise value. When neither status nor threshold gives
 * a signal, returns the original value (undefined).
 */
function deriveUtilization(
  utilization: number | undefined,
  status: SDKRateLimitInfo["status"],
  surpassedThreshold: number | undefined,
): number | undefined {
  if (utilization !== undefined) return utilization;
  if (status === "rejected") return 1.0;
  if (status === "allowed_warning" && surpassedThreshold !== undefined) {
    return surpassedThreshold;
  }
  return undefined;
}

export class RateLimitTracker {
  private readonly latest = new Map<string, RateLimitSnapshot>();
  private readonly upsertStmt: Statement;
  private readonly selectAllStmt: Statement;
  private readonly log: LoggerLike | undefined;

  constructor(db: DatabaseType, log?: LoggerLike) {
    this.log = log;
    // Idempotent — UsageTracker.initSchema may already have created this
    // table when sharing the same DB handle. CREATE TABLE IF NOT EXISTS
    // is a no-op in that case.
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
        rate_limit_type TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      )
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO rate_limit_snapshots(rate_limit_type, payload, recorded_at)
      VALUES (?, ?, ?)
      ON CONFLICT(rate_limit_type) DO UPDATE SET
        payload = excluded.payload,
        recorded_at = excluded.recorded_at
    `);
    this.selectAllStmt = db.prepare(
      `SELECT rate_limit_type, payload, recorded_at FROM rate_limit_snapshots`,
    );

    // Restore on construction.
    this.restore();
  }

  private restore(): void {
    const rows = this.selectAllStmt.all() as Array<{
      rate_limit_type: string;
      payload: string;
      recorded_at: number;
    }>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as RateLimitSnapshot;
        this.latest.set(row.rate_limit_type, Object.freeze({ ...parsed }));
      } catch (err) {
        // Corrupt row — skip. Log but never throw out of constructor.
        this.log?.warn(
          { type: row.rate_limit_type, error: (err as Error).message },
          "rate-limit-tracker: corrupt row on restore (skipped)",
        );
      }
    }
  }

  /** Record a snapshot. Best-effort persistence — never throws. */
  record(info: SDKRateLimitInfo): void {
    const type = info.rateLimitType ?? "unknown";
    const snapshot: RateLimitSnapshot = Object.freeze({
      rateLimitType: type,
      status: info.status,
      utilization: deriveUtilization(
        info.utilization,
        info.status,
        info.surpassedThreshold,
      ),
      resetsAt: normalizeEpochToMs(info.resetsAt),
      surpassedThreshold: info.surpassedThreshold,
      overageStatus: info.overageStatus,
      overageResetsAt: normalizeEpochToMs(info.overageResetsAt),
      overageDisabledReason: info.overageDisabledReason,
      isUsingOverage: info.isUsingOverage,
      recordedAt: Date.now(),
    });
    this.latest.set(type, snapshot);
    try {
      this.upsertStmt.run(type, JSON.stringify(snapshot), snapshot.recordedAt);
    } catch (err) {
      // Persistence failure is observational — in-memory state is the
      // source of truth for this process. Log and continue.
      this.log?.warn(
        { type, error: (err as Error).message },
        "rate-limit-tracker: SQLite persist failed (in-memory unaffected)",
      );
    }
  }

  /** Read the latest snapshot for a rate-limit type, or undefined if none. */
  getLatest(type: string): RateLimitSnapshot | undefined {
    return this.latest.get(type);
  }

  /** Read all snapshots (frozen array). Order: insertion order. */
  getAllSnapshots(): readonly RateLimitSnapshot[] {
    return Object.freeze([...this.latest.values()]);
  }
}
