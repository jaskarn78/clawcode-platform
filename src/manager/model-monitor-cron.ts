/**
 * Phase 999.98 D9 — croner-landmine-safe model-monitor poll cron.
 *
 * Modeled EXACTLY on `dream-cron.ts` / `daily-summary-cron.ts`:
 *   - DI `cronFactory` (prod wraps `new Cron(...)`; tests inject a stub that
 *     captures the callback for synchronous triggering).
 *   - CONSTRUCTION wrapped in try/catch → returns `{registered:false,
 *     reason:'pattern-error'}` on a bad pattern (the daemon boot loop logs +
 *     continues — INC-2026-06-04 fail-open).
 *   - `onTick` body FULLY wrapped in try/catch → logs + returns; a single
 *     mis-fire never crashes the cron and the NEXT tick still fires.
 *
 * INC-2026-06-04: an unguarded croner throw crash-looped the entire daemon and
 * blew the org `op` cap. The static pattern below cannot itself trip the
 * minute-step "step greater than 60" bug — it is a literal six-hourly pattern
 * (hour field stepped by 6, minute field a fixed 0), NOT derived from any
 * input. The defense-in-depth construction guard is kept anyway — that is the
 * exact mitigation shape the incident demands.
 */

import { Cron } from "croner";
import type { ModelInfo } from "./sdk-types.js";
import type { ModelCatalogStore } from "./model-catalog-store.js";
import { deriveFamily } from "./model-resolver.js";
import {
  computeModelDiff,
  surfaceModelDiff,
  type PinnedAgentInput,
} from "./model-monitor.js";

/**
 * STATIC poll pattern — six-hourly. A literal "0 (slash)6 * * *" (minute 0,
 * hour stepped by 6); NEVER interpolated from user/config input (T-99998-07).
 * The hour-field step (6) is ≤24, so it cannot trip the minute-field
 * "step greater than 60" bug from INC-2026-06-04.
 */
export const MODEL_MONITOR_CRON_PATTERN = "0 */6 * * *";

/** Cron handle — trims the surface to `.stop()` (mirrors DreamCronHandle). */
export interface ModelMonitorCronHandle {
  readonly stop: () => void;
}

/** Factory signature. Prod wraps `new Cron(...)`; tests capture the callback. */
export type ModelMonitorCronFactory = (
  pattern: string,
  opts: { readonly name: string },
  callback: () => void | Promise<void>,
) => ModelMonitorCronHandle;

/** Default production factory — thin wrapper over `new Cron(...)`. */
const DEFAULT_FACTORY: ModelMonitorCronFactory = (pattern, opts, callback) => {
  const cron = new Cron(pattern, { name: opts.name }, async () => {
    await callback();
  });
  return { stop: () => cron.stop() };
};

/** A handle exposing the per-agent entitled-model accessor the tick reads. */
export interface ModelMonitorHandleLike {
  getSupportedModels(): Promise<readonly ModelInfo[]>;
}

/**
 * Registration deps. Production wiring (daemon edge) bridges the catalog store,
 * the session-manager accessors, and the Admin-Clawdy sender; tests inject
 * stubs (including the cronFactory).
 */
export interface ModelMonitorCronDeps {
  readonly catalogStore: ModelCatalogStore;
  /** Names of currently-running agents (manager.getRunningAgents()). */
  readonly getRunningAgents: () => readonly string[];
  /** Per-agent handle accessor (manager.getSessionHandle(name)). */
  readonly getHandle: (name: string) => ModelMonitorHandleLike | undefined;
  /**
   * Builds the pin-bump candidate list for the diff: running agents pinned to a
   * CONCRETE model (an `@latest`-track agent is excluded — it adopts new tiers
   * live, so it is never a pin-bump proposal target). Returned by the daemon
   * which owns the resolved-config + resolveModelId mapping.
   */
  readonly getPinnedAgents: () => readonly PinnedAgentInput[];
  /** Refreshes the daemon's `@latest` snapshot ref after the upsert. */
  readonly refreshSnapshot: () => void;
  /** Admin-Clawdy sender (the existing daemon postToAdminClawdy closure). */
  readonly postToAdminClawdy: (msg: string) => Promise<void>;
  readonly now: () => number;
  readonly log: {
    readonly info: (msg: string) => void;
    readonly warn: (msg: string) => void;
    readonly error: (msg: string) => void;
  };
  /** Test override — defaults to the real croner factory. */
  readonly cronFactory?: ModelMonitorCronFactory;
}

