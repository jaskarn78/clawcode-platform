/**
 * Live claude.ai plan usage for the research usage guard.
 *
 * Operator (2026-09-26): usage must come from Claude, not from what we infer. The
 * SDK exposes the data behind Claude Code's `/usage` (Anthropic's usage
 * endpoint) as an experimental control request on any live session; every
 * agent shares the fleet account, so one answer covers them all. This probe
 * asks a running agent every few minutes and caches the answer. The guard
 * trusts it while it's fresh and falls back to the SDK's rate_limit_event
 * snapshots only when the probe has no recent answer.
 */

import type { SdkPlanUsage } from "../manager/sdk-types.js";
import { liveAccountSnapshots } from "../manager/research-usage-guard.js";
import type { RateLimitSnapshot } from "./rate-limit-tracker.js";

/** A probe answer older than this is not trusted; the guard falls back. */
export const PLAN_USAGE_FRESH_MS = 15 * 60 * 1000;

const WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;

/** Convert the `/usage` answer (percent 0-100) into snapshots (0-1) in the
 *  same shape the rate_limit_event tracker stores, so every consumer (the
 *  research guard, /clawcode-usage, /clawcode-status, the dashboard) reads one type. */
export function planUsageToSnapshots(resp: SdkPlanUsage, now: number): RateLimitSnapshot[] {
  if (!resp.rate_limits_available || !resp.rate_limits) return [];
  const out: RateLimitSnapshot[] = [];
  for (const name of WINDOWS) {
    const w = resp.rate_limits[name];
    if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    const util = w.utilization / 100;
    const resetsAt = w.resets_at ? Date.parse(w.resets_at) : Number.NaN;
    out.push(
      Object.freeze({
        rateLimitType: name,
        status: util >= 1 ? ("rejected" as const) : ("allowed" as const),
        utilization: util,
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
        surpassedThreshold: undefined,
        overageStatus: undefined,
        overageResetsAt: undefined,
        overageDisabledReason: undefined,
        isUsingOverage: undefined,
        recordedAt: now,
      }),
    );
  }
  return out;
}

export type PlanUsageSource = () => ReadonlyArray<() => Promise<SdkPlanUsage | null>>;

type LoggerLike = { warn: (obj: unknown, msg?: string) => void };

export class PlanUsageProbe {
  private snapshots: readonly RateLimitSnapshot[] = [];
  private fetchedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly sources: PlanUsageSource,
    private readonly log?: LoggerLike,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last live answer, or null when none is fresh enough to trust. */
  fresh(): readonly RateLimitSnapshot[] | null {
    return this.snapshots.length > 0 && this.now() - this.fetchedAt <= PLAN_USAGE_FRESH_MS ? this.snapshots : null;
  }

  /** Ask one live session for `/usage`; try the next on failure. Never throws. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchOnce(): Promise<void> {
    for (const ask of this.sources()) {
      try {
        const resp = await ask();
        if (!resp) continue;
        const snaps = planUsageToSnapshots(resp, this.now());
        if (snaps.length === 0) continue;
        this.snapshots = Object.freeze(snaps);
        this.fetchedAt = this.now();
        return;
      } catch (err) {
        this.log?.warn({ error: (err as Error).message }, "plan-usage probe: /usage request failed (trying next session)");
      }
    }
  }
}

/* ---------- one shared source for every usage surface ---------- */

let active: PlanUsageProbe | undefined;

/** The daemon registers its probe at boot. */
export function setActivePlanUsageProbe(p: PlanUsageProbe | undefined): void {
  active = p;
}

/** How long a slash command waits for a stale probe to refresh. */
export const LIVE_REFRESH_WAIT_MS = 4000;

/**
 * Live `/usage` snapshots, refreshing once if stale (waiting at most
 * `waitMs`, so a slow session never hangs a slash command). Null when
 * unavailable.
 */
export async function livePlanSnapshots(
  waitMs: number = LIVE_REFRESH_WAIT_MS,
): Promise<readonly RateLimitSnapshot[] | null> {
  if (!active) return null;
  const now = active.fresh();
  if (now) return now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
    timer.unref?.();
  });
  await Promise.race([active.refresh(), timeout]);
  clearTimeout(timer);
  return active.fresh();
}

const LIVE_TYPES = new Set(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]);

/**
 * What every usage surface should show: Anthropic's live `/usage` windows when
 * available, plus any other tracked window (e.g. an overage-inclusive weekly
 * one) only if it is fresh and belongs to the live account. With no live
 * answer, the tracked snapshots filtered the same way (a previous account's
 * rows and anything older than 24h are dropped).
 */
export function effectiveSnapshots(
  tracked: readonly RateLimitSnapshot[],
  live: readonly RateLimitSnapshot[] | null,
  now: number,
): RateLimitSnapshot[] {
  if (!live || live.length === 0) return liveAccountSnapshots(tracked, now);
  const extra = liveAccountSnapshots([...live, ...tracked], now).filter(
    (s) => !LIVE_TYPES.has(s.rateLimitType) && tracked.includes(s),
  );
  return [...live, ...extra];
}
