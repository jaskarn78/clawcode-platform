/**
 * Phase 69 Plan 03 Task 1 — api_key_sessions + ApiKeySessionIndex tests (OPENAI-05).
 *
 * Covers the per-bearer-key → session_id mapping that gives each API key its
 * own persistent conversation with an agent. Tests validate:
 *   - Isolation: two different key_hashes for the same agent get distinct sessions.
 *   - Continuity: close the DB, reopen at the same path, lookup still resolves.
 *   - Revoke path: delete removes the row cleanly.
 *   - Migration idempotency: running the CREATE TABLE twice does not error.
 *
 * Uses the real migration SQL from src/memory/store.ts (by calling the helper
 * indirectly via MemoryStore construction on a :memory: db) for migration
 * idempotency tests, plus a bare `better-sqlite3` Database for focused unit
 * tests of ApiKeySessionIndex.
 */

import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApiKeySessionIndex,
  API_KEY_SESSIONS_MIGRATION_SQL,
  API_KEY_SESSIONS_MIGRATION_V2_SQL,
  lookupSessionForKey,
  recordSessionForKey,
} from "../session-index.js";

describe("ApiKeySessionIndex", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(API_KEY_SESSIONS_MIGRATION_SQL);
    db.exec(API_KEY_SESSIONS_MIGRATION_V2_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it("first lookup for unknown keyHash returns null", () => {
    const index = new ApiKeySessionIndex(db);
    expect(index.lookup("a".repeat(64), "clawdy")).toBeNull();
  });

  it("record then lookup returns the session_id and agent_name", () => {
    const index = new ApiKeySessionIndex(db);
    const keyHash = "a".repeat(64);
    index.record(keyHash, "clawdy", "sess-abc-123");
    const found = index.lookup(keyHash, "clawdy");
    expect(found).not.toBeNull();
    expect(found?.session_id).toBe("sess-abc-123");
    expect(found?.agent_name).toBe("clawdy");
  });

  it("record with existing (key_hash, agent_name) updates session_id (ON CONFLICT REPLACE)", () => {
    const index = new ApiKeySessionIndex(db);
    const keyHash = "b".repeat(64);
    index.record(keyHash, "clawdy", "sess-original");
    index.record(keyHash, "clawdy", "sess-rotated");
    const found = index.lookup(keyHash, "clawdy");
    expect(found?.session_id).toBe("sess-rotated");
  });

  it("two different key_hashes for same agent have distinct session_id rows (isolation)", () => {
    const index = new ApiKeySessionIndex(db);
    const key1 = "c".repeat(64);
    const key2 = "d".repeat(64);
    index.record(key1, "clawdy", "sess-alpha");
    index.record(key2, "clawdy", "sess-beta");
    expect(index.lookup(key1, "clawdy")?.session_id).toBe("sess-alpha");
    expect(index.lookup(key2, "clawdy")?.session_id).toBe("sess-beta");
  });

  it("same keyHash + different agents → distinct sessions (P51-SESSION-ISOLATION)", () => {
    const index = new ApiKeySessionIndex(db);
    const keyHash = "f".repeat(64);
    index.record(keyHash, "clawdy", "sess-A");
    index.record(keyHash, "fin-test", "sess-B");
    expect(index.lookup(keyHash, "clawdy")?.session_id).toBe("sess-A");
    expect(index.lookup(keyHash, "fin-test")?.session_id).toBe("sess-B");
    // Both rows coexist — composite PK is (key_hash, agent_name).
    const rowCount = db
      .prepare("SELECT COUNT(*) AS n FROM api_key_sessions_v2 WHERE key_hash = ?")
      .get(keyHash) as { n: number };
    expect(rowCount.n).toBe(2);
  });

  it("touch updates last_used_at without changing session_id", () => {
    const index = new ApiKeySessionIndex(db);
    const keyHash = "e".repeat(64);
    index.record(keyHash, "clawdy", "sess-1");

    const before = db
      .prepare(
        "SELECT last_used_at FROM api_key_sessions_v2 WHERE key_hash = ? AND agent_name = ?",
      )
      .get(keyHash, "clawdy") as { last_used_at: number };

    index.touch(keyHash, "clawdy");

    const after = db
      .prepare(
        "SELECT last_used_at, session_id FROM api_key_sessions_v2 WHERE key_hash = ? AND agent_name = ?",
      )
      .get(keyHash, "clawdy") as { last_used_at: number; session_id: string };

    expect(after.session_id).toBe("sess-1");
    expect(after.last_used_at).toBeGreaterThanOrEqual(before.last_used_at);
  });

  it("delete(keyHash) removes ALL rows for that hash (revoke-clears-all-agents)", () => {
    const index = new ApiKeySessionIndex(db);
    const keyHash = "7".repeat(64);
    index.record(keyHash, "clawdy", "sess-clawdy");
    index.record(keyHash, "fin-test", "sess-fin");
    expect(index.lookup(keyHash, "clawdy")).not.toBeNull();
    expect(index.lookup(keyHash, "fin-test")).not.toBeNull();
    expect(index.delete(keyHash)).toBe(true);
    expect(index.lookup(keyHash, "clawdy")).toBeNull();
    expect(index.lookup(keyHash, "fin-test")).toBeNull();
    // Second delete returns false (nothing to remove).
    expect(index.delete(keyHash)).toBe(false);
  });

  it("listForAgent returns all rows for that agent, sorted by last_used_at DESC", () => {
    const index = new ApiKeySessionIndex(db);
    const keyA = "0".repeat(64);
    const keyB = "1".repeat(64);
    const keyC = "2".repeat(64);

    index.record(keyA, "clawdy", "sess-A");
    index.record(keyB, "clawdy", "sess-B");
    index.record(keyC, "other-agent", "sess-C");

    // Update last_used_at so A is oldest, B is newest.
    db.prepare(
      "UPDATE api_key_sessions_v2 SET last_used_at = ? WHERE key_hash = ?",
    ).run(1000, keyA);
    db.prepare(
      "UPDATE api_key_sessions_v2 SET last_used_at = ? WHERE key_hash = ?",
    ).run(2000, keyB);

    const rows = index.listForAgent("clawdy");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.key_hash).toBe(keyB);
    expect(rows[1]?.key_hash).toBe(keyA);
    expect(rows.every((r) => r.session_id.startsWith("sess-"))).toBe(true);
  });

  it("convenience wrappers lookupSessionForKey + recordSessionForKey work", () => {
    const keyHash = "9".repeat(64);
    expect(lookupSessionForKey(db, keyHash, "clawdy")).toBeNull();
    recordSessionForKey(db, keyHash, "clawdy", "sess-conv");
    const found = lookupSessionForKey(db, keyHash, "clawdy");
    expect(found?.session_id).toBe("sess-conv");
    expect(found?.agent_name).toBe("clawdy");
  });
});

