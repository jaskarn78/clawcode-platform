/**
 * SLO source of truth for the v1.7 latency budget.
 *
 * `DEFAULT_SLOS` is the single, frozen list of latency targets. It is imported
 * by:
 *   - The daemon's latency IPC handler (Plan 51-03) — to attach
 *     `slo_status: "healthy" | "breach" | "no_data"` per segment to the
 *     `/api/agents/:name/latency` response.
 *   - The CI regression gate (`src/benchmarks/thresholds.ts`) — to know which
 *     segments require a tracked threshold.
 *
 * Per-agent or fleet-wide overrides arrive through the Zod-parsed
 * `clawcode.yaml` `perf.slos: [...]` field (see `src/config/schema.ts`
 * `sloOverrideSchema`). They merge through `mergeSloOverrides` with
 * per-(segment, metric) replacement semantics.
 *
 * SECURITY: SLO entries are tiny config — no PII, no secrets, no risk vector.
 * Every record returned by this module is `Object.freeze`d.
 */

import {
  CANONICAL_SEGMENTS,
  type CacheHitRateStatus,
  type CanonicalSegment,
  type PercentileRow,
  type SloMetric,
  type SloStatus,
} from "./types.js";
// Phase 999.114 — SLO buckets are per-FAMILY and now DERIVE from the model
// catalog, so adding a model alias no longer requires editing this file.
// (model-catalog is a leaf module — importing it here cannot create a cycle.)
import {
  MODEL_ALIAS_CATALOG,
  type ConfigModel,
  type ModelAlias,
  type ModelFamily,
} from "../shared/model-catalog.js";

// `SloMetric` + `SloStatus` were moved to `./types.ts` in Phase 51 Plan 03 so
// `PercentileRow` can reference them without a circular import. Re-export here
// so existing callers that import from `./slos.js` keep working unchanged.
export type { CacheHitRateStatus, SloMetric, SloStatus };

/**
 * A single SLO target: which segment, which percentile, and the maximum
 * milliseconds before the row is considered a breach.
 */
export type SloEntry = {
  readonly segment: CanonicalSegment;
  readonly metric: SloMetric;
  readonly thresholdMs: number;
};

/**
 * Default SLO targets for v1.7 — the single source of truth. Verbatim from
 * `.planning/phases/51-slos-regression-gate/51-CONTEXT.md` decisions plus
 * Phase 54 streaming-and-typing-indicator additions:
 *
 *   - `end_to_end`        p95 ≤ 6000 ms
 *   - `first_token`       p50 ≤ 2000 ms
 *   - `context_assemble`  p95 ≤  300 ms
 *   - `tool_call`         p95 ≤ 1500 ms
 *   - `typing_indicator`  p95 ≤  500 ms  (Phase 54 — observational initially)
 *
 * The `typing_indicator` 500 ms budget is deliberately aggressive. Per Phase
 * 54 CONTEXT D-03 operators should treat it as OBSERVATIONAL for the first
 * week of real traffic, observing p95 before treating breach as a hard gate.
 * The `first_visible_token` canonical segment intentionally has NO default
 * SLO — it is the debug/support metric (delta vs `first_token` captures
 * Discord plumbing overhead), not a headline.
 *
 * Frozen at module load. Override per-agent via `clawcode.yaml`
 * `perf.slos: [...]` which feeds `mergeSloOverrides`.
 */
export const DEFAULT_SLOS: readonly SloEntry[] = Object.freeze([
  Object.freeze<SloEntry>({
    segment: "end_to_end",
    metric: "p95",
    thresholdMs: 6000,
  }),
  Object.freeze<SloEntry>({
    segment: "first_token",
    metric: "p50",
    thresholdMs: 2000,
  }),
  Object.freeze<SloEntry>({
    segment: "context_assemble",
    metric: "p95",
    thresholdMs: 300,
  }),
  Object.freeze<SloEntry>({
    segment: "tool_call",
    metric: "p95",
    thresholdMs: 1500,
  }),
  Object.freeze<SloEntry>({
    segment: "typing_indicator",
    metric: "p95",
    thresholdMs: 500,
  }),
]);

