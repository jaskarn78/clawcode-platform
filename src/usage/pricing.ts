/**
 * Model pricing map and cost estimation for the Claude + OpenAI model
 * families. Prices are per million tokens (input/output).
 *
 * Last verified: 2026-05-19
 */

import {
  MODEL_ALIAS_CATALOG,
  MODEL_FAMILY_CATALOG,
  type ModelAliasSpec,
} from "../shared/model-catalog.js";

/** Pricing entry for a single model (cost per million tokens). */
export type ModelPricing = {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
};

/**
 * Hardcoded price-per-token map for Claude + OpenAI models.
 * Key is the model name as reported by the backend.
 *
 * Anthropic entries — pricing snapshot 2026-04-10 (re-confirmed
 * 2026-05-19, unchanged).
 *
 * OpenAI entries — pricing snapshot 2026-05-19 — verify quarterly per
 * Phase 138 D1.
 * Source: https://openai.com/api/pricing (executor: confirm at write
 * time; raise a researcher_todo if the URL / page format has drifted).
 * Rates below are USD per 1M tokens, standard (non-batch, non-cached)
 * tier. `o3` reflects the post-2025 reasoning-model price cut.
 */
/**
 * Anthropic per-family rates, DERIVED from the model catalog (the single source
 * of truth for pricing). Keyed by family name; `lookupPricing`'s length-sorted
 * substring matcher maps a resolved id like `claude-sonnet-5` → `sonnet` (and
 * `claude-fable-5` → `fable`). A family added to the catalog gets a pricing key
 * here automatically.
 */
const ANTHROPIC_FAMILY_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MODEL_FAMILY_CATALOG).map(([family, spec]) => [
      family,
      Object.freeze({
        inputPerMillion: spec.pricing.inputPerMillion,
        outputPerMillion: spec.pricing.outputPerMillion,
      }),
    ]),
  ),
);

/**
 * Phase 999.114 — EXACT per-MODEL-ID rates, derived from the alias catalog.
 *
 * Anthropic prices per model, not per family: Claude Sonnet 5 is $2/$10 while
 * Sonnet 4.6 and 4.5 are $3/$15. Now that historical pins are selectable, a
 * family-only map would bill a Sonnet 4.5 agent at the Sonnet 5 rate.
 *
 * These rows are keyed by the RESOLVED model id (`claude-sonnet-4-6`), which
 * `lookupPricing` matches EXACTLY before it ever reaches the substring scan —
 * so an exact row always beats the family fallback. An alias without its own
 * `pricing` override inherits the family rate, which keeps the two in lockstep
 * for the (common) case where a whole family shares one rate.
 */
const ANTHROPIC_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze(
  Object.fromEntries(
    (Object.values(MODEL_ALIAS_CATALOG) as readonly ModelAliasSpec[]).map((spec) => [
      spec.id,
      Object.freeze({
        inputPerMillion:
          spec.pricing?.inputPerMillion ??
          MODEL_FAMILY_CATALOG[spec.family].pricing.inputPerMillion,
        outputPerMillion:
          spec.pricing?.outputPerMillion ??
          MODEL_FAMILY_CATALOG[spec.family].pricing.outputPerMillion,
      }),
    ]),
  ),
);

/**
 * Family rows FIRST, exact-id rows second: on a key collision the exact id must
 * win, and `Object.freeze({...a, ...b})` gives `b` precedence. (No collision is
 * possible today — a family key is a bare word, an id is `claude-*` — but the
 * ordering makes the intent explicit rather than incidental.)
 *
 * The family rows remain load-bearing as the FALLBACK for any id we have no
 * exact row for — most importantly a model the 6-hourly monitor discovers that
 * this build has never heard of. Such an id substring-matches its family and
 * bills at the family's current-flagship rate. That is deliberately a rough
 * estimate rather than a silent $0: `estimateCost` returns 0 for an unmatched
 * model, and a brand-new model reporting zero cost is a far worse failure than
 * one reporting its family's rate.
 */
const ANTHROPIC_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  ...ANTHROPIC_FAMILY_PRICING,
  ...ANTHROPIC_MODEL_PRICING,
});

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  ...ANTHROPIC_PRICING,
  // --- OpenAI — pricing snapshot 2026-05-19, verify quarterly per D1 ---
  "gpt-5-codex": Object.freeze({ inputPerMillion: 1.25, outputPerMillion: 10.0 }),
  o3: Object.freeze({ inputPerMillion: 2.0, outputPerMillion: 8.0 }),
  "o3-mini": Object.freeze({ inputPerMillion: 1.1, outputPerMillion: 4.4 }),
});

/**
 * Estimate the cost of a model interaction in USD.
 *
 * @param model - Model name (e.g., "haiku", "sonnet", "opus")
 * @param tokensIn - Number of input tokens
 * @param tokensOut - Number of output tokens
 * @returns Estimated cost in USD, or 0 if model is unknown
 */
export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = lookupPricing(model);
  if (!pricing) return 0;

  const inputCost = (tokensIn / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (tokensOut / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
}

/**
 * Keys sorted by length descending — used for the substring fallback so
 * a longer, more-specific key wins before a shorter one it contains.
 *
 * Phase 138 T-02 collision fix: with both `"o3"` and `"o3-mini"` in the
 * map, a model string like `"openai/o3-mini-2026"` must resolve to
 * `o3-mini` (length 7), NOT `o3` (length 2). Object key-iteration order
 * is insertion order — without this sort, `"o3"` (inserted first) would
 * win the `.includes` race. Computed once at module load.
 */
const PRICING_KEYS_BY_LENGTH_DESC: readonly string[] = Object.freeze(
  Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length),
);

/**
 * Look up pricing by exact key first, then by substring match
 * (e.g. "claude-sonnet-4-5" → sonnet). The substring scan iterates
 * keys in length-descending order so the most-specific key wins
 * (Phase 138 T-02 — `o3` vs `o3-mini` collision regression).
 *
 * Exported for direct unit testing of the matcher (Phase 138 T-02).
 */
export function lookupPricing(model: string): ModelPricing | undefined {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;

  const lower = model.toLowerCase();
  for (const key of PRICING_KEYS_BY_LENGTH_DESC) {
    if (lower.includes(key)) return MODEL_PRICING[key];
  }
  return undefined;
}
