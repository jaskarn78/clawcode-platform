import { describe, expect, it } from "vitest";
import { formatBrokerStatusTable } from "../broker-status.js";

describe("formatBrokerStatusTable", () => {
  it("renders empty-pool case as a single-line message", () => {
    const out = formatBrokerStatusTable({
      pools: [],
      totalRps: 0,
      totalThrottles24h: 0,
    });
    expect(out).toMatch(/No 1Password broker pools active/);
  });

  it("renders one row per pool with rps + throttle + retry columns", () => {
    const out = formatBrokerStatusTable({
      pools: [
        {
          tokenHash: "aa18cf6f",
          alive: true,
          agentRefCount: 3,
          inflightCount: 1,
          queueDepth: 0,
          respawnCount: 2,
          childPid: 1234,
          rpsLastMin: 12,
          throttleEvents24h: 4,
          lastRetryAfterSec: 5,
        },
      ],
      totalRps: 12,
      totalThrottles24h: 4,
    });
    expect(out).toContain("aa18cf6f");
    expect(out).toContain("RPS/60S");
    expect(out).toContain("THROTTLES/24H");
    expect(out).toContain("RETRY-AFTER(S)");
    expect(out).toContain("Totals: 12 rps");
    expect(out).toContain("4 throttle events");
  });

  it("renders dash placeholders when optional fields are absent", () => {
    const out = formatBrokerStatusTable({
      pools: [
        {
          tokenHash: "bb18cf7f",
          alive: false,
          agentRefCount: 0,
          inflightCount: 0,
          queueDepth: 0,
          respawnCount: 0,
          childPid: null,
        },
      ],
      totalRps: 0,
      totalThrottles24h: 0,
    });
    // childPid null and rps/throttle/retry undefined should each produce "-"
    const dashes = (out.match(/ - /g) ?? []).length;
    expect(dashes).toBeGreaterThanOrEqual(3);
  });
});