/**
 * Evaluate a percentile row against an SLO threshold for a given metric.
 *
 * Returns `"no_data"` when `count === 0` OR when the requested percentile is
 * `null` (the row exists but the metric column is empty — e.g. a window with
 * traces but no first-token spans).
 *
 * Returns `"healthy"` when `row[metric] <= thresholdMs`.
 * Returns `"breach"`  when `row[metric] >  thresholdMs`.
 *
 * Pure function — safe to call from the daemon, the dashboard, or the CI gate.
 *
 * @param row         - The percentile row to evaluate (any object with the
 *                      four standard percentile keys + count).
 * @param thresholdMs - Maximum tolerated milliseconds for `metric`.
 * @param metric      - Which percentile column the SLO targets.
 */
export function evaluateSloStatus(
  row: Pick<PercentileRow, "p50" | "p95" | "p99" | "count">,
  thresholdMs: number,
  metric: SloMetric,
): SloStatus {
  if (row.count === 0) return "no_data";
  const value = row[metric];
  if (value === null) return "no_data";
  return value <= thresholdMs ? "healthy" : "breach";
}

/**
 * Merge user overrides into a base SLO list (typically `DEFAULT_SLOS`).
 *
 * Per-(segment, metric) override semantics:
 *   - An override matching BOTH `segment` AND `metric` REPLACES the base
 *     threshold. Position in the result preserved.
 *   - An override matching the segment but a DIFFERENT metric is APPENDED —
 *     a single segment may carry multiple SLOs in future (e.g. p50 AND p95
 *     first_token).
 *
 * The returned array and every entry are frozen. Inputs are never mutated.
 *
 * @param defaults  - Base SLO list (usually `DEFAULT_SLOS`).
 * @param overrides - User-supplied overrides (validated by Zod elsewhere).
 * @returns A frozen merged list.
 */
export function mergeSloOverrides(
  defaults: readonly SloEntry[],
  overrides: readonly SloEntry[],
): readonly SloEntry[] {
  const result: SloEntry[] = [];
  const consumed = new Set<number>();

  for (const def of defaults) {
    const matchIndex = overrides.findIndex(
      (o) => o.segment === def.segment && o.metric === def.metric,
    );
    if (matchIndex >= 0) {
      const o = overrides[matchIndex]!;
      result.push(
        Object.freeze<SloEntry>({
          segment: def.segment,
          metric: def.metric,
          thresholdMs: o.thresholdMs,
        }),
      );
      consumed.add(matchIndex);
    } else {
      result.push(def);
    }
  }

  for (let i = 0; i < overrides.length; i++) {
    if (consumed.has(i)) continue;
    const o = overrides[i]!;
    result.push(
      Object.freeze<SloEntry>({
        segment: o.segment,
        metric: o.metric,
        thresholdMs: o.thresholdMs,
      }),
    );
  }

  return Object.freeze(result);
}

/**
 * Phase 52 Plan 01: cache-hit-rate SLO bands.
 *
 * Separate from `DEFAULT_SLOS` because cache hit rate is a ratio (0..1), not a
 * millisecond threshold. Per Phase 52 CONTEXT D-03 surfacing decision:
 *   - healthy ≥ 0.60
 *   - breach  < 0.30
 *   - gray zone (0.30..0.60) → `no_data` = warming up, neutral tint
 *
 * Values are verbatim from the CONTEXT file and MUST NOT be edited casually —
 * they are surfaced on the dashboard and drive operator attention bandwidth.
 */
export type CacheHitRateSloEntry = {
  readonly healthyMin: number;
  readonly breachMax: number;
};

export const CACHE_HIT_RATE_SLO: CacheHitRateSloEntry = Object.freeze({
  healthyMin: 0.6,
  breachMax: 0.3,
});

