/**
 * Phase 999.173 polish — usage-aware research launch guard.
 *
 * The fleet shares one Claude account; it hit its usage limit twice on
 * 2026-09-25, the second time mid-research (3 researchers, 351 tool calls in
 * ~6 min). Before a researcher launches, the launch gate asks this module how
 * close the account is to its limit:
 *
 *   limited (a window is `rejected`) or ≥ blockAt  → block every launch
 *   ≥ reduceAt                                     → at most 1 per origin
 *   below                                          → the normal cap
 *   no usable signal at all                        → fail open (logged)
 *
 * Signal: the SDK's `rate_limit_event`s, recorded per agent by
 * RateLimitTracker (src/usage/rate-limit-tracker.ts). Every agent sees the
 * same account, so the daemon registers ONE provider returning all agents'
 * snapshots and the freshest per window wins. Windows considered: the
 * 5-hour session window and the weekly ones (`seven_day*`); `overage` is not
 * a limit on its own. A snapshot whose window already reset counts as 0 %;
 * one older than MAX_SIGNAL_AGE_MS with no reset time is stale and ignored.
 *
 * Account epoch (2026-09-26 fix): after an account swap (999.176) the other
 * account's snapshots linger in every agent's usage.db with FUTURE reset
 * times, so a 92% weekly reading from the old account blocked research on a
 * fresh one. Every window of one account shares its weekly reset time, so the
 * most recently recorded weekly snapshot identifies the live account and
 * weekly snapshots with a different reset time are dropped. Any snapshot not
 * refreshed within MAX_ANY_SIGNAL_AGE_MS is dropped too; no usable signal
 * fails open, as before.
 */

export type UsageSnapshotLike = Readonly<{
  rateLimitType: string;
  status: "allowed" | "allowed_warning" | "rejected";
  utilization: number | undefined;
  resetsAt: number | undefined;
  recordedAt: number;
}>;

export type UsageGuardThresholds = Readonly<{ reduceAt: number; blockAt: number }>;

export const DEFAULT_USAGE_GUARD: UsageGuardThresholds = Object.freeze({ reduceAt: 0.7, blockAt: 0.85 });

/** A signal with no reset time older than this says nothing about now. */
export const MAX_SIGNAL_AGE_MS = 6 * 60 * 60 * 1000;

/** Any signal not refreshed within this is ignored, reset time or not. */
export const MAX_ANY_SIGNAL_AGE_MS = 24 * 60 * 60 * 1000;

/** Weekly windows of one account reset together; allow a little jitter. */
const SAME_ACCOUNT_RESET_TOLERANCE_MS = 60 * 60 * 1000;

export type UsageBand = "normal" | "reduce" | "block" | "unknown";

export type UsageGuardState = Readonly<{
  band: UsageBand;
  /** Highest utilization among usable windows (0..1); undefined when unknown. */
  utilization?: number;
  /** The window that set the band ("five_hour", "seven_day" …). */
  window?: string;
  /** A window is already rejected (the account is at its limit). */
  limited: boolean;
  /** When the binding window resets (ms epoch), if known. */
  resetsAt?: number;
}>;

const LIMIT_WINDOWS = /^(five_hour|seven_day)/;

let provider: (() => readonly UsageSnapshotLike[]) | undefined;

/** The daemon registers the fleet-wide snapshot source at boot. */
export function setResearchUsageProvider(p: (() => readonly UsageSnapshotLike[]) | undefined): void {
  provider = p;
}

export function currentUsageSnapshots(): readonly UsageSnapshotLike[] {
  try {
    return provider?.() ?? [];
  } catch {
    return [];
  }
}

const WEEKLY = /^seven_day/;

/**
 * Drop signals that can't describe the live account: anything not refreshed
 * in 24h, and weekly snapshots whose reset time differs from the most
 * recently recorded weekly snapshot's (a previous account's epoch).
 */
export function liveAccountSnapshots<T extends UsageSnapshotLike>(
  snapshots: readonly T[],
  now: number,
): T[] {
  const recent = snapshots.filter((s) => now - s.recordedAt <= MAX_ANY_SIGNAL_AGE_MS);
  const anchor = recent
    .filter((s) => WEEKLY.test(s.rateLimitType) && s.resetsAt !== undefined && s.resetsAt > now)
    .reduce<T | undefined>((a, s) => (a === undefined || s.recordedAt > a.recordedAt ? s : a), undefined);
  if (anchor?.resetsAt === undefined) return recent;
  const epoch = anchor.resetsAt;
  return recent.filter(
    (s) =>
      !WEEKLY.test(s.rateLimitType) ||
      s.resetsAt === undefined ||
      s.resetsAt <= now ||
      Math.abs(s.resetsAt - epoch) <= SAME_ACCOUNT_RESET_TOLERANCE_MS,
  );
}

