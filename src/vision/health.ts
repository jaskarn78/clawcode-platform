/**
 * Phase 999.154 — per-provider health. A provider goes unhealthy after
 * FAILURE_THRESHOLD consecutive failures (live calls or canary) and is
 * skipped by the failover chain until a success (normally the next canary)
 * restores it. Transitions are reported once, not per image.
 */

import type { VisionProviderId } from "./types.js";

export const FAILURE_THRESHOLD = 2;

export type ProviderHealthSnapshot = {
  readonly healthy: boolean;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly lastChangeAt: number | null;
};

export type HealthTransition = {
  readonly provider: VisionProviderId;
  readonly healthy: boolean;
  readonly reason: string;
};

type Entry = ProviderHealthSnapshot;

const INITIAL: Entry = Object.freeze({
  healthy: true,
  consecutiveFailures: 0,
  lastError: null,
  lastChangeAt: null,
});

export class VisionHealth {
  private entries = new Map<VisionProviderId, Entry>();

  constructor(
    private readonly onTransition: (t: HealthTransition) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  get(id: VisionProviderId): ProviderHealthSnapshot {
    return this.entries.get(id) ?? INITIAL;
  }

  isHealthy(id: VisionProviderId): boolean {
    return this.get(id).healthy;
  }

  markSuccess(id: VisionProviderId): void {
    const prev = this.get(id);
    this.entries.set(id, {
      healthy: true,
      consecutiveFailures: 0,
      lastError: null,
      lastChangeAt: prev.healthy ? prev.lastChangeAt : this.now(),
    });
    if (!prev.healthy) {
      this.onTransition({ provider: id, healthy: true, reason: "recovered" });
    }
  }

  markFailure(id: VisionProviderId, reason: string): void {
    const prev = this.get(id);
    const failures = prev.consecutiveFailures + 1;
    const healthy = failures < FAILURE_THRESHOLD;
    this.entries.set(id, {
      healthy,
      consecutiveFailures: failures,
      lastError: reason,
      lastChangeAt: healthy === prev.healthy ? prev.lastChangeAt : this.now(),
    });
    if (prev.healthy && !healthy) {
      this.onTransition({ provider: id, healthy: false, reason });
    }
  }
}
