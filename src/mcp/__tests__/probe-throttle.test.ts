import { describe, it, expect } from "vitest";
import {
  shouldProbeNow,
  partitionByThrottle,
  type PriorProbeState,
} from "../probe-throttle.js";

const T0 = Date.parse("2026-08-12T12:00:00.000Z");
const healthy = (lastRunAt: string): PriorProbeState => ({
  status: "ready",
  capabilityProbe: { status: "ready", lastRunAt },
});

describe("shouldProbeNow — default is unchanged behavior", () => {
  it("probes every tick when no interval is configured", () => {
    // Every server on the fleet today. The throttle must be strictly opt-in.
    expect(shouldProbeNow({ name: "a" }, healthy(new Date(T0).toISOString()), T0)).toBe(true);
    expect(
      shouldProbeNow({ name: "a", minProbeIntervalMs: 0 }, healthy(new Date(T0).toISOString()), T0),
    ).toBe(true);
  });
});

describe("shouldProbeNow — throttling a healthy server", () => {
  const s = { name: "playwright-shopping", minProbeIntervalMs: 900_000 };

  it("skips inside the interval", () => {
    const prior = healthy(new Date(T0 - 60_000).toISOString());
    expect(shouldProbeNow(s, prior, T0)).toBe(false);
  });

  it("probes once the interval has elapsed", () => {
    expect(shouldProbeNow(s, healthy(new Date(T0 - 900_001).toISOString()), T0)).toBe(true);
  });

  it("probes exactly AT the interval boundary", () => {
    expect(shouldProbeNow(s, healthy(new Date(T0 - 900_000).toISOString()), T0)).toBe(true);
  });
});

describe("shouldProbeNow — never throttle a server that needs watching", () => {
  const s = { name: "x", minProbeIntervalMs: 900_000 };
  const justRan = new Date(T0 - 1_000).toISOString();

  it("probes when there is NO prior state (cold boot / first tick)", () => {
    // Otherwise a fresh server sits in `unknown` for a whole interval, and
    // `unknown` means its tools are filtered out of the model's tool list.
    expect(shouldProbeNow(s, undefined, T0)).toBe(true);
    expect(shouldProbeNow(s, { status: "ready" }, T0)).toBe(true);
  });

  it("probes when the connect status is not ready", () => {
    for (const status of ["degraded", "failed", "unknown"]) {
      expect(
        shouldProbeNow(s, { status, capabilityProbe: { status: "ready", lastRunAt: justRan } }, T0),
      ).toBe(true);
    }
  });

  it("probes when the CAPABILITY status is not ready, even if connect says ready", () => {
    // The two can disagree, and a degraded capability probe is exactly the
    // server you want to keep watching every tick.
    for (const status of ["degraded", "failed", "unknown"]) {
      expect(
        shouldProbeNow(s, { status: "ready", capabilityProbe: { status, lastRunAt: justRan } }, T0),
      ).toBe(true);
    }
  });
});

describe("shouldProbeNow — hostile clocks", () => {
  const s = { name: "x", minProbeIntervalMs: 900_000 };

  it("probes on an unparseable timestamp rather than trusting it", () => {
    expect(
      shouldProbeNow(s, { status: "ready", capabilityProbe: { status: "ready", lastRunAt: "nope" } }, T0),
    ).toBe(true);
  });

  it("probes when the clock steps backwards, instead of wedging forever", () => {
    // An NTP step that puts lastRunAt in the future must not disable probing
    // for this server until the clock catches up.
    const future = new Date(T0 + 3_600_000).toISOString();
    expect(shouldProbeNow(s, healthy(future), T0)).toBe(true);
  });
});

describe("partitionByThrottle", () => {
  it("splits and preserves order within each bucket", () => {
    const servers = [
      { name: "cheap" },
      { name: "browser", minProbeIntervalMs: 900_000 },
      { name: "db" },
    ];
    const prior = new Map<string, PriorProbeState>([
      ["browser", healthy(new Date(T0 - 60_000).toISOString())],
    ]);
    const { toProbe, carried } = partitionByThrottle(servers, prior, T0);
    expect(toProbe.map((s) => s.name)).toEqual(["cheap", "db"]);
    expect(carried.map((s) => s.name)).toEqual(["browser"]);
  });

  it("carries nothing when no server opts in (fleet default)", () => {
    const servers = [{ name: "a" }, { name: "b" }];
    const prior = new Map<string, PriorProbeState>([
      ["a", healthy(new Date(T0).toISOString())],
      ["b", healthy(new Date(T0).toISOString())],
    ]);
    const { toProbe, carried } = partitionByThrottle(servers, prior, T0);
    expect(toProbe).toHaveLength(2);
    expect(carried).toHaveLength(0);
  });

  it("handles an empty server list", () => {
    const r = partitionByThrottle([], new Map(), T0);
    expect(r.toProbe).toEqual([]);
    expect(r.carried).toEqual([]);
  });
});
