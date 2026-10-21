import { describe, it, expect } from "vitest";
import { PlanUsageProbe, effectiveSnapshots, livePlanSnapshots, setActivePlanUsageProbe, planUsageToSnapshots, PLAN_USAGE_FRESH_MS } from "../plan-usage-probe.js";
import { evaluateUsageGuard } from "../../manager/research-usage-guard.js";
import type { SdkPlanUsage } from "../../manager/sdk-types.js";

// Shaped like the live /usage Operator saw on 2026-09-26: session 26%, week 40%.
const LIVE: SdkPlanUsage = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 26, resets_at: "2026-09-26T16:20:00Z" },
    seven_day: { utilization: 40, resets_at: "2026-10-01T20:00:00Z" },
    seven_day_opus: null,
  },
};
const now = Date.parse("2026-09-26T14:40:00Z");

describe("planUsageToSnapshots", () => {
  it("converts percent to a 0-1 utilization with reset times", () => {
    const snaps = planUsageToSnapshots(LIVE, now);
    expect(snaps.map((s) => [s.rateLimitType, s.utilization])).toEqual([["five_hour", 0.26], ["seven_day", 0.4]]);
    expect(snaps[1].resetsAt).toBe(Date.parse("2026-10-01T20:00:00Z"));
  });

  it("100% is treated as the limit being reached", () => {
    const [s] = planUsageToSnapshots({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: null } } }, now);
    expect(s.status).toBe("rejected");
  });

  it("no plan limits (API key sessions) → no snapshots", () => {
    expect(planUsageToSnapshots({ rate_limits_available: false, rate_limits: null }, now)).toEqual([]);
  });

  it("the live numbers drive the guard: 40% weekly → normal band", () => {
    expect(evaluateUsageGuard(planUsageToSnapshots(LIVE, now), now).band).toBe("normal");
  });
});

describe("PlanUsageProbe", () => {
  it("uses the first session that answers and is fresh until the TTL passes", async () => {
    let t = now;
    const probe = new PlanUsageProbe(
      () => [async () => { throw new Error("session busy"); }, async () => null, async () => LIVE],
      undefined,
      () => t,
    );
    expect(probe.fresh()).toBeNull();
    await probe.refresh();
    expect(probe.fresh()?.length).toBe(2);
    t += PLAN_USAGE_FRESH_MS + 1;
    expect(probe.fresh()).toBeNull();
  });

  it("concurrent refreshes share one request", async () => {
    let calls = 0;
    const probe = new PlanUsageProbe(() => [async () => { calls += 1; return LIVE; }], undefined, () => now);
    await Promise.all([probe.refresh(), probe.refresh(), probe.refresh()]);
    expect(calls).toBe(1);
  });
});

describe("effectiveSnapshots (what /clawcode-usage and /clawcode-status show)", () => {
  const tracked = (type: string, util: number, recordedAt: number, resetsAt?: number) => ({
    rateLimitType: type,
    status: "allowed" as const,
    utilization: util,
    resetsAt,
    surpassedThreshold: type === "seven_day_overage_included" ? 0.75 : undefined,
    overageStatus: undefined,
    overageResetsAt: undefined,
    overageDisabledReason: undefined,
    isUsingOverage: undefined,
    recordedAt,
  });

  it("Anthropic's live windows replace the tracked ones", () => {
    const live = planUsageToSnapshots(LIVE, now);
    const out = effectiveSnapshots([tracked("seven_day", 0.29, now - 60_000, Date.parse("2026-10-01T20:00:00Z"))], live, now);
    expect(out.find((s) => s.rateLimitType === "seven_day")?.utilization).toBe(0.4);
    expect(out.find((s) => s.rateLimitType === "five_hour")?.utilization).toBe(0.26);
    expect(out.filter((s) => s.rateLimitType === "seven_day")).toHaveLength(1);
  });

  it("drops the old account's months-old overage rows", () => {
    const live = planUsageToSnapshots(LIVE, now);
    const fiveMonths = 150 * 86_400_000;
    const out = effectiveSnapshots(
      [tracked("overage", 0.1, now - fiveMonths, now - 120 * 86_400_000), tracked("seven_day_overage_included", 0.75, now - fiveMonths)],
      live,
      now,
    );
    expect(out.map((s) => s.rateLimitType).sort()).toEqual(["five_hour", "seven_day"]);
  });

  it("keeps a fresh, same-account tracked window Anthropic doesn't report", () => {
    const live = planUsageToSnapshots(LIVE, now);
    const weeklyReset = Date.parse("2026-10-01T20:00:00Z");
    const out = effectiveSnapshots(
      [tracked("seven_day", 0.39, now - 60_000, weeklyReset), tracked("seven_day_overage_included", 0.2, now - 60_000, weeklyReset)],
      live,
      now,
    );
    expect(out.some((s) => s.rateLimitType === "seven_day_overage_included")).toBe(true);
  });

  it("no live numbers → tracked rows, still filtered to the live account", () => {
    const out = effectiveSnapshots([tracked("seven_day", 0.3, now - 60_000, now + 86_400_000), tracked("overage", 0.1, now - 150 * 86_400_000)], null, now);
    expect(out.map((s) => s.rateLimitType)).toEqual(["seven_day"]);
  });
});

describe("livePlanSnapshots", () => {
  it("returns null when no probe is registered", async () => {
    setActivePlanUsageProbe(undefined);
    expect(await livePlanSnapshots()).toBeNull();
  });

  it("a hung /usage call gives up after the wait instead of hanging the command", async () => {
    setActivePlanUsageProbe(new PlanUsageProbe(() => [() => new Promise(() => {})], undefined, () => now));
    expect(await livePlanSnapshots(20)).toBeNull();
    setActivePlanUsageProbe(undefined);
  });

  it("refreshes a stale probe and returns the live windows", async () => {
    setActivePlanUsageProbe(new PlanUsageProbe(() => [async () => LIVE], undefined, () => now));
    expect((await livePlanSnapshots())?.map((s) => s.rateLimitType)).toEqual(["five_hour", "seven_day"]);
    setActivePlanUsageProbe(undefined);
  });
});
