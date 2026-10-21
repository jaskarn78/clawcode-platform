import { describe, it, expect } from "vitest";
import { CompactionEventLog } from "../compaction-event-log.js";

describe("CompactionEventLog", () => {
  it("returns null for unseen agents", () => {
    const log = new CompactionEventLog();
    expect(log.getLastCompactionAt("alpha")).toBeNull();
    expect(log.getMillisSinceLast("alpha", Date.now())).toBeNull();
  });

  it("records and returns ISO timestamp", () => {
    const log = new CompactionEventLog();
    const at = "2026-05-14T20:00:00.000Z";
    const stored = log.record("alpha", at);
    expect(stored).toBe(at);
    expect(log.getLastCompactionAt("alpha")).toBe(at);
  });

  it("auto-fills timestamp when omitted", () => {
    const log = new CompactionEventLog();
    const stored = log.record("alpha");
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("overwrites prior entries with the latest", () => {
    const log = new CompactionEventLog();
    log.record("alpha", "2026-05-14T20:00:00.000Z");
    log.record("alpha", "2026-05-14T20:05:00.000Z");
    expect(log.getLastCompactionAt("alpha")).toBe("2026-05-14T20:05:00.000Z");
  });

  it("isolates per-agent entries", () => {
    const log = new CompactionEventLog();
    log.record("alpha", "2026-05-14T20:00:00.000Z");
    expect(log.getLastCompactionAt("beta")).toBeNull();
  });

  it("computes millis since last compaction", () => {
    const log = new CompactionEventLog();
    const at = "2026-05-14T20:00:00.000Z";
    log.record("alpha", at);
    const now = Date.parse(at) + 60_000;
    expect(log.getMillisSinceLast("alpha", now)).toBe(60_000);
  });

  it("returns null millis when never compacted", () => {
    const log = new CompactionEventLog();
    expect(log.getMillisSinceLast("ghost", Date.now())).toBeNull();
  });
});
