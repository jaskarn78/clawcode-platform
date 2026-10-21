import { describe, it, expect } from "vitest";
import {
  resolveLatestModel,
  resolveExecutorModelForGates,
  compareModelVersion,
  parseModelVersion,
  LATEST_MODEL_MAX_AGE_MS,
  deriveFamily,
  type CatalogSnapshot,
  type CatalogModelRow,
} from "../model-resolver.js";

/**
 * Phase 999.98 D11 — pure `@latest` resolution + the version-compare helper.
 *
 * The load-bearing assertion is the NUMERIC version pick
 * (`claude-opus-4-10 > claude-opus-4-8`) — a lexical sort would invert it and
 * silently resolve `@latest` to the OLDER tier (the SC-5 bug this guards).
 */

// Phase 999.114 — `last_seen_at` defaults to a far-future-proof constant so
// these fixtures are never filtered by the OPTIONAL freshness bound (which only
// applies when a caller passes both `now` and `maxAgeMs`).
const row = (model_id: string, last_seen_at = 1_800_000_000_000): CatalogModelRow => ({
  model_id,
  display_name: model_id,
  last_seen_at,
  family: deriveFamily(model_id) ?? "",
});

const snapshot = (...ids: string[]): CatalogSnapshot => ids.map(row);

describe("parseModelVersion", () => {
  it("parses trailing numeric segments", () => {
    expect(parseModelVersion("claude-opus-4-8")).toEqual([4, 8]);
    expect(parseModelVersion("claude-opus-4-10")).toEqual([4, 10]);
    expect(parseModelVersion("claude-haiku-4-5")).toEqual([4, 5]);
  });

  it("returns [] for an id with no trailing numeric segment", () => {
    expect(parseModelVersion("claude-fable-5")).toEqual([5]);
    // Phase 999.158 — the Opus 5.5 pair. A minor-version bump adds a SEGMENT
    // rather than changing one, so `claude-opus-5-5` must parse to [5, 5] and
    // `claude-opus-5` to [5]; the compare below depends on the zero-padding
    // rule to rank them.
    expect(parseModelVersion("claude-opus-5-5")).toEqual([5, 5]);
    expect(parseModelVersion("claude-opus-5")).toEqual([5]);
    expect(parseModelVersion("claude-opus-latest")).toEqual([]);
    expect(parseModelVersion("weird-model")).toEqual([]);
  });
});

describe("compareModelVersion", () => {
  // THE load-bearing assertion — numeric, not lexical.
  it("ranks claude-opus-4-10 ABOVE claude-opus-4-8 (numeric, not lexical)", () => {
    expect(
      compareModelVersion("claude-opus-4-10", "claude-opus-4-8"),
    ).toBeGreaterThan(0);
    expect(
      compareModelVersion("claude-opus-4-8", "claude-opus-4-10"),
    ).toBeLessThan(0);
  });

  // Phase 999.158 — LOCKS the Opus 5.5 > Opus 5 ordering. This is the exact
  // pair the `opus` repin turns on: [5,5] vs [5] zero-pads to [5,5] vs [5,0],
  // so 5.5 wins on the second segment. If this ever inverts, `opus@latest`
  // silently floors the fleet back to Opus 5.
  it("ranks claude-opus-5-5 ABOVE claude-opus-5 ([5,5] > [5])", () => {
    expect(compareModelVersion("claude-opus-5-5", "claude-opus-5")).toBeGreaterThan(0);
    expect(compareModelVersion("claude-opus-5", "claude-opus-5-5")).toBeLessThan(0);
  });

  it("compares per-segment numerically with zero-padding", () => {
    expect(compareModelVersion("claude-opus-5-0", "claude-opus-4-99")).toBeGreaterThan(0);
    expect(compareModelVersion("claude-opus-4", "claude-opus-4-1")).toBeLessThan(0); // [4] vs [4,1]
  });

  it("equal versions compare to 0", () => {
    expect(compareModelVersion("claude-opus-4-8", "claude-opus-4-8")).toBe(0);
  });

  it("an unparseable version sorts BELOW any parseable one", () => {
    expect(compareModelVersion("claude-opus-4-8", "claude-opus-vNext")).toBeGreaterThan(0);
    expect(compareModelVersion("claude-opus-vNext", "claude-opus-4-8")).toBeLessThan(0);
    expect(compareModelVersion("a-vNext", "b-vNext")).toBe(0);
  });
});

describe("deriveFamily", () => {
  it("buckets ids by family substring", () => {
    expect(deriveFamily("claude-opus-4-8")).toBe("opus");
    expect(deriveFamily("claude-sonnet-4-6")).toBe("sonnet");
    expect(deriveFamily("claude-haiku-4-5")).toBe("haiku");
    expect(deriveFamily("claude-fable-5")).toBe("fable");
  });

  it("returns null for an unidentifiable family", () => {
    expect(deriveFamily("gpt-4o")).toBeNull();
  });
});

