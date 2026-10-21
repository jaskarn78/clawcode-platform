/**
 * Phase 999.98 D8 — runtime model catalog store.
 *
 * A SQLite-backed store (sibling to `advisor-budget.db` / `verbose-state.db` in
 * `~/.clawcode/manager/`) that records the entitled model set discovered from a
 * running agent's `initializationResult().models` (the OAuth/Max-entitled
 * catalog — the fleet sets no `availableModels` allowlist, so absent = not
 * entitled). The daemon's model-monitor cron upserts each tick; the daemon's
 * `@latest` snapshot ref is refreshed from `snapshot()`.
 *
 * This is daemon RUNTIME-STATE — the config differ must NEVER read it (D8). It
 * never flows into `clawcode.yaml`.
 *
 * Two tables on purpose:
 *   - `model_catalog` — the discovered models, keyed on `model_id`. `upsert`
 *     preserves `first_seen_at` on re-write and refreshes `last_seen_at`.
 *   - `model_surfaced` — per-kind dedup, keyed on `(kind, model_id)`. A single
 *     `surfaced_at` column on `model_catalog` could NOT express per-kind dedup:
 *     surfacing an id as "new-tier" would suppress a later "pin-bump" surface
 *     for the SAME id. The composite-key table keeps the two dedup streams
 *     independent.
 *
 * Mirrors the `AdvisorBudget` pattern: takes a `better-sqlite3` Database in the
 * constructor, creates tables idempotently, all methods synchronous.
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";
import type { ModelInfo } from "./sdk-types.js";
import {
  deriveFamily,
  type CatalogModelRow,
  type CatalogSnapshot,
} from "./model-resolver.js";

/** Prepared statements for the catalog store. */
type CatalogStatements = {
  readonly upsert: Statement;
  readonly selectAll: Statement;
  readonly markSurfaced: Statement;
  readonly wasSurfaced: Statement;
};

/** Raw row shape read back from `model_catalog`. */
type CatalogDbRow = {
  readonly model_id: string;
  readonly display_name: string;
  readonly family: string;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly entitled: number;
};

/**
 * Phase 999.98 D8 — runtime model catalog store.
 */
export class ModelCatalogStore {
  private readonly stmts: CatalogStatements;

  constructor(db: DatabaseType) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_catalog (
        model_id TEXT PRIMARY KEY,
        display_name TEXT,
        family TEXT,
        first_seen_at INTEGER,
        last_seen_at INTEGER,
        entitled INTEGER
      );
      CREATE TABLE IF NOT EXISTS model_surfaced (
        kind TEXT NOT NULL,
        model_id TEXT NOT NULL,
        surfaced_at INTEGER,
        PRIMARY KEY (kind, model_id)
      );
    `);

    this.stmts = {
      // INSERT-or-UPDATE: on first write set first_seen_at; on re-write PRESERVE
      // first_seen_at and refresh last_seen_at + display_name + entitled.
      upsert: db.prepare(`
        INSERT INTO model_catalog
          (model_id, display_name, family, first_seen_at, last_seen_at, entitled)
        VALUES (@model_id, @display_name, @family, @now, @now, @entitled)
        ON CONFLICT(model_id) DO UPDATE SET
          display_name = excluded.display_name,
          family = excluded.family,
          last_seen_at = excluded.last_seen_at,
          entitled = excluded.entitled
      `),
      selectAll: db.prepare(
        "SELECT model_id, display_name, family, first_seen_at, last_seen_at, entitled FROM model_catalog",
      ),
      markSurfaced: db.prepare(`
        INSERT INTO model_surfaced (kind, model_id, surfaced_at)
        VALUES (@kind, @model_id, @at)
        ON CONFLICT(kind, model_id) DO UPDATE SET surfaced_at = excluded.surfaced_at
      `),
      wasSurfaced: db.prepare(
        "SELECT 1 FROM model_surfaced WHERE kind = ? AND model_id = ? LIMIT 1",
      ),
    };
  }

  /**
   * Upsert the discovered entitled model set. `first_seen_at` is preserved
   * across re-writes (so the store remembers when a model first appeared);
   * `last_seen_at` refreshes every tick. `family` is derived from the id —
   * a model whose family can't be derived is stored with `family = ""` (it is
   * still recorded, just not matched by family-scoped reads).
   *
   * @param models the entitled `ModelInfo[]` from a handle's
   *   `getSupportedModels()`. `entitled` is always 1 here — the init result IS
   *   the entitled set; an absent model is simply never upserted.
   * @param now epoch ms (injected for deterministic tests).
   */
  upsert(models: readonly ModelInfo[], now: number): void {
    for (const m of models) {
      const fam = deriveFamily(m.value);
      this.stmts.upsert.run({
        model_id: m.value,
        display_name: m.displayName,
        family: fam ?? "",
        now,
        entitled: 1,
      });
    }
  }

  /**
   * Read all catalog rows into a plain in-memory array (the injected snapshot
   * the pure `resolveLatestModel` reads). Ordering is unspecified — the resolver
   * picks the newest by VERSION, not by row order.
   */
  snapshot(): CatalogSnapshot {
    const rows = this.stmts.selectAll.all() as CatalogDbRow[];
    return rows.map(
      (r): CatalogModelRow => ({
        model_id: r.model_id,
        display_name: r.display_name,
        family: r.family,
        // Phase 999.114 — always SELECTed, previously dropped here. Consumers
        // need it to bound `@latest` to models still being offered.
        last_seen_at: r.last_seen_at,
      }),
    );
  }

  /**
   * Record that `(kind, modelId)` was surfaced to Admin Clawdy. Idempotent
   * upsert on the composite key — keeps "new-tier" and "pin-bump" dedup
   * independent for the same id.
   */
  markSurfaced(kind: string, modelId: string, at: number): void {
    this.stmts.markSurfaced.run({ kind, model_id: modelId, at });
  }

  /**
   * Has `(kind, modelId)` already been surfaced? The diff/surface logic gates
   * each surface on this so the same discovery is not re-surfaced every tick.
   */
  wasSurfaced(kind: string, modelId: string): boolean {
    return this.stmts.wasSurfaced.get(kind, modelId) !== undefined;
  }
}