/**
 * Evaluate a cache hit-rate observation against `CACHE_HIT_RATE_SLO`.
 *
 * Pure function. Returns:
 *   - `"no_data"` when `turns === 0` (no observations in window).
 *   - `"healthy"` when `hitRate >= CACHE_HIT_RATE_SLO.healthyMin` (0.60).
 *   - `"breach"`  when `hitRate <  CACHE_HIT_RATE_SLO.breachMax`  (0.30).
 *   - `"no_data"` in the gray zone (0.30..0.60) — warming up, neither green
 *     nor red. The dashboard renders a neutral tint so operators are not
 *     distracted while the cache is establishing its prefix.
 *
 * @param hitRate - Observed hit rate in [0..1].
 * @param turns   - Number of turns that contributed to the hit rate.
 */
export function evaluateCacheHitRateStatus(
  hitRate: number,
  turns: number,
): CacheHitRateStatus {
  if (turns === 0) return "no_data";
  if (hitRate >= CACHE_HIT_RATE_SLO.healthyMin) return "healthy";
  if (hitRate < CACHE_HIT_RATE_SLO.breachMax) return "breach";
  return "no_data";
}

/**
 * Phase 55 — resolve the effective SLO for a named tool with fallback to the
 * global `tool_call` SLO.
 *
 * Lookup order:
 *   1. If `perTools?.slos?.[toolName]` exists, that wins. The override's
 *      `metric` defaults to `"p95"` when omitted so the common case stays
 *      concise in clawcode.yaml.
 *   2. Otherwise falls back to the `tool_call` entry in `DEFAULT_SLOS`
 *      (1500ms p95 from 51-CONTEXT).
 *
 * Unknown tools (not in the override map, not in DEFAULT_SLOS) still receive
 * the global `tool_call` fallback so the dashboard and CLI always have a
 * threshold to render — no `null` cases for consumers to null-check.
 *
 * Pure function; returns a frozen `{ thresholdMs, metric }` pair.
 *
 * @param toolName - The tool name (e.g. `"memory_lookup"`) without the
 *                   `tool_call.` prefix.
 * @param perTools - Optional per-agent `perf.tools` config (the `.slos` field
 *                   is the only one this helper reads). `undefined` falls
 *                   through to the global SLO directly.
 */
export function getPerToolSlo(
  toolName: string,
  perTools?: {
    readonly slos?: Readonly<
      Record<
        string,
        { readonly thresholdMs: number; readonly metric?: SloMetric }
      >
    >;
  },
): { readonly thresholdMs: number; readonly metric: SloMetric } {
  const override = perTools?.slos?.[toolName];
  if (override) {
    return Object.freeze({
      thresholdMs: override.thresholdMs,
      metric: override.metric ?? "p95",
    });
  }
  const globalToolCall = DEFAULT_SLOS.find((s) => s.segment === "tool_call");
  return Object.freeze({
    thresholdMs: globalToolCall?.thresholdMs ?? 1500,
    metric: globalToolCall?.metric ?? "p95",
  });
}

// Re-export for downstream symmetry (so callers don't need a second import to
// iterate canonical segment names).
export { CANONICAL_SEGMENTS };

// ---------------------------------------------------------------------------
// Phase 116 F02 — per-model SLO recalibration (folds Phase 999.38).
//
// `DEFAULT_SLOS` above is the fleet-wide baseline (sonnet-tuned). On a fleet
// running mixed Opus / Sonnet / Haiku agents, applying a single threshold
// across all models surfaces every Opus turn as a breach because Opus is
// inherently slower than Sonnet on first_token. The redesigned dashboard
// (Plan 116-01 F03 agent tile grid) colour-codes per agent using these
// per-model defaults; per-agent overrides via the existing
// `agents[*].perf.slos[]` mechanism still win on a per-(segment, metric) basis.
//
// Threshold derivation — locked 2026-05-11 from 30-day fleet aggregate (full
// table + rationale in Plan 116-00 T02 action block). Targets are
// **aspirational**, not empirical p50: heavy-context operator-facing agents
// (Admin Clawdy, fin-client) currently exceed these and SHOULD render
// red in the dashboard until Phase 115's cache-breakpoint reorder +
// lazy-recall propagate. The point of per-model SLOs is to stop Opus tiles
// from going red purely because Opus runs ~33% slower than Sonnet — not to
// lower the bar.
//
// Source = "model-default" | "agent-override" so the UI can render the
// provenance pill next to the gauge.
// ---------------------------------------------------------------------------

