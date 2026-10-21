/**
 * SQLite-backed delivery queue for Discord messages.
 * Persists outbound messages before delivery attempt, enabling
 * retry with exponential backoff on failure.
 */
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { nanoid } from "nanoid";
import { logger as defaultLogger } from "../shared/logger.js";
import type {
  DeliverFn,
  DeliveryEntry,
  DeliveryQueueConfig,
  DeliveryStats,
} from "./delivery-queue-types.js";
import { DEFAULT_DELIVERY_QUEUE_CONFIG } from "./delivery-queue-types.js";

/**
 * Row shape from SQLite for the delivery_queue table.
 */
type DeliveryRow = {
  readonly id: string;
  readonly agent_name: string;
  readonly channel_id: string;
  readonly content: string;
  readonly status: string;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly created_at: string;
  readonly last_attempt_at: string | null;
  readonly next_retry_at: string | null;
  readonly last_error: string | null;
  readonly delivered_at: string | null;
};

/**
 * Convert a SQLite row to an immutable DeliveryEntry.
 */
function rowToEntry(row: DeliveryRow): DeliveryEntry {
  return {
    id: row.id,
    agentName: row.agent_name,
    channelId: row.channel_id,
    content: row.content,
    status: row.status as DeliveryEntry["status"],
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    lastAttemptAt: row.last_attempt_at,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
  };
}

/**
 * Compute exponential backoff delay: min(baseDelayMs * 2^attempts, maxDelayMs).
 */
function computeBackoffMs(
  attempts: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const delay = baseDelayMs * Math.pow(2, attempts);
  return Math.min(delay, maxDelayMs);
}

/**
 * Configuration for creating a DeliveryQueue.
 */
export type DeliveryQueueOptions = {
  readonly db: Database.Database;
  readonly deliverFn: DeliverFn;
  readonly config?: Partial<DeliveryQueueConfig>;
  readonly log?: Logger;
};

/**
 * SQLite-backed delivery queue with exponential backoff retry.
 *
 * Lifecycle: enqueue -> pending -> in_flight -> delivered | failed
 * On delivery error: in_flight -> pending (with nextRetryAt) until maxAttempts reached -> failed
 */
export class DeliveryQueue {
  private readonly db: Database.Database;
  private readonly deliverFn: DeliverFn;
  private readonly config: DeliveryQueueConfig;
  private readonly log: Logger;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private maintenanceIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(options: DeliveryQueueOptions) {
    this.db = options.db;
    this.deliverFn = options.deliverFn;
    this.config = { ...DEFAULT_DELIVERY_QUEUE_CONFIG, ...options.config };
    this.log = options.log ?? defaultLogger;

    this.initializeTable();
  }

