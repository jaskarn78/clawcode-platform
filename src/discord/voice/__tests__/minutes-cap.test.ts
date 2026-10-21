/**
 * Phase 135 Plan 03 Task 3 — monthly minutes cap tests.
 *
 * Pins MinutesTracker behaviour:
 *   - Fresh init (no file) creates voice-minutes.json at
 *     <memoryPath>/voice-minutes.json with {month, secondsUsed: 0}.
 *   - addUtteranceSeconds + addSynthesisSeconds accumulate.
 *   - secondsUsedThisMonth returns the running total.
 *   - File is rewritten with the new count on each accumulator call.
 *   - Existing file with a prior month → reset on construction (UTC
 *     month rollover).
 *   - isCapExceeded(capMinutes) returns true once seconds >= cap*60.
 *   - isCapExceeded(undefined) is always false.
 *   - Lazy month-rollover on accumulator: if the wall clock crosses
 *     the month boundary AFTER the tracker is constructed, the next
 *     accumulator call resets first then adds.
 *   - Internal state is replaced, not mutated (immutability per
 *     coding-style.md).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MinutesTracker, currentUtcMonth } from "../minutes-cap.js";

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("MinutesTracker — Phase 135 Plan 03 Task 3", () => {
  let memoryPath: string;
  let filePath: string;

  beforeEach(async () => {
    memoryPath = await mkdtemp(join(tmpdir(), "minutes-tracker-test-"));
    filePath = join(memoryPath, "voice-minutes.json");
  });

  afterEach(async () => {
    await rm(memoryPath, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("fresh init: creates voice-minutes.json with current month + 0 seconds", async () => {
    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    expect(tracker.secondsUsedThisMonth()).toBe(0);
    const onDisk = JSON.parse(await readFile(filePath, "utf-8"));
    expect(onDisk).toEqual({ month: currentUtcMonth(), secondsUsed: 0 });
  });

  it("addUtteranceSeconds accumulates; file is rewritten with the new count", async () => {
    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    tracker.addUtteranceSeconds(30);
    expect(tracker.secondsUsedThisMonth()).toBe(30);
    const onDisk = JSON.parse(await readFile(filePath, "utf-8"));
    expect(onDisk.secondsUsed).toBe(30);
  });

  it("addSynthesisSeconds also accumulates (combined STT + TTS seconds)", () => {
    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    tracker.addUtteranceSeconds(10);
    tracker.addSynthesisSeconds(15);
    expect(tracker.secondsUsedThisMonth()).toBe(25);
  });

  it("existing file with prior month → reset on construction", async () => {
    // Pre-seed the file with last month's count.
    await mkdir(memoryPath, { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ month: "2020-01", secondsUsed: 99999 }),
      "utf-8",
    );

    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    expect(tracker.secondsUsedThisMonth()).toBe(0);
    const onDisk = JSON.parse(await readFile(filePath, "utf-8"));
    expect(onDisk.month).toBe(currentUtcMonth());
    expect(onDisk.secondsUsed).toBe(0);
  });

  it("existing file with current month → preserved on construction", async () => {
    await mkdir(memoryPath, { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ month: currentUtcMonth(), secondsUsed: 120 }),
      "utf-8",
    );

    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    expect(tracker.secondsUsedThisMonth()).toBe(120);
  });

  it("isCapExceeded(1) (60s cap): false at 30s, true at 60s", () => {
    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    tracker.addUtteranceSeconds(30);
    expect(tracker.isCapExceeded(1)).toBe(false);
    tracker.addUtteranceSeconds(30);
    expect(tracker.isCapExceeded(1)).toBe(true);
  });

  it("isCapExceeded(undefined) is always false (no cap configured)", () => {
    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    tracker.addUtteranceSeconds(999_999);
    expect(tracker.isCapExceeded(undefined)).toBe(false);
  });

  it("lazy month-rollover: accumulator after the month flips resets to 0 then adds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    tracker.addUtteranceSeconds(50);
    expect(tracker.secondsUsedThisMonth()).toBe(50);

    // Cross the month boundary.
    vi.setSystemTime(new Date("2026-06-01T00:00:01Z"));
    tracker.addUtteranceSeconds(10);
    // Should have reset to 0 + 10 (the prior 50 was last month).
    expect(tracker.secondsUsedThisMonth()).toBe(10);
  });

  it("immutability: state object is replaced, not mutated", () => {
    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    const ref1 = (tracker as any).state;
    tracker.addUtteranceSeconds(10);
    const ref2 = (tracker as any).state;
    expect(ref1).not.toBe(ref2);
    expect(ref1.secondsUsed).toBe(0); // original state untouched
    expect(ref2.secondsUsed).toBe(10);
  });

  it("rolloverIfNeeded: explicit call after month flip resets state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    tracker.addUtteranceSeconds(100);
    vi.setSystemTime(new Date("2026-06-01T00:00:01Z"));
    tracker.rolloverIfNeeded();
    expect(tracker.secondsUsedThisMonth()).toBe(0);
  });

  // Phase 135 REVIEW WR-04 — atomic write via temp-file + rename.
  // The final file must never be half-written: readers must see the
  // previous valid state OR the complete new state, never a partial
  // JSON blob. We can't easily induce a mid-write crash in-process,
  // but we CAN assert two observable properties of the atomic-write
  // implementation:
  //   1. After a successful write, no stray .tmp-* file is left.
  //   2. The persisted JSON is parseable (no partial writes during
  //      the test's accumulation calls).
  it("WR-04 atomic write: no orphan .tmp files after accumulation", async () => {
    const tracker = new MinutesTracker({
      agentName: "test-agent",
      memoryPath,
      log: silentLog as any,
    });
    tracker.addUtteranceSeconds(10);
    tracker.addSynthesisSeconds(5);
    tracker.addUtteranceSeconds(3);

    const entries = await import("node:fs/promises").then((m) => m.readdir(memoryPath));
    const tmpFiles = entries.filter((e) => e.startsWith("voice-minutes.json.tmp-"));
    expect(tmpFiles).toEqual([]);
    // The final file is parseable and reflects the accumulated total.
    const onDisk = JSON.parse(await readFile(filePath, "utf-8"));
    expect(onDisk.secondsUsed).toBe(18);
  });
});
