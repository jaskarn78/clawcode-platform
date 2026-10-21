import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import pino from "pino";
import { DeliveryQueue } from "../delivery-queue.js";
import type { DeliverFn } from "../delivery-queue-types.js";

const silentLog = pino({ level: "silent" });

/**
 * Build a DeliveryQueue over an in-memory SQLite db. The deliverFn is a no-op
 * by default; tests override per-case. Maintenance windows are tightened so a
 * row inserted at "now" is immediately considered stale/old when we ask.
 */
function makeQueue(deliverFn: DeliverFn = async () => {}) {
  const db = new Database(":memory:");
  const queue = new DeliveryQueue({
    db,
    deliverFn,
    log: silentLog,
    config: {
      inFlightReclaimMs: 1000, // 1s staleness window
      deliveredRetentionMs: 1000, // 1s retention
      maintenanceIntervalMs: 60_000,
    },
  });
  return { db, queue };
}

/** Insert a raw delivery_queue row with explicit timestamps for control. */
function insertRow(
  db: Database.Database,
  row: {
    id: string;
    status: string;
    attempts?: number;
    maxAttempts?: number;
    createdAt: string;
    lastAttemptAt?: string | null;
    nextRetryAt?: string | null;
    deliveredAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO delivery_queue
       (id, agent_name, channel_id, content, status, attempts, max_attempts,
        created_at, last_attempt_at, next_retry_at, last_error, delivered_at)
     VALUES (?, 'agent', 'chan', 'hello', ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    row.id,
    row.status,
    row.attempts ?? 0,
    row.maxAttempts ?? 3,
    row.createdAt,
    row.lastAttemptAt ?? null,
    row.nextRetryAt ?? null,
    row.deliveredAt ?? null,
  );
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("DeliveryQueue maintenance (M1)", () => {
  let db: Database.Database;
  let queue: DeliveryQueue;

  beforeEach(() => {
    ({ db, queue } = makeQueue());
  });

  afterEach(() => {
    queue.stop();
    db.close();
  });

  describe("reclaimStaleInFlight", () => {
    it("flips a stale in_flight row back to pending", () => {
      insertRow(db, {
        id: "stale",
        status: "in_flight",
        createdAt: iso(-10_000),
        lastAttemptAt: iso(-5_000), // 5s ago > 1s window
      });

      const reclaimed = queue.reclaimStaleInFlight();

      expect(reclaimed).toBe(1);
      const after = db
        .prepare(`SELECT status, next_retry_at FROM delivery_queue WHERE id = 'stale'`)
        .get() as { status: string; next_retry_at: string | null };
      expect(after.status).toBe("pending");
      expect(after.next_retry_at).toBeNull(); // immediately eligible
    });

    it("leaves a fresh in_flight row untouched", () => {
      insertRow(db, {
        id: "fresh",
        status: "in_flight",
        createdAt: iso(-500),
        lastAttemptAt: iso(-100), // 100ms ago < 1s window
      });

      const reclaimed = queue.reclaimStaleInFlight();

      expect(reclaimed).toBe(0);
      const after = db
        .prepare(`SELECT status FROM delivery_queue WHERE id = 'fresh'`)
        .get() as { status: string };
      expect(after.status).toBe("in_flight");
    });

    it("preserves attempts so the maxAttempts cap still terminates", () => {
      insertRow(db, {
        id: "burned",
        status: "in_flight",
        attempts: 2,
        maxAttempts: 3,
        createdAt: iso(-10_000),
        lastAttemptAt: iso(-5_000),
      });

      queue.reclaimStaleInFlight();

      const after = db
        .prepare(`SELECT status, attempts FROM delivery_queue WHERE id = 'burned'`)
        .get() as { status: string; attempts: number };
      expect(after.status).toBe("pending");
      expect(after.attempts).toBe(2); // NOT reset — next failure hits the cap
    });

    it("does not resurrect a failed row", () => {
      insertRow(db, {
        id: "failed",
        status: "failed",
        attempts: 3,
        createdAt: iso(-10_000),
        lastAttemptAt: iso(-5_000),
      });

      const reclaimed = queue.reclaimStaleInFlight();

      expect(reclaimed).toBe(0);
      const after = db
        .prepare(`SELECT status FROM delivery_queue WHERE id = 'failed'`)
        .get() as { status: string };
      expect(after.status).toBe("failed");
    });
  });

  describe("pruneDelivered", () => {
    it("deletes old delivered rows", () => {
      insertRow(db, {
        id: "old",
        status: "delivered",
        createdAt: iso(-10_000),
        deliveredAt: iso(-5_000), // 5s ago > 1s retention
      });

      const pruned = queue.pruneDelivered();

      expect(pruned).toBe(1);
      const exists = db
        .prepare(`SELECT id FROM delivery_queue WHERE id = 'old'`)
        .get();
      expect(exists).toBeUndefined();
    });

    it("keeps recent delivered rows", () => {
      insertRow(db, {
        id: "recent",
        status: "delivered",
        createdAt: iso(-500),
        deliveredAt: iso(-100), // 100ms ago < 1s retention
      });

      const pruned = queue.pruneDelivered();

      expect(pruned).toBe(0);
      const exists = db
        .prepare(`SELECT id FROM delivery_queue WHERE id = 'recent'`)
        .get();
      expect(exists).toBeDefined();
    });

    it("never prunes pending / in_flight / failed rows", () => {
      insertRow(db, { id: "p", status: "pending", createdAt: iso(-10_000) });
      insertRow(db, {
        id: "f",
        status: "failed",
        createdAt: iso(-10_000),
        deliveredAt: null,
      });

      const pruned = queue.pruneDelivered();

      expect(pruned).toBe(0);
      const count = db
        .prepare(`SELECT COUNT(*) AS c FROM delivery_queue`)
        .get() as { c: number };
      expect(count.c).toBe(2);
    });
  });

  describe("integration: reclaimed message re-delivers", () => {
    it("a reclaimed in_flight row is delivered on the next processNext tick", async () => {
      const delivered: string[] = [];
      const local = makeQueue(async (_a, _c, content) => {
        delivered.push(content);
      });
      // Strand a row in in_flight.
      insertRow(local.db, {
        id: "stranded",
        status: "in_flight",
        createdAt: iso(-10_000),
        lastAttemptAt: iso(-5_000),
      });

      // Before reclaim, processNext finds nothing (only selects pending).
      expect(await local.queue.processNext()).toBe(false);
      expect(delivered).toHaveLength(0);

      // Reclaim, then process — now it delivers.
      expect(local.queue.reclaimStaleInFlight()).toBe(1);
      expect(await local.queue.processNext()).toBe(true);
      expect(delivered).toEqual(["hello"]);

      const after = local.db
        .prepare(`SELECT status FROM delivery_queue WHERE id = 'stranded'`)
        .get() as { status: string };
      expect(after.status).toBe("delivered");

      local.queue.stop();
      local.db.close();
    });
  });

  describe("start() runs a recovery sweep", () => {
    it("reclaims stranded in_flight + prunes old delivered on start", () => {
      insertRow(db, {
        id: "stranded",
        status: "in_flight",
        createdAt: iso(-10_000),
        lastAttemptAt: iso(-5_000),
      });
      insertRow(db, {
        id: "olddelivered",
        status: "delivered",
        createdAt: iso(-10_000),
        deliveredAt: iso(-5_000),
      });

      queue.start();

      const stranded = db
        .prepare(`SELECT status FROM delivery_queue WHERE id = 'stranded'`)
        .get() as { status: string };
      expect(stranded.status).toBe("pending");

      const old = db
        .prepare(`SELECT id FROM delivery_queue WHERE id = 'olddelivered'`)
        .get();
      expect(old).toBeUndefined();
    });
  });
});
