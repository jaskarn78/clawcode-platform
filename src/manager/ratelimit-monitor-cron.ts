/**
 * INC-2026-08-08 — 1Password service-account ratelimit monitor cron.
 *
 * The 1,000-reads/24h cap is enforced across ALL service accounts on the
 * account. On 2026-08-08 two smarthome cron jobs shelling `op read` directly
 * (bypassing the daemon SecretsResolver) drained it, and the first signal the
 * fleet got was agents failing to start. This cron makes exhaustion VISIBLE
 * hours before it bites.
 *
 * Modeled EXACTLY on `model-monitor-cron.ts` (itself modeled on dream-cron /
 * daily-summary-cron):
 *   - DI `cronFactory` (prod wraps `new Cron(...)`; tests inject a stub that
 *     captures the callback for synchronous triggering).
 *   - CONSTRUCTION wrapped in try/catch → returns `{registered:false,
 *     reason:'pattern-error'}` (INC-2026-06-04 fail-open).
 *   - `onTick` body FULLY wrapped in try/catch → logs + returns; one mis-fire
 *     never crashes the cron and the NEXT tick still fires.
 *
 * The pattern below is a STATIC literal, never interpolated from config
 * (T-99998-07). Minute 17 rather than 0 deliberately: the top of the hour is
 * where the standalone `op`-burning cron jobs fire, so an offset probe reads a
 * SETTLED counter instead of racing them.
 *
 * Alert semantics copied from MemoryGuard (`memory-guard.ts` ~838-880): dedup
 * by breach key, warn→critical escalation bypasses the cooldown, cooldown
 * otherwise, and an explicit CLEARED branch that deletes the key. The clear
 * branch is load-bearing — the 1P cap resets every 24h, and without it a stale
 * `lastAlertAt` would suppress the NEXT real breach for a full cooldown.
 */

import { Cron } from "croner";

/**
 * STATIC hourly poll pattern — minute 17 of every hour. NEVER derived from
 * user/config input. No stepped field, so it cannot trip the minute-field
 * "step greater than 60" croner bug from INC-2026-06-04.
 */
export const RATELIMIT_MONITOR_CRON_PATTERN = "17 * * * *";

/**
 * Tiers as FRACTIONS of the reported limit, not absolutes: at the documented
 * 1,000/24h account cap these are exactly the 700 (warn) / 900 (critical)
 * thresholds, and they stay correct if 1Password ever changes the cap.
 * Cooldown matches MEMORY_GUARD_DEFAULTS.alertCooldownMs (6h).
 */
export const RATELIMIT_MONITOR_DEFAULTS = Object.freeze({
  warnPct: 0.7,
  critPct: 0.9,
  alertCooldownMs: 6 * 60 * 60 * 1000,
});

/** Single breach key — mirrors MemoryGuard's `key` dedup dimension. */
export const RATELIMIT_ALERT_KEY = "op-ratelimit:account:read_write";

/** One parsed row of `op service-account ratelimit` output. */
export interface RatelimitRow {
  readonly type: string;
  readonly action: string;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  /** Free-text reset window ("23 hours from now"); "unknown" when blank. */
  readonly reset: string;
}

/** Header-derived column positions. */
interface RatelimitColumns {
  readonly type: number;
  readonly action: number;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly reset: number;
}

/**
 * Parse the `account` / `read_write` row out of the CLI's whitespace-aligned
 * table. HEADER-DRIVEN (column positions read from the header row) rather than
 * fixed offsets, so a column re-order or width change can't silently mis-read.
 * RESET is the last column and may contain spaces ("23 hours from now"), so
 * its tokens are joined to the end of the row.
 *
 * Returns null on ANY shape it doesn't recognise — the caller treats that as
 * "log and stay silent", never as an alert.
 */
