/**
 * Phase 61 Plan 01 Task 2 -- MysqlSource TriggerSource adapter.
 *
 * Polls a MySQL table for new rows using `SELECT ... WHERE id > ?` with
 * committed-read confirmation. Implements TriggerSource for registration
 * with TriggerEngine.
 *
 * Key behaviors:
 * - Watermark-based polling with configurable interval and batch size
 * - Committed-read confirmation: re-queries max row to confirm it wasn't
 *   ROLLBACKed before advancing watermark
 * - Connection always released in finally block (no leak on error)
 * - Timer handle is .unref()ed to avoid blocking daemon shutdown
 */

import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { Logger } from "pino";

import type { TriggerEvent, TriggerSource } from "../types.js";

/**
 * Constructor options for MysqlSource.
 * The `ingest` callback is bound to `TriggerEngine.ingest` by daemon.ts.
 */
export type MysqlSourceOptions = Readonly<{
  pool: Pool;
  table: string;
  idColumn: string;
  pollIntervalMs: number;
  targetAgent: string;
  batchSize: number;
  filter?: string;
  ingest: (event: TriggerEvent) => Promise<void>;
  log: Logger;
}>;

/**
 * MysqlSource polls a MySQL table for new rows and ingests them as
 * TriggerEvents. Each table gets a unique sourceId (`mysql:{table}`).
 */
export class MysqlSource implements TriggerSource {
  readonly sourceId: string;

  private readonly pool: Pool;
  private readonly table: string;
  private readonly idColumn: string;
  private readonly pollIntervalMs: number;
  private readonly targetAgent: string;
  private readonly batchSize: number;
  private readonly filter: string | undefined;
  private readonly ingestFn: (event: TriggerEvent) => Promise<void>;
  private readonly log: Logger;

  private lastSeenId: number = 0;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(options: MysqlSourceOptions) {
    this.pool = options.pool;
    this.table = options.table;
    this.idColumn = options.idColumn;
    this.pollIntervalMs = options.pollIntervalMs;
    this.targetAgent = options.targetAgent;
    this.batchSize = options.batchSize;
    this.filter = options.filter;
    this.ingestFn = options.ingest;
    this.log = options.log;
    this.sourceId = `mysql:${options.table}`;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start polling. Creates a setInterval with the configured poll interval.
   * The timer handle is .unref()ed so it doesn't prevent daemon shutdown.
   */
  start(): void {
    this.intervalHandle = setInterval(() => {
      void this._pollOnceForTest();
    }, this.pollIntervalMs);
    this.intervalHandle.unref();

    this.log.info(
      { sourceId: this.sourceId, pollIntervalMs: this.pollIntervalMs },
      "mysql-source: started",
    );
  }

  /** Stop polling. Clears the interval handle. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // -------------------------------------------------------------------------
  // poll -- watermark-based replay (TRIG-06)
  // -------------------------------------------------------------------------

  /**
   * Replay missed events since a watermark. Returns events WITHOUT calling
   * ingestFn -- the engine handles that during replay.
   *
   * When `since` is null, returns empty (first boot, no replay).
   */
  async poll(since: string | null): Promise<readonly TriggerEvent[]> {
    if (since === null) {
      return [];
    }

    const startId = parseInt(since, 10);
    if (isNaN(startId)) {
      return [];
    }

    return this.queryRows(startId, false);
  }

  // -------------------------------------------------------------------------
  // Internal polling
  // -------------------------------------------------------------------------

  /**
   * Execute a single poll cycle. Queries for new rows, confirms max row
   * with committed-read, then ingests events and advances watermark.
   *
   * Exposed as `_pollOnceForTest` for test access.
   * @internal
   */
  async _pollOnceForTest(): Promise<void> {
    let conn: PoolConnection | null = null;
    try {
      conn = await this.pool.getConnection();

      // Primary query: find rows > lastSeenId
      const filterClause = this.filter ? `AND ${this.filter} ` : "";
      const sql =
        `SELECT \`${this.idColumn}\` AS id, t.* ` +
        `FROM \`${this.table}\` t ` +
        `WHERE \`${this.idColumn}\` > ? ${filterClause}` +
        `ORDER BY \`${this.idColumn}\` ASC LIMIT ?`;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, [
        this.lastSeenId,
        this.batchSize,
      ]);

      if (!rows || rows.length === 0) {
        return;
      }

      const maxId = (rows[rows.length - 1] as RowDataPacket)["id"] as number;

      // Committed-read confirmation: verify max row still exists
      const confirmSql = `SELECT \`${this.idColumn}\` AS id FROM \`${this.table}\` WHERE \`${this.idColumn}\` = ?`;
      const [confirmRows] = await conn.execute<RowDataPacket[]>(confirmSql, [maxId]);

      if (!confirmRows || confirmRows.length === 0) {
        this.log.warn(
          { table: this.table, maxId },
          "mysql-source: max row disappeared (probable ROLLBACK), watermark NOT advanced",
        );
        return;
      }

      // Build and ingest events
      const events: readonly TriggerEvent[] = rows.map((row) => ({
        sourceId: this.sourceId,
        idempotencyKey: `${this.table}:${row["id"] as number}`,
        targetAgent: this.targetAgent,
        payload: { ...row },
        timestamp: Date.now(),
      }));

      for (const event of events) {
        await this.ingestFn(event);
      }

      // Advance watermark only after successful ingestion
      this.lastSeenId = maxId;
    } catch (err) {
      this.log.error(
        { sourceId: this.sourceId, error: (err as Error).message },
        "mysql-source: poll error",
      );
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Query rows from the table and return as TriggerEvents. Used by both
   * _pollOnceForTest (with ingest=true) and poll() (with ingest=false).
   */
  private async queryRows(
    startId: number,
    shouldIngest: boolean,
  ): Promise<readonly TriggerEvent[]> {
    let conn: PoolConnection | null = null;
    try {
      conn = await this.pool.getConnection();

      const filterClause = this.filter ? `AND ${this.filter} ` : "";
      const sql =
        `SELECT \`${this.idColumn}\` AS id, t.* ` +
        `FROM \`${this.table}\` t ` +
        `WHERE \`${this.idColumn}\` > ? ${filterClause}` +
        `ORDER BY \`${this.idColumn}\` ASC LIMIT ?`;

      const [rows] = await conn.execute<RowDataPacket[]>(sql, [
        startId,
        this.batchSize,
      ]);

      if (!rows || rows.length === 0) {
        return [];
      }

      const maxId = (rows[rows.length - 1] as RowDataPacket)["id"] as number;

      // Committed-read confirmation
      const confirmSql = `SELECT \`${this.idColumn}\` AS id FROM \`${this.table}\` WHERE \`${this.idColumn}\` = ?`;
      const [confirmRows] = await conn.execute<RowDataPacket[]>(confirmSql, [maxId]);

      if (!confirmRows || confirmRows.length === 0) {
        this.log.warn(
          { table: this.table, maxId },
          "mysql-source: max row disappeared (probable ROLLBACK), watermark NOT advanced",
        );
        return [];
      }

      const events: TriggerEvent[] = rows.map((row) => ({
        sourceId: this.sourceId,
        idempotencyKey: `${this.table}:${row["id"] as number}`,
        targetAgent: this.targetAgent,
        payload: { ...row },
        timestamp: Date.now(),
      }));

      if (shouldIngest) {
        for (const event of events) {
          await this.ingestFn(event);
        }
      }

      return events;
    } catch (err) {
      this.log.error(
        { sourceId: this.sourceId, error: (err as Error).message },
        "mysql-source: query error",
      );
      return [];
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }
}
