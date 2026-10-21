import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { ModelCatalogStore } from "../model-catalog-store.js";
import {
  computeModelDiff,
  surfaceModelDiff,
  SURFACE_NEW_TIER,
  SURFACE_PIN_BUMP,
  type PinnedAgentInput,
  type SurfaceDeps,
} from "../model-monitor.js";
import type { ModelInfo } from "../sdk-types.js";
import { deriveFamily, type CatalogModelRow } from "../model-resolver.js";

/**
 * Phase 999.98 D10 — pure diff + dedup-gated surfacing.
 *
 * Covers: one new family → one newTier; a pinned agent with a STRICTLY-newer
 * same-family catalog id → one pin-bump PROPOSAL; an agent already on the newest
 * id → zero pin-bumps; re-tick with no new discovery → zero surfaces (dedup);
 * dedup INDEPENDENCE across kinds; NEVER auto-flips a pin (no setModel path).
 */

const mi = (value: string, displayName = value): ModelInfo => ({ value, displayName });
// Phase 999.114 — `last_seen_at` defaults to a far-future-proof constant so
// these fixtures are never filtered by the OPTIONAL freshness bound (which only
// applies when a caller passes both `now` and `maxAgeMs`).
const row = (model_id: string, last_seen_at = 1_800_000_000_000): CatalogModelRow => ({
  model_id,
  display_name: model_id,
  last_seen_at,
  family: deriveFamily(model_id) ?? "",
});
const pinned = (name: string, resolvedModelId: string): PinnedAgentInput => ({
  name,
  resolvedModelId,
  family: deriveFamily(resolvedModelId) ?? "",
});

describe("computeModelDiff", () => {
  it("a discovered NEW family (absent from snapshot) → exactly one newTier", () => {
    const snapshot = [row("claude-opus-4-8")]; // opus known; fable is new
    const discovered = [mi("claude-opus-4-8"), mi("claude-fable-5", "Fable 5")];
    const diff = computeModelDiff(discovered, snapshot, []);
    expect(diff.newTiers).toHaveLength(1);
    expect(diff.newTiers[0]).toMatchObject({
      kind: SURFACE_NEW_TIER,
      modelId: "claude-fable-5",
      family: "fable",
      displayName: "Fable 5",
    });
  });

  it("two simultaneous models of one new family → a SINGLE newTier", () => {
    const diff = computeModelDiff(
      [mi("claude-fable-5"), mi("claude-fable-6")],
      [],
      [],
    );
    expect(diff.newTiers.filter((t) => t.family === "fable")).toHaveLength(1);
  });

  it("a pinned agent with a STRICTLY-newer same-family catalog id → one pin-bump PROPOSAL", () => {
    // Pinned opus-4-8; catalog adds opus-4-10 → propose the bump.
    const diff = computeModelDiff(
      [mi("claude-opus-4-8"), mi("claude-opus-4-10")],
      [row("claude-opus-4-8")],
      [pinned("research", "claude-opus-4-8")],
    );
    expect(diff.pinBumps).toHaveLength(1);
    expect(diff.pinBumps[0]).toMatchObject({
      kind: SURFACE_PIN_BUMP,
      agent: "research",
      oldModelId: "claude-opus-4-8",
      newModelId: "claude-opus-4-10",
    });
  });

  it("a pinned agent already on the NEWEST id → ZERO pin-bumps", () => {
    const diff = computeModelDiff(
      [mi("claude-opus-4-10")],
      [row("claude-opus-4-10")],
      [pinned("research", "claude-opus-4-10")],
    );
    expect(diff.pinBumps).toHaveLength(0);
  });

  it("the pin-bump 'newer' is NUMERIC, not lexical (4-10 beats 4-8)", () => {
    // If the diff sorted lexically, "claude-opus-4-8" would rank above
    // "claude-opus-4-10" and produce NO bump (or the wrong one).
    const diff = computeModelDiff(
      [mi("claude-opus-4-8"), mi("claude-opus-4-9"), mi("claude-opus-4-10")],
      [row("claude-opus-4-8")],
      [pinned("a", "claude-opus-4-8")],
    );
    expect(diff.pinBumps[0]!.newModelId).toBe("claude-opus-4-10");
  });

  it("an @latest-track agent is simply NOT passed in as a pin-bump candidate (caller excludes it)", () => {
    // Wiring contract: getPinnedAgents() omits @latest agents. With none passed,
    // no pin-bumps regardless of newer catalog ids.
    const diff = computeModelDiff(
      [mi("claude-opus-4-10")],
      [row("claude-opus-4-8")],
      [], // @latest agent excluded by the caller
    );
    expect(diff.pinBumps).toHaveLength(0);
  });
});