  /**
   * Create the delivery_queue table if it does not exist.
   */
  private initializeTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_queue (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'in_flight', 'failed', 'delivered')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL,
        last_attempt_at TEXT,
        next_retry_at TEXT,
        last_error TEXT,
        delivered_at TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_delivery_queue_status_retry
      ON delivery_queue (status, next_retry_at)
    `);
  }

  /**
   * Enqueue a message for delivery. Persists to SQLite immediately.
   * Returns the generated entry ID.
   */
  enqueue(agentName: string, channelId: string, content: string): string {
    const id = nanoid();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO delivery_queue (id, agent_name, channel_id, content, status, attempts, max_attempts, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
    `);

    stmt.run(id, agentName, channelId, content, this.config.maxAttempts, now);

    this.log.debug(
      { id, agentName, channelId },
      "delivery queue: message enqueued",
    );

    return id;
  }

  /**
   * Process the next deliverable entry.
   * Picks the oldest pending entry or retryable entry whose nextRetryAt has passed.
   * Returns true if an entry was processed, false if queue was empty.
   */
  async processNext(): Promise<boolean> {
    const now = new Date().toISOString();

    // Select oldest deliverable entry:
    // - pending with no nextRetryAt (new entries)
    // - pending with nextRetryAt <= now (retryable entries)
    const row = this.db
      .prepare(
        `
      SELECT * FROM delivery_queue
      WHERE (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?))
      ORDER BY created_at ASC
      LIMIT 1
    `,
      )
      .get(now) as DeliveryRow | undefined;

    if (!row) {
      return false;
    }

    // Mark as in_flight
    this.db
      .prepare(
        `
      UPDATE delivery_queue
      SET status = 'in_flight', last_attempt_at = ?
      WHERE id = ?
    `,
      )
      .run(now, row.id);

    try {
      await this.deliverFn(row.agent_name, row.channel_id, row.content);

      // Success: mark as delivered
      const deliveredAt = new Date().toISOString();
      this.db
        .prepare(
          `
        UPDATE delivery_queue
        SET status = 'delivered', delivered_at = ?, attempts = attempts + 1
        WHERE id = ?
      `,
        )
        .run(deliveredAt, row.id);

      this.log.info(
        { id: row.id, agentName: row.agent_name, channelId: row.channel_id },
        "delivery queue: message delivered",
      );

      return true;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const newAttempts = row.attempts + 1;

      if (newAttempts >= row.max_attempts) {
        // Permanently failed
        this.db
          .prepare(
            `
          UPDATE delivery_queue
          SET status = 'failed', attempts = ?, last_error = ?, next_retry_at = NULL
          WHERE id = ?
        `,
          )
          .run(newAttempts, errorMessage, row.id);

        this.log.error(
          {
            id: row.id,
            agentName: row.agent_name,
            channelId: row.channel_id,
            attempts: newAttempts,
            error: errorMessage,
          },
          "delivery queue: message permanently failed",
        );
      } else {
        // Schedule retry with exponential backoff
        const delayMs = computeBackoffMs(
          newAttempts,
          this.config.baseDelayMs,
          this.config.maxDelayMs,
        );
        const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

        this.db
          .prepare(
            `
          UPDATE delivery_queue
          SET status = 'pending', attempts = ?, last_error = ?, next_retry_at = ?
          WHERE id = ?
        `,
          )
          .run(newAttempts, errorMessage, nextRetryAt, row.id);

        this.log.warn(
          {
            id: row.id,
            agentName: row.agent_name,
            attempts: newAttempts,
            nextRetryAt,
            delayMs,
            error: errorMessage,
          },
          "delivery queue: delivery failed, scheduled retry",
        );
      }

      return true;
    }
  }

  /**
   * Reclaim stranded `in_flight` rows.
   *
   * A row is marked `in_flight` (processNext :178) BEFORE the delivery
   * attempt. If the process crashes / hangs / is SIGTERM'd between that mark
   * and the terminal update (delivered | pending-retry | failed), the row is
   * stuck in `in_flight` forever — `processNext` only ever selects `pending`,
   * so it is never retried and never surfaces in `getFailedEntries`.
   *
   * This flips any `in_flight` row whose `last_attempt_at` is older than
   * `inFlightReclaimMs` back to `pending` (with `next_retry_at` cleared so it
   * is immediately eligible). `attempts` is left untouched, so a row that has
   * already burned its retries still terminates at the `maxAttempts` cap on
   * its next failure — reclaim cannot create an infinite-retry loop.
   *
   * Returns the number of rows reclaimed. Best-effort: never throws into the
   * caller (the maintenance timer logs + swallows).
   */
  reclaimStaleInFlight(): number {
    const cutoff = new Date(Date.now() - this.config.inFlightReclaimMs)
      .toISOString();

    const result = this.db
      .prepare(
        `
      UPDATE delivery_queue
      SET status = 'pending', next_retry_at = NULL
      WHERE status = 'in_flight'
        AND last_attempt_at IS NOT NULL
        AND last_attempt_at <= ?
    `,
      )
      .run(cutoff);

    const reclaimed = result.changes;
    if (reclaimed > 0) {
      this.log.warn(
        { reclaimed, inFlightReclaimMs: this.config.inFlightReclaimMs },
        "delivery queue: reclaimed stranded in_flight rows to pending",
      );
    }
    return reclaimed;
  }

  /**
   * Prune old `delivered` rows. The table otherwise grows unbounded — one row
   * per successfully delivered message persists forever. Deletes `delivered`
   * rows whose `delivered_at` is older than `deliveredRetentionMs`.
   *
   * Only `delivered` rows are pruned — `failed` rows are retained for the
   * `getFailedEntries` debugging surface; `pending` / `in_flight` are live.
   *
   * Returns the number of rows pruned.
   */
  pruneDelivered(): number {
    const cutoff = new Date(Date.now() - this.config.deliveredRetentionMs)
      .toISOString();

    const result = this.db
      .prepare(
        `
      DELETE FROM delivery_queue
      WHERE status = 'delivered'
        AND delivered_at IS NOT NULL
        AND delivered_at <= ?
    `,
      )
      .run(cutoff);

    const pruned = result.changes;
    if (pruned > 0) {
      this.log.debug(
        { pruned, deliveredRetentionMs: this.config.deliveredRetentionMs },
        "delivery queue: pruned old delivered rows",
      );
    }
    return pruned;
  }

  /**
   * Run one maintenance pass: reclaim stranded in_flight rows, then prune old
   * delivered rows. Failure-isolated — a maintenance error never affects the
   * delivery hot path.
   */
  private runMaintenance(): void {
    try {
      this.reclaimStaleInFlight();
    } catch (error: unknown) {
      this.log.error(
        { error },
        "delivery queue: in_flight reclaim failed (non-fatal)",
      );
    }
    try {
      this.pruneDelivered();
    } catch (error: unknown) {
      this.log.error(
        { error },
        "delivery queue: delivered prune failed (non-fatal)",
      );
    }
  }

  /**
   * Get aggregate statistics for the delivery queue.
   */
  getStats(): DeliveryStats {
    const rows = this.db
      .prepare(
        `
      SELECT status, COUNT(*) as count FROM delivery_queue GROUP BY status
    `,
      )
      .all() as readonly { status: string; count: number }[];

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM delivery_queue`)
      .get() as { total: number };

    return {
      pending: counts["pending"] ?? 0,
      inFlight: counts["in_flight"] ?? 0,
      failed: counts["failed"] ?? 0,
      delivered: counts["delivered"] ?? 0,
      totalEnqueued: totalRow.total,
    };
  }

  /**
   * Get the most recent permanently failed entries.
   * Includes full error context and original content for debugging.
   */
  getFailedEntries(limit: number = 50): readonly DeliveryEntry[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM delivery_queue
      WHERE status = 'failed'
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(limit) as readonly DeliveryRow[];

    return rows.map(rowToEntry);
  }

  /**
   * Start the automatic processing loop.
   * Calls processNext at the configured processingIntervalMs.
   */
  start(): void {
    if (this.intervalId !== null) {
      return;
    }

    // Startup recovery sweep: a previous process may have died with rows
    // stuck in `in_flight` (no terminal update). Reclaim them BEFORE the
    // delivery loop starts so they re-enter the pending pool immediately;
    // also prune any accumulated delivered rows. Best-effort.
    this.runMaintenance();

    this.intervalId = setInterval(() => {
      this.processNext().catch((error: unknown) => {
        this.log.error(
          { error },
          "delivery queue: unexpected error in processing loop",
        );
      });
    }, this.config.processingIntervalMs);

    this.maintenanceIntervalId = setInterval(() => {
      this.runMaintenance();
    }, this.config.maintenanceIntervalMs);

    this.log.info(
      {
        intervalMs: this.config.processingIntervalMs,
        maintenanceIntervalMs: this.config.maintenanceIntervalMs,
      },
      "delivery queue: processing started",
    );
  }

  /**
   * Stop the automatic processing loop and the maintenance sweep.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.maintenanceIntervalId !== null) {
      clearInterval(this.maintenanceIntervalId);
      this.maintenanceIntervalId = null;
    }
  }
}
