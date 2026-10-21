/**
 * Phase 999.114 — option list for the `/clawcode-model` Discord select menu.
 *
 * Pure + presentation-only, kept out of `slash-commands.ts` (already ~6k lines)
 * and out of `src/shared/model-catalog.ts` (a leaf identity module that
 * deliberately holds no per-feature policy or rendering).
 *
 * Before this module the picker rendered the raw config alias as the label —
 * an operator saw `opus-4-8` with no name, no price, and no hint which entry
 * was the current pin. With historical pins now selectable that list is long
 * enough that the raw strings stop being readable.
 */
import {
  MODEL_ALIAS_CATALOG,
  MODEL_FAMILY_CATALOG,
  type ConfigModel,
  type ModelAlias,
  type ModelAliasSpec,
  type ModelFamily,
} from "../shared/model-catalog.js";

/**
 * `MODEL_ALIAS_CATALOG` is declared `as const`, so each entry narrows to its own
 * literal shape and the OPTIONAL fields (`pricing`, `legacy`) are absent from
 * the members that omit them. Read it through the declared spec type instead.
 */
const CATALOG: Readonly<Record<string, ModelAliasSpec | undefined>> =
  MODEL_ALIAS_CATALOG;

/** Discord hard limits on a StringSelectMenu option. */
export const DISCORD_OPTION_LABEL_MAX = 100;
export const DISCORD_OPTION_DESCRIPTION_MAX = 100;

export type ModelPickerOption = {
  /** The config value dispatched over IPC on selection. */
  readonly value: ConfigModel;
  readonly label: string;
  readonly description: string;
  /** Marks the agent's current model so Discord pre-selects it. */
  readonly isCurrent: boolean;
};

function priceOf(family: ModelFamily, alias?: ModelAlias): string {
  const spec = alias ? CATALOG[alias] : undefined;
  const p = spec?.pricing ?? MODEL_FAMILY_CATALOG[family].pricing;
  return `$${p.inputPerMillion}/$${p.outputPerMillion} per MTok`;
}

function familyOf(value: ConfigModel): ModelFamily | null {
  if (value.endsWith("@latest")) {
    const fam = value.slice(0, -"@latest".length);
    return fam in MODEL_FAMILY_CATALOG ? (fam as ModelFamily) : null;
  }
  return CATALOG[value]?.family ?? null;
}

/** Families ordered strongest-first, so the capable tiers head the menu. */
function familyOrder(): ModelFamily[] {
  return (Object.keys(MODEL_FAMILY_CATALOG) as ModelFamily[]).sort(
    (a, b) =>
      MODEL_FAMILY_CATALOG[b].advisorRank - MODEL_FAMILY_CATALOG[a].advisorRank,
  );
}

/**
 * Rank WITHIN a family: the current pin first, then its `@latest` track, then
 * superseded pins newest-first (catalog declaration order).
 */
function withinFamilyRank(value: ConfigModel): number {
  if (value.endsWith("@latest")) return 1;
  const spec = CATALOG[value];
  if (spec === undefined) return 3;
  return spec.legacy === true ? 2 : 0;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Build the select-menu options for one agent.
 *
 * @param allowed the agent's resolved `allowedModels` (already the allowlist —
 *   this function renders, it does NOT authorize; `setModelForAgent` remains
 *   the server-side gate).
 * @param currentModel the agent's current config value, marked as default.
 */
export function buildModelPickerOptions(
  allowed: readonly ConfigModel[],
  currentModel?: string,
): readonly ModelPickerOption[] {
  const order = familyOrder();
  // De-dupe: a hand-written clawcode.yaml allowlist may repeat a value, and a
  // duplicate `value` makes Discord reject the whole menu payload.
  const seen = new Set<string>();
  const unique = allowed.filter((v) => !seen.has(v) && seen.add(v) !== undefined);

  const sorted = [...unique].sort((a, b) => {
    const fa = familyOf(a);
    const fb = familyOf(b);
    const ia = fa === null ? order.length : order.indexOf(fa);
    const ib = fb === null ? order.length : order.indexOf(fb);
    if (ia !== ib) return ia - ib;
    const ra = withinFamilyRank(a);
    const rb = withinFamilyRank(b);
    if (ra !== rb) return ra - rb;
    return unique.indexOf(a) - unique.indexOf(b);
  });

  return sorted.map((value): ModelPickerOption => {
    const family = familyOf(value);
    const isCurrent = value === currentModel;

    if (value.endsWith("@latest")) {
      const famName = family === null ? value : family;
      const pretty = famName.charAt(0).toUpperCase() + famName.slice(1);
      return {
        value,
        label: truncate(`Claude ${pretty} — latest`, DISCORD_OPTION_LABEL_MAX),
        // The one option whose behavior changes over time; say so explicitly.
        description: truncate(
          `Auto-follows the newest ${famName} model as it ships · ${
            family === null ? "" : priceOf(family)
          }`,
          DISCORD_OPTION_DESCRIPTION_MAX,
        ),
        isCurrent,
      };
    }

    const spec = CATALOG[value];
    if (spec === undefined || family === null) {
      // Defensive — a value the catalog does not know (hand-edited yaml).
      // Render it rather than dropping it silently, so the operator can see
      // what their config actually contains.
      return {
        value,
        label: truncate(value, DISCORD_OPTION_LABEL_MAX),
        description: "Unrecognized model value from clawcode.yaml",
        isCurrent,
      };
    }
    const tag = spec.legacy === true ? "previous release" : "current";
    return {
      value,
      label: truncate(spec.displayName, DISCORD_OPTION_LABEL_MAX),
      description: truncate(
        `${tag} · ${priceOf(family, value as ModelAlias)}`,
        DISCORD_OPTION_DESCRIPTION_MAX,
      ),
      isCurrent,
    };
  });
}
