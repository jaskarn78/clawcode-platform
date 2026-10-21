/**
 * Maps the user-facing generic aliases ("sonnet" | "opus" | "haiku") to the
 * explicit Claude model IDs the Agent SDK should use.
 *
 * The SDK/Claude Code CLI accepts either a generic alias or a full model ID.
 * Aliases resolve to whichever version the CLI ships with at the time, which
 * lags new releases. Pinning at the SDK boundary keeps `clawcode.yaml` readable
 * (`model: sonnet`) while guaranteeing which exact version runs.
 */

// Historical pinning notes (pre-catalog):
//   - Phase 999.92 — executor alias bumped to Opus 4.8; the advisor alias was
//     held at 4.7 under the SDK-bundled 0.2.140 binary, then lifted to 4.8 on
//     the external 2.1.158+ binary (see 999.92-FINDINGS.md + ADVISOR_MODEL_ALIASES).
//   - Phase 999.98 D2 — `fable` (`claude-fable-5`) added; advisor-incompatible.
//   - Sonnet 5 (2026-06) — `sonnet` bumped to claude-sonnet-5 + `sonnet-4-6`
//     config-pin-only escape hatch.
// The alias→id pins, the family list, and per-family advisor-compat now live in
// the single source of truth at src/shared/model-catalog.ts; this module holds
// the pure RESOLVERS over that data.
import {
  isSelectableModelId,
  MODEL_ALIAS_MAP,
  MODEL_FAMILIES,
  MODEL_FAMILY_CATALOG,
  MODEL_ALIAS_CATALOG,
  type ModelAlias,
  type ModelFamily,
} from "../shared/model-catalog.js";

// `ModelFamily` was historically declared here; keep re-exporting it so
// downstream importers of it from model-resolver are unaffected.
export type { ModelFamily };

function isModelAlias(value: string): value is ModelAlias {
  return value in MODEL_ALIAS_MAP;
}

/**
 * Resolve a model alias to its pinned ID. Full model IDs pass through unchanged
 * so callers can also hand in explicit IDs without double-translation.
 */
export function resolveModelId(aliasOrId: string): string {
  return isModelAlias(aliasOrId) ? MODEL_ALIAS_MAP[aliasOrId] : aliasOrId;
}

/**
 * Phase 999.98 D8 — a single catalog row, projected to the fields the pure
 * `@latest` resolver and the diff logic read. The store (model-catalog-store.ts)
 * produces these via `snapshot()`. Kept here (the pure module) so the resolver
 * stays self-contained and importers don't create a runtime cycle with the
 * better-sqlite3 store.
 */
export type CatalogModelRow = {
  readonly model_id: string;
  readonly display_name: string;
  readonly family: string;
  /**
   * Phase 999.114 — epoch ms of the last discovery tick that saw this model.
   * The column has always existed in SQLite; `snapshot()` simply dropped it.
   *
   * Load-bearing for `@latest`: rows are NEVER deleted and `entitled` is written
   * a literal 1 and never reset, so the live prod catalog still lists models
   * Anthropic stopped offering weeks ago (claude-sonnet-4-6 last seen 06-30,
   * claude-opus-4-8 last seen 07-15). Without a freshness bound, a model that
   * was seen once and then pulled would win `<family>@latest` forever and
   * resolve every spawn of that agent to a dead id.
   */
  readonly last_seen_at: number;
};

/** Phase 999.98 D8 — an in-memory snapshot of the catalog (a plain array). */
export type CatalogSnapshot = readonly CatalogModelRow[];

/**
 * Phase 999.98 D8 — derive the family bucket from a model id. Substring match on
 * the known families (`sonnet|opus|haiku|fable`). Returns `null` for an id whose
 * family cannot be identified (e.g. an unrelated model the SDK might surface) so
 * the caller can skip it rather than mis-bucket it.
 */
export function deriveFamily(modelId: string): ModelFamily | null {
  for (const fam of MODEL_FAMILIES) {
    if (modelId.includes(fam)) return fam;
  }
  return null;
}

