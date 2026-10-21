/**
 * Single source of truth for Claude model IDENTITY — the alias→id pins, the
 * family each alias belongs to, and the per-family pricing + advisor-compat
 * facts. Everything downstream DERIVES from the two catalogs below:
 *
 *   - `MODEL_ALIAS_MAP` + `MODEL_FAMILIES` + `advisorAllowedForExecutor`
 *     (src/manager/model-resolver.ts)
 *   - `TIER_MODEL_MAP` (src/openai/types.ts)
 *   - the Anthropic rows of `MODEL_PRICING` (src/usage/pricing.ts)
 *   - the `modelSchema` enum tuple + every narrow `model` union
 *     (src/config/schema.ts, src/shared/types.ts, src/manager/types.ts,
 *      src/tasks/task-manager.ts)
 *
 * To add or bump a Claude model, edit `MODEL_ALIAS_CATALOG` (and
 * `MODEL_FAMILY_CATALOG` for a genuinely new family) + the `MODEL_ALIASES`
 * tuple — the type-level guards below fail compilation if the tuple drifts from
 * the catalog keys.
 *
 * What is DELIBERATELY *not* here (policy, not identity): which models a feature
 * is allowed to use — the default `allowedModels` picker, the dream/optimizer
 * small-model enums, the dashboard pickers, and which aliases are exposed as
 * OpenAI tier tokens. Those are per-feature decisions that stay at their sites.
 *
 * Leaf module — imports NOTHING from the project so config/manager/usage/openai
 * can all import it without a cycle.
 */

/** Per-family economic + capability facts (shared by every alias in the family). */
export type ModelFamilySpec = {
  readonly pricing: {
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
  };
  /**
   * Whether the native advisor tool may pair with an executor of this family.
   * `false` for Fable — a Fable executor 400s when the default (Opus) advisor is
   * wired in-request (see `advisorAllowedForExecutor` in model-resolver.ts).
   */
  readonly advisorCompatible: boolean;
  /**
   * 2026-08-28 — capability rank for native-advisor PAIRING. The API rejects
   * an advisor less capable than the executor (400 on EVERY request, not just
   * consults: `tools.N.model: 'claude-opus-4-8' cannot be used as an advisor
   * when the request model is 'claude-opus-5'`). Rank is by family, not by
   * version: the API's own example pairs executor claude-sonnet-5 with advisor
   * claude-opus-4-7. Verified 2026-08-28 on the pinned 2.1.210 binary:
   * fable→fable consults cleanly; fable→opus 400s.
   */
  readonly advisorRank: number;
  /**
   * Phase 999.114 — the family REJECTS a thinking-disabled turn (400), so an
   * effort-`off` zero budget must be mapped to `null` (model default) instead.
   * True for Fable, whose thinking is adaptive-ALWAYS-ON.
   *
   * This was previously a literal `currentModel === "claude-fable-5"` test at
   * the two `setMaxThinkingTokens` sites in persistent-session-handle.ts — which
   * would have SILENTLY stopped covering Fable the moment the alias repinned to
   * `claude-fable-5-1`, on the exact model that needs it most. Keyed by family
   * here so it cannot decay again.
   */
  readonly requiresThinking: boolean;
  /**
   * Phase 999.114 — MINIMUM stream-stall timeout (ms) for this family: how long
   * a turn may emit no useful delta (text / json / thinking) before the Phase
   * 127 watchdog aborts it. Omitted === use the fleet baseline.
   *
   * This is a FLOOR, not an override. An EXPLICIT operator value (per-agent
   * `streamStallTimeoutMs`, or `defaults.modelOverrides.<family>`) always wins
   * exactly as written — including a LOWER one, because fast dead-stream
   * detection is a legitimate choice. The floor only lifts the DEFAULT.
   *
   * Why it must be a floor and not a fallback: `defaults.streamStallTimeoutMs`
   * is `.default(180_000)`, so it is ALWAYS populated (verified:
   * `defaultsSchema.parse({}).streamStallTimeoutMs === 180000`). A family value
   * placed BELOW it in a `??` cascade would be unreachable — the exact bug that
   * made `defaults.modelOverrides.fable` dead for the agent it was written for.
   */
  readonly minStreamStallTimeoutMs?: number;
};

