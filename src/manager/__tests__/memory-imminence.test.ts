/**
 * 999.147 — imminence predicates + tier router (pure module).
 *
 * The numbers in these fixtures are not invented: they are the live prod
 * readings that produced the operator's 2026-09-16 screenshot, and the
 * 2026-08-14 OOM-kill shape from the journal. A predicate that pages on the
 * former or stays quiet on the latter has failed its only job.
 */
import { describe, it, expect } from "vitest";
import {
  advanceSustain,
  etaMinutes,
  evaluateImminence,
  pushPoint,
  resolveTier,
  slopeMbPerMin,
  sustained,
  IMMINENCE_DEFAULTS,
  type ImminenceBreach,
  type TrajectoryPoint,
} from "../memory-imminence.js";

const CEILING_MB = 17408; // prod memory.high, verified on clawdy
const MIN = 60_000;

/** A steady series at `mb`, one sample per minute, ending at t=0. */
function flat(mb: number, count = 6): readonly TrajectoryPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    atMs: (i - count + 1) * MIN,
    mb,
  }));
}

/** A series climbing `perMin` MB/min, ending at `endMb` at t=0. */
function climbing(
  endMb: number,
  perMin: number,
  count = 6,
): readonly TrajectoryPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    atMs: (i - count + 1) * MIN,
    mb: endMb + (i - count + 1) * perMin,
  }));
}

const base = {
  nowMs: 0,
  ceilingMb: CEILING_MB,
  hostAvailableMb: 23_000,
  hostPoints: flat(23_000),
  actNow: false,
  actNowReason: "",
  oomKillDelta: 0,
  cfg: IMMINENCE_DEFAULTS,
};

describe("tier router", () => {
  it("routes every process-census proxy to telemetry — the screenshot population", () => {
    // These four keys produced 4 of the 8 alerts the operator complained
    // about, including both `other RSS` lines whose 38717MB reading was
    // arithmetically impossible (shared pages counted once per process).
    expect(resolveTier("class:other:rss")).toBe("telemetry");
    expect(resolveTier("class:chrome:rss")).toBe("telemetry");
    expect(resolveTier("class:mcp-python:rss")).toBe("telemetry");
    expect(resolveTier("class:chrome:instances")).toBe("telemetry");
    expect(resolveTier("class:chrome:procs")).toBe("telemetry");
  });

  it("routes total:pct to telemetry — it was paging about reclaimable page cache", () => {
    // The `cgroup at 97% of ceiling` page carried `anon 6524MB` against a
    // 17408MB ceiling: ~10GB of it was file cache the kernel drops for free.
    expect(resolveTier("total:pct")).toBe("telemetry");
  });

  it("keeps real-resource exhaustion on the page tier", () => {
    expect(resolveTier("host:mem")).toBe("page");
    expect(resolveTier("host:disk")).toBe("page");
    expect(resolveTier("daemon:heap")).toBe("page");
  });

  it("every imminent:* key pages, including ones invented later", () => {
    expect(resolveTier("imminent:anon-ceiling")).toBe("page");
    expect(resolveTier("imminent:oom-kill")).toBe("page");
    expect(resolveTier("imminent:something-new")).toBe("page");
  });

  it("demotes the slow tells to digest rather than deleting them", () => {
    expect(resolveTier("proc:anon-balloon")).toBe("digest");
    expect(resolveTier("cgroup:swap")).toBe("digest");
    expect(resolveTier("class:other:anonswap")).toBe("digest");
    expect(resolveTier("class:survivor-cli:count")).toBe("digest");
  });

  it("an untiered key defaults to digest, never to silence", () => {
    // A rule added later must surface once a day until someone tiers it —
    // silently dropping it would rebuild the blindness half of the problem.
    expect(resolveTier("something:nobody:tiered")).toBe("digest");
  });

  it("operator overrides win, by exact key and by class-rule wildcard", () => {
    expect(resolveTier("total:pct", { "total:pct": "page" })).toBe("page");
    expect(resolveTier("class:chrome:rss", { "class:*:rss": "page" })).toBe(
      "page",
    );
    // Exact beats wildcard.
    expect(
      resolveTier("class:chrome:rss", {
        "class:*:rss": "page",
        "class:chrome:rss": "telemetry",
      }),
    ).toBe("telemetry");
  });
});

describe("slope + eta", () => {
  it("returns null until there is enough spread to fit a line", () => {
    expect(slopeMbPerMin([])).toBeNull();
    expect(slopeMbPerMin(flat(5000, 2))).toBeNull();
  });

  it("reads ~0 on a flat series and the true rate on a clean climb", () => {
    expect(slopeMbPerMin(flat(5000))).toBeCloseTo(0, 5);
    expect(slopeMbPerMin(climbing(5000, 200))).toBeCloseTo(200, 5);
  });

  it("is not fooled by one noisy endpoint (why least-squares, not first-vs-last)", () => {
    // A subagent spawning on the last tick swings anon by hundreds of MB.
    // Endpoint differencing would call this a 300MB/min climb.
    const noisy = [...flat(5000, 5), { atMs: 0, mb: 5300 }];
    const slope = slopeMbPerMin(noisy);
    expect(slope).not.toBeNull();
    expect(slope as number).toBeLessThan(100);
  });

  it("eta is null when flat or falling, 0 when already past the target", () => {
    expect(etaMinutes(5000, 14_000, null)).toBeNull();
    expect(etaMinutes(5000, 14_000, 0)).toBeNull();
    expect(etaMinutes(5000, 14_000, -50)).toBeNull();
    expect(etaMinutes(15_000, 14_000, 50)).toBe(0);
    expect(etaMinutes(13_000, 14_000, 100)).toBeCloseTo(10, 5);
  });

  it("pushPoint drops samples outside the window and never mutates", () => {
    const prev = flat(100, 3); // t = -2min, -1min, 0
    const next = pushPoint(prev, { atMs: 10 * MIN, mb: 200 }, 5 * MIN);
    expect(next).toHaveLength(1);
    expect(next[0].mb).toBe(200);
    expect(prev).toHaveLength(3); // untouched
  });
});

