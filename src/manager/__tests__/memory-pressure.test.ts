import { describe, it, expect } from "vitest";
import {
  parsePsi,
  parseMemoryEvents,
  isCorroborated,
  pressureSummaryFields,
  PRESSURE_THRESHOLDS,
  type PressureSample,
  type MemoryEvents,
} from "../memory-pressure.js";

/**
 * INC-2026-08-09 — MemoryGuard paged about chrome while every kernel pressure
 * metric read zero. These pin the two rules that make the corroboration gate
 * safe: deltas never absolutes, and fail-open when the sensor is missing.
 */

// Verbatim from the live fleet host.
const LIVE_PSI = `some avg10=0.00 avg60=0.00 avg300=0.00 total=563838286
full avg10=0.00 avg60=0.00 avg300=0.00 total=471477983`;
const LIVE_EVENTS = `low 0
high 0
max 0
oom 0
oom_kill 0
oom_group_kill 0`;

const ZERO_EVENTS: MemoryEvents = { low: 0, high: 0, max: 0, oom: 0, oomKill: 0 };

function sample(over: Partial<PressureSample> = {}): PressureSample {
  return {
    available: true,
    cgSome60: 0,
    cgFull60: 0,
    cgFull10: 0,
    hostSome60: 0,
    events: ZERO_EVENTS,
    ...over,
  };
}

describe("parsePsi", () => {
  it("parses the live host's PSI verbatim", () => {
    const psi = parsePsi(LIVE_PSI);
    expect(psi.some).toEqual({ avg10: 0, avg60: 0, avg300: 0, total: 563838286 });
    expect(psi.full?.total).toBe(471477983);
  });

  it("parses nonzero stall", () => {
    const psi = parsePsi("some avg10=12.34 avg60=5.67 avg300=1.20 total=99");
    expect(psi.some?.avg60).toBe(5.67);
    expect(psi.full).toBeNull();
  });

  it("returns nulls rather than throwing on garbage", () => {
    expect(parsePsi("").some).toBeNull();
    expect(parsePsi("nonsense").some).toBeNull();
  });
});

describe("parseMemoryEvents", () => {
  it("parses the live host's counters (never throttled)", () => {
    expect(parseMemoryEvents(LIVE_EVENTS)).toEqual({
      low: 0, high: 0, max: 0, oom: 0, oomKill: 0,
    });
  });

  it("reads oom_kill under its snake_case key", () => {
    expect(parseMemoryEvents("high 7\noom_kill 3").oomKill).toBe(3);
  });
});

describe("isCorroborated — the gate", () => {
  it("does NOT corroborate the reported incident's conditions", () => {
    // Exactly the live state when the chrome alert fired.
    const v = isCorroborated({ current: sample(), previousEvents: ZERO_EVENTS });
    expect(v.corroborated).toBe(false);
    expect(v.reason).toContain("no kernel pressure");
  });

  it("corroborates on a throttle DELTA — the primary signal", () => {
    const v = isCorroborated({
      current: sample({ events: { ...ZERO_EVENTS, high: 3 } }),
      previousEvents: ZERO_EVENTS,
    });
    expect(v.corroborated).toBe(true);
    expect(v.reason).toContain("high +3");
  });

  it("does NOT corroborate on a stale ABSOLUTE count", () => {
    // The critical rule: a cgroup throttled once weeks ago must not
    // permanently un-gate every future proxy alert.
    const old: MemoryEvents = { ...ZERO_EVENTS, high: 42 };
    const v = isCorroborated({
      current: sample({ events: { ...ZERO_EVENTS, high: 42 } }),
      previousEvents: old,
    });
    expect(v.corroborated).toBe(false);
  });

  it("cannot corroborate on the first tick after a restart (no prior sample)", () => {
    const v = isCorroborated({
      current: sample({ events: { ...ZERO_EVENTS, high: 99 } }),
      previousEvents: null,
    });
    expect(v.corroborated).toBe(false);
    expect(v.reason).toContain("first tick after restart");
  });

  it("corroborates on measured stall at/above the floor", () => {
    const at = isCorroborated({
      current: sample({ cgSome60: PRESSURE_THRESHOLDS.corroborateSome60 }),
      previousEvents: ZERO_EVENTS,
    });
    expect(at.corroborated).toBe(true);
    const below = isCorroborated({
      current: sample({ cgSome60: 0.99 }),
      previousEvents: ZERO_EVENTS,
    });
    expect(below.corroborated).toBe(false);
  });

  it("flags actNow on severe stall or any sustained full-stall", () => {
    expect(
      isCorroborated({ current: sample({ cgSome60: 12 }), previousEvents: ZERO_EVENTS }).actNow,
    ).toBe(true);
    expect(
      isCorroborated({ current: sample({ cgSome60: 2, cgFull60: 1.5 }), previousEvents: ZERO_EVENTS }).actNow,
    ).toBe(true);
    expect(
      isCorroborated({ current: sample({ cgSome60: 2 }), previousEvents: ZERO_EVENTS }).actNow,
    ).toBe(false);
  });

  it("FAILS OPEN when PSI is unavailable — never silences the guard", () => {
    // A kernel without CONFIG_PSI must behave exactly as today (alert),
    // never as "no pressure detected, suppress".
    const v = isCorroborated({
      current: sample({ available: false, cgSome60: null, cgFull60: null, hostSome60: null, events: null }),
      previousEvents: null,
    });
    expect(v.corroborated).toBe(true);
    expect(v.reason).toContain("fail-open");
  });

  it("host-scoped findings use the host line and a louder floor", () => {
    // 2.0 clears the cgroup floor (1.0) but not the host floor (5.0).
    const v = isCorroborated({
      current: sample({ hostSome60: 2.0 }),
      previousEvents: ZERO_EVENTS,
      scope: "host",
    });
    expect(v.corroborated).toBe(false);
    const loud = isCorroborated({
      current: sample({ hostSome60: 6.0 }),
      previousEvents: ZERO_EVENTS,
      scope: "host",
    });
    expect(loud.corroborated).toBe(true);
  });
});

describe("pressureSummaryFields", () => {
  it("exposes the delta, not just the absolute", () => {
    const fields = pressureSummaryFields(
      sample({ events: { ...ZERO_EVENTS, high: 5 } }),
      { ...ZERO_EVENTS, high: 2 },
    );
    expect(fields.eventsHigh).toBe(5);
    expect(fields.eventsHighDelta).toBe(3);
  });

  it("reports a null delta when there is no prior sample", () => {
    expect(pressureSummaryFields(sample(), null).eventsHighDelta).toBeNull();
  });
});
