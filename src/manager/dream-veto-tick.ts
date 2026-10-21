/**
 * Phase 999.188 — the veto-window tick. Phase 115 shipped the store and the
 * 30-minute window; nothing ever called `tick`, so scheduled promotions sat
 * `pending` forever. One fleet-wide cron (every minute) drives the store;
 * the apply callback (daemon edge) resolves the agent's memory root and
 * writes MEMORY.md through `promoteCandidates`.
 *
 * Pure-DI, same cron factory seam as dream-cron.ts. `runOnce` is exposed so
 * the approve IPC can apply immediately after closing a window.
 */

import { Cron } from "croner";
import type { VetoApplyFn, VetoStore } from "./dream-veto-store.js";

export interface VetoTickHandle {
  readonly stop: () => void;
  /** Run one tick now (used by the approve IPC and by tests). */
  readonly runOnce: () => Promise<readonly string[]>;
}

export type VetoTickCronFactory = (
  pattern: string,
  opts: { readonly name: string },
  callback: () => void | Promise<void>,
) => { readonly stop: () => void };

const DEFAULT_FACTORY: VetoTickCronFactory = (pattern, opts, callback) => {
  const cron = new Cron(pattern, { name: opts.name }, async () => {
    await callback();
  });
  return { stop: () => cron.stop() };
};

export interface RegisterVetoTickDeps {
  readonly vetoStore: VetoStore;
  readonly applyRow: VetoApplyFn;
  readonly now: () => Date;
  readonly log: {
    readonly info: (obj: Record<string, unknown>, msg: string) => void;
    readonly warn: (obj: Record<string, unknown>, msg: string) => void;
  };
  /** Cron cadence in minutes (1..59). Default 1. */
  readonly everyMinutes?: number;
  readonly cronFactory?: VetoTickCronFactory;
  /** Fires once per applied run (channel confirmation). Best-effort. */
  readonly onApplied?: (runId: string) => Promise<void>;
}

export function registerDreamVetoTick(deps: RegisterVetoTickDeps): VetoTickHandle {
  const every = Math.min(Math.max(Math.floor(deps.everyMinutes ?? 1), 1), 59);
  let inFlight: Promise<readonly string[]> | null = null;

  const runOnce = async (): Promise<readonly string[]> => {
    // Serialise: an approve IPC landing mid-tick waits for the tick.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const applied = await deps.vetoStore.tick(deps.now(), deps.applyRow);
        if (applied.length > 0) {
          deps.log.info({ applied, action: "dream-veto-tick-applied" }, "[dream] veto windows closed and applied");
          for (const runId of applied) {
            try {
              await deps.onApplied?.(runId);
            } catch (err) {
              deps.log.warn({ runId, err: err instanceof Error ? err.message : String(err) }, "[dream] post-apply confirmation failed (non-fatal)");
            }
          }
        }
        return applied;
      } catch (err) {
        deps.log.warn({ err: err instanceof Error ? err.message : String(err), action: "dream-veto-tick-failed" }, "[dream] veto tick failed; next tick retries");
        return [];
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const handle = (deps.cronFactory ?? DEFAULT_FACTORY)(`*/${every} * * * *`, { name: "dream-veto-tick" }, async () => {
    await runOnce();
  });
  return { stop: () => handle.stop(), runOnce };
}