/**
 * Phase 999.98 D8/D11 — parse the trailing numeric version segments from a model
 * id of the shape `claude-<family>-<major>-<minor>[-...]`. Returns the numeric
 * segments in order (e.g. `claude-opus-4-10` → `[4, 10]`).
 *
 * Pure. An id with NO parseable trailing numeric segment returns `[]` — the
 * caller sorts such ids BELOW any parseable id (an unparseable version never
 * wins "newest"). This is the function that makes `claude-opus-4-10` rank ABOVE
 * `claude-opus-4-8`: a LEXICAL sort would invert it (string "10" < "8"); the
 * NUMERIC per-segment compare in `compareModelVersion` gets it right.
 */
export function parseModelVersion(modelId: string): number[] {
  // Collect the maximal trailing run of `-<digits>` segments.
  const parts = modelId.split("-");
  const trailing: number[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i]!;
    if (/^\d+$/.test(seg)) {
      trailing.unshift(Number(seg));
    } else {
      break;
    }
  }
  return trailing;
}

/**
 * Phase 999.98 D8/D11 — compare two model ids by their parsed NUMERIC version
 * segments. Returns >0 when `idA` is newer, <0 when `idB` is newer, 0 when
 * equal. Per-segment numeric compare with zero-padding for unequal lengths.
 *
 * An id whose version cannot be parsed (`[]`) sorts BELOW any parseable id, so
 * it never wins "newest". Two unparseable ids compare equal (0).
 *
 * Load-bearing invariant (guards SC-5 on two-digit-minor data):
 *   compareModelVersion("claude-opus-4-10", "claude-opus-4-8") > 0
 * A lexical sort would return < 0 here — that is the bug this protects against.
 */