export const MODEL_FAMILY_CATALOG = Object.freeze({
  // 2026-09-01 CORRECTION ($3/$15 -> $2/$10): Sonnet 5 is $2/$10. The $2/$10 rate
  // shipped as "introductory pricing through 2026-08-31"; Anthropic has since
  // confirmed it is the STANDARD price and the scheduled 09-01 increase to $3/$15
  // will NOT occur (models overview + pricing page, re-verified 2026-09-01). The
  // stale $3/$15 over-reported every Sonnet 5 turn by 50%. Sonnet 4.6/4.5 really
  // ARE $3/$15 and now carry per-alias overrides below.
  sonnet: { pricing: { inputPerMillion: 2.0, outputPerMillion: 10.0 }, advisorCompatible: true, advisorRank: 1, requiresThinking: false },
  // Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 are all $5 in / $25 out per MTok (Anthropic
  // models overview). The prior $15/$75 was the retired Opus-3/4.1-era rate and
  // over-estimated every Opus turn ~3×; corrected here for accurate cost
  // reporting on the `opus` family (personal / state-contract usage lines drop).
  // Phase 999.158 — the family rate tracks the CURRENT flagship, which is now
  // Opus 5.5 at $4/$20 (Anthropic pricing page, verified 2026-09-22). Opus
  // 4.5-5 were all $5/$25, so every superseded opus alias now carries an
  // explicit `pricing` override at the old rate — the same shape Sonnet 5 left
  // behind on `sonnet-4-6`/`sonnet-4-5`. Keeping the flagship rate HERE is what
  // makes a future opus the monitor discovers (with no alias row of its own)
  // fall back to a sane current rate instead of an obsolete one.
  //
  // 🚨 `requiresThinking: true` — Opus 5.5 REJECTS a disabled-thinking turn:
  // `thinking: {"type":"disabled"}` returns 400 `"thinking.type.disabled" is
  // not supported for this model.` (Opus 5.5 migration guide, breaking change
  // 1). Without this flag `/clawcode-effort off` maps to `setMaxThinkingTokens(0)`
  // and 400s EVERY turn on the 7 agents running the `opus` pin — the exact
  // failure `guardEffortBudgetForModel` exists to prevent, and the same trap
  // 999.114 hit when `fable` repinned to an always-on-thinking model.
  // ⚠ TRADEOFF: the flag is per-FAMILY, so the superseded opus pins (which DO
  // tolerate disabled thinking) also stop honouring `effort: off` — they fall
  // back to model-default thinking instead. That degrades a cost optimisation;
  // the alternative degrades into a per-turn 400. A per-ALIAS flag would serve
  // both, and is the clean follow-up if `effort: off` on a legacy pin matters.
  opus: { pricing: { inputPerMillion: 4.0, outputPerMillion: 20.0 }, advisorCompatible: true, advisorRank: 2, requiresThinking: true },
  // 2026-09-01 CORRECTION ($0.25/$1.25 -> $1/$5): $0.25/$1.25 was the RETIRED
  // Haiku 3.5-era rate and under-reported every Haiku 4.5 turn 4x. Haiku 4.5 is
  // $1 in / $5 out (Anthropic pricing page, verified 2026-09-01).
  haiku: { pricing: { inputPerMillion: 1.0, outputPerMillion: 5.0 }, advisorCompatible: true, advisorRank: 0, requiresThinking: false },
  // Fable 5 — top tier above Opus. $10 in / $50 out per MTok. 2026-08-28: advisor-
  // COMPATIBLE when paired with a Fable advisor (verified on 2.1.210); the old
  // `false` came from pairing it with the default Opus advisor, which the API
  // rejects. Pairing is now checked by rank (`advisorPairingValid`).
  // 🚨 `minStreamStallTimeoutMs` — Fable is the SLOWEST family in the lineup
  // (Anthropic's own comparative-latency row: "Slower"), runs adaptive thinking
  // that is ALWAYS ON, and defaults to `high` effort — so its time-to-FIRST
  // stream event is routinely the longest of any model. The fleet 180s baseline
  // was calibrated for sonnet/opus and produced a real incident: on 2026-08-21
  // fin-research (on fable) was aborted FOUR times at exactly 180.0s with ZERO
  // assistant output and `inFlightTools: []` — the watchdog killed turns that
  // were merely slow to first token. A rerun landed its answer at ~171s.
  // 600_000 is the value the operator arrived at empirically for that agent;
  // it is now the family floor so every fable agent gets it with no yaml edit.
  fable: { pricing: { inputPerMillion: 10.0, outputPerMillion: 50.0 }, advisorCompatible: true, advisorRank: 3, requiresThinking: true, minStreamStallTimeoutMs: 600_000 },
} as const) satisfies Readonly<Record<string, ModelFamilySpec>>;

