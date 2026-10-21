/**
 * Model catalog — single-source-of-truth regression guards.
 *
 * The catalog (`src/shared/model-catalog.ts`) is the ONE place model identity
 * lives; every consumer below DERIVES from it. These tests pin the derived
 * values so an accidental catalog edit (or a broken derivation) is caught, and
 * assert the cross-consumer invariants the type system can't (e.g. the OpenAI
 * tier map's dated haiku snapshot vs the executor's undated alias).
 */

import { describe, it, expect } from "vitest";

import {
  MODEL_ALIAS_CATALOG,
  MODEL_FAMILY_CATALOG,
  MODEL_ALIAS_MAP,
  MODEL_ALIASES,
  MODEL_FAMILIES,
  type ModelAliasSpec,
} from "../model-catalog.js";
import { TIER_MODEL_MAP } from "../../openai/types.js";
import { MODEL_PRICING } from "../../usage/pricing.js";
import { advisorAllowedForExecutor, resolveModelId } from "../../manager/model-resolver.js";

describe("model-catalog — alias → id map (derived)", () => {
  it("exposes exactly the expected alias→id pins", () => {
    // 999.158 — refreshed to the FULL current catalog. This assertion had been
    // stale since 999.114 (it still expected `fable: claude-fable-5` and was
    // missing every escape-hatch alias), so it was failing on master before the
    // Opus 5.5 repin and could not catch drift. Exhaustive by design: a new
    // alias must be added here deliberately.
    expect(MODEL_ALIAS_MAP).toEqual({
      sonnet: "claude-sonnet-5",
      "sonnet-4-6": "claude-sonnet-4-6",
      "sonnet-4-5": "claude-sonnet-4-5-20250929",
      opus: "claude-opus-5-5",
      "opus-5": "claude-opus-5",
      "opus-4-8": "claude-opus-4-8",
      "opus-4-7": "claude-opus-4-7",
      "opus-4-6": "claude-opus-4-6",
      "opus-4-5": "claude-opus-4-5-20251101",
      haiku: "claude-haiku-4-5",
      fable: "claude-fable-5-1",
      "fable-5": "claude-fable-5",
    });
  });

  it("resolveModelId agrees with the catalog for every alias", () => {
    for (const alias of MODEL_ALIASES) {
      expect(resolveModelId(alias)).toBe(MODEL_ALIAS_CATALOG[alias].id);
    }
  });

  it("MODEL_ALIASES lists exactly the catalog keys", () => {
    expect([...MODEL_ALIASES].sort()).toEqual(Object.keys(MODEL_ALIAS_CATALOG).sort());
  });

  it("MODEL_FAMILIES lists exactly the family-catalog keys", () => {
    expect([...MODEL_FAMILIES].sort()).toEqual(Object.keys(MODEL_FAMILY_CATALOG).sort());
    // Every alias's family exists in the family catalog.
    for (const alias of MODEL_ALIASES) {
      expect(MODEL_FAMILIES).toContain(MODEL_ALIAS_CATALOG[alias].family);
    }
  });
});

describe("model-catalog — OpenAI tier map (derived, dated-haiku preserved)", () => {
  it("sonnet/opus follow the executor id; haiku keeps its dated snapshot via tierId", () => {
    expect(TIER_MODEL_MAP.sonnet).toBe("claude-sonnet-5");
    expect(TIER_MODEL_MAP.sonnet).toBe(MODEL_ALIAS_MAP.sonnet);
    expect(TIER_MODEL_MAP.opus).toBe("claude-opus-5-5");
    expect(TIER_MODEL_MAP.opus).toBe(MODEL_ALIAS_MAP.opus);
    // The executor uses the undated alias; the tier map pins the dated snapshot.
    expect(TIER_MODEL_MAP.haiku).toBe("claude-haiku-4-5-20251001");
    expect(MODEL_ALIAS_MAP.haiku).toBe("claude-haiku-4-5");
  });

  it("each tier value equals the catalog's tierId ?? id", () => {
    for (const [tier, id] of Object.entries(TIER_MODEL_MAP)) {
      const spec: ModelAliasSpec = MODEL_ALIAS_CATALOG[tier as keyof typeof MODEL_ALIAS_CATALOG];
      expect(id).toBe(spec.tierId ?? spec.id);
    }
  });
});

describe("model-catalog — pricing (derived Anthropic rows)", () => {
  it("MODEL_PRICING carries every family's catalog pricing", () => {
    for (const family of MODEL_FAMILIES) {
      expect(MODEL_PRICING[family]).toEqual(MODEL_FAMILY_CATALOG[family].pricing);
    }
  });

  it("preserves the known Anthropic rates", () => {
    // 999.158 — the sonnet row had been stale since the Sonnet 5 repin dropped
    // the rate to $2/$10 (it still asserted the pre-Sonnet-5 $3/$15), so this
    // was failing on master before this phase. Rates verified against the
    // Anthropic pricing page 2026-09-22.
    expect(MODEL_PRICING.sonnet).toEqual({ inputPerMillion: 2.0, outputPerMillion: 10.0 });
    // Opus family rate tracks the current flagship — Opus 5.5 at $4/$20,
    // CHEAPER than Opus 5's $5/$25, which every superseded opus alias now
    // carries as an explicit per-alias override.
    expect(MODEL_PRICING.opus).toEqual({ inputPerMillion: 4.0, outputPerMillion: 20.0 });
    expect(MODEL_PRICING.haiku).toEqual({ inputPerMillion: 1.0, outputPerMillion: 5.0 });
    expect(MODEL_PRICING.fable).toEqual({ inputPerMillion: 10.0, outputPerMillion: 50.0 });
  });
});

describe("model-catalog — advisor compatibility (derived)", () => {
  it("every family is advisor-compatible; pairing is decided by advisorRank (2026-08-28)", () => {
    for (const alias of MODEL_ALIASES) {
      const spec = MODEL_ALIAS_CATALOG[alias];
      const expected = MODEL_FAMILY_CATALOG[spec.family].advisorCompatible;
      expect(advisorAllowedForExecutor(spec.id)).toBe(expected);
    }
    expect(advisorAllowedForExecutor("claude-fable-5")).toBe(true);
    expect(advisorAllowedForExecutor("claude-opus-4-8")).toBe(true);
    // Ranks are strictly ordered by capability tier: haiku < sonnet < opus < fable.
    const r = (f: keyof typeof MODEL_FAMILY_CATALOG) => MODEL_FAMILY_CATALOG[f].advisorRank;
    expect(r("haiku")).toBeLessThan(r("sonnet"));
    expect(r("sonnet")).toBeLessThan(r("opus"));
    expect(r("opus")).toBeLessThan(r("fable"));
  });

  it("a non-Claude id defaults to advisor-allowed (unknown family)", () => {
    expect(advisorAllowedForExecutor("gpt-5")).toBe(true);
  });
});