export function parseAccountReadWriteRow(raw: string): RatelimitRow | null {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let headerIdx = -1;
  let cols: RatelimitColumns | null = null;
  for (let i = 0; i < lines.length; i++) {
    const upper = lines[i].split(/\s+/).map((t) => t.toUpperCase());
    const idx: RatelimitColumns = {
      type: upper.indexOf("TYPE"),
      action: upper.indexOf("ACTION"),
      limit: upper.indexOf("LIMIT"),
      used: upper.indexOf("USED"),
      remaining: upper.indexOf("REMAINING"),
      reset: upper.indexOf("RESET"),
    };
    if (Object.values(idx).every((v) => v >= 0)) {
      headerIdx = i;
      cols = idx;
      break;
    }
  }
  if (headerIdx === -1 || cols === null) return null;

  for (const line of lines.slice(headerIdx + 1)) {
    const tokens = line.split(/\s+/);
    if (tokens.length <= cols.remaining) continue;
    if (tokens[cols.type].toLowerCase() !== "account") continue;
    if (tokens[cols.action].toLowerCase() !== "read_write") continue;
    const limit = Number(tokens[cols.limit]);
    const used = Number(tokens[cols.used]);
    const remaining = Number(tokens[cols.remaining]);
    if (
      !Number.isFinite(limit) ||
      !Number.isFinite(used) ||
      !Number.isFinite(remaining)
    ) {
      return null;
    }
    const reset = tokens.slice(cols.reset).join(" ").trim();
    return {
      type: "account",
      action: "read_write",
      limit,
      used,
      remaining,
      reset: reset.length > 0 ? reset : "unknown",
    };
  }
  return null;
}

/** Cron handle — trims the surface to `.stop()` (mirrors ModelMonitorCronHandle). */
export interface RatelimitMonitorCronHandle {
  readonly stop: () => void;
}

/** Factory signature. Prod wraps `new Cron(...)`; tests capture the callback. */
export type RatelimitMonitorCronFactory = (
  pattern: string,
  opts: { readonly name: string },
  callback: () => void | Promise<void>,
) => RatelimitMonitorCronHandle;

/** Default production factory — thin wrapper over `new Cron(...)`. */
const DEFAULT_FACTORY: RatelimitMonitorCronFactory = (
  pattern,
  opts,
  callback,
) => {
  const cron = new Cron(pattern, { name: opts.name }, async () => {
    await callback();
  });
  return { stop: () => cron.stop() };
};

export interface RatelimitMonitorCronDeps {
  /**
   * Shells `op service-account ratelimit` and returns raw stdout. Production
   * wires `defaultOpRatelimitShellOut` from op-env-resolver.ts (same env
   * construction as every other `op` shell-out); tests inject a string.
   */
  readonly runRatelimitProbe: () => Promise<string>;
  /** Alert sink (the daemon's postToAdminClawdy closure). */
  readonly postToAdminClawdy: (msg: string) => Promise<void>;
  readonly now: () => number;
  readonly log: {
    readonly info: (msg: string) => void;
    readonly warn: (msg: string) => void;
    readonly error: (msg: string) => void;
  };
  /** Test/operator override — defaults to RATELIMIT_MONITOR_DEFAULTS. */
  readonly thresholds?: {
    readonly warnPct?: number;
    readonly critPct?: number;
    readonly alertCooldownMs?: number;
  };
  /** Test override — defaults to the real croner factory. */
  readonly cronFactory?: RatelimitMonitorCronFactory;
}

export interface RatelimitMonitorCronRegistration {
  readonly registered: boolean;
  readonly reason?: string;
  readonly stop?: () => void;
}

type Severity = "warn" | "critical";

/**
 * Register the hourly 1P ratelimit probe.
 *
 * onTick (fully guarded):
 *   1. Shell the probe; parse the `account read_write` row.
 *   2. Unparsable → transition-logged warn + RETURN. A parse failure that
 *      alerted would fire every hour forever — strictly worse than silence.
 *   3. Always log a greppable usage line (the trend record, alert or not).
 *   4. Below warn → clear any prior breach state (+ recovery log), return.
 *   5. At/above a tier → dedup + escalation + cooldown, then post an alert
 *      carrying full attribution (used/limit/%/remaining/reset).
 */
