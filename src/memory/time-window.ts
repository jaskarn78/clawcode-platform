/**
 * Phase 999.125 — time windows for memory lookup.
 *
 * `memory_lookup` accepts `since` / `until` so an agent can answer "what did
 * we discuss last week?" or "what did I decide about X in July?" without
 * guessing keywords. Bounds are written by a model, so the parser accepts
 * the forms a model reaches for: ISO datetimes, bare dates (local day),
 * relative shorthand (`7d`, `2w`, `3m`, `12h`), `today`, `yesterday`, `now`.
 *
 * Everything is normalised to ISO UTC strings, which is what every
 * `created_at` / `started_at` column holds, so SQL can compare strings.
 */

export interface TimeWindow {
  /** Inclusive lower bound, ISO UTC. */
  readonly since?: string;
  /** Inclusive upper bound, ISO UTC. */
  readonly until?: string;
}

export type TimeWindowResult =
  | { readonly ok: true; readonly window: TimeWindow }
  | { readonly ok: false; readonly error: string };

/** Sentinels for one-sided windows in SQL `BETWEEN` clauses. */
export const SINCE_FLOOR = "0000-01-01T00:00:00.000Z";
export const UNTIL_CEIL = "9999-12-31T23:59:59.999Z";

const RELATIVE = /^(\d+)\s*([hdwm])$/i;
const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  m: 30 * 24 * 60 * 60 * 1000,
};

const BOUND_HELP = "use an ISO date/time, YYYY-MM-DD, or a relative form like 7d, 2w, 12h, yesterday";

function localDayStart(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function localDayEnd(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

function dayBound(date: Date, kind: "since" | "until"): Date {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return kind === "since" ? localDayStart(y, m, d) : localDayEnd(y, m, d);
}

/**
 * Parse one bound. Returns ISO UTC or null when unparseable. A bare date
 * is the local calendar day: its `since` is 00:00 and its `until` is
 * 23:59:59.999, so `since: 2026-07-01, until: 2026-07-31` covers all of
 * July.
 */
export function parseTimeBound(
  raw: string,
  kind: "since" | "until",
  now: Date = new Date(),
): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  const lower = value.toLowerCase();
  if (lower === "now") return now.toISOString();
  if (lower === "today") return dayBound(now, kind).toISOString();
  if (lower === "yesterday") {
    return dayBound(new Date(now.getTime() - UNIT_MS.d!), kind).toISOString();
  }
  const rel = RELATIVE.exec(lower);
  if (rel) {
    const n = Number(rel[1]);
    const unit = UNIT_MS[rel[2]!]!;
    return new Date(now.getTime() - n * unit).toISOString();
  }
  const bare = BARE_DATE.exec(value);
  if (bare) {
    const y = Number(bare[1]);
    const m = Number(bare[2]);
    const d = Number(bare[3]);
    const date = kind === "since" ? localDayStart(y, m, d) : localDayEnd(y, m, d);
    // Reject impossible dates (e.g. 2026-02-31 rolls over in JS).
    if (date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return date.toISOString();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Resolve both bounds; an error names the offending bound. */
export function resolveTimeWindow(
  raw: { readonly since?: string; readonly until?: string },
  now: Date = new Date(),
): TimeWindowResult {
  const window: { since?: string; until?: string } = {};
  if (raw.since !== undefined && raw.since.trim().length > 0) {
    const since = parseTimeBound(raw.since, "since", now);
    if (!since) return { ok: false, error: `invalid since: "${raw.since}" (${BOUND_HELP})` };
    window.since = since;
  }
  if (raw.until !== undefined && raw.until.trim().length > 0) {
    const until = parseTimeBound(raw.until, "until", now);
    if (!until) return { ok: false, error: `invalid until: "${raw.until}" (${BOUND_HELP})` };
    window.until = until;
  }
  if (window.since && window.until && window.since > window.until) {
    return { ok: false, error: `since (${window.since}) is after until (${window.until})` };
  }
  return { ok: true, window: Object.freeze(window) };
}

export function hasWindow(window: TimeWindow | undefined): window is TimeWindow {
  return window !== undefined && (window.since !== undefined || window.until !== undefined);
}

/** True when `iso` falls inside the window (missing bounds are open). */
export function inWindow(iso: string, window: TimeWindow): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  if (window.since && t < Date.parse(window.since)) return false;
  if (window.until && t > Date.parse(window.until)) return false;
  return true;
}

/** True when the span [start, end] touches the window (an open end = still running). */
export function overlapsWindow(
  startIso: string,
  endIso: string | null,
  window: TimeWindow,
): boolean {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return false;
  const end = endIso ? Date.parse(endIso) : Number.POSITIVE_INFINITY;
  if (window.since && end < Date.parse(window.since)) return false;
  if (window.until && start > Date.parse(window.until)) return false;
  return true;
}

/** Bounds with sentinels filled in, for SQL. */
export function sqlBounds(window: TimeWindow): { readonly since: string; readonly until: string } {
  return { since: window.since ?? SINCE_FLOOR, until: window.until ?? UNTIL_CEIL };
}
