/**
 * Phase 999.98 D10 — pure model-diff + Admin-Clawdy surfacing.
 *
 * The monitor cron (model-monitor-cron.ts) discovers the entitled model set per
 * tick, upserts the catalog, then calls `computeModelDiff` against the PRE-tick
 * snapshot and `surfaceModelDiff` to post each non-deduped item to Admin Clawdy.
 *
 * Two surface kinds:
 *   - "new-tier"  — a discovered model whose FAMILY is absent from the pre-tick
 *     snapshot. Surfaced once: "use `model: <family>` or `<family>@latest`".
 *   - "pin-bump"  — a pinned agent for which the catalog now holds a same-family
 *     id that `compareModelVersion` ranks STRICTLY NEWER than the agent's pinned
 *     resolved id. Surfaced as a PROPOSAL only (edit clawcode.yaml + restart) —
 *     NEVER auto-flipped (D10): this module never mutates a pinned agent's model
 *     (no live-switch call on this path; the surface is purely advisory).
 *
 * Version ordering reuses `compareModelVersion` from model-resolver (NUMERIC,
 * not lexical, not insertion-order) — this module never re-implements it.
 *
 * `computeModelDiff` is PURE (reads only its three args). `surfaceModelDiff`
 * performs IO via injected deps (`postToAdminClawdy`, `wasSurfaced`,
 * `markSurfaced`, `now`).
 */

import type { ModelInfo } from "./sdk-types.js";
import {
  compareModelVersion,
  deriveFamily,
  type CatalogSnapshot,
} from "./model-resolver.js";

/** Surface-kind discriminators (also the dedup table's `kind` column). */
export const SURFACE_NEW_TIER = "new-tier" as const;
export const SURFACE_PIN_BUMP = "pin-bump" as const;

/** A pinned agent the diff considers for a pin-bump proposal. */
export type PinnedAgentInput = {
  readonly name: string;
  /** The agent's resolved (concrete) model id, e.g. `claude-opus-4-8`. */
  readonly resolvedModelId: string;
  /** Derived family, e.g. `opus`. */
  readonly family: string;
};

/** A single new-tier surface candidate. */
export type NewTierItem = {
  readonly kind: typeof SURFACE_NEW_TIER;
  readonly modelId: string;
  readonly displayName: string;
  readonly family: string;
};

/** A single pin-bump proposal candidate. */
export type PinBumpItem = {
  readonly kind: typeof SURFACE_PIN_BUMP;
  readonly agent: string;
  /** The agent's current (older) pinned id. */
  readonly oldModelId: string;
  /** The newer same-family catalog id available. */
  readonly newModelId: string;
};

export type ModelDiff = {
  readonly newTiers: readonly NewTierItem[];
  readonly pinBumps: readonly PinBumpItem[];
};

/**
 * Phase 999.98 D10 — pure diff. NO IO, NO dedup (dedup is the surfacing layer's
 * job so the diff stays a pure function of its inputs).
 *
 * @param discovered the entitled `ModelInfo[]` discovered THIS tick.
 * @param snapshot the PRE-tick catalog snapshot (used to detect new families).
 * @param pinnedAgents running agents with a CONCRETE pinned model (an
 *   `@latest`-track agent is NOT a pin-bump target — it adopts new tiers live).
 */