export function registerRatelimitMonitorCron(
  deps: RatelimitMonitorCronDeps,
): RatelimitMonitorCronRegistration {
  const factory = deps.cronFactory ?? DEFAULT_FACTORY;
  const warnPct = deps.thresholds?.warnPct ?? RATELIMIT_MONITOR_DEFAULTS.warnPct;
  const critPct = deps.thresholds?.critPct ?? RATELIMIT_MONITOR_DEFAULTS.critPct;
  const alertCooldownMs =
    deps.thresholds?.alertCooldownMs ??
    RATELIMIT_MONITOR_DEFAULTS.alertCooldownMs;

  /** breach key → {severity, lastAlertAt} — MemoryGuard's alertState shape. */
  const alertState = new Map<
    string,
    { severity: Severity; lastAlertAt: number }
  >();
  /**
   * Transition-logged parse failure (MemoryGuard's `lastLiveSetUnavailable`
   * pattern) — a CLI format change would otherwise emit 24 identical warns a
   * day. Warn once on entering the broken state, once more on recovery.
   */
  let parseFailureTicks = 0;

  const onTick = async (): Promise<void> => {
    try {
      const raw = await deps.runRatelimitProbe();
      const row = parseAccountReadWriteRow(raw);
      if (row === null) {
        // Re-warn every 24th consecutive failure (~daily at an hourly tick)
        // rather than once-then-forever. A PERMANENT `op` output-format change
        // would otherwise produce a single warn and then indefinite silence —
        // which is precisely the invisible degradation this monitor exists to
        // prevent. Daily is quiet enough to not be noise, loud enough to notice.
        if (parseFailureTicks % 24 === 0) {
          deps.log.warn(
            "[1p-ratelimit] no parsable \"account read_write\" row in `op service-account ratelimit` " +
              `output (${raw.trim().length} chars, consecutive failures: ${parseFailureTicks + 1}) — NO alert ` +
              "emitted (an hourly parse-failure alert would be worse than silence). Capture the raw " +
              "output and fix parseAccountReadWriteRow.",
          );
        }
        parseFailureTicks += 1;
        return;
      }
      if (parseFailureTicks > 0) {
        deps.log.info(
          `[1p-ratelimit] probe output parsable again (after ${parseFailureTicks} failed ticks)`,
        );
        parseFailureTicks = 0;
      }

      const pct = row.limit > 0 ? Math.round((row.used / row.limit) * 100) : 0;
      // Greppable trend line every tick, alert or not.
      deps.log.info(
        `[1p-ratelimit] account read_write used=${row.used}/${row.limit} (${pct}%) ` +
          `remaining=${row.remaining} reset=${row.reset}`,
      );

      const warnAt = Math.round(row.limit * warnPct);
      const critAt = Math.round(row.limit * critPct);
      const severity: Severity | null =
        row.used >= critAt ? "critical" : row.used >= warnAt ? "warn" : null;

      // CLEARED branch — the cap resets daily, so state MUST be dropped when
      // usage falls back under the warn tier or a stale lastAlertAt would
      // suppress the next real breach for a whole cooldown window.
      if (severity === null) {
        const prev = alertState.get(RATELIMIT_ALERT_KEY);
        if (prev !== undefined) {
          alertState.delete(RATELIMIT_ALERT_KEY);
          deps.log.info(
            `[1p-ratelimit] breach cleared (was ${prev.severity}) — used=${row.used}/${row.limit}`,
          );
        }
        return;
      }

      const now = deps.now();
      const prev = alertState.get(RATELIMIT_ALERT_KEY);
      const escalated =
        prev !== undefined && prev.severity === "warn" && severity === "critical";
      const cooledDown =
        prev !== undefined && now - prev.lastAlertAt >= alertCooldownMs;
      if (prev !== undefined && !escalated && !cooledDown) return;

      alertState.set(RATELIMIT_ALERT_KEY, { severity, lastAlertAt: now });

      const detail =
        `account read_write at ${row.used}/${row.limit} reads (${pct}%), ` +
        `${row.remaining} remaining, resets ${row.reset}`;
      if (severity === "critical") {
        deps.log.error(`[1p-ratelimit] CRITICAL — ${detail}`);
      } else {
        deps.log.warn(`[1p-ratelimit] warn — ${detail}`);
      }

      const prefix =
        severity === "critical"
          ? "🚨 **1Password rate limit CRITICAL**"
          : "⚠️ 1Password rate limit";
      await deps.postToAdminClawdy(
        `${prefix}: ${detail}. The cap is SHARED across every service account — a standalone ` +
          "`op read` caller (cron job, homelab script) that bypasses the daemon SecretsResolver " +
          "is the usual culprit; route it through `op-cached`.",
      );
    } catch (err) {
      // INC-2026-06-04 fail-open: a single mis-fire is logged and swallowed;
      // the cron keeps firing on the next tick.
      deps.log.error(
        `[1p-ratelimit] tick crashed (caught): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // Defense-in-depth: even with the static valid pattern, any croner
  // construction failure degrades the monitor, never crashes the daemon.
  let handle: RatelimitMonitorCronHandle;
  try {
    handle = factory(
      RATELIMIT_MONITOR_CRON_PATTERN,
      { name: "ratelimit-monitor" },
      onTick,
    );
  } catch (err) {
    deps.log.error(
      `[1p-ratelimit] cron registration failed (pattern=${RATELIMIT_MONITOR_CRON_PATTERN}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { registered: false, reason: "pattern-error" };
  }

  return { registered: true, stop: () => handle.stop() };
}
