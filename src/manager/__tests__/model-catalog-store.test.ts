import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ModelCatalogStore } from "../model-catalog-store.js";
import type { ModelInfo } from "../sdk-types.js";

/**
 * Phase 999.98 D8 — ModelCatalogStore CRUD + dedup assertions against an
 * in-memory SQLite catalog (mirrors the verbose-state / advisor-budget
 * `:memory:` pattern).
 */
describe("ModelCatalogStore", () => {
  let db: InstanceType<typeof Database>;
  let store: ModelCatalogStore;

  const opus8: ModelInfo = { value: "claude-opus-4-8", displayName: "Opus 4.8" };
  const opus10: ModelInfo = {
    value: "claude-opus-4-10",
    displayName: "Opus 4.10",
  };
  const haiku: ModelInfo = { value: "claude-haiku-4-5", displayName: "Haiku 4.5" };

  beforeEach(() => {
    db = new Database(":memory:");
    store = new ModelCatalogStore(db);
  });

  it("upsert + snapshot: round-trips a discovered model with derived family", () => {
    store.upsert([opus8], 1_000);
    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      model_id: "claude-opus-4-8",
      display_name: "Opus 4.8",
      family: "opus",
    });
  });

  it("upsert PRESERVES first_seen_at across re-writes, refreshes last_seen_at", () => {
    store.upsert([opus8], 1_000);
    store.upsert([opus8], 5_000); // re-write at a later time
    // Read the raw row to assert the timestamps directly.
    const row = db
      .prepare(
        "SELECT first_seen_at, last_seen_at FROM model_catalog WHERE model_id = ?",
      )
      .get("claude-opus-4-8") as {
      first_seen_at: number;
      last_seen_at: number;
    };
    expect(row.first_seen_at).toBe(1_000); // preserved
    expect(row.last_seen_at).toBe(5_000); // refreshed
  });

  it("upsert is idempotent on model_id (no duplicate rows)", () => {
    store.upsert([opus8, opus8], 1_000);
    store.upsert([opus8], 2_000);
    expect(store.snapshot()).toHaveLength(1);
  });

  it("snapshot returns all distinct models", () => {
    store.upsert([opus8, opus10, haiku], 1_000);
    const ids = store
      .snapshot()
      .map((r) => r.model_id)
      .sort();
    expect(ids).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-10",
      "claude-opus-4-8",
    ]);
  });

  it("markSurfaced / wasSurfaced gate on the (kind, model_id) composite key", () => {
    expect(store.wasSurfaced("new-tier", "claude-opus-4-10")).toBe(false);
    store.markSurfaced("new-tier", "claude-opus-4-10", 1_000);
    expect(store.wasSurfaced("new-tier", "claude-opus-4-10")).toBe(true);
  });

  it("dedup is PER-KIND: surfacing as 'new-tier' does NOT mark 'pin-bump'", () => {
    store.markSurfaced("new-tier", "claude-opus-4-10", 1_000);
    // Same model id, different kind — must still be un-surfaced for pin-bump.
    expect(store.wasSurfaced("new-tier", "claude-opus-4-10")).toBe(true);
    expect(store.wasSurfaced("pin-bump", "claude-opus-4-10")).toBe(false);
  });

  it("markSurfaced is idempotent on the composite key (no throw on re-mark)", () => {
    store.markSurfaced("pin-bump", "claude-opus-4-10", 1_000);
    expect(() =>
      store.markSurfaced("pin-bump", "claude-opus-4-10", 2_000),
    ).not.toThrow();
    expect(store.wasSurfaced("pin-bump", "claude-opus-4-10")).toBe(true);
  });
});
