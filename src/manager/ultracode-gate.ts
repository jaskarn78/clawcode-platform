/**
 * Quick 260715-j1j (D6) — pure ultracode eligibility check.
 *
 * `ultracode` is the 8th effort level: xhigh thinking budget + the CLI's
 * native-Workflow orchestration mode (claude ≥2.1.210). An agent may enter
 * it ONLY when BOTH hold:
 *
 *   (a) its resolved model is xhigh-capable — the CLI rejects sonnet/haiku
 *       with "Ultracode runs at xhigh effort, which <model> doesn't
 *       support"; and
 *   (b) it carries `nativeWorkflow: true` in clawcode.yaml — the per-agent
 *       opt-out of the fleet-wide native-Workflow block that the mode
 *       orchestrates through (NON-RELOADABLE; requires a daemon restart).
 *
 * Capability resolution goes through the model-catalog single source
 * (src/shared/model-catalog.ts): alias → family, `<family>@latest` sugar →
 * family, concrete pinned id → family. The catalog has no explicit
 * xhigh-capability field, so per the D6 fallback the capable set is the
 * conservative hardcoded {opus, fable} family pair, with a substring
 * fallback for raw model ids the catalog doesn't pin.
 *
 * Pure + loggerless (unit-testable): callers decide how to surface the
 * reason. Consumed by SessionManager.setEffortForAgent (slash + IPC gate)
 * AND the boot re-apply path (a persisted ultracode override on an agent
 * whose config no longer qualifies degrades safely — warn + skip, never
 * crash boot).
 */

import { MODEL_ALIAS_CATALOG, MODEL_FAMILY_CATALOG } from "../shared/model-catalog.js";

/** Discriminated eligibility result — reasons are operator-readable. */
export type UltracodeEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** The xhigh-capable model families (conservative hardcoded set per D6). */
const ULTRACODE_CAPABLE_FAMILIES: ReadonlySet<string> = new Set(["opus", "fable"]);

/**
 * Resolve a config model value (alias, `<family>@latest` sugar, or raw SDK
 * id) to its family via the catalog; substring fallback for raw ids. Returns
 * null when nothing matches (treated as not capable — fail closed).
 */
function resolveModelFamily(model: string): string | null {
  // Concrete alias (e.g. "opus", "fable", "sonnet-4-6").
  const aliasSpec = (
    MODEL_ALIAS_CATALOG as Readonly<Record<string, { readonly id: string; readonly family: string }>>
  )[model];
  if (aliasSpec) return aliasSpec.family;
  // `<family>@latest` opt-in sugar.
  if (model.endsWith("@latest")) {
    const family = model.slice(0, -"@latest".length);
    return family in MODEL_FAMILY_CATALOG ? family : null;
  }
  // Concrete pinned id (e.g. "claude-opus-4-8", "claude-fable-5").
  for (const spec of Object.values(MODEL_ALIAS_CATALOG)) {
    if (spec.id === model) return spec.family;
  }
  // Substring fallback for raw ids the catalog doesn't pin (e.g. a dated
  // snapshot id) — conservative: only the capable families are probed.
  if (model.includes("opus")) return "opus";
  if (model.includes("fable")) return "fable";
  return null;
}

/**
 * Check whether an agent's resolved config qualifies for ultracode.
 * Missing fields fail CLOSED with an operator-readable reason.
 */
export function checkUltracodeEligibility(config: {
  readonly model?: string;
  readonly nativeWorkflow?: boolean;
}): UltracodeEligibility {
  const model = config.model;
  if (model === undefined || model.length === 0) {
    return {
      ok: false,
      reason: "agent has no resolved model — cannot verify xhigh capability for ultracode",
    };
  }
  const family = resolveModelFamily(model);
  if (family === null || !ULTRACODE_CAPABLE_FAMILIES.has(family)) {
    return {
      ok: false,
      reason: `model ${model} does not support ultracode (needs opus/fable)`,
    };
  }
  if (config.nativeWorkflow !== true) {
    return {
      ok: false,
      reason:
        "agent has nativeWorkflow: false — set nativeWorkflow: true in clawcode.yaml and restart",
    };
  }
  return { ok: true };
}