// Phase 999.98 D6 — `fable` added. `resolveSloFor` does `DEFAULT_MODEL_SLOS[
// agent.model]` with NO fallback, so the exhaustive Record below MUST carry a
// `fable` entry or a Fable agent throws at dashboard render. `agent.model` here
// is the ALIAS form ("fable"), not a resolved id.
// Phase 999.114 — DERIVED from the catalog's family set rather than re-listed.
// `DEFAULT_MODEL_SLOS` below is an exhaustive `Record<SloModel, …>`, so adding a
// new model FAMILY to the catalog is a COMPILE error here until it gets its own
// thresholds — which is precisely the guard the 999.98 note above asked for
// (`resolveSloFor` indexes with no fallback, so a missing bucket throws at
// dashboard render). Adding a new model *alias* to an existing family is now
// free — it buckets by family via `normalizeSloModel`.
export type SloModel = ModelFamily;

// Phase 999.98 D11 — the resolved-config `model` field now also admits the four
// `<family>@latest` opt-in literals (config-time sugar pre-resolved at the
// session adapter). `resolveSloFor` is a daemon-side consumer that reads the
// pre-resolution config value, so its input union must accept `@latest` too —
// we normalize the suffix to the base family before the bucket lookup (an
// `@latest` agent shares its family's SLO bucket).
// Phase 999.114 — was a hand-maintained union that re-listed every escape-hatch
// pin ("sonnet-4-6", "opus-4-8", …). That made every new historical pin a
// silent compile break here. It is now exactly `ConfigModel` — every accepted
// config `model` value — and `normalizeSloModel` buckets it by FAMILY.
export type SloModelInput = ConfigModel;

/**
 * Phase 999.98 D11 — strip a `<family>@latest` suffix to its concrete SLO
 * family bucket. A plain `SloModel` passes through unchanged. Pure.
 *
 * Sonnet 5 — the `sonnet-4-6` escape-hatch pin maps to the `sonnet` bucket
 * (it is the sonnet family; there is no separate 4.6 threshold set).
 */
/**
 * Phase 999.114 — EXPORTED. `endpoint-bootstrap.ts` was casting a raw config
 * model straight to `SloModel` and then guarding with `model in
 * DEFAULT_MODEL_SLOS`; the cast suppressed the type error and the guard turned
 * every non-family value into a silent `null` (no SLO at all). Callers must
 * normalize through here instead of casting.
 */
export function normalizeSloModel(model: SloModelInput): SloModel {
  // `<family>@latest` sugar → the family itself.
  if (model.endsWith("@latest")) {
    return model.slice(0, -"@latest".length) as SloModel;
  }
  // Every concrete alias buckets to its catalog family, so a historical pin
  // ("opus-4-6", "fable-5", …) shares its family's thresholds automatically.
  const spec = MODEL_ALIAS_CATALOG[model as ModelAlias];
  // Defensive: the closed enum makes an unknown alias unreachable in practice.
  return spec ? spec.family : ("sonnet" as SloModel);
}

export type ModelSloThresholds = {
  readonly first_token_p50_ms: number;
  readonly end_to_end_p95_ms: number;
  readonly tool_call_p95_ms: number;
};

