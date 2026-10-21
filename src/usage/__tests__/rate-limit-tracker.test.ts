/**
 * Phase 103 OBS-04 — RateLimitTracker primitive tests.
 *
 * Pins the per-rateLimitType independence, UPSERT semantics, immutability
 * (Object.freeze), Pitfall 9 (surpassedThreshold is a NUMBER), Pitfall 10
 * (missing rateLimitType stored as 'unknown'), and SQLite restart-resilience.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { RateLimitTracker } from "../rate-limit-tracker.js";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

function makeDb(): DatabaseType {
  return new Database(":memory:");
}

describe("RateLimitTracker (OBS-04)", () => {
  it("returns undefined for getLatest before any record", () => {
    const t = new RateLimitTracker(makeDb());
    expect(t.getLatest("five_hour")).toBeUndefined();
  });

  it("getAllSnapshots is empty array on fresh DB", () => {
    const t = new RateLimitTracker(makeDb());
    expect(t.getAllSnapshots()).toEqual([]);
  });

  it("record + getLatest round-trips a snapshot", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.87,
      resetsAt: 1735000000000,
    } as SDKRateLimitInfo);
    const got = t.getLatest("five_hour");
    expect(got?.utilization).toBe(0.87);
    expect(got?.status).toBe("allowed_warning");
    expect(got?.resetsAt).toBe(1735000000000);
  });

  it("snapshots are Object.frozen (immutability invariant)", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({ status: "allowed", rateLimitType: "five_hour" } as SDKRateLimitInfo);
    const got = t.getLatest("five_hour")!;
    expect(Object.isFrozen(got)).toBe(true);
  });

  it("UPSERT — second record on same type OVERWRITES", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1 } as SDKRateLimitInfo);
    t.record({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9 } as SDKRateLimitInfo);
    expect(t.getLatest("five_hour")?.utilization).toBe(0.9);
    expect(t.getLatest("five_hour")?.status).toBe("allowed_warning");
    expect(t.getAllSnapshots()).toHaveLength(1);
  });

  it("independent per-type — 4 types coexist", () => {
    const t = new RateLimitTracker(makeDb());
    for (const type of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const) {
      t.record({ status: "allowed", rateLimitType: type } as SDKRateLimitInfo);
    }
    expect(t.getAllSnapshots()).toHaveLength(4);
  });

  it("missing rateLimitType stored as 'unknown' (Pitfall 10)", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({ status: "allowed" } as SDKRateLimitInfo);
    expect(t.getLatest("unknown")).toBeDefined();
    expect(t.getLatest("unknown")?.rateLimitType).toBe("unknown");
  });

  it("preserves surpassedThreshold as number (Pitfall 9)", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      surpassedThreshold: 0.75,
    } as SDKRateLimitInfo);
    expect(t.getLatest("five_hour")?.surpassedThreshold).toBe(0.75);
    expect(typeof t.getLatest("five_hour")?.surpassedThreshold).toBe("number");
  });

  it("persistence round-trip — new tracker on same DB restores latest", () => {
    const db = makeDb();
    const t1 = new RateLimitTracker(db);
    t1.record({
      status: "allowed",
      rateLimitType: "seven_day",
      utilization: 0.42,
    } as SDKRateLimitInfo);

    // New tracker over the SAME db handle.
    const t2 = new RateLimitTracker(db);
    expect(t2.getLatest("seven_day")?.utilization).toBe(0.42);
  });

  it("constructor is idempotent — second instantiation does not throw on existing table", () => {
    const db = makeDb();
    new RateLimitTracker(db);
    expect(() => new RateLimitTracker(db)).not.toThrow();
  });

  it("captures all 9 SDKRateLimitInfo fields", () => {
    const t = new RateLimitTracker(makeDb());
    const full: SDKRateLimitInfo = {
      status: "allowed_warning",
      rateLimitType: "overage",
      utilization: 0.5,
      resetsAt: 1735000000000,
      surpassedThreshold: 0.75,
      overageStatus: "allowed",
      overageResetsAt: 1735100000000,
      overageDisabledReason: "out_of_credits",
      isUsingOverage: true,
    };
    t.record(full);
    const got = t.getLatest("overage")!;
    expect(got.status).toBe("allowed_warning");
    expect(got.utilization).toBe(0.5);
    expect(got.resetsAt).toBe(1735000000000);
    expect(got.surpassedThreshold).toBe(0.75);
    expect(got.overageStatus).toBe("allowed");
    expect(got.overageResetsAt).toBe(1735100000000);
    expect(got.overageDisabledReason).toBe("out_of_credits");
    expect(got.isUsingOverage).toBe(true);
  });

  // Phase 999.4 — resetsAt unit normalization + utilization derivation.

  it("999.4: seconds-epoch resetsAt is normalized to ms", () => {
    const t = new RateLimitTracker(makeDb());
    // 1735000000 = seconds-epoch (10 digits) — what OAuth Max session emits.
    t.record({
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: 1735000000,
    } as SDKRateLimitInfo);
    expect(t.getLatest("five_hour")?.resetsAt).toBe(1735000000000);
  });

  it("999.4: ms-epoch resetsAt passes through (no double-conversion)", () => {
    const t = new RateLimitTracker(makeDb());
    // 1735000000000 = ms-epoch (13 digits) — documented SDK shape.
    t.record({
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: 1735000000000,
    } as SDKRateLimitInfo);
    expect(t.getLatest("five_hour")?.resetsAt).toBe(1735000000000);
  });

  it("999.4: overageResetsAt is normalized too", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({
      status: "allowed",
      rateLimitType: "overage",
      overageResetsAt: 1735000000,
    } as SDKRateLimitInfo);
    expect(t.getLatest("overage")?.overageResetsAt).toBe(1735000000000);
  });

  it("999.4: undefined resetsAt stays undefined", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({
      status: "allowed",
      rateLimitType: "five_hour",
    } as SDKRateLimitInfo);
    expect(t.getLatest("five_hour")?.resetsAt).toBeUndefined();
  });

  it("999.4: utilization=undefined + status=rejected derives 1.0", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({
      status: "rejected",
      rateLimitType: "five_hour",
    } as SDKRateLimitInfo);
    expect(t.getLatest("five_hour")?.utilization).toBe(1.0);
  });

  it("999.4: utilization=undefined + status=allowed_warning + surpassedThreshold derives threshold", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      surpassedThreshold: 0.8,
    } as SDKRateLimitInfo);
    expect(t.getLatest("five_hour")?.utilization).toBe(0.8);
  });

  it("999.4: utilization=undefined + status=allowed stays undefined", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({
      status: "allowed",
      rateLimitType: "five_hour",
    } as SDKRateLimitInfo);
    expect(t.getLatest("five_hour")?.utilization).toBeUndefined();
  });

  it("999.4: explicit utilization is never overridden", () => {
    const t = new RateLimitTracker(makeDb());
    t.record({
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 0.5,
    } as SDKRateLimitInfo);
    expect(t.getLatest("five_hour")?.utilization).toBe(0.5);
  });
});