export type ModelFamily = keyof typeof MODEL_FAMILY_CATALOG;

/** Per-alias resolution to a concrete Claude model id + its family. */
export type ModelAliasSpec = {
  /** Executor/SDK model id the alias pins to. */
  readonly id: string;
  readonly family: ModelFamily;
  /** Exposed as an OpenAI-compatible endpoint tier token (`TIER_MODEL_MAP`). */
  readonly tier?: boolean;
  /**
   * Overrides `id` for the OpenAI tier map ONLY — a dated snapshot pin the
   * endpoint records for cost attribution while the executor uses the undated
   * alias. Currently only `haiku`.
   */
  readonly tierId?: string;
  /**
   * Phase 999.114 — human label for the Discord `/clawcode-model` picker and
   * any other operator-facing surface. Kept HERE so a model added to the
   * catalog is automatically presentable; the picker never hardcodes names.
   */
  readonly displayName: string;
  /**
   * Phase 999.114 — per-MODEL rate override. Anthropic prices per model, not
   * per family: Sonnet 5 is $2/$10 while Sonnet 4.6 and 4.5 are $3/$15. When
   * omitted the alias inherits `MODEL_FAMILY_CATALOG[family].pricing`, which is
   * pinned to the family's CURRENT flagship — so a model we have no row for yet
   * (a future release the monitor discovers) falls back to a sane family rate
   * rather than to zero.
   */
  readonly pricing?: {
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
  };
  /**
   * Phase 999.114 — cache-READ multiplier against base input price. 0.1x for
   * every model EXCEPT Fable 5.1 / Mythos 5.1, which read cache at 0.025x
   * (Anthropic pricing page, verified 2026-09-01). Omitted === 0.1x.
   */
  readonly cacheReadMultiplier?: number;
  /**
   * Phase 999.114 — `true` for a superseded pin kept selectable for rollback /
   * A-B comparison. Drives ordering + a "legacy" hint in the picker; does NOT
   * restrict selection. The family's current flagship is the alias WITHOUT this.
   */
  readonly legacy?: boolean;
  /**
   * Phase 999.159 — MINIMUM Claude Code CLI version this model needs, as
   * `MAJOR.MINOR.PATCH`. Anthropic rejects the model outright below it
   * (`400 ... does not support this model; version 2.1.280 or newer is
   * required`), so it is a property OF THE MODEL and belongs next to the model.
   *
   * 🚨 This field exists because the requirement was twice recorded only as a
   * code comment and twice missed, taking the whole fleet down
   * (2026-09-01 Fable 5.1, 2026-09-22 Opus 5.5 — see `cli-version.ts`). The
   * daemon's boot guard reads it and refuses to start on a binary that cannot
   * serve the configured models, naming the offending model and the remediation.
   *
   * Set it whenever a repin requires a newer binary than the fleet runs today.
   * Omitted === no known floor (every CLI the fleet would plausibly run serves it).
   */
  readonly minCliVersion?: string;
};