describe("evaluateImminence — the quiet cases must stay quiet", () => {
  it("live prod anon (6.3GB of a 17.4GB ceiling, flat) pages nothing", () => {
    // Straight from the prod summary line: anonMb 6306, ceiling 17408 = 36%.
    const out = evaluateImminence({
      ...base,
      anonMb: 6306,
      anonPoints: flat(6306),
    });
    expect(out).toHaveLength(0);
  });

  it("a browser opening — anon jumps 5.5GB — still pages nothing", () => {
    // The `other anon+swap 5509MB` alert. Real memory, real jump, and
    // completely routine: 11.8GB of anon is 68% of the ceiling, under the
    // 75% warn line, and one jump is not a trend.
    const out = evaluateImminence({
      ...base,
      anonMb: 11_800,
      anonPoints: [...flat(6306, 5), { atMs: 0, mb: 11_800 }],
    });
    expect(out).toHaveLength(0);
  });

  it("high but FLAT anon does not page — plateaued is not imminent", () => {
    // memwatch v2's proven rule: a plateaued 7GB hog was spared across ~7
    // ticks and self-exited. Level alone never pages.
    const out = evaluateImminence({
      ...base,
      anonMb: 13_500, // 78% — above the warn line
      anonPoints: flat(13_500),
    });
    expect(out).toHaveLength(0);
  });
});

describe("evaluateImminence — the dangerous cases must page", () => {
  it("anon climbing into the ceiling pages with an ETA", () => {
    const out = evaluateImminence({
      ...base,
      anonMb: 13_500,
      anonPoints: climbing(13_500, 200), // 200MB/min → ~1.3GB to 85% ≈ 6min
    });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("imminent:anon-ceiling");
    expect(out[0].message).toMatch(/min to exhaustion/);
    expect(out[0].requiresSustain).toBe(true);
  });

  it("anon past the critical line pages immediately, no sustain needed", () => {
    const out = evaluateImminence({
      ...base,
      anonMb: 15_000, // 86%
      anonPoints: flat(15_000),
    });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("critical");
    expect(out[0].requiresSustain).toBe(false);
    expect(out[0].actNow).toBe(true);
  });

  it("an OOM kill delta pages — and only on the DELTA", () => {
    const killed = evaluateImminence({
      ...base,
      anonMb: 6306,
      anonPoints: flat(6306),
      oomKillDelta: 2,
    });
    expect(killed.map((b) => b.key)).toContain("imminent:oom-kill");
    // A lifetime counter that has not moved must never page: one kill six
    // weeks ago would otherwise page forever.
    const quiet = evaluateImminence({
      ...base,
      anonMb: 6306,
      anonPoints: flat(6306),
      oomKillDelta: 0,
    });
    expect(quiet).toHaveLength(0);
  });

  it("kernel actNow pages on the first sample", () => {
    const out = evaluateImminence({
      ...base,
      anonMb: 6306,
      anonPoints: flat(6306),
      actNow: true,
      actNowReason: "memory stall 61.20% (avg60)",
    });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("imminent:kernel-stall");
    expect(out[0].requiresSustain).toBe(false);
    expect(out[0].message).toContain("61.20%");
  });

  it("host availability falling toward the floor pages", () => {
    const out = evaluateImminence({
      ...base,
      anonMb: 6306,
      anonPoints: flat(6306),
      hostAvailableMb: 4000,
      hostPoints: climbing(4000, -250), // falling 250MB/min → ~8min to 2048
    });
    expect(out.map((b) => b.key)).toContain("imminent:host-exhaustion");
  });

  it("host availability merely LOW but steady does not page", () => {
    const out = evaluateImminence({
      ...base,
      anonMb: 6306,
      anonPoints: flat(6306),
      hostAvailableMb: 3000,
      hostPoints: flat(3000),
    });
    expect(out).toHaveLength(0);
  });
});

describe("sustain", () => {
  const traj = (): ImminenceBreach => ({
    key: "imminent:anon-ceiling",
    severity: "warn",
    message: "climbing",
    requiresSustain: true,
    actNow: false,
  });
  const proof = (): ImminenceBreach => ({
    key: "imminent:oom-kill",
    severity: "critical",
    message: "killed",
    requiresSustain: false,
    actNow: true,
  });

  it("a trajectory breach needs sustainSamples consecutive ticks", () => {
    let counts = advanceSustain({}, ["imminent:anon-ceiling"]);
    expect(sustained([traj()], counts, IMMINENCE_DEFAULTS)).toHaveLength(0);
    counts = advanceSustain(counts, ["imminent:anon-ceiling"]);
    expect(sustained([traj()], counts, IMMINENCE_DEFAULTS)).toHaveLength(1);
  });

  it("a gap resets the run — two separated spikes never page", () => {
    let counts = advanceSustain({}, ["imminent:anon-ceiling"]);
    counts = advanceSustain(counts, []); // quiet tick
    counts = advanceSustain(counts, ["imminent:anon-ceiling"]);
    expect(sustained([traj()], counts, IMMINENCE_DEFAULTS)).toHaveLength(0);
  });

  it("proof-tier breaches page on the first tick regardless", () => {
    const counts = advanceSustain({}, ["imminent:oom-kill"]);
    expect(sustained([proof()], counts, IMMINENCE_DEFAULTS)).toHaveLength(1);
  });
});