describe("ApiKeySessionIndex — persistence across reopen (OPENAI-05 restart)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "api-key-sessions-"));
    dbPath = join(dir, "memories.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("session persists across close + reopen (OPENAI-05 survives restart)", () => {
    const keyHash = "7".repeat(64);

    // Boot 1: record a session.
    const db1 = new Database(dbPath);
    db1.exec(API_KEY_SESSIONS_MIGRATION_SQL);
    db1.exec(API_KEY_SESSIONS_MIGRATION_V2_SQL);
    new ApiKeySessionIndex(db1).record(keyHash, "clawdy", "sess-persisted");
    db1.close();

    // Boot 2: reopen. Lookup should still find the row.
    const db2 = new Database(dbPath);
    db2.exec(API_KEY_SESSIONS_MIGRATION_SQL);
    db2.exec(API_KEY_SESSIONS_MIGRATION_V2_SQL);
    const found = new ApiKeySessionIndex(db2).lookup(keyHash, "clawdy");
    expect(found).not.toBeNull();
    expect(found?.session_id).toBe("sess-persisted");
    expect(found?.agent_name).toBe("clawdy");
    db2.close();
  });

  it("migration SQL is idempotent — running twice does not error", () => {
    const db = new Database(dbPath);
    expect(() => {
      db.exec(API_KEY_SESSIONS_MIGRATION_SQL);
      db.exec(API_KEY_SESSIONS_MIGRATION_V2_SQL);
      db.exec(API_KEY_SESSIONS_MIGRATION_SQL);
      db.exec(API_KEY_SESSIONS_MIGRATION_V2_SQL);
      db.exec(API_KEY_SESSIONS_MIGRATION_SQL);
      db.exec(API_KEY_SESSIONS_MIGRATION_V2_SQL);
    }).not.toThrow();
    // Final state is still usable.
    const index = new ApiKeySessionIndex(db);
    index.record("z".repeat(64), "clawdy", "sess-idempotent");
    expect(index.lookup("z".repeat(64), "clawdy")?.session_id).toBe("sess-idempotent");
    db.close();
  });

  // Quick task 260419-p51 — v1 → v2 migration copy test
  it("v1 legacy rows are copied to v2 exactly once on first post-migration boot", () => {
    const keyHash = "8".repeat(64);

    // Seed a v1 DB with a legacy row (no v2 table yet).
    const db1 = new Database(dbPath);
    db1.exec(API_KEY_SESSIONS_MIGRATION_SQL);
    const now = Date.now();
    db1
      .prepare(
        "INSERT INTO api_key_sessions (key_hash, agent_name, session_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(keyHash, "clawdy", "sess-legacy", now, now);
    db1.close();

    // Now run the v2 migration the same way src/memory/store.ts will —
    // create the v2 table and, if empty, copy the v1 rows over.
    const db2 = new Database(dbPath);
    db2.exec(API_KEY_SESSIONS_MIGRATION_V2_SQL);
    const empty = db2
      .prepare("SELECT 1 FROM api_key_sessions_v2 LIMIT 1")
      .get();
    if (!empty) {
      db2.exec(`
        INSERT OR IGNORE INTO api_key_sessions_v2
          (key_hash, agent_name, session_id, created_at, last_used_at)
        SELECT key_hash, agent_name, session_id, created_at, last_used_at
        FROM api_key_sessions
      `);
    }
    // Row is now in v2.
    const found = new ApiKeySessionIndex(db2).lookup(keyHash, "clawdy");
    expect(found?.session_id).toBe("sess-legacy");
    db2.close();

    // Third boot: verify we don't double-copy. Mutate the v2 row so a re-copy
    // would overwrite it back to the legacy session_id.
    const db3 = new Database(dbPath);
    db3
      .prepare(
        "UPDATE api_key_sessions_v2 SET session_id = 'sess-evolved' WHERE key_hash = ? AND agent_name = ?",
      )
      .run(keyHash, "clawdy");
    db3.exec(API_KEY_SESSIONS_MIGRATION_V2_SQL);
    const notEmpty = db3
      .prepare("SELECT 1 FROM api_key_sessions_v2 LIMIT 1")
      .get();
    if (!notEmpty) {
      db3.exec(`
        INSERT OR IGNORE INTO api_key_sessions_v2
          (key_hash, agent_name, session_id, created_at, last_used_at)
        SELECT key_hash, agent_name, session_id, created_at, last_used_at
        FROM api_key_sessions
      `);
    }
    const refound = new ApiKeySessionIndex(db3).lookup(keyHash, "clawdy");
    // Session_id remains "sess-evolved" — the v2 → v1 copy did NOT re-run.
    expect(refound?.session_id).toBe("sess-evolved");
    db3.close();
  });
});

describe("MemoryStore — api_key_sessions migration integration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memstore-api-keys-"));
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("MemoryStore construction creates both api_key_sessions (v1) + api_key_sessions_v2", async () => {
    // Import MemoryStore lazily to avoid loading sqlite-vec for the focused
    // unit tests above (which only need better-sqlite3 bare).
    const { MemoryStore } = await import("../../memory/store.js");
    const store = new MemoryStore(join(dir, "memories.db"));
    const db = store.getDatabase();
    const v1Row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='api_key_sessions'",
      )
      .get() as { name: string } | undefined;
    expect(v1Row?.name).toBe("api_key_sessions");
    const v2Row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='api_key_sessions_v2'",
      )
      .get() as { name: string } | undefined;
    expect(v2Row?.name).toBe("api_key_sessions_v2");
    // The ApiKeySessionIndex can operate against the MemoryStore-owned DB.
    const index = new ApiKeySessionIndex(db);
    index.record("y".repeat(64), "clawdy", "sess-via-memstore");
    expect(index.lookup("y".repeat(64), "clawdy")?.session_id).toBe("sess-via-memstore");
    store.close();
  }, 30000);
});