export interface ModelMonitorCronRegistration {
  readonly registered: boolean;
  readonly reason?: string;
  readonly stop?: () => void;
}

/**
 * Register the model-monitor poll cron.
 *
 * onTick (fully guarded):
 *   1. Snapshot the catalog BEFORE the upsert (the diff baseline).
 *   2. For each running agent, pull `getSupportedModels()` and union the
 *      entitled set (per-agent failures are caught and skipped — one bad handle
 *      never aborts the tick).
 *   3. Upsert the union into the catalog; refresh the daemon `@latest` snapshot.
 *   4. computeModelDiff(union, preSnapshot, pinnedAgents) → surfaceModelDiff
 *      (dedup-gated, proposal-only for pins).
 *
 * Any throw inside onTick is caught + logged; the cron keeps firing.
 */
export function registerModelMonitorCron(
  deps: ModelMonitorCronDeps,
): ModelMonitorCronRegistration {
  const factory = deps.cronFactory ?? DEFAULT_FACTORY;

  const onTick = async (): Promise<void> => {
    try {
      // 1. Pre-tick snapshot = the diff baseline (new families detected against
      //    this).
      const preSnapshot = deps.catalogStore.snapshot();

      // 2. Union the entitled model set across running agents. Dedup by id.
      const unionById = new Map<string, ModelInfo>();
      for (const name of deps.getRunningAgents()) {
        const handle = deps.getHandle(name);
        if (!handle) continue;
        try {
          const models = await handle.getSupportedModels();
          for (const m of models) {
            if (deriveFamily(m.value) === null) continue; // skip unrelated ids
            unionById.set(m.value, m);
          }
        } catch (err) {
          deps.log.warn(
            `[model-monitor] getSupportedModels failed for ${name}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      const discovered = [...unionById.values()];

      // 3. Upsert + refresh the @latest snapshot.
      const now = deps.now();
      deps.catalogStore.upsert(discovered, now);
      deps.refreshSnapshot();

      // 4. COLD-START GUARD — on the FIRST tick after a fresh deploy the catalog
      //    is empty, so `computeModelDiff` would flag EVERY currently-entitled
      //    family as a "new tier" (each is absent from the empty preSnapshot) →
      //    4 spurious "New Anthropic model tier available" posts to Admin Clawdy
      //    for models that have been running forever (a false-positive of the
      //    "surface only NEW tiers" intent). Treat an empty preSnapshot as a
      //    BASELINE-SEEDING tick: upsert + refresh (done above), but skip
      //    surfacing. The catalog is durable (SQLite persists across restarts),
      //    so this is a genuine one-time first-deploy event — the NEXT tick has
      //    a populated baseline and surfaces only genuinely-new models. Skipping
      //    a first-tick pin-bump once is harmless (re-evaluated next tick).
      if (preSnapshot.length === 0) {
        deps.log.info(
          `[model-monitor] baseline-seeding tick (empty catalog) — recorded ${discovered.length} entitled models, surfacing skipped`,
        );
        return;
      }

      // 5. Diff against the PRE-tick snapshot + surface (dedup, proposal-only).
      const diff = computeModelDiff(
        discovered,
        preSnapshot,
        deps.getPinnedAgents(),
      );
      await surfaceModelDiff(diff, {
        postToAdminClawdy: deps.postToAdminClawdy,
        wasSurfaced: (kind, id) => deps.catalogStore.wasSurfaced(kind, id),
        markSurfaced: (kind, id, at) =>
          deps.catalogStore.markSurfaced(kind, id, at),
        now: deps.now,
        log: deps.log,
      });
    } catch (err) {
      // INC-2026-06-04 fail-open: a single mis-fire is logged and swallowed; the
      // cron keeps firing on the next tick.
      deps.log.error(
        `[model-monitor] tick crashed (caught): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // Defense-in-depth: even with the static valid pattern, any croner
  // construction failure degrades the monitor, never crashes the daemon.
  let handle: ModelMonitorCronHandle;
  try {
    handle = factory(
      MODEL_MONITOR_CRON_PATTERN,
      { name: "model-monitor" },
      onTick,
    );
  } catch (err) {
    deps.log.error(
      `[model-monitor] cron registration failed (pattern=${MODEL_MONITOR_CRON_PATTERN}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { registered: false, reason: "pattern-error" };
  }

  return { registered: true, stop: () => handle.stop() };
}