export function computeModelDiff(
  discovered: readonly ModelInfo[],
  snapshot: CatalogSnapshot,
  pinnedAgents: readonly PinnedAgentInput[],
): ModelDiff {
  // Families already known from the pre-tick snapshot.
  const knownFamilies = new Set<string>();
  for (const row of snapshot) {
    const fam = deriveFamily(row.model_id);
    if (fam) knownFamilies.add(fam);
  }

  // New tiers: a discovered model whose family is NOT in the pre-tick snapshot.
  // Dedup by family so two simultaneous models of one new family surface once.
  const newTiers: NewTierItem[] = [];
  const surfacedFamilies = new Set<string>();
  for (const m of discovered) {
    const fam = deriveFamily(m.value);
    if (fam === null) continue; // unidentifiable family — skip, never mis-bucket
    if (knownFamilies.has(fam)) continue;
    if (surfacedFamilies.has(fam)) continue;
    surfacedFamilies.add(fam);
    newTiers.push({
      kind: SURFACE_NEW_TIER,
      modelId: m.value,
      displayName: m.displayName,
      family: fam,
    });
  }

  // Pin bumps: for each pinned agent, find the catalog id of the SAME family
  // that ranks STRICTLY NEWER than the agent's pinned id. Search the union of
  // {discovered ∪ snapshot} so a model seen in a prior tick still counts.
  const unionById = new Map<string, string>(); // model_id -> family
  for (const row of snapshot) {
    const fam = deriveFamily(row.model_id);
    if (fam) unionById.set(row.model_id, fam);
  }
  for (const m of discovered) {
    const fam = deriveFamily(m.value);
    if (fam) unionById.set(m.value, fam);
  }

  const pinBumps: PinBumpItem[] = [];
  for (const agent of pinnedAgents) {
    let newest: string | null = null;
    for (const [id, fam] of unionById) {
      if (fam !== agent.family) continue;
      if (compareModelVersion(id, agent.resolvedModelId) <= 0) continue; // not newer
      if (newest === null || compareModelVersion(id, newest) > 0) {
        newest = id;
      }
    }
    if (newest !== null) {
      pinBumps.push({
        kind: SURFACE_PIN_BUMP,
        agent: agent.name,
        oldModelId: agent.resolvedModelId,
        newModelId: newest,
      });
    }
  }

  return { newTiers, pinBumps };
}

/** IO deps for surfacing — all injected so the cron can wire prod / tests stub. */
export type SurfaceDeps = {
  readonly postToAdminClawdy: (msg: string) => Promise<void>;
  readonly wasSurfaced: (kind: string, modelId: string) => boolean;
  readonly markSurfaced: (kind: string, modelId: string, at: number) => void;
  readonly now: () => number;
  readonly log: {
    readonly info: (msg: string) => void;
    readonly warn: (msg: string) => void;
    readonly error: (msg: string) => void;
  };
};

/**
 * Phase 999.98 D10 — surface each non-deduped diff item to Admin Clawdy.
 *
 * Dedup: every surface is gated on `wasSurfaced(kind, model_id)` and recorded
 * with `markSurfaced(kind, model_id, now)` AFTER a successful post. A failed
 * post is NOT marked (so the next tick retries) and is logged — it never throws
 * out of this function (the cron's onTick try/catch is the outer net, but
 * surfacing degrades gracefully on a single send failure too).
 *
 * NEVER performs a live model switch — pin-bumps are proposals only (D10).
 */
export async function surfaceModelDiff(
  diff: ModelDiff,
  deps: SurfaceDeps,
): Promise<void> {
  const at = deps.now();

  for (const item of diff.newTiers) {
    // Dedup the new-tier surface on (kind, model_id).
    if (deps.wasSurfaced(item.kind, item.modelId)) continue;
    const msg =
      `New Anthropic model tier available: \`${item.displayName}\` ` +
      `(\`${item.modelId}\`). Use \`model: ${item.family}\` or ` +
      `\`${item.family}@latest\` in clawcode.yaml to adopt it.`;
    try {
      await deps.postToAdminClawdy(msg);
      deps.markSurfaced(item.kind, item.modelId, at);
    } catch (err) {
      deps.log.warn(
        `[model-monitor] new-tier surface failed for ${item.modelId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  for (const item of diff.pinBumps) {
    // Dedup the pin-bump surface on (kind, NEW model_id) — independent of the
    // new-tier stream for the same id (the per-kind dedup table guarantees it).
    if (deps.wasSurfaced(item.kind, item.newModelId)) continue;
    const msg =
      `Agent \`${item.agent}\` is pinned to \`${item.oldModelId}\`; ` +
      `\`${item.newModelId}\` is now available (same family). This is a ` +
      `PROPOSAL only — edit clawcode.yaml and restart the agent to adopt it. ` +
      `(Pinned agents are never auto-switched.)`;
    try {
      await deps.postToAdminClawdy(msg);
      deps.markSurfaced(item.kind, item.newModelId, at);
    } catch (err) {
      deps.log.warn(
        `[model-monitor] pin-bump surface failed for ${item.agent} → ${item.newModelId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
