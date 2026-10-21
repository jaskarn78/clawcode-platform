/**
 * Phase 60 Plan 01 — LruMap + DedupLayer tests.
 *
 * Tests the three-layer dedup pipeline:
 *   Layer 1: In-memory LRU (LruMap)
 *   Layer 2: Per-source debounce (setTimeout + unref)
 *   Layer 3: SQLite UNIQUE (trigger_events table)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { LruMap, DedupLayer } from "../dedup.js";
import type { TriggerEvent } from "../types.js";

// ---------------------------------------------------------------------------
// LruMap
// ---------------------------------------------------------------------------

describe("LruMap", () => {
  it("stores and retrieves values", () => {
    const lru = new LruMap<string, number>(10);
    lru.set("a", 1);
    expect(lru.get("a")).toBe(1);
    expect(lru.has("a")).toBe(true);
  });

  it("returns undefined for missing keys", () => {
    const lru = new LruMap<string, number>(10);
    expect(lru.get("missing")).toBeUndefined();
    expect(lru.has("missing")).toBe(false);
  });

  it("evicts oldest entry at capacity", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    lru.set("d", 4); // should evict "a"
    expect(lru.has("a")).toBe(false);
    expect(lru.has("b")).toBe(true);
    expect(lru.has("c")).toBe(true);
    expect(lru.has("d")).toBe(true);
    expect(lru.size).toBe(3);
  });

  it("promotes on get (MRU reorder)", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    // Access "a" — promotes it to most recent
    lru.get("a");
    // Insert "d" — should evict "b" (oldest after promotion), not "a"
    lru.set("d", 4);
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("c")).toBe(true);
    expect(lru.has("d")).toBe(true);
  });

  it("overwrites existing key without increasing size", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 10); // overwrite
    expect(lru.size).toBe(2);
    expect(lru.get("a")).toBe(10);
  });

  it("clear() empties the map", () => {
    const lru = new LruMap<string, number>(5);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.has("a")).toBe(false);
  });

  it("handles capacity of 1", () => {
    const lru = new LruMap<string, number>(1);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.size).toBe(1);
    expect(lru.has("a")).toBe(false);
    expect(lru.has("b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DedupLayer
// ---------------------------------------------------------------------------

describe("DedupLayer", () => {
  let db: DatabaseType;
  let dedup: DedupLayer;

  const makeEvent = (overrides: Partial<TriggerEvent> = {}): TriggerEvent => ({
    sourceId: "src-1",
    idempotencyKey: "key-1",
    targetAgent: "agent-1",
    payload: null,
    timestamp: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(":memory:");
    dedup = new DedupLayer({
      db,
      lruSize: 100,
      defaultDebounceMs: 50, // short window for test speed
    });
  });

  afterEach(() => {
    dedup.stopAllTimers();
    db.close();
  });

  describe("Layer 1: LRU isLruDuplicate", () => {
    it("returns false on first call, true on second", () => {
      expect(dedup.isLruDuplicate("src-1", "key-1")).toBe(false);
      expect(dedup.isLruDuplicate("src-1", "key-1")).toBe(true);
    });

    it("different keys are independent", () => {
      expect(dedup.isLruDuplicate("src-1", "key-1")).toBe(false);
      expect(dedup.isLruDuplicate("src-1", "key-2")).toBe(false);
    });

    it("clearLru resets duplicate tracking", () => {
      dedup.isLruDuplicate("src-1", "key-1");
      dedup.clearLru();
      expect(dedup.isLruDuplicate("src-1", "key-1")).toBe(false);
    });
  });

  describe("Layer 2: debounce", () => {
    it("resolves with event after window expires", async () => {
      const event = makeEvent();
      const result = await dedup.debounce(event, 10);
      expect(result).toEqual(event);
    });

    it("replaces pending event with latest (collapse)", async () => {
      const event1 = makeEvent({ idempotencyKey: "tick-1" });
      const event2 = makeEvent({ idempotencyKey: "tick-2" });

      // Start first debounce (won't resolve until timer fires)
      const promise1 = dedup.debounce(event1, 50);
      // Immediately replace with second (within window)
      const promise2 = dedup.debounce(event2, 50);

      // First promise should resolve to null (replaced)
      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toBeNull();
      expect(result2).toEqual(event2);
    });

    it("different sources debounce independently", async () => {
      const eventA = makeEvent({ sourceId: "src-a" });
      const eventB = makeEvent({ sourceId: "src-b" });

      const [resultA, resultB] = await Promise.all([
        dedup.debounce(eventA, 10),
        dedup.debounce(eventB, 10),
      ]);
      expect(resultA).toEqual(eventA);
      expect(resultB).toEqual(eventB);
    });

    it("uses defaultDebounceMs when no override", async () => {
      const event = makeEvent();
      // defaultDebounceMs is 50 in test setup
      const result = await dedup.debounce(event);
      expect(result).toEqual(event);
    });
  });

  describe("Layer 3: SQLite insertTriggerEvent", () => {
    it("returns true on first insert", () => {
      expect(dedup.insertTriggerEvent("src-1", "key-1")).toBe(true);
    });

    it("returns false on duplicate (UNIQUE constraint)", () => {
      dedup.insertTriggerEvent("src-1", "key-1");
      expect(dedup.insertTriggerEvent("src-1", "key-1")).toBe(false);
    });

    it("allows same key from different source", () => {
      dedup.insertTriggerEvent("src-1", "key-1");
      expect(dedup.insertTriggerEvent("src-2", "key-1")).toBe(true);
    });
  });

  describe("purgeTriggerEvents", () => {
    it("deletes rows older than cutoff", () => {
      // Insert with artificial created_at via raw SQL
      const stmt = db.prepare(
        "INSERT INTO trigger_events (source_id, idempotency_key, created_at) VALUES (?, ?, ?)",
      );
      stmt.run("old", "key-old", 1000);
      stmt.run("new", "key-new", 9999);

      const deleted = dedup.purgeTriggerEvents(5000);
      expect(deleted).toBe(1);

      // Verify old is gone, new remains
      const rows = db.prepare("SELECT * FROM trigger_events").all();
      expect(rows).toHaveLength(1);
    });

    it("returns 0 when nothing to purge", () => {
      expect(dedup.purgeTriggerEvents(0)).toBe(0);
    });
  });

  describe("stopAllTimers", () => {
    it("clears pending timers without firing", async () => {
      const event = makeEvent();
      const promise = dedup.debounce(event, 5_000); // long timer

      dedup.stopAllTimers();

      // The promise should resolve to null (timer cleared)
      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe("DDL", () => {
    it("creates trigger_events table with UNIQUE constraint", () => {
      const info = db.prepare("PRAGMA table_info(trigger_events)").all();
      const columns = (info as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toContain("source_id");
      expect(columns).toContain("idempotency_key");
      expect(columns).toContain("created_at");
    });

    it("creates idx_trigger_events_created_at index", () => {
      const indexes = db
        .prepare("PRAGMA index_list(trigger_events)")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_trigger_events_created_at");
    });
  });
});
