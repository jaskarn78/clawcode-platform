/**
 * Quick 260611-h50 — pacific-window helper unit tests.
 *
 * Pins the DST-correct Pacific (America/Los_Angeles) day/week ranges used by
 * the /clawcode-usage token totals. Pure module — no Discord/IPC; just feeds
 * `now: Date` literals and asserts exact UTC-ISO boundaries.
 *
 * Invariants pinned:
 *   - Pacific midnight = 07:00:00Z in summer (PDT, UTC-7) / 08:00:00Z in
 *     winter (PST, UTC-8).
 *   - Half-open: start ≤ now < end.
 *   - Day span = 24h; non-DST week span = 7 × 24h.
 *   - Monday-start week math is correct on a Sunday (the off-by-one trap).
 */
import { describe, it, expect } from "vitest";
import { pacificDayRangeUtc, pacificWeekRangeUtc } from "../pacific-window.js";

const HOUR_MS = 3_600_000;

describe("pacificDayRangeUtc", () => {
  it("PDT: 2026-06-11T05:00:00Z → Pacific date 2026-06-10 (22:00 PDT prev day)", () => {
    // 05:00 UTC = 22:00 PDT on 2026-06-10 (UTC-7).
    const r = pacificDayRangeUtc(new Date("2026-06-11T05:00:00Z"));
    expect(r.startIso).toBe("2026-06-10T07:00:00.000Z");
    expect(r.endIso).toBe("2026-06-11T07:00:00.000Z");
  });

  it("PST: 2026-01-15T05:00:00Z → Pacific date 2026-01-14 (21:00 PST prev day)", () => {
    // 05:00 UTC = 21:00 PST on 2026-01-14 (UTC-8).
    const r = pacificDayRangeUtc(new Date("2026-01-15T05:00:00Z"));
    expect(r.startIso).toBe("2026-01-14T08:00:00.000Z");
    expect(r.endIso).toBe("2026-01-15T08:00:00.000Z");
  });

  it("PDT mid-day: 2026-06-11T20:00:00Z (13:00 PDT) → Pacific date 2026-06-11", () => {
    const r = pacificDayRangeUtc(new Date("2026-06-11T20:00:00Z"));
    expect(r.startIso).toBe("2026-06-11T07:00:00.000Z");
    expect(r.endIso).toBe("2026-06-12T07:00:00.000Z");
  });

  it("day span is exactly 24h on a non-transition day", () => {
    const r = pacificDayRangeUtc(new Date("2026-06-11T20:00:00Z"));
    const span = Date.parse(r.endIso) - Date.parse(r.startIso);
    expect(span).toBe(24 * HOUR_MS);
  });

  it("range is half-open: start ≤ now < end", () => {
    const now = new Date("2026-06-11T20:00:00Z");
    const r = pacificDayRangeUtc(now);
    expect(Date.parse(r.startIso)).toBeLessThanOrEqual(now.getTime());
    expect(now.getTime()).toBeLessThan(Date.parse(r.endIso));
  });

  it("sub-second ms on `now` does not leak into the boundary (clean .000Z)", () => {
    const r = pacificDayRangeUtc(new Date("2026-06-11T20:00:00.523Z"));
    expect(r.startIso).toBe("2026-06-11T07:00:00.000Z");
    expect(r.endIso).toBe("2026-06-12T07:00:00.000Z");
  });

  it("spring-forward day (2026-03-08) spans 23h", () => {
    // 2026-03-08 is the US spring-forward date; the Pacific day loses an hour.
    const r = pacificDayRangeUtc(new Date("2026-03-08T20:00:00Z"));
    // Day starts at PST midnight (08:00Z), ends at PDT midnight (07:00Z next).
    expect(r.startIso).toBe("2026-03-08T08:00:00.000Z");
    expect(r.endIso).toBe("2026-03-09T07:00:00.000Z");
    const span = Date.parse(r.endIso) - Date.parse(r.startIso);
    expect(span).toBe(23 * HOUR_MS);
  });

  it("fall-back day (2026-11-01) spans 25h", () => {
    // 2026-11-01 is the US fall-back date; the Pacific day gains an hour.
    const r = pacificDayRangeUtc(new Date("2026-11-01T18:00:00Z"));
    // Day starts at PDT midnight (07:00Z), ends at PST midnight (08:00Z next).
    expect(r.startIso).toBe("2026-11-01T07:00:00.000Z");
    expect(r.endIso).toBe("2026-11-02T08:00:00.000Z");
    const span = Date.parse(r.endIso) - Date.parse(r.startIso);
    expect(span).toBe(25 * HOUR_MS);
  });
});

describe("pacificWeekRangeUtc", () => {
  it("PDT Wednesday: 2026-06-11T05:00:00Z (Pacific Wed 2026-06-10) → Mon..Mon week", () => {
    // Pacific date is Wed 2026-06-10; its Monday is 2026-06-08.
    const r = pacificWeekRangeUtc(new Date("2026-06-11T05:00:00Z"));
    expect(r.startIso).toBe("2026-06-08T07:00:00.000Z");
    expect(r.endIso).toBe("2026-06-15T07:00:00.000Z");
  });

  it("Sunday lands on the SAME Monday-start (the off-by-one trap)", () => {
    // 2026-06-14T20:00:00Z = Sun 13:00 PDT. Its week's Monday is still
    // 2026-06-08, NOT the upcoming Monday. Naive getUTCDay() Sun=0 would
    // subtract 0 and pick the wrong Monday — this guards against that.
    const r = pacificWeekRangeUtc(new Date("2026-06-14T20:00:00Z"));
    expect(r.startIso).toBe("2026-06-08T07:00:00.000Z");
    expect(r.endIso).toBe("2026-06-15T07:00:00.000Z");
  });

  it("Monday itself starts the week containing it", () => {
    // 2026-06-08T20:00:00Z = Mon 13:00 PDT.
    const r = pacificWeekRangeUtc(new Date("2026-06-08T20:00:00Z"));
    expect(r.startIso).toBe("2026-06-08T07:00:00.000Z");
    expect(r.endIso).toBe("2026-06-15T07:00:00.000Z");
  });

  it("non-DST week span is exactly 7 × 24h", () => {
    const r = pacificWeekRangeUtc(new Date("2026-06-11T05:00:00Z"));
    const span = Date.parse(r.endIso) - Date.parse(r.startIso);
    expect(span).toBe(7 * 24 * HOUR_MS);
  });

  it("range is half-open: start ≤ now < end", () => {
    const now = new Date("2026-06-11T05:00:00Z");
    const r = pacificWeekRangeUtc(now);
    expect(Date.parse(r.startIso)).toBeLessThanOrEqual(now.getTime());
    expect(now.getTime()).toBeLessThan(Date.parse(r.endIso));
  });

  it("PST winter week starts at 08:00Z Monday", () => {
    // 2026-01-15T20:00:00Z = Thu 12:00 PST. Its Monday is 2026-01-12.
    const r = pacificWeekRangeUtc(new Date("2026-01-15T20:00:00Z"));
    expect(r.startIso).toBe("2026-01-12T08:00:00.000Z");
    expect(r.endIso).toBe("2026-01-19T08:00:00.000Z");
  });
});