export const DEFAULT_MODEL_SLOS: Readonly<Record<SloModel, ModelSloThresholds>> =
  Object.freeze({
    sonnet: Object.freeze({
      first_token_p50_ms: 6_000,
      end_to_end_p95_ms: 30_000,
      tool_call_p95_ms: 30_000,
    }),
    opus: Object.freeze({
      first_token_p50_ms: 8_000,
      end_to_end_p95_ms: 40_000,
      tool_call_p95_ms: 30_000,
    }),
    haiku: Object.freeze({
      first_token_p50_ms: 2_000,
      end_to_end_p95_ms: 15_000,
      tool_call_p95_ms: 30_000,
    }),
    // Phase 999.98 D6 — Fable 5 starting thresholds cloned from opus's bucket
    // (Claude's discretion — tune once live latency data exists).
    fable: Object.freeze({
      first_token_p50_ms: 8_000,
      end_to_end_p95_ms: 40_000,
      tool_call_p95_ms: 30_000,
    }),
  });

/**
 * Source tag for a resolved SLO threshold — the UI renders this so the
 * operator can distinguish a fleet-wide model default from a per-agent
 * override they (or the YAML) set.
 */
export type SloSource = "model-default" | "agent-override";

/**
 * Resolved SLO bundle for a single agent. Returned by {@link resolveSloFor}.
 *
 * `first_token_p50_ms` is the headline value the dashboard uses for the
 * "first-token p50" gauge in F03 agent tiles. `source` indicates whether the
 * value came from `agents[*].perf.slos[]` (operator override) or the fleet-wide
 * per-model default in {@link DEFAULT_MODEL_SLOS}.
 *
 * The full per-model bundle is exposed via `model_defaults` so the dashboard
 * can render end_to_end_p95 / tool_call_p95 from the same response.
 */
export type ResolvedAgentSlos = {
  readonly first_token_p50_ms: number;
  readonly source: SloSource;
  readonly model: SloModel;
  readonly model_defaults: ModelSloThresholds;
};

/**
 * Pure shape of the inputs {@link resolveSloFor} reads. Declared structurally
 * so callers don't need to import `ResolvedAgentConfig` from `src/shared/types`
 * (which would pull in dream/memory/skills config that this helper does not
 * need). Anything with `{ model, perf?: { slos? } }` works.
 */
export type ResolveSloInput = {
  // Phase 999.98 D11 — accepts the `@latest` literals (normalized to the family
  // bucket inside resolveSloFor); a daemon caller passes the resolved-config
  // model value, which may still be the pre-resolution `@latest` form.
  readonly model: SloModelInput;
  readonly perf?: {
    readonly slos?: readonly SloEntry[];
  };
};

/**
 * Resolve the effective per-agent SLO bundle.
 *
 * Resolution order for the headline `first_token_p50_ms`:
 *   1. Per-agent override — if `agent.perf.slos[]` contains
 *      `{ segment: "first_token", metric: "p50" }`, that wins
 *      and `source = "agent-override"`.
 *   2. Per-model default — fall back to
 *      `DEFAULT_MODEL_SLOS[agent.model].first_token_p50_ms`
 *      and `source = "model-default"`.
 *
 * Pure function; returns a frozen result. Never throws.
 *
 * @param agent - Resolved agent config (or structurally compatible subset).
 */
export function resolveSloFor(agent: ResolveSloInput): ResolvedAgentSlos {
  // Phase 999.98 D11 — normalize `<family>@latest` → family before the bucket
  // lookup so an `@latest` agent shares its family's SLO thresholds (and the
  // exhaustive Record stays 4 buckets — no `@latest` entries needed).
  const model = normalizeSloModel(agent.model);
  const modelDefaults = DEFAULT_MODEL_SLOS[model];
  const override = agent.perf?.slos?.find(
    (s) => s.segment === "first_token" && s.metric === "p50",
  );
  if (override) {
    return Object.freeze({
      first_token_p50_ms: override.thresholdMs,
      source: "agent-override" as const,
      model,
      model_defaults: modelDefaults,
    });
  }
  return Object.freeze({
    first_token_p50_ms: modelDefaults.first_token_p50_ms,
    source: "model-default" as const,
    model,
    model_defaults: modelDefaults,
  });
}
