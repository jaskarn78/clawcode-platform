/**
 * Quick 260611-h50 — pure, dependency-free Pacific (America/Los_Angeles)
 * day/week window helper for the /clawcode-usage token totals.
 *
 * Both exports take a `now: Date` and return a half-open UTC instant range
 * `{ startIso, endIso }` (ISO strings, `[start, end)`) describing the Pacific
 * calendar day / Monday-start week that contains `now`.
 *
 * DST-correct WITHOUT date-fns-tz: the LA UTC offset is derived at the
 * relevant instant via `Intl.DateTimeFormat` wall-clock parts, then the
 * day-start guess is refined once so the algorithm stays correct across the
 * spring-forward / fall-back transition days. The day boundary (Pacific
 * midnight) is always ≥ 1h away from the 02:00 transition, so a single
 * refine pass converges in both directions.
 *
 * Invariants the unit tests pin:
 *   - Pacific midnight = 07:00Z in summer (PDT, UTC-7) / 08:00Z in winter
 *     (PST, UTC-8).
 *   - Day span end − start = 24h; non-DST week span = 7 × 24h.
 *   - Ranges are half-open: start ≤ now < end.
 *
 * Scope guard: ONLY Node's built-in `Intl` is used — no npm dependency.
 */

const LA_TIME_ZONE = "America/Los_Angeles";

/** A UTC instant range, half-open `[startIso, endIso)`. */
export type UtcRange = Readonly<{
  startIso: string;
  endIso: string;
}>;

/** Pacific wall-clock breakdown of an instant. */
type PacificParts = Readonly<{
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number;
  second: number;
  /** Monday=0 .. Sunday=6 (ISO-style, shifted so week math subtracts cleanly). */
  weekdayMon0: number;
}>;

// Single shared formatter instance — constructing Intl.DateTimeFormat is
// relatively expensive, and this module is hot on the /clawcode-usage path.
const PACIFIC_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

const WEEKDAY_MON0: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/**
 * Parse a numeric Intl part, throwing a clear error rather than producing a
 * silent NaN that would poison every downstream Date.UTC computation.
 */
function numericPart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const raw = parts.find((p) => p.type === type)?.value;
  if (raw === undefined) {
    throw new Error(`Intl part '${type}' missing from Pacific formatter output`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Intl part '${type}' is not numeric: '${raw}'`);
  }
  return n;
}

/**
 * Break an instant down into its Pacific wall-clock components.
 *
 * The `hourCycle: "h23"` guard keeps midnight as hour "00" (some ICU builds
 * emit "24" under h24); we additionally normalize 24 → 0 as free insurance
 * since the refine step evaluates the offset exactly at Pacific midnight.
 */
function pacificParts(instant: Date): PacificParts {
  const parts = PACIFIC_FORMATTER.formatToParts(instant);
  const weekdayRaw = parts.find((p) => p.type === "weekday")?.value;
  if (weekdayRaw === undefined || WEEKDAY_MON0[weekdayRaw] === undefined) {
    throw new Error(`Unexpected Pacific weekday from Intl: '${weekdayRaw}'`);
  }
  const hour = numericPart(parts, "hour") % 24; // 24 → 0
  return Object.freeze({
    year: numericPart(parts, "year"),
    month: numericPart(parts, "month"),
    day: numericPart(parts, "day"),
    hour,
    minute: numericPart(parts, "minute"),
    second: numericPart(parts, "second"),
    weekdayMon0: WEEKDAY_MON0[weekdayRaw],
  });
}

/**
 * The LA UTC offset (in ms) at a given instant.
 *
 * Computed as `Date.UTC(<Pacific wall parts>) − floor(instant to seconds)`.
 * The flooring matters: a `Date` carrying sub-second ms would otherwise leak
 * into the offset and push the day boundary off the clean `.000Z` second.
 * The value is NEGATIVE for LA (e.g. −7h in PDT, −8h in PST).
 */
function offsetMsAt(instant: Date): number {
  const p = pacificParts(instant);
  const wallUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const flooredInstantMs = Math.floor(instant.getTime() / 1000) * 1000;
  return wallUtcMs - flooredInstantMs;
}

/**
 * The UTC instant of Pacific midnight (00:00:00 local) for the Pacific
 * calendar date Y/M/D.
 *
 * `guess` assumes the offset at `now`; we refine once with the offset
 * evaluated AT the guessed midnight so DST-transition days resolve correctly
 * (the day boundary is always ≥ 1h from the 02:00 transition → one pass
 * converges).
 */
function pacificMidnightUtc(year: number, month: number, day: number, near: Date): number {
  const wallMidnightUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  const guess = wallMidnightUtcMs - offsetMsAt(near);
  const refinedOffset = offsetMsAt(new Date(guess));
  return wallMidnightUtcMs - refinedOffset;
}

/** Advance a Pacific calendar date by `days` (handles month/year rollover). */
function addPacificDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  // Use a noon-UTC anchor so the +days arithmetic never straddles a DST
  // boundary into the wrong calendar date; we only read back Y/M/D.
  const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return {
    year: anchor.getUTCFullYear(),
    month: anchor.getUTCMonth() + 1,
    day: anchor.getUTCDate(),
  };
}

/**
 * Half-open UTC range for the Pacific calendar DAY containing `now`.
 *
 * `[pacificMidnight(today), pacificMidnight(tomorrow))`. The end is computed
 * from the next Pacific calendar date (not `start + 24h`) so a spring-forward
 * day correctly spans 23h and a fall-back day spans 25h.
 */
export function pacificDayRangeUtc(now: Date): UtcRange {
  const p = pacificParts(now);
  const startMs = pacificMidnightUtc(p.year, p.month, p.day, now);
  const next = addPacificDays(p.year, p.month, p.day, 1);
  const endMs = pacificMidnightUtc(next.year, next.month, next.day, new Date(startMs));
  return Object.freeze({
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  });
}

/**
 * Half-open UTC range for the Pacific WEEK (Monday-start) containing `now`.
 *
 * Subtract `weekdayMon0` Pacific days to land on Monday, then compute the
 * following Monday by adding 7 Pacific days and re-deriving midnight (NOT
 * `start + 7×24h`) so a mid-week DST shift keeps the span correct.
 */
export function pacificWeekRangeUtc(now: Date): UtcRange {
  const p = pacificParts(now);
  const monday = addPacificDays(p.year, p.month, p.day, -p.weekdayMon0);
  const startMs = pacificMidnightUtc(monday.year, monday.month, monday.day, now);
  const nextMonday = addPacificDays(monday.year, monday.month, monday.day, 7);
  const endMs = pacificMidnightUtc(
    nextMonday.year,
    nextMonday.month,
    nextMonday.day,
    new Date(startMs),
  );
  return Object.freeze({
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  });
}