describe("surfaceModelDiff — dedup + proposal-only", () => {
  function makeSurfaceDeps(
    store: ModelCatalogStore,
    posted: string[],
  ): SurfaceDeps {
    return {
      postToAdminClawdy: async (msg) => {
        posted.push(msg);
      },
      wasSurfaced: (kind, id) => store.wasSurfaced(kind, id),
      markSurfaced: (kind, id, at) => store.markSurfaced(kind, id, at),
      now: () => 1_000,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  }

  it("surfaces each non-deduped item once; a re-surface with no new discovery is silent", async () => {
    const store = new ModelCatalogStore(new Database(":memory:"));
    const posted: string[] = [];
    const deps = makeSurfaceDeps(store, posted);
    const diff = computeModelDiff([mi("claude-fable-5", "Fable 5")], [], []);

    await surfaceModelDiff(diff, deps);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("fable@latest");

    // Re-run the SAME diff — dedup gates it; nothing new posted.
    await surfaceModelDiff(diff, deps);
    expect(posted).toHaveLength(1);
  });

  it("dedup is INDEPENDENT per kind: surfacing id X as new-tier does NOT suppress a pin-bump for X", async () => {
    const store = new ModelCatalogStore(new Database(":memory:"));
    const posted: string[] = [];
    const deps = makeSurfaceDeps(store, posted);

    // 1. Surface claude-opus-4-10 as a new-tier (new family scenario simulated
    //    by an empty snapshot).
    await surfaceModelDiff(
      {
        newTiers: [
          {
            kind: SURFACE_NEW_TIER,
            modelId: "claude-opus-4-10",
            displayName: "Opus 4.10",
            family: "opus",
          },
        ],
        pinBumps: [],
      },
      deps,
    );
    expect(store.wasSurfaced(SURFACE_NEW_TIER, "claude-opus-4-10")).toBe(true);
    expect(store.wasSurfaced(SURFACE_PIN_BUMP, "claude-opus-4-10")).toBe(false);

    // 2. A pin-bump for the SAME id must still surface (per-kind dedup table).
    await surfaceModelDiff(
      {
        newTiers: [],
        pinBumps: [
          {
            kind: SURFACE_PIN_BUMP,
            agent: "research",
            oldModelId: "claude-opus-4-8",
            newModelId: "claude-opus-4-10",
          },
        ],
      },
      deps,
    );
    expect(posted).toHaveLength(2);
    expect(store.wasSurfaced(SURFACE_PIN_BUMP, "claude-opus-4-10")).toBe(true);
  });

  it("a failed post is NOT marked surfaced — the next tick retries", async () => {
    const store = new ModelCatalogStore(new Database(":memory:"));
    const deps: SurfaceDeps = {
      postToAdminClawdy: async () => {
        throw new Error("webhook down");
      },
      wasSurfaced: (kind, id) => store.wasSurfaced(kind, id),
      markSurfaced: (kind, id, at) => store.markSurfaced(kind, id, at),
      now: () => 1_000,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const diff = computeModelDiff([mi("claude-fable-5")], [], []);
    await expect(surfaceModelDiff(diff, deps)).resolves.toBeUndefined();
    // Not marked → a future tick can retry.
    expect(store.wasSurfaced(SURFACE_NEW_TIER, "claude-fable-5")).toBe(false);
  });
});