export const MODEL_ALIAS_CATALOG = Object.freeze({
  // ────────────────────────── sonnet ──────────────────────────
  // Sonnet 5 (2026-06) — the `sonnet` pin. $2/$10 (see the family-rate note).
  sonnet: {
    id: "claude-sonnet-5",
    family: "sonnet",
    tier: true,
    displayName: "Claude Sonnet 5",
  },
  // Superseded pins, kept selectable for rollback + A-B comparison. Both are
  // still ACTIVE upstream (retirement not sooner than 2027-02-17 / 2026-09-29)
  // and both are $3/$15 — the pre-Sonnet-5 rate — hence the pricing overrides.
  "sonnet-4-6": {
    id: "claude-sonnet-4-6",
    family: "sonnet",
    displayName: "Claude Sonnet 4.6",
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    legacy: true,
  },
  // Pre-4.6 generation → the id carries a snapshot DATE. The undated
  // `claude-sonnet-4-5` is a convenience ALIAS upstream; we pin the dated
  // snapshot so the running model can never shift under us.
  "sonnet-4-5": {
    id: "claude-sonnet-4-5-20250929",
    family: "sonnet",
    displayName: "Claude Sonnet 4.5",
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    legacy: true,
  },

  // ─────────────────────────── opus ───────────────────────────
  // Opus 5.5 (2026-09) — replaces Opus 5 as the `opus` pin. $4/$20 (CHEAPER
  // than Opus 5's $5/$25), 1M context, 128K output, thinking ALWAYS ON, and a
  // default effort of `medium` where Opus 5's was `high`.
  //
  // ⚠ REPIN BLAST RADIUS: every agent on `model: opus` moves to Opus 5.5 on its
  // next spawn — no yaml edit. Rollback for one agent = `model: opus-5`.
  // ⚠ The native-advisor pin `ADVISOR_MODEL_ALIASES.opus` MUST move in lockstep
  // (model-resolver.ts) — see the lockstep note there.
  // ⚠ Requires CLI >= 2.1.280 — now ENFORCED by `minCliVersion` below, not by
  // this comment. On the 2.1.257 prod pin an explicit `--model claude-opus-5-5`
  // returned `400 ... does not support this model; version 2.1.280 or newer is
  // required` on EVERY turn (2026-09-22 outage). The daemon boot guard fails
  // loud (naming the SDK bump that ships a >= 2.1.280 binary) rather than
  // letting it reach the wire.
  // ⚠ Effort default moved high → medium upstream. ClawCode always sends an
  // explicit budget via `setMaxThinkingTokens`, so the fleet is insulated from
  // the default — but an operator comparing quality should know it moved.
  opus: {
    id: "claude-opus-5-5",
    family: "opus",
    tier: true,
    displayName: "Claude Opus 5.5",
    // Opus 5.5 reads cache at 0.05x base input ($0.20/MTok); every other model
    // except Fable 5.1 (0.025x) is 0.1x.
    cacheReadMultiplier: 0.05,
    // The 2026-09-22 outage floor, measured from the 400 body itself.
    minCliVersion: "2.1.280",
  },
  // Opus 5 — superseded pin, kept selectable for rollback + A-B comparison.
  // Still ACTIVE upstream (retirement not sooner than 2027-09-22 for 5.5; Opus
  // 5 is listed as legacy-but-available). $5/$25 — the pre-5.5 rate.
  "opus-5": {
    id: "claude-opus-5",
    family: "opus",
    displayName: "Claude Opus 5",
    pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
    legacy: true,
  },
  // Every Opus 4.5–5 is $5/$25 — the pre-Opus-5.5 rate, so each overrides the
  // family rate (which now tracks 5.5's cheaper $4/$20).
  "opus-4-8": {
    id: "claude-opus-4-8",
    family: "opus",
    displayName: "Claude Opus 4.8",
    pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
    legacy: true,
  },
  "opus-4-7": {
    id: "claude-opus-4-7",
    family: "opus",
    displayName: "Claude Opus 4.7",
    pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
    legacy: true,
  },
  "opus-4-6": {
    id: "claude-opus-4-6",
    family: "opus",
    displayName: "Claude Opus 4.6",
    pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
    legacy: true,
  },
  // Pre-4.6 generation → dated snapshot id (see `sonnet-4-5`).
  "opus-4-5": {
    id: "claude-opus-4-5-20251101",
    family: "opus",
    displayName: "Claude Opus 4.5",
    pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
    legacy: true,
  },

  // ────────────────────────── haiku ───────────────────────────
  // The executor uses the undated `claude-haiku-4-5`; the OpenAI tier map pins
  // the dated snapshot via `tierId` (preserved from the pre-catalog map).
  haiku: {
    id: "claude-haiku-4-5",
    family: "haiku",
    tier: true,
    tierId: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
  },

  // ────────────────────────── fable ───────────────────────────
  // Fable 5.1 (2026-09) — replaces Fable 5 as the `fable` pin. $10/$50, 1M
  // context, 128K output, adaptive thinking ALWAYS ON, default effort `high`
  // (Anthropic models overview, verified 2026-09-01).
  //
  // ⚠ REPIN BLAST RADIUS: every agent on `model: fable` moves to Fable 5.1 on
  // its next spawn — no yaml edit. Rollback for one agent = `model: fable-5`.
  // ⚠ The native-advisor pin `ADVISOR_MODEL_ALIASES.fable` MUST move in
  // lockstep (model-resolver.ts): `advisorPairingValid` compares FAMILY rank
  // only, so a 5.1 executor paired with a 5.0 advisor passes our local check
  // while the API may still reject it — a 400 on EVERY request, not just
  // consults. Same class as the 999.92 / Opus 5 lockstep landmines.
  fable: {
    id: "claude-fable-5-1",
    family: "fable",
    displayName: "Claude Fable 5.1",
    // Fable 5.1 reads cache at 0.025x base input; every other model is 0.1x.
    cacheReadMultiplier: 0.025,
    // The 2026-09-01 outage floor — the FIRST instance of the bug class the
    // 09-22 Opus 5.5 outage then repeated. Recorded here so it is enforced
    // rather than remembered.
    minCliVersion: "2.1.257",
  },
  // Fable 5 — superseded pin, still ACTIVE upstream (retirement not sooner
  // than 2027-06-09). Same $10/$50 base, but the standard 0.1x cache read.
  "fable-5": {
    id: "claude-fable-5",
    family: "fable",
    displayName: "Claude Fable 5",
    legacy: true,
  },
} as const) satisfies Readonly<Record<string, ModelAliasSpec>>;