describe("resolveLatestModel", () => {
  it("cold/empty snapshot → falls back to the pinned MODEL_ALIAS_MAP alias", () => {
    expect(resolveLatestModel("opus@latest", snapshot())).toBe("claude-opus-5-5");
    expect(resolveLatestModel("sonnet@latest", snapshot())).toBe("claude-sonnet-5");
    expect(resolveLatestModel("haiku@latest", snapshot())).toBe("claude-haiku-4-5");
    expect(resolveLatestModel("fable@latest", snapshot())).toBe("claude-fable-5-1");
  });

  it("no rows for the family → pinned alias (other families present)", () => {
    const snap = snapshot("claude-haiku-4-5", "claude-sonnet-4-6");
    expect(resolveLatestModel("opus@latest", snap)).toBe("claude-opus-5-5");
  });

  it("picks the NUMERICALLY-newest family member (8 vs 10 → 10)", () => {
    // Fixtures live ABOVE the opus pin (now claude-opus-5-5) so the snapshot
    // winner isn't floored to the pin — the assertion under test is the
    // numeric (not lexical) pick: 5-10 beats 5-8.
    const snap = snapshot("claude-opus-5-8", "claude-opus-5-10");
    expect(resolveLatestModel("opus@latest", snap)).toBe("claude-opus-5-10");
  });

  it("never resolves OLDER than the pin (only old rows → pinned alias)", () => {
    // Pin is claude-opus-5-5; a snapshot whose only opus row is older (4-7).
    const snap = snapshot("claude-opus-4-7");
    expect(resolveLatestModel("opus@latest", snap)).toBe("claude-opus-5-5");
  });

  it("returns the snapshot winner when it is newer than the pin", () => {
    const snap = snapshot("claude-opus-5-9");
    expect(resolveLatestModel("opus@latest", snap)).toBe("claude-opus-5-9");
  });

  it("is PURE — same inputs, same output; does not mutate the snapshot", () => {
    const snap = snapshot("claude-opus-5-8", "claude-opus-5-10");
    const before = JSON.stringify(snap);
    const a = resolveLatestModel("opus@latest", snap);
    const b = resolveLatestModel("opus@latest", snap);
    expect(a).toBe(b);
    expect(JSON.stringify(snap)).toBe(before);
  });

  // ── Phase 999.158 — "does @latest actually mean latest?" ─────────────────
  // These are the operator's real ask, and they are NOT satisfied by asserting
  // the pin: `resolveLatestModel` grounds against `MODEL_ALIAS_MAP[family]` and
  // returns whichever of {snapshot winner, pin} parses newer, so once the pin
  // moved to 5.5 every "expect opus@latest → 5.5" assertion passes whether or
  // not the catalog ever learns the row. The only way to prove `@latest`
  // FOLLOWS the catalog is a snapshot row strictly newer than the pin.
  it("follows the catalog PAST the pin — a newer opus row beats claude-opus-5-5", () => {
    // Next minor (5.6) and next major (6) both beat the 5.5 pin.
    expect(resolveLatestModel("opus@latest", snapshot("claude-opus-5-6"))).toBe(
      "claude-opus-5-6",
    );
    expect(resolveLatestModel("opus@latest", snapshot("claude-opus-6"))).toBe(
      "claude-opus-6",
    );
  });

  it("floors at the pin when the catalog only knows the PREVIOUS opus (5 vs 5.5)", () => {
    // The live catalog state on 2026-09-22: a `claude-opus-5` row, no 5.5 row.
    // `@latest` must NOT walk backwards to Opus 5 just because it is the only
    // row present — this is the adjacency the 4-7 fixture above does not cover.
    expect(resolveLatestModel("opus@latest", snapshot("claude-opus-5"))).toBe(
      "claude-opus-5-5",
    );
  });

  it("a newer row that is STALE loses to the pin (freshness bound still applies)", () => {
    // 999.114's 30-day bound: a withdrawn model must not win `@latest` forever.
    const now = 1_800_000_000_000;
    const stale = snapshot("claude-opus-5-6").map((r) => ({
      ...r,
      last_seen_at: now - 31 * 24 * 60 * 60 * 1000,
    }));
    expect(
      resolveLatestModel("opus@latest", stale, { now, maxAgeMs: LATEST_MODEL_MAX_AGE_MS }),
    ).toBe("claude-opus-5-5");
  });

  it("ignores rows of OTHER families when picking the latest", () => {
    const snap = snapshot(
      "claude-opus-5-10",
      "claude-haiku-4-99", // a higher version, but a different family
    );
    expect(resolveLatestModel("opus@latest", snap)).toBe("claude-opus-5-10");
  });
});

describe("resolveExecutorModelForGates — @latest advisor-gate leak fix (D11)", () => {
  // The leak this guards: widening config.model to carry @latest means a raw
  // "fable@latest" reaches the advisor-OMIT gate. resolveModelId("fable@latest")
  // passes it through unchanged → advisorAllowedForExecutor would return true →
  // the SDK keeps the native advisor ON → the Fable per-turn 400. This helper
  // collapses @latest to the family's PINNED concrete id (family is all the gate
  // needs) WITHOUT a snapshot.
  it("collapses fable@latest → claude-fable-5-1 (so the advisor gate sees the family)", () => {
    expect(resolveExecutorModelForGates("fable@latest")).toBe("claude-fable-5-1");
  });

  it("collapses opus@latest → claude-opus-5-5 (pinned alias, no snapshot)", () => {
    expect(resolveExecutorModelForGates("opus@latest")).toBe("claude-opus-5-5");
  });

  it("passes a plain alias through resolveModelId", () => {
    expect(resolveExecutorModelForGates("fable")).toBe("claude-fable-5-1");
    expect(resolveExecutorModelForGates("opus")).toBe("claude-opus-5-5");
  });

  it("passes a concrete id through unchanged", () => {
    // A CONCRETE id passes through untouched — it is not an alias, so the
    // Fable 5.1 repin must NOT rewrite it. (Guards the blanket-rename hazard:
    // "claude-fable-5" is a legitimate standalone id, not just the old pin.)
    expect(resolveExecutorModelForGates("claude-fable-5")).toBe("claude-fable-5");
    expect(resolveExecutorModelForGates("claude-opus-4-10")).toBe("claude-opus-4-10");
  });
});
