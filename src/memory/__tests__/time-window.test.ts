/**
 * Phase 999.125 — time-window parsing for memory lookup.
 */

import { describe, it, expect } from "vitest";
import {
  inWindow,
  overlapsWindow,
  parseTimeBound,
  resolveTimeWindow,
  sqlBounds,
} from "../time-window.js";

// A fixed "now" in the middle of a local day.
const NOW = new Date(2026, 8, 5, 14, 30, 0, 0); // 2026-09-05 14:30 local

describe("parseTimeBound", () => {
  it("passes ISO datetimes through, normalised to UTC", () => {
    expect(parseTimeBound("2026-07-01T10:00:00Z", "since", NOW)).toBe("2026-07-01T10:00:00.000Z");
    expect(parseTimeBound("2026-07-01T10:00:00.250+02:00", "until", NOW)).toBe("2026-07-01T08:00:00.250Z");
  });

  it("treats a bare date as the local day: since = 00:00, until = 23:59:59.999", () => {
    const since = parseTimeBound("2026-07-01", "since", NOW)!;
    const until = parseTimeBound("2026-07-31", "until", NOW)!;
    expect(new Date(since).getTime()).toBe(new Date(2026, 6, 1, 0, 0, 0, 0).getTime());
    expect(new Date(until).getTime()).toBe(new Date(2026, 6, 31, 23, 59, 59, 999).getTime());
  });

  it("rejects impossible dates and garbage", () => {
    expect(parseTimeBound("2026-02-31", "since", NOW)).toBeNull();
    expect(parseTimeBound("last tuesday-ish", "since", NOW)).toBeNull();
    expect(parseTimeBound("", "since", NOW)).toBeNull();
  });

  it("understands relative shorthand and the day words", () => {
    expect(parseTimeBound("7d", "since", NOW)).toBe(new Date(NOW.getTime() - 7 * 86_400_000).toISOString());
    expect(parseTimeBound("2w", "since", NOW)).toBe(new Date(NOW.getTime() - 14 * 86_400_000).toISOString());
    expect(parseTimeBound("12h", "since", NOW)).toBe(new Date(NOW.getTime() - 12 * 3_600_000).toISOString());
    expect(parseTimeBound("1m", "since", NOW)).toBe(new Date(NOW.getTime() - 30 * 86_400_000).toISOString());
    expect(parseTimeBound("now", "until", NOW)).toBe(NOW.toISOString());
    expect(new Date(parseTimeBound("today", "since", NOW)!).getTime()).toBe(new Date(2026, 8, 5, 0, 0, 0, 0).getTime());
    expect(new Date(parseTimeBound("yesterday", "until", NOW)!).getTime()).toBe(new Date(2026, 8, 4, 23, 59, 59, 999).getTime());
  });
});

describe("resolveTimeWindow", () => {
  it("returns an empty window when nothing is given", () => {
    expect(resolveTimeWindow({}, NOW)).toEqual({ ok: true, window: {} });
    expect(resolveTimeWindow({ since: "  " }, NOW)).toEqual({ ok: true, window: {} });
  });

  it("names the bad bound", () => {
    const r = resolveTimeWindow({ since: "7d", until: "someday" }, NOW);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('invalid until: "someday"');
  });

  it("refuses an inverted window", () => {
    const r = resolveTimeWindow({ since: "2026-08-01", until: "2026-07-01" }, NOW);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("is after until");
  });
});

describe("window predicates", () => {
  const w = { since: "2026-07-01T00:00:00.000Z", until: "2026-07-31T23:59:59.999Z" };

  it("inWindow is inclusive and open-ended", () => {
    expect(inWindow("2026-07-01T00:00:00.000Z", w)).toBe(true);
    expect(inWindow("2026-07-15T12:00:00Z", w)).toBe(true);
    expect(inWindow("2026-08-01T00:00:00.000Z", w)).toBe(false);
    expect(inWindow("2026-06-30T23:59:59.999Z", w)).toBe(false);
    expect(inWindow("2030-01-01T00:00:00Z", { since: w.since })).toBe(true);
    expect(inWindow("not a date", w)).toBe(false);
  });

  it("overlapsWindow treats a running session (no end) as open", () => {
    expect(overlapsWindow("2026-06-20T00:00:00Z", "2026-07-02T00:00:00Z", w)).toBe(true);
    expect(overlapsWindow("2026-06-20T00:00:00Z", "2026-06-25T00:00:00Z", w)).toBe(false);
    expect(overlapsWindow("2026-06-20T00:00:00Z", null, w)).toBe(true);
    expect(overlapsWindow("2026-08-02T00:00:00Z", null, w)).toBe(false);
  });

  it("sqlBounds fills sentinels", () => {
    expect(sqlBounds({ since: w.since })).toEqual({ since: w.since, until: "9999-12-31T23:59:59.999Z" });
    expect(sqlBounds({ until: w.until })).toEqual({ since: "0000-01-01T00:00:00.000Z", until: w.until });
  });
});