export function compareModelVersion(idA: string, idB: string): number {
  const a = parseModelVersion(idA);
  const b = parseModelVersion(idB);
  // An empty (unparseable) version always loses to a parseable one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return -1;
  if (b.length === 0) return 1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Phase 999.98 D11 — resolve a `<family>@latest` value to the newest entitled
 * concrete model id, PURELY over an injected in-memory catalog snapshot.
 *
 * Logic:
 *   1. Parse the family from `<family>@latest`. If the family is unknown, fall
 *      through to returning the input unchanged (defensive — schema gates this).
 *   2. Among the snapshot rows for that family, pick the one with the HIGHEST
 *      parsed version via `compareModelVersion` (NUMERIC per segment — NOT a
 *      lexical sort, and NOT a timestamp/insertion-order sort).
 *   3. GROUND against the pinned alias `MODEL_ALIAS_MAP[family]`: return
 *      whichever of {snapshot winner, pinned alias} parses NEWER. So `@latest`
 *      never resolves OLDER than the pin, and a cold/empty snapshot (no rows for
 *      the family) returns the pinned alias.
 *
 * PURE: reads ONLY its two arguments. No store / SDK / IO / module-global / async.
 * Degenerates correctly whether the SDK returns one-current-version-per-family
 * OR multiple simultaneously (it floors at the pin in the one-per-family case).
 *
 * @param familyAtLatest e.g. `"opus@latest"` (the closed-enum sugar literal).
 * @param snapshot the daemon-owned in-memory catalog snapshot (injected dep).
 */
/**
 * Phase 999.114 — optional freshness bound for `resolveLatestModel`. BOTH
 * fields must be supplied for the bound to apply; the clock is INJECTED so the
 * resolver stays pure and unit-testable. Omit to consider every row (the
 * pre-999.114 behavior every existing caller still gets).
 */
/**
 * Phase 999.114 — how stale a discovered catalog row may be and still win
 * `<family>@latest`. 30 days: the monitor ticks every 6h, so a model still
 * offered by Anthropic is re-stamped ~120x within the window, while a model
 * that was pulled falls out after a month and `@latest` floors back to the
 * code pin (which is always a real, shipped id).
 *
 * Rows are never deleted and `entitled` is never reset to 0, so this bound is
 * the ONLY thing preventing a withdrawn model from winning `@latest` forever.
 */
export const LATEST_MODEL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type LatestModelOpts = {
  readonly now?: number;
  readonly maxAgeMs?: number;
};

export function resolveLatestModel(
  familyAtLatest: string,
  snapshot: CatalogSnapshot,
  opts?: LatestModelOpts,
): string {
  const family = familyAtLatest.endsWith("@latest")
    ? familyAtLatest.slice(0, -"@latest".length)
    : familyAtLatest;
  if (!isModelAlias(family)) {
    // Unknown family — defensive pass-through (the closed enum prevents this in
    // practice). Nothing to resolve against.
    return familyAtLatest;
  }
  const pinned = MODEL_ALIAS_MAP[family];

  // Newest snapshot row for this family (version-aware, NOT lexical).
  let best: string | null = null;
  for (const row of snapshot) {
    // Phase 999.114 — the SAME predicate the Discord picker filters on, so the
    // two can never disagree about a family's "latest". Drops the CLI selector
    // tokens and bare family names the monitor also upserts (`opus[1m]`,
    // `sonnet`, …) — see `isSelectableModelId`.
    if (!isSelectableModelId(row.model_id)) continue;
    // Phase 999.114 — freshness bound. Skipped entirely when the caller passes
    // no clock (keeps this function PURE and every existing caller unchanged).
    if (opts?.now !== undefined && opts.maxAgeMs !== undefined) {
      if (opts.now - row.last_seen_at > opts.maxAgeMs) continue;
    }
    if (deriveFamily(row.model_id) !== family) continue;
    if (best === null || compareModelVersion(row.model_id, best) > 0) {
      best = row.model_id;
    }
  }

  // Cold / no-family-rows snapshot → the pinned alias.
  if (best === null) return pinned;

  // Ground against the pin: never return OLDER than the pinned alias.
  return compareModelVersion(best, pinned) > 0 ? best : pinned;
}

/**
 * Phase 999.98 D3 — is the native advisor allowed for this RESOLVED executor
 * model id?
 *
 * Pure predicate, co-located with the 999.92 advisor-pairing history so it is
 * trivially unit-testable. Returns `false` for `claude-fable-5` and `true`
 * otherwise.
 *
 * Why: a Fable *executor* 400s when the default native advisor (`opus` →
 * `claude-opus-4-8`) is wired in-request —
 *   `400 tools.10.model: 'claude-opus-4-8' cannot be used as an advisor when
 *    the request model is 'claude-fable-5'`.
 * This is the same asymmetric-advisor failure class as the 999.92 pin above.
 * Ship OMIT: `shouldEnableAdvisor` (session-config.ts) calls this on
 * `resolveModelId(config.model)` so the existing
 * `...(shouldEnableAdvisor ? {advisorModel} : {})` spread drops the advisor →
 * the SDK never enables `advisor_20260301` → no per-turn 400.
 *
 * NOTE: the input must be the RESOLVED id form (`"claude-fable-5"`), NOT the
 * alias `"fable"`. Callers resolve via `resolveModelId` first.
 *
 * Derived from the catalog: the disallowed set is every alias whose family is
 * `advisorCompatible: false` (today just `claude-fable-5`), so a future
 * advisor-incompatible family is covered without touching this predicate.
 */
const ADVISOR_INCOMPATIBLE_MODEL_IDS: ReadonlySet<string> = new Set(
  Object.values(MODEL_ALIAS_CATALOG)
    .filter((spec) => !MODEL_FAMILY_CATALOG[spec.family].advisorCompatible)
    .map((spec) => spec.id),
);

export function advisorAllowedForExecutor(resolvedExecutorId: string): boolean {
  return !ADVISOR_INCOMPATIBLE_MODEL_IDS.has(resolvedExecutorId);
}

export type AdvisorPairing =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * 2026-08-28 — native-advisor PAIRING check, by family rank
 * (`MODEL_FAMILY_CATALOG[*].advisorRank`). The API requires advisor >= executor
 * and 400s EVERY request of a session that carries a weaker advisor — and the
 * `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` env flag the daemon sets for
 * native agents BYPASSES the CLI's own client-side check, so this is the only
 * guard left. Unknown ids (non-Claude executors, typos) are rejected, never
 * guessed: the failure mode of a wrong "ok" is a dead agent.
 */
export function advisorPairingValid(executorId: string, advisorId: string): AdvisorPairing {
  const executorFamily = deriveFamily(executorId);
  const advisorFamily = deriveFamily(advisorId);
  if (executorFamily === null) {
    return { ok: false, reason: `executor ${executorId} has no advisor rank in the model catalog` };
  }
  if (advisorFamily === null) {
    return { ok: false, reason: `advisor ${advisorId} has no advisor rank in the model catalog` };
  }
  const executorRank = MODEL_FAMILY_CATALOG[executorFamily].advisorRank;
  const advisorRank = MODEL_FAMILY_CATALOG[advisorFamily].advisorRank;
  if (advisorRank < executorRank) {
    return {
      ok: false,
      reason:
        `advisor ${advisorId} (${advisorFamily}) is less capable than executor ` +
        `${executorId} (${executorFamily}) — the API rejects the pair with 400 on every request`,
    };
  }
  // Phase 999.114 — WITHIN-family version check. Family rank alone is blind to
  // version skew: a `claude-fable-5` advisor under a `claude-fable-5-1` executor
  // is rank 3 vs rank 3 and would pass the check above, while the API may still
  // reject the older advisor as less capable — again a 400 on EVERY request.
  // Only applied inside one family; ACROSS families rank is authoritative (the
  // API's own docs pair executor sonnet-5 with advisor opus-4-7, so a numerically
  // lower cross-family version is fine and must NOT be rejected here).
  if (advisorFamily === executorFamily && compareModelVersion(advisorId, executorId) < 0) {
    return {
      ok: false,
      reason:
        `advisor ${advisorId} is an OLDER ${advisorFamily} than executor ${executorId} — ` +
        `the API rejects a less capable advisor with 400 on every request`,
    };
  }
  return { ok: true };
}

/**
 * Phase 999.98 D11 — collapse a `<family>@latest` value to its FAMILY's pinned
 * concrete id, WITHOUT a catalog snapshot. Pure + synchronous.
 *
 * This is the helper that family-only consumers (the advisor-OMIT gate, the SLO
 * bucket lookup) must use when `config.model` may be the `@latest` form: those
 * consumers only care which FAMILY the executor is, not which exact version, so
 * the pinned alias is the correct family-canonical id. The actual SESSION model
 * (which must reflect the newest entitled tier) is resolved separately via the
 * snapshot-aware `resolveLatestModel` at the session-adapter boundary.
 *
 * Behavior:
 *   - `"fable@latest"` → `MODEL_ALIAS_MAP.fable` (`"claude-fable-5"`)
 *   - a plain alias (`"opus"`) or concrete id passes through `resolveModelId`.
 *
 * Why this exists: widening `config.model` to carry the `@latest` sugar means a
 * raw `@latest` value reaches the advisor gate; `resolveModelId("fable@latest")`
 * would pass it through unchanged → `advisorAllowedForExecutor` returns true →
 * the SDK keeps the native advisor ON → the Fable per-turn 400 the D3 OMIT gate
 * was built to prevent. Collapsing to the pinned family id closes that leak.
 */
export function resolveExecutorModelForGates(modelOrLatest: string): string {
  if (modelOrLatest.endsWith("@latest")) {
    const family = modelOrLatest.slice(0, -"@latest".length);
    if (isModelAlias(family)) return MODEL_ALIAS_MAP[family];
  }
  return resolveModelId(modelOrLatest);
}

/**
 * Advisor-specific alias map. The advisor model is Opus by convention
 * (per Anthropic's docs valid-pair table — Sonnet executor + Opus advisor
 * is the canonical pairing). Users typically write `"opus"` in their
 * `clawcode.yaml` `defaults.advisor.model` for readability; the Claude
 * Agent SDK's `advisorModel` option, however, expects a fully-qualified
 * model ID. This map handles that translation at the SDK boundary.
 *
 * Phase 117 only documents the Opus mapping (the advisor-pattern beta is
 * Opus-centric). Future advisor models can be added here without changing
 * call sites.
 *
 * See:
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md` §13.7
 *   - <https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool>
 *     (executor/advisor pairing table)
 */
const ADVISOR_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Opus 5.5 (2026-09) — the advisor tracks the latest Opus. This MUST move with
  // the `opus` executor pin: the native advisor requires advisor >= executor,
  // so an Opus-5.5 executor (personal / state-contract on `model: opus`) paired
  // with an Opus-5 advisor would be rejected
  // (`tools.N.model: 'claude-opus-5' cannot be used as an advisor when the
  //  request model is 'claude-opus-5-5'`). Opus-5.5 advisor is >= every executor
  // family (sonnet/opus/haiku), so all advisor-enabled agents stay valid.
  //
  // Phase 999.158 — MOVED IN LOCKSTEP with the `opus` executor repin to Opus
  // 5.5. `advisorPairingValid` compares family rank AND within-family version,
  // so a `claude-opus-5` advisor under a `claude-opus-5-5` executor is caught
  // locally: `compareModelVersion([5], [5,5]) < 0`.
  //
  // 🚨 That local guard FAILS SAFE, not loud — `session-config.ts` logs a warn
  // and returns false, so the session comes up with NO advisor rather than
  // 400ing. An agent that pins an older opus advisor therefore loses its
  // advisor SILENTLY at the next restart. Prod `state-contract` pins
  // `advisor.model: claude-opus-5` (2026-08-02, per Operator) and is exactly this
  // case: its yaml must move to `claude-opus-5-5` (or bare `opus`) in the same
  // change window as this repin, or it quietly runs unadvised.
  opus: "claude-opus-5-5",
  "claude-opus-5-5": "claude-opus-5-5",
  // Explicit rollback pins — an operator can hold the advisor at an older Opus
  // by writing the full id in `defaults.advisor.model`. Each is valid only
  // under an executor at or below its own version.
  "claude-opus-5": "claude-opus-5",
  "claude-opus-4-8": "claude-opus-4-8",
  // 2026-08-28 — Fable advises Fable (fin-client). A Fable executor can
  // ONLY pair with a Fable advisor (rank 3); `advisorPairingValid` enforces it.
  //
  // Phase 999.114 — MOVED IN LOCKSTEP with the `fable` executor repin to
  // Fable 5.1. Leaving this at claude-fable-5 would put a 5.0 advisor under a
  // 5.1 executor: family rank is equal (3 vs 3) so the pairing check passes,
  // but the API can still reject the weaker advisor — a 400 on EVERY request.
  // `advisorPairingValid` now also compares WITHIN-family version to catch it.
  fable: "claude-fable-5-1",
  "claude-fable-5-1": "claude-fable-5-1",
  // Explicit rollback pin — hold the advisor at Fable 5 by writing the full id
  // (valid only under a Fable 5 executor).
  "claude-fable-5": "claude-fable-5",
});

export { ADVISOR_MODEL_ALIASES };

/**
 * Resolve an advisor model alias to its pinned SDK-compatible ID.
 * Unknown values pass through unchanged so operators can pin a specific
 * version directly in `clawcode.yaml` (e.g. `model: "claude-opus-4-8"`).
 */
export function resolveAdvisorModel(raw: string): string {
  return ADVISOR_MODEL_ALIASES[raw] ?? raw;
}