export type ModelAlias = keyof typeof MODEL_ALIAS_CATALOG;

/**
 * The accepted config-alias TUPLE, listed explicitly as `as const` (NOT
 * `Object.keys(...)`) so `z.enum([...MODEL_ALIASES, ...])` narrows to string
 * literals — a `string[]` spread would degrade `z.infer` to `string` and break
 * the config layer's literal-narrowing. The `_AliasesMatchCatalog` guard below
 * fails compilation if this tuple drifts from `MODEL_ALIAS_CATALOG`.
 */
export const MODEL_ALIASES = [
  "sonnet",
  "sonnet-4-6",
  "sonnet-4-5",
  "opus",
  "opus-5",
  "opus-4-8",
  "opus-4-7",
  "opus-4-6",
  "opus-4-5",
  "haiku",
  "fable",
  "fable-5",
] as const;

/**
 * Phase 999.114 — the DEFAULT `/clawcode-model` picker allowlist: every alias in
 * the catalog. This REVERSES the Phase 999.98 "Category E" decision that kept
 * the picker at 3 models (haiku|sonnet|opus) and treated Fable + the escape
 * hatches as hand-pinned, config-only values — the operator has since asked for
 * every tier and every historical pin to be selectable from Discord.
 *
 * ⚠ COST SURFACE: this puts Fable ($10 in / $50 out per MTok — 5x Sonnet 5 in,
 * 5x out) one click away in every bound channel. Per-agent `allowedModels` in
 * clawcode.yaml still narrows the list for any agent that should not offer it,
 * and the `ModelNotAllowedError` path still enforces it server-side.
 *
 * Ordering is the catalog's own declaration order — current pin first within
 * each family, superseded pins after it — which is the order the picker renders.
 * Discord caps a select menu at 25 options; this list must stay under that.
 */