/** Freshest snapshot per limit window. */
function freshestByWindow(snapshots: readonly UsageSnapshotLike[]): UsageSnapshotLike[] {
  const best = new Map<string, UsageSnapshotLike>();
  for (const s of snapshots) {
    if (!LIMIT_WINDOWS.test(s.rateLimitType)) continue;
    const prev = best.get(s.rateLimitType);
    if (prev === undefined || s.recordedAt > prev.recordedAt) best.set(s.rateLimitType, s);
  }
  return [...best.values()];
}

export function evaluateUsageGuard(
  snapshots: readonly UsageSnapshotLike[],
  now: number,
  thresholds: UsageGuardThresholds = DEFAULT_USAGE_GUARD,
): UsageGuardState {
  let usable = 0;
  let limited = false;
  let limitedResetsAt: number | undefined;
  let top: { util: number; window: string; resetsAt: number | undefined } | undefined;
  for (const s of freshestByWindow(liveAccountSnapshots(snapshots, now))) {
    const windowReset = s.resetsAt !== undefined && s.resetsAt <= now;
    if (windowReset) {
      usable++;
      if (top === undefined) top = { util: 0, window: s.rateLimitType, resetsAt: undefined };
      continue;
    }
    if (s.resetsAt === undefined && now - s.recordedAt > MAX_SIGNAL_AGE_MS) continue;
    if (s.status === "rejected") {
      usable++;
      limited = true;
      if (s.resetsAt !== undefined && (limitedResetsAt === undefined || s.resetsAt > limitedResetsAt)) {
        limitedResetsAt = s.resetsAt;
      }
      continue;
    }
    if (typeof s.utilization !== "number" || !Number.isFinite(s.utilization)) continue;
    usable++;
    if (top === undefined || s.utilization > top.util) {
      top = { util: s.utilization, window: s.rateLimitType, resetsAt: s.resetsAt };
    }
  }
  if (limited) {
    return { band: "block", limited: true, utilization: 1, ...(limitedResetsAt !== undefined ? { resetsAt: limitedResetsAt } : {}) };
  }
  if (usable === 0 || top === undefined) return { band: "unknown", limited: false };
  const band: UsageBand = top.util >= thresholds.blockAt ? "block" : top.util >= thresholds.reduceAt ? "reduce" : "normal";
  return {
    band,
    limited: false,
    utilization: top.util,
    window: top.window,
    ...(top.resetsAt !== undefined ? { resetsAt: top.resetsAt } : {}),
  };
}

/** "5:30 PM PT" in the operator's zone. */
export function formatResetAt(ms: number, timeZone = "America/Los_Angeles"): string {
  const t = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(ms));
  const abbr = timeZone === "America/Los_Angeles" ? "PT" : timeZone;
  return `${t} ${abbr}`;
}

export function usageDenyText(state: UsageGuardState, now: number): string {
  const when = state.resetsAt !== undefined && state.resetsAt > now ? ` (resets ${formatResetAt(state.resetsAt)})` : "";
  const why = state.limited
    ? `The Claude usage limit is reached${when}.`
    : `Research is paused near the Claude usage limit: ${Math.round((state.utilization ?? 1) * 100)}% used${when}.`;
  return `${why} Do not launch researchers. Answer inline from what you can do yourself, and tell the user research is paused until the limit resets.`;
}

export const USAGE_REDUCED_DENY_TEXT =
  "Near the Claude usage limit, only one researcher may run per request. Fold this sub-question into the running researcher's results or answer it inline.";

/** One line for `/clawcode-ux feature:research state:status`. */
export function usageStatusLine(state: UsageGuardState, thresholds: UsageGuardThresholds, now: number): string {
  const limits = `reduce at ${Math.round(thresholds.reduceAt * 100)}%, block at ${Math.round(thresholds.blockAt * 100)}%`;
  if (state.band === "unknown") return `Usage guard: no usage data yet, launches allowed (${limits}).`;
  const pct = `${Math.round((state.utilization ?? 0) * 100)}%`;
  const window = state.window === "five_hour" ? "5-hour window" : state.window?.startsWith("seven_day") ? "weekly window" : "usage";
  const when = state.resetsAt !== undefined && state.resetsAt > now ? `, resets ${formatResetAt(state.resetsAt)}` : "";
  const effect =
    state.band === "block"
      ? "research paused"
      : state.band === "reduce"
        ? "limited to 1 researcher per request"
        : "normal";
  if (state.limited) return `Usage guard: limit reached${when} — research paused (${limits}).`;
  return `Usage guard: ${pct} of the ${window}${when} — ${effect} (${limits}).`;
}
