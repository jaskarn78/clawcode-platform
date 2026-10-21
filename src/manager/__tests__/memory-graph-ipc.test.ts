/**
 * Phase 999.8 Plan 01 — memory-graph IPC handler unit tests.
 *
 * Pins the contract for the optional `limit` param introduced in this
 * plan (CAP-01..CAP-03):
 *
 *   - default cap = 5000 (raised from the previous hardcoded 500)
 *   - explicit numeric `limit` overrides the default
 *   - inclusive range [1, 50000]; out-of-range numeric values throw
 *     `ManagerError` with `/must be integer in \[1, 50000\]/`
 *   - non-number `limit` (e.g. string `"100"`) silently falls back to
 *     the default — matches the inline `typeof === "number"` coercion
 *     pattern at daemon.ts:4724 (memory-lookup), per D-CAP-02.
 *
 * Strategy: tests Option A from the plan — call the pure exported
 * helper `handleMemoryGraphIpc(params, db)` directly with a real
 * in-memory better-sqlite3 database. The daemon switch-case is a
 * one-line dispatch onto this helper, mirroring `handleSetModelIpc`
 * (Phase 86 Plan 02) and `invokeMemoryLookup` (Phase 68 Plan 02).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { ManagerError } from "../../shared/errors.js";
// Import target — does not exist yet; this is what makes the RED phase fail.
import { handleMemoryGraphIpc } from "../memory-graph-handler.js";

/**
 * Build a hermetic in-memory database with the minimum schema the
 * memory-graph handler reads from. We include `tier` directly because
 * production adds it via migration; the column has to exist for the
 * SELECT to return successfully.
 */
function makeDb(): DatabaseType {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      tier TEXT
    );
    CREATE TABLE memory_links (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      link_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedMemories(db: DatabaseType, count: number): void {
  const insert = db.prepare(
    `INSERT INTO memories (id, content, source, importance, access_count, tags, created_at, tier)
     VALUES (?, ?, 'manual', 0.5, 0, '[]', ?, 'warm')`,
  );
  // Stable, monotonically increasing created_at so ORDER BY DESC is deterministic.
  const insertMany = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      const ts = new Date(2026, 0, 1, 0, 0, i).toISOString();
      insert.run(`mem-${String(i).padStart(5, "0")}`, `content ${i}`, ts);
    }
  });
  insertMany(count);
}

describe("handleMemoryGraphIpc — limit param contract (Phase 999.8 Plan 01)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------
  // CAP-02 — default cap raised from 500 → 5000
  // ---------------------------------------------------------------------
  it("CAP-02: defaults to 5000 when `limit` is omitted (returns up to 5000 rows)", () => {
    // Seed 5500 memories so the handler must clip at 5000 if the default
    // is correctly applied. If the OLD `LIMIT 500` literal were still in
    // place this would return 500 rather than 5000.
    seedMemories(db, 5500);

    const result = handleMemoryGraphIpc({ agent: "fin-client" }, db);

    expect(result.nodes).toHaveLength(5000);
  });

  it("CAP-02: when DB has fewer rows than the default 5000, returns the actual row count (Pitfall 5)", () => {
    seedMemories(db, 47);

    const result = handleMemoryGraphIpc({ agent: "fin-client" }, db);

    // Must NOT be padded to 5000; must equal actual row count.
    expect(result.nodes).toHaveLength(47);
  });

  // ---------------------------------------------------------------------
  // CAP-01 — explicit numeric limit is honored
  // ---------------------------------------------------------------------
  it("CAP-01: explicit `limit: 100` returns at most 100 rows", () => {
    seedMemories(db, 250);

    const result = handleMemoryGraphIpc(
      { agent: "fin-client", limit: 100 },
      db,
    );

    expect(result.nodes).toHaveLength(100);
  });

  // ---------------------------------------------------------------------
  // CAP-03 — inclusive boundaries [1, 50000]
  // ---------------------------------------------------------------------
  it("CAP-03: `limit: 1` is accepted (lower inclusive bound)", () => {
    seedMemories(db, 5);

    const result = handleMemoryGraphIpc(
      { agent: "fin-client", limit: 1 },
      db,
    );

    expect(result.nodes).toHaveLength(1);
  });

  it("CAP-03: `limit: 50000` is accepted (upper inclusive bound)", () => {
    // Don't seed 50000 rows — that's slow. Just confirm the call
    // doesn't throw. The actual returned length is bounded by the
    // empty table.
    expect(() =>
      handleMemoryGraphIpc(
        { agent: "fin-client", limit: 50000 },
        db,
      ),
    ).not.toThrow();
  });

  // ---------------------------------------------------------------------
  // CAP-03 — out-of-range rejections
  // ---------------------------------------------------------------------
  it("CAP-03: `limit: 0` throws ManagerError matching /must be integer in \\[1, 50000\\]/", () => {
    expect(() =>
      handleMemoryGraphIpc({ agent: "fin-client", limit: 0 }, db),
    ).toThrow(ManagerError);
    expect(() =>
      handleMemoryGraphIpc({ agent: "fin-client", limit: 0 }, db),
    ).toThrow(/must be integer in \[1, 50000\]/);
  });

  it("CAP-03: `limit: 50001` throws ManagerError (above upper bound)", () => {
    expect(() =>
      handleMemoryGraphIpc(
        { agent: "fin-client", limit: 50001 },
        db,
      ),
    ).toThrow(/must be integer in \[1, 50000\]/);
  });

  it("CAP-03: `limit: -1` throws ManagerError (negative)", () => {
    expect(() =>
      handleMemoryGraphIpc({ agent: "fin-client", limit: -1 }, db),
    ).toThrow(/must be integer in \[1, 50000\]/);
  });

  it("CAP-03: `limit: 1.5` throws ManagerError (non-integer)", () => {
    expect(() =>
      handleMemoryGraphIpc(
        { agent: "fin-client", limit: 1.5 },
        db,
      ),
    ).toThrow(/must be integer in \[1, 50000\]/);
  });

  // ---------------------------------------------------------------------
  // D-CAP-02 — non-number `limit` is NOT an error; falls back to default
  //
  // Mirrors the existing memory-lookup pattern at daemon.ts:4724:
  //   `typeof params.limit === "number" ? params.limit : DEFAULT`
  // The dashboard never sends `limit`, so this must not be a hard
  // failure — string-typed `limit` (e.g. from a misconfigured caller)
  // simply takes the default path.
  // ---------------------------------------------------------------------
  it("D-CAP-02: non-number `limit` (string `\"100\"`) falls back to default — does NOT throw", () => {
    seedMemories(db, 10);

    expect(() =>
      handleMemoryGraphIpc(
        // Cast through unknown — caller bypassed any type checking.
        { agent: "fin-client", limit: "100" as unknown as number },
        db,
      ),
    ).not.toThrow();

    const result = handleMemoryGraphIpc(
      { agent: "fin-client", limit: "100" as unknown as number },
      db,
    );

    // 10 rows present; default cap of 5000 means we just get all 10.
    expect(result.nodes).toHaveLength(10);
  });
});