export const DEFAULT_PICKER_MODELS = Object.freeze([
  ...MODEL_ALIASES,
  // Derived from MODEL_FAMILY_CATALOG (declared above) rather than
  // MODEL_FAMILIES (declared below) — the latter is a temporal dead zone here.
  ...(Object.keys(MODEL_FAMILY_CATALOG).map(
    (f) => `${f}@latest`,
  ) as LatestModelAlias[]),
]) as readonly ConfigModel[];

/**
 * Phase 999.114 — is `id` a model id we are willing to SELECT or auto-follow?
 *
 * The discovered catalog is not clean. Read live from prod 2026-09-01, it holds
 * CLI selector tokens (`opus[1m]`, `sonnet[1m]`, `claude-fable-5[1m]`) and bare
 * family names (`sonnet`, `haiku`) alongside real API ids, because the monitor
 * upserts whatever the SDK init result lists and `deriveFamily` happily buckets
 * all of them by substring.
 *
 * Both the `<family>@latest` resolver and the Discord picker filter through
 * THIS ONE predicate, so they can never disagree about what a family's "latest"
 * model is. Requires the real API id shape — `claude-<family>-<version...>` —
 * which rejects every polluted row above.
 *
 * (Today those rows happen to lose the version compare anyway, because an
 * unparseable version sorts below a parseable one. That is luck, not a
 * guarantee: `opus[1m]` is one upstream naming change away from parsing.)
 */
export function isSelectableModelId(id: string): boolean {
  return /^claude-[a-z]+(?:-\d+)+$/.test(id);
}

/**
 * Phase 999.114 — the family's minimum stream-stall timeout, or 0 when the
 * family has no floor and the fleet baseline stands alone.
 *
 * An accessor rather than a raw index because `MODEL_FAMILY_CATALOG` is `as
 * const`: each entry narrows to its own literal shape, so the OPTIONAL
 * `minStreamStallTimeoutMs` is absent from the type of every family that omits
 * it and a direct index does not type-check. Reading through the declared
 * `ModelFamilySpec` here keeps that cast in ONE place.
 */
export function familyStallFloorMs(family: ModelFamily): number {
  const spec: ModelFamilySpec = MODEL_FAMILY_CATALOG[family];
  return spec.minStreamStallTimeoutMs ?? 0;
}

/** The family list used for substring family-bucketing (`deriveFamily`). */
export const MODEL_FAMILIES = Object.freeze(
  Object.keys(MODEL_FAMILY_CATALOG) as ModelFamily[],
) as readonly ModelFamily[];

/** alias → pinned executor model id (the map `resolveModelId` reads). */
export const MODEL_ALIAS_MAP: Readonly<Record<ModelAlias, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MODEL_ALIAS_CATALOG).map(([alias, spec]) => [alias, spec.id]),
  ),
) as Readonly<Record<ModelAlias, string>>;

/** The `<family>@latest` opt-in sugar literals, derived from the family set. */
export type LatestModelAlias = `${ModelFamily}@latest`;

/**
 * Every accepted config `model` value: concrete aliases + `<family>@latest`
 * sugar. This is the single type the narrow `model` unions and `z.infer` of
 * `modelSchema` both resolve to.
 */
export type ConfigModel = ModelAlias | LatestModelAlias;

// ── Compile-time consistency guards (no runtime cost) ──────────────────────
type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The MODEL_ALIASES tuple must list EXACTLY the MODEL_ALIAS_CATALOG keys.
// A divergence (missing/extra/typo alias) is a compile error here.
export type _AliasesMatchCatalog = Assert<Equal<(typeof MODEL_ALIASES)[number], ModelAlias>>;
