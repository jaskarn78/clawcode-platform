/**
 * P3 (memory program, 3a) — governor for haiku-via-bridge one-shot claude
 * children: the last wholly-unbounded spawn path in the fleet.
 *
 * `runHaikuViaBridge` raw-spawns a claude CLI (bypassing startAgent /
 * makeDetachedSpawn / the registry) from 4 message-path sites
 * (summarizer, vision-pre-pass, dream, skill-distiller) with — until now —
 * no concurrency bound, no timeout, and no census visibility (P1's
 * MemoryGuard misfiled them under managed classes).
 *
 * This module supplies exactly the three missing properties and nothing
 * else (deliberately NOT routed through startAgent — a one-shot --print
 * call must not drag registry/memory/warm-path lifecycle into the
 * message path):
 *   1. a FIFO semaphore (reusing image-work-governor's proven Semaphore)
 *      with a SOFT acquire timeout — on timeout we log and PROCEED
 *      WITHOUT a slot, because summarization must never break on a
 *      wedged slot-holder (message-path fail-open);
 *   2. per-site child hard-timeouts (enforced in haiku-via-bridge);
 *   3. a live pid registry feeding MemoryGuard's census (`bridge-cli`
 *      class via the daemon's getManagedPids closure).
 */

import { Semaphore } from "../manager/image-work-governor.js";
import type { Logger } from "pino";

export type HaikuBridgeGovernorSite =
  | "summarizer"
  | "vision-pre-pass"
  | "dream"
  | "skill-distiller"
  | (string & {})
  | "fast-lane";

export const BRIDGE_SPAWN_DEFAULTS = Object.freeze({
  maxConcurrent: 3,
  /** Soft — on expiry the caller proceeds WITHOUT a slot (fail-open). */
  acquireSoftTimeoutMs: 15_000,
  /** Hard per-child ceilings; unknown sites get the conservative slow one. */
  childTimeoutMsBySite: Object.freeze({
    summarizer: 60_000,
    "vision-pre-pass": 60_000,
    dream: 300_000,
    "skill-distiller": 300_000,
    // Matches SYNTHESIS_TIMEOUT_MS in workflow-reports.ts. If the child
    // outlived the caller's race the process would linger with nobody waiting
    // on it - the exact orphan shape this fleet has had to reap before.
    "workflow-report": 180_000,
    // Phase 999.154 — a labeled 9-image Haiku batch measured ~20 s wall; 10
    // images at 1024px leaves wide headroom under 120 s. The canary is one
    // tiny PNG. OCR vision may run Sonnet on a dense page.
    "ingest-vision": 120_000,
    "vision-canary": 60_000,
    "ocr-vision": 120_000,
  }) as Readonly<Record<string, number>>,
  childTimeoutMsDefault: 300_000,
});

export function childTimeoutMsForSite(site: string): number {
  return (
    BRIDGE_SPAWN_DEFAULTS.childTimeoutMsBySite[site] ??
    BRIDGE_SPAWN_DEFAULTS.childTimeoutMsDefault
  );
}

const semaphore = new Semaphore(BRIDGE_SPAWN_DEFAULTS.maxConcurrent);
const bridgeChildPids = new Set<number>();

export function registerBridgeChild(pid: number): void {
  if (Number.isFinite(pid) && pid > 1) bridgeChildPids.add(pid);
}

export function unregisterBridgeChild(pid: number): void {
  bridgeChildPids.delete(pid);
}

/** Snapshot for MemoryGuard's census (`bridge-cli` class). */
export function getBridgeChildPids(): ReadonlySet<number> {
  return new Set(bridgeChildPids);
}

/**
 * Run `fn` under a bridge spawn slot. Soft-timeout acquire: if no slot
 * frees within `acquireSoftTimeoutMs`, log a warn and run WITHOUT the
 * slot — the per-child hard timeout still bounds total resource use, so
 * a wedged slot-holder can degrade the cap but never break the
 * summarizer/vision message path.
 */
export async function withBridgeSpawnSlot<T>(
  site: HaikuBridgeGovernorSite,
  log: Logger | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const acquirePromise = semaphore.acquire().then(() => true as const);
  const got = await Promise.race([
    acquirePromise,
    new Promise<false>((resolve) => {
      const t = setTimeout(
        () => resolve(false),
        BRIDGE_SPAWN_DEFAULTS.acquireSoftTimeoutMs,
      );
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
  if (!got) {
    log?.warn(
      { tag: "bridge-spawn-governor", site },
      "bridge spawn slot acquire soft-timed-out — proceeding WITHOUT a slot (fail-open)",
    );
    // The abandoned acquire is still queued in the semaphore — when it
    // eventually resolves, hand the permit straight back so it can't leak.
    void acquirePromise.then(() => semaphore.release());
  }
  try {
    return await fn();
  } finally {
    if (got) semaphore.release();
  }
}
