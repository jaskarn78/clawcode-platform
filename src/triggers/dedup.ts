/**
 * Phase 60 Plan 01 — three-layer dedup pipeline.
 *
 * Layer 1: In-memory LRU (LruMap) — zero I/O fast path that rejects
 *          exact duplicate (sourceId, idempotencyKey) pairs.
 * Layer 2: Per-source debounce — collapses burst events within a
 *          configurable window (default 5s). Only the latest fires.
 * Layer 3: SQLite UNIQUE — dedicated trigger_events table catches any
 *          duplicate that slips past the first two layers.
 *
 * All debounce timers call `.unref()` so they don't keep the process
 * alive on shutdown (Pitfall 3 from RESEARCH.md).
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";
import type { TriggerEvent } from "./types.js";

// ---------------------------------------------------------------------------
// LruMap — simple Map-based LRU cache (~40 LOC)
// ---------------------------------------------------------------------------

/**
 * Lightweight LRU cache backed by Map iteration order. Uses the
 * delete-then-set trick to promote entries to the end (most recent).
 *
 * Sufficient for ~10K entries. No npm dependency warranted at this scale.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first entry in Map iteration order)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// DedupLayer — composes all three dedup layers
// ---------------------------------------------------------------------------

export type DedupLayerOptions = Readonly<{
  db: DatabaseType;
  lruSize: number;
  defaultDebounceMs: number;
}>;

/**
 * Pending debounce state for a single source. The resolve callback settles
 * the promise returned by `debounce()`. When a newer event replaces the
 * pending one, the previous promise resolves with `null`.
 */
type PendingDebounce = {
  timer: ReturnType<typeof setTimeout>;
  event: TriggerEvent;
  resolve: (event: TriggerEvent | null) => void;
};

export class DedupLayer {
  private readonly lru: LruMap<string, number>;
  private readonly insertStmt: Statement;
  private readonly purgeStmt: Statement;
  private readonly defaultDebounceMs: number;

  /** Per-source pending debounce state. Key = sourceId. */
  private readonly pending = new Map<string, PendingDebounce>();

  constructor(options: DedupLayerOptions) {
    this.defaultDebounceMs = options.defaultDebounceMs;
    this.lru = new LruMap(options.lruSize);

    // Create trigger_events table idempotently (Phase 62: added source_kind + payload).
    options.db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_events (
        source_id        TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        source_kind      TEXT,
        payload          TEXT,
        UNIQUE(source_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_trigger_events_created_at
        ON trigger_events(created_at);
    `);

    // Phase 62: idempotent ALTER TABLE for existing DBs missing new columns.
    try { options.db.exec("ALTER TABLE trigger_events ADD COLUMN source_kind TEXT"); } catch { /* column exists */ }
    try { options.db.exec("ALTER TABLE trigger_events ADD COLUMN payload TEXT"); } catch { /* column exists */ }

    this.insertStmt = options.db.prepare(
      "INSERT OR IGNORE INTO trigger_events (source_id, idempotency_key, created_at, source_kind, payload) VALUES (?, ?, ?, ?, ?)",
    );
    this.purgeStmt = options.db.prepare(
      "DELETE FROM trigger_events WHERE created_at < ?",
    );
  }

  // -----------------------------------------------------------------------
  // Layer 1: LRU idempotency check
  // -----------------------------------------------------------------------

  /**
   * Check the in-memory LRU for a duplicate. If not found, insert and
   * return false (not a duplicate). If found, return true (duplicate).
   */
  isLruDuplicate(sourceId: string, idempotencyKey: string): boolean {
    const key = `${sourceId}:${idempotencyKey}`;
    if (this.lru.has(key)) {
      return true;
    }
    this.lru.set(key, Date.now());
    return false;
  }

  /**
   * Clear the LRU cache. Useful for testing or cache reset.
   */
  clearLru(): void {
    this.lru.clear();
  }

  // -----------------------------------------------------------------------
  // Layer 2: Per-source debounce
  // -----------------------------------------------------------------------

  /**
   * Debounce an event for its source. Returns a Promise that resolves to:
   *   - The event after the debounce window expires, OR
   *   - null if a newer event replaced this one (collapsed)
   *
   * When stopAllTimers() is called, all pending promises resolve to null.
   */
  debounce(
    event: TriggerEvent,
    debounceMs?: number,
  ): Promise<TriggerEvent | null> {
    const ms = debounceMs ?? this.defaultDebounceMs;
    const key = event.sourceId;
    const existing = this.pending.get(key);

    // If a timer is already pending for this source, clear it and resolve
    // the old promise with null (the old event was collapsed).
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve(null);
    }

    return new Promise<TriggerEvent | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve(event);
      }, ms);

      // CRITICAL: unref so Node doesn't keep the process alive for this timer.
      timer.unref();

      this.pending.set(key, { timer, event, resolve });
    });
  }

  // -----------------------------------------------------------------------
  // Layer 3: SQLite UNIQUE safety net
  // -----------------------------------------------------------------------

  /**
   * Attempt to insert a trigger event into SQLite. Returns true if the row
   * was inserted (not a duplicate), false if the UNIQUE constraint rejected
   * it (INSERT OR IGNORE).
   *
   * Phase 62: Extended with optional sourceKind and payload for dry-run replay.
   */
  insertTriggerEvent(
    sourceId: string,
    idempotencyKey: string,
    sourceKind?: string,
    payload?: string,
  ): boolean {
    const result = this.insertStmt.run(
      sourceId,
      idempotencyKey,
      Date.now(),
      sourceKind ?? null,
      payload ?? null,
    );
    return result.changes > 0;
  }

  /**
   * Purge trigger_events rows with created_at older than cutoffMs.
   * Returns the number of rows deleted.
   */
  purgeTriggerEvents(cutoffMs: number): number {
    const result = this.purgeStmt.run(cutoffMs);
    return result.changes;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Clear all pending debounce timers. Pending promises resolve to null.
   * Called during daemon shutdown to prevent timer leaks.
   */
  stopAllTimers(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pending.clear();
  }
}
