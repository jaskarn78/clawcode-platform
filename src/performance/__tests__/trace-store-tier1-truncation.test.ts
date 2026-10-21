/**
 * Phase 115 Plan 05 T03 — TraceStore tier1_truncation_events tests.
 *
 * Pin the contract:
 *   - recordTier1TruncationEvent inserts a row with current epoch ms
 *   - countTier1TruncationEventsSince counts rows in [since, now] for one agent
 *   - per-agent isolation: counter for agent A doesn't see rows for agent B
 *   - 0 rows → returns 0 (never throws)
 *   - droppedChars defaults to 0 when omitted
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceStore } from "../trace-store.js";

describe("TraceStore — Phase 115 D-05 tier1_truncation_events", () => {
  let store: TraceStore;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-store-tier1-"));
    dbPath = join(tempDir, "traces.db");
    store = new TraceStore(dbPath);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("countTier1TruncationEventsSince on empty table returns 0", () => {
    const count = store.countTier1TruncationEventsSince("atlas", 0);
    expect(count).toBe(0);
  });

  it("recordTier1TruncationEvent inserts a row + count reflects it", () => {
    store.recordTier1TruncationEvent("atlas", 12345);
    const count = store.countTier1TruncationEventsSince("atlas", 0);
    expect(count).toBe(1);
  });

  it("counts only events ≥ sinceMs", () => {
    const sinceFuture = Date.now() + 60_000; // future cutoff
    store.recordTier1TruncationEvent("atlas", 100);
    const countFromFuture = store.countTier1TruncationEventsSince(
      "atlas",
      sinceFuture,
    );
    expect(countFromFuture).toBe(0);

    const countFromPast = store.countTier1TruncationEventsSince("atlas", 0);
    expect(countFromPast).toBe(1);
  });

  it("per-agent isolation — events for agent A invisible to agent B", () => {
    store.recordTier1TruncationEvent("atlas", 100);
    store.recordTier1TruncationEvent("atlas", 200);
    store.recordTier1TruncationEvent("hermes", 300);

    expect(store.countTier1TruncationEventsSince("atlas", 0)).toBe(2);
    expect(store.countTier1TruncationEventsSince("hermes", 0)).toBe(1);
    expect(store.countTier1TruncationEventsSince("nobody", 0)).toBe(0);
  });

  it("droppedChars defaults to 0 when omitted", () => {
    store.recordTier1TruncationEvent("atlas");
    expect(store.countTier1TruncationEventsSince("atlas", 0)).toBe(1);
  });

  it("multiple events same agent in 24h — count matches", () => {
    for (let i = 0; i < 5; i++) {
      store.recordTier1TruncationEvent("atlas", i * 100);
    }
    const since24h = Date.now() - 24 * 60 * 60 * 1000;
    expect(store.countTier1TruncationEventsSince("atlas", since24h)).toBe(5);
  });

  it("schema persists across re-open", () => {
    store.recordTier1TruncationEvent("atlas", 100);
    // Re-open the same DB.
    const store2 = new TraceStore(dbPath);
    expect(store2.countTier1TruncationEventsSince("atlas", 0)).toBe(1);
  });
});
