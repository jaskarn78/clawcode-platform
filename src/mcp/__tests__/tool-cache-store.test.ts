/**
 * Phase 115 Plan 07 T01 — ToolCacheStore unit tests.
 *
 * Verifies the daemon-side better-sqlite3 cache:
 *   - Schema matches the spec (key, tool, agent_or_null, response_json,
 *     created_at, expires_at, bytes, last_accessed_at).
 *   - put/get round-trip returns the stored row.
 *   - Lazy expiration: get on expired row returns null + deletes the row.
 *   - LRU promotion: get updates last_accessed_at.
 *   - LRU eviction: oldest by last_accessed_at evicted when over cap.
 *   - inspect filters by tool and/or agent.
 *   - clear() empties; clear(tool) drops only matching rows.
 *   - sizeMb reflects total bytes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ToolCacheStore } from "../tool-cache-store.js";

describe("ToolCacheStore (Phase 115 Plan 07 T01)", () => {
  let tmp: string;
  let dbPath: string;
  let store: ToolCacheStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tool-cache-store-test-"));
    dbPath = join(tmp, "tool-cache.db");
    store = new ToolCacheStore({ path: dbPath });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the schema with all required columns", () => {
    const db = new Database(dbPath);
    const cols = db
      .prepare("PRAGMA table_info(tool_cache)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "agent_or_null",
        "bytes",
        "created_at",
        "expires_at",
        "key",
        "last_accessed_at",
        "response_json",
        "tool",
      ].sort(),
    );
    db.close();
  });

  it("put + get round-trip returns the stored row", () => {
    const now = Date.now();
    store.put({
      key: "k1",
      tool: "web_search",
      agent_or_null: null,
      response_json: '{"hits":[1,2,3]}',
      created_at: now,
      expires_at: now + 60_000,
    });

    const row = store.get("k1", now);
    expect(row).not.toBeNull();
    expect(row!.tool).toBe("web_search");
    expect(row!.agent_or_null).toBeNull();
    expect(row!.response_json).toBe('{"hits":[1,2,3]}');
    expect(row!.bytes).toBe(Buffer.byteLength('{"hits":[1,2,3]}', "utf8"));
  });

  it("get on missing key returns null", () => {
    expect(store.get("never-set")).toBeNull();
  });

  it("lazy expiration: get on expired row returns null AND deletes the row", () => {
    const now = Date.now();
    store.put({
      key: "k-expired",
      tool: "web_search",
      agent_or_null: null,
      response_json: '{"x":1}',
      created_at: now - 120_000,
      expires_at: now - 60_000, // already expired
    });

    expect(store.get("k-expired", now)).toBeNull();
    // After lazy delete, sub-cap rebuild should also see no row
    const db = new Database(dbPath);
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM tool_cache WHERE key = 'k-expired'")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });

  it("LRU promotion: get updates last_accessed_at to the new now", () => {
    const t0 = 1_000_000_000_000;
    store.put({
      key: "k-lru",
      tool: "web_search",
      agent_or_null: null,
      response_json: '{"y":2}',
      created_at: t0,
      expires_at: t0 + 60_000,
    });

    const t1 = t0 + 30_000;
    const row = store.get("k-lru", t1);
    expect(row!.last_accessed_at).toBe(t1);

    const db = new Database(dbPath);
    const stored = db
      .prepare("SELECT last_accessed_at FROM tool_cache WHERE key = 'k-lru'")
      .get() as { last_accessed_at: number };
    expect(stored.last_accessed_at).toBe(t1);
    db.close();
  });

  it("LRU eviction: oldest by last_accessed_at evicted when over cap", () => {
    // Insert rows totaling ~1.2 MB at a 1 MB cap. ~120 rows of 10KB each.
    const tinyCap = 1; // 1 MB
    const payload = "x".repeat(10 * 1024); // 10 KB per row
    const rows = 130; // ~1.3 MB total
    const t0 = 1_000_000_000_000;

    // Use ascending last_accessed_at so the FIRST inserts are the oldest.
    for (let i = 0; i < rows; i++) {
      store.put(
        {
          key: `k${i.toString().padStart(4, "0")}`,
          tool: "web_search",
          agent_or_null: null,
          response_json: JSON.stringify({ payload }),
          created_at: t0 + i,
          expires_at: t0 + i + 60_000,
        },
        tinyCap,
      );
    }

    // After eviction, total bytes must be at or below the cap.
    expect(store.sizeMb()).toBeLessThanOrEqual(tinyCap);

    // The OLDEST keys (by insert order = LRU order) should be gone.
    const db = new Database(dbPath);
    const oldestSurvived = db
      .prepare("SELECT COUNT(*) AS n FROM tool_cache WHERE key = 'k0000'")
      .get() as { n: number };
    expect(oldestSurvived.n).toBe(0);

    // The newest insert should still be present.
    const newestSurvived = db
      .prepare("SELECT COUNT(*) AS n FROM tool_cache WHERE key = 'k0129'")
      .get() as { n: number };
    expect(newestSurvived.n).toBe(1);
    db.close();
  });

  it("LRU eviction also reclaims expired rows preferentially", () => {
    const t0 = 1_000_000_000_000;
    // Add an expired row + a fresh row.
    store.put({
      key: "k-expired",
      tool: "web_search",
      agent_or_null: null,
      response_json: JSON.stringify({ payload: "y".repeat(500_000) }), // ~0.5MB
      created_at: t0 - 120_000,
      expires_at: t0 - 60_000,
    });
    store.put({
      key: "k-fresh",
      tool: "web_search",
      agent_or_null: null,
      response_json: JSON.stringify({ payload: "z".repeat(500_000) }),
      created_at: t0,
      expires_at: t0 + 60_000,
    });

    // Force eviction at 0.6MB cap. Phase 1 should drop the expired row first.
    store.put(
      {
        key: "k-trigger",
        tool: "web_search",
        agent_or_null: null,
        response_json: JSON.stringify({ payload: "a".repeat(100_000) }),
        created_at: t0,
        expires_at: t0 + 60_000,
      },
      0.6,
    );

    const db = new Database(dbPath);
    const expiredRows = db
      .prepare("SELECT COUNT(*) AS n FROM tool_cache WHERE key = 'k-expired'")
      .get() as { n: number };
    expect(expiredRows.n).toBe(0);
    db.close();
  });

  it("inspect filters by tool", () => {
    const now = Date.now();
    store.put({
      key: "k1",
      tool: "web_search",
      agent_or_null: null,
      response_json: "{}",
      created_at: now,
      expires_at: now + 60_000,
    });
    store.put({
      key: "k2",
      tool: "search_documents",
      agent_or_null: "agent1",
      response_json: "{}",
      created_at: now,
      expires_at: now + 60_000,
    });

    const wsRows = store.inspect({ tool: "web_search" });
    expect(wsRows).toHaveLength(1);
    expect(wsRows[0]!.tool).toBe("web_search");

    const docRows = store.inspect({ tool: "search_documents" });
    expect(docRows).toHaveLength(1);
    expect(docRows[0]!.agent_or_null).toBe("agent1");
  });

  it("inspect filters by agent", () => {
    const now = Date.now();
    store.put({
      key: "k1",
      tool: "search_documents",
      agent_or_null: "agentA",
      response_json: "{}",
      created_at: now,
      expires_at: now + 60_000,
    });
    store.put({
      key: "k2",
      tool: "search_documents",
      agent_or_null: "agentB",
      response_json: "{}",
      created_at: now,
      expires_at: now + 60_000,
    });

    const aRows = store.inspect({ agent: "agentA" });
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.agent_or_null).toBe("agentA");
  });

  it("clear() empties the table", () => {
    const now = Date.now();
    store.put({
      key: "k1",
      tool: "web_search",
      agent_or_null: null,
      response_json: "{}",
      created_at: now,
      expires_at: now + 60_000,
    });
    expect(store.rowCount()).toBe(1);
    const cleared = store.clear();
    expect(cleared).toBe(1);
    expect(store.rowCount()).toBe(0);
  });

  it("clear(tool) only drops matching rows", () => {
    const now = Date.now();
    store.put({
      key: "k1",
      tool: "web_search",
      agent_or_null: null,
      response_json: "{}",
      created_at: now,
      expires_at: now + 60_000,
    });
    store.put({
      key: "k2",
      tool: "search_documents",
      agent_or_null: "agent1",
      response_json: "{}",
      created_at: now,
      expires_at: now + 60_000,
    });

    const cleared = store.clear("web_search");
    expect(cleared).toBe(1);
    expect(store.rowCount()).toBe(1);
    expect(store.inspect()[0]!.tool).toBe("search_documents");
  });

  it("topToolsByRows returns aggregated stats", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      store.put({
        key: `ws${i}`,
        tool: "web_search",
        agent_or_null: null,
        response_json: "{}",
        created_at: now,
        expires_at: now + 60_000,
      });
    }
    store.put({
      key: "sd1",
      tool: "search_documents",
      agent_or_null: "a",
      response_json: "{}",
      created_at: now,
      expires_at: now + 60_000,
    });

    const top = store.topToolsByRows(5);
    expect(top.find((t) => t.tool === "web_search")!.rows).toBe(3);
    expect(top.find((t) => t.tool === "search_documents")!.rows).toBe(1);
  });

  it("rowCount + sizeMb reflect inserts", () => {
    expect(store.rowCount()).toBe(0);
    expect(store.sizeMb()).toBe(0);
    const payload = JSON.stringify({ x: "y".repeat(1000) });
    store.put({
      key: "k1",
      tool: "web_search",
      agent_or_null: null,
      response_json: payload,
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    });
    expect(store.rowCount()).toBe(1);
    expect(store.sizeMb()).toBeGreaterThan(0);
  });
});
