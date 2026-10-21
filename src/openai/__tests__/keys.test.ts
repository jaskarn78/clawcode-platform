/**
 * Quick task 260419-p51 — ApiKeysStore scope column + createAllKey tests
 * (P51-MULTI-AGENT-KEY).
 *
 * Complements `src/openai/__tests__/auth.test.ts` (Phase 69 Plan 01 coverage —
 * hash/verify/generate + baseline CRUD). Focuses specifically on the new
 * `scope` column added by this quick task:
 *
 *   - Greenfield construction persists `scope` on new rows.
 *   - `createKey(agent)` writes `scope = "agent:<agent>"`.
 *   - `createAllKey({label})` writes `scope = "all"`, `agent_name = "*"`.
 *   - Idempotent ALTER (scope column is added to pre-v2 DBs without throw).
 *   - One-time backfill sets `scope = "agent:<agent>"` on legacy NULL rows
 *     then does NOT re-run on subsequent constructions.
 *   - `listKeys` + `lookupByIncomingKey` expose the scope field on every row.
 */

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiKeysStore } from "../keys.js";

// ---------------------------------------------------------------------------
// Greenfield (fresh :memory: DB) — scope column present from first boot
// ---------------------------------------------------------------------------

describe("ApiKeysStore scope column — greenfield", () => {
  let store: ApiKeysStore;

  beforeEach(() => {
    store = new ApiKeysStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("createKey persists scope='agent:<name>' (back-compat path)", () => {
    const { row } = store.createKey("clawdy");
    expect(row.scope).toBe("agent:clawdy");
    expect(row.agent_name).toBe("clawdy");
  });

  it("createAllKey persists scope='all' + agent_name='*' sentinel", () => {
    const { row, key } = store.createAllKey({ label: "openclaw-all" });
    expect(row.scope).toBe("all");
    expect(row.agent_name).toBe("*");
    expect(row.label).toBe("openclaw-all");
    // Key format mirrors createKey — slug is "all" from generateApiKey("all").
    expect(key).toMatch(/^ck_all_[A-Za-z0-9_-]+$/);
  });

  it("createAllKey honors expiresAt", () => {
    const future = Date.now() + 60_000;
    const { row } = store.createAllKey({ expiresAt: future });
    expect(row.expires_at).toBe(future);
    expect(row.scope).toBe("all");
  });

  it("listKeys returns scope on every row (both shapes)", () => {
    store.createKey("clawdy", { label: "pinned" });
    store.createAllKey({ label: "fleet" });
    const rows = store.listKeys();
    expect(rows).toHaveLength(2);
    const scopes = rows.map((r) => r.scope).sort();
    expect(scopes).toEqual(["agent:clawdy", "all"]);
  });

  it("lookupByIncomingKey returns scope on the matched row", () => {
    const { key } = store.createKey("clawdy");
    const row = store.lookupByIncomingKey(key);
    expect(row?.scope).toBe("agent:clawdy");
  });

  it("lookupByIncomingKey returns scope='all' for an --all key", () => {
    const { key } = store.createAllKey({ label: "multi" });
    const row = store.lookupByIncomingKey(key);
    expect(row?.scope).toBe("all");
    expect(row?.agent_name).toBe("*");
  });
});

// ---------------------------------------------------------------------------
// Idempotent migration — pre-v2 DB (no scope column) upgrades cleanly
// ---------------------------------------------------------------------------

describe("ApiKeysStore scope migration — legacy DB upgrade", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "api-keys-scope-"));
    dbPath = join(dir, "api-keys.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Simulate a pre-v2 DB: manually create the v1 schema (no scope column)
   * with the v1 schema-version row, seed a legacy pinned row, then construct
   * ApiKeysStore and verify the migration ran exactly once.
   */
  function seedV1Db(
    rows: ReadonlyArray<{ key_hash: string; agent_name: string; label?: string }>,
  ): void {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys_schema_version (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        key_hash      TEXT PRIMARY KEY,
        agent_name    TEXT NOT NULL,
        label         TEXT,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        expires_at    INTEGER,
        disabled_at   INTEGER
      );
    `);
    db.prepare("INSERT OR IGNORE INTO api_keys_schema_version (version) VALUES (1)").run();
    const insert = db.prepare(
      "INSERT INTO api_keys (key_hash, agent_name, label, created_at, last_used_at, expires_at, disabled_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL)",
    );
    for (const r of rows) {
      insert.run(r.key_hash, r.agent_name, r.label ?? null, Date.now());
    }
    db.close();
  }

  it("construction adds the scope column without throwing on pre-v2 DB", () => {
    seedV1Db([{ key_hash: "a".repeat(64), agent_name: "clawdy", label: "legacy" }]);
    // First construction runs the migration.
    expect(() => {
      const store = new ApiKeysStore(dbPath);
      store.close();
    }).not.toThrow();

    // Inspect the schema directly — scope column is now present.
    const db = new Database(dbPath);
    const columns = db
      .prepare("PRAGMA table_info(api_keys)")
      .all() as ReadonlyArray<{ name: string }>;
    db.close();
    expect(columns.some((c) => c.name === "scope")).toBe(true);
  });

  it("backfill runs once — legacy rows gain scope='agent:<name>'", () => {
    seedV1Db([
      { key_hash: "a".repeat(64), agent_name: "clawdy", label: "legacy-1" },
      { key_hash: "b".repeat(64), agent_name: "fin-test", label: "legacy-2" },
    ]);
    const store = new ApiKeysStore(dbPath);
    const rows = store.listKeys();
    const byLabel = Object.fromEntries(rows.map((r) => [r.label ?? "", r.scope]));
    expect(byLabel["legacy-1"]).toBe("agent:clawdy");
    expect(byLabel["legacy-2"]).toBe("agent:fin-test");
    store.close();
  });

  it("backfill does NOT re-run on subsequent constructions (idempotent)", () => {
    seedV1Db([{ key_hash: "a".repeat(64), agent_name: "clawdy", label: "legacy" }]);
    // First construction runs the migration.
    const s1 = new ApiKeysStore(dbPath);
    s1.close();

    // Manually null-out the scope so we can detect a re-run. Inspect the raw
    // DB AFTER the second construction — listKeys() synthesizes scope on
    // transient-null rows, so we must read the stored cell directly.
    const db = new Database(dbPath);
    db.prepare("UPDATE api_keys SET scope = NULL WHERE label = 'legacy'").run();
    db.close();

    // Second construction should NOT re-backfill — version row is the guard.
    const s2 = new ApiKeysStore(dbPath);
    s2.close();

    const db2 = new Database(dbPath);
    const rawScope = db2
      .prepare("SELECT scope FROM api_keys WHERE label = 'legacy'")
      .get() as { scope: string | null };
    db2.close();
    expect(rawScope.scope).toBeNull();
  });

  it("construction is idempotent — calling twice against the same DB is safe", () => {
    seedV1Db([{ key_hash: "a".repeat(64), agent_name: "clawdy", label: "legacy" }]);
    expect(() => {
      const s1 = new ApiKeysStore(dbPath);
      s1.close();
      const s2 = new ApiKeysStore(dbPath);
      s2.close();
      const s3 = new ApiKeysStore(dbPath);
      s3.close();
    }).not.toThrow();
  });

  it("new keys created against a migrated DB still get the correct scope", () => {
    seedV1Db([{ key_hash: "a".repeat(64), agent_name: "clawdy", label: "legacy" }]);
    const store = new ApiKeysStore(dbPath);
    const { row: pinned } = store.createKey("admin-clawdy");
    const { row: fleet } = store.createAllKey({ label: "fleet-post-migration" });
    expect(pinned.scope).toBe("agent:admin-clawdy");
    expect(fleet.scope).toBe("all");
    // Verify listKeys returns all three rows with correct scopes.
    const rows = store.listKeys();
    expect(rows).toHaveLength(3);
    const scopeByLabel = Object.fromEntries(
      rows.map((r) => [r.label ?? "", r.scope] as const),
    );
    expect(scopeByLabel["legacy"]).toBe("agent:clawdy");
    expect(scopeByLabel["fleet-post-migration"]).toBe("all");
    store.close();
  });
});
