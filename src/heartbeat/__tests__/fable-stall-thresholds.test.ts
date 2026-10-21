/**
 * Phase 999.114 — fable stall/timeout handling.
 *
 * Regression cover for the 2026-08-21 fin-research incident: a fable agent was
 * aborted four times at exactly 180.0s with ZERO assistant output and
 * `inFlightTools: []` — the stream-stall watchdog killing turns that were
 * merely slow to their first token.
 */
import { describe, it, expect } from "vitest";
import {
  resolveForceReleaseThresholdMs,
  TURN_FORCE_RELEASE_THRESHOLD_MS,
  FORCE_RELEASE_MARGIN_MS,
} from "../stale-turn-thresholds.js";
import {
  familyStallFloorMs,
  MODEL_FAMILIES,
} from "../../shared/model-catalog.js";
import { describeStallNotice } from "../../manager/tool-mutation-classifier.js";

describe("familyStallFloorMs", () => {
  it("gives fable a floor above the 180s fleet baseline; nothing else needs one", () => {
    expect(familyStallFloorMs("fable")).toBe(600_000);
    expect(familyStallFloorMs("opus")).toBe(0);
    expect(familyStallFloorMs("sonnet")).toBe(0);
    expect(familyStallFloorMs("haiku")).toBe(0);
  });

  it("returns a number for every family (no undefined leaks into Math.max)", () => {
    for (const f of MODEL_FAMILIES) {
      expect(Number.isFinite(familyStallFloorMs(f))).toBe(true);
    }
  });
});

describe("resolveForceReleaseThresholdMs — the ordering invariant", () => {
  it("keeps force-release STRICTLY above the agent's own stall abort", () => {
    // This is the whole point: a fixed 300s sweep fired BEFORE a 600s stall
    // abort, so raising the stall timeout bought nothing but a blunter kill.
    expect(resolveForceReleaseThresholdMs(600_000)).toBe(
      600_000 + FORCE_RELEASE_MARGIN_MS,
    );
    expect(resolveForceReleaseThresholdMs(600_000)).toBeGreaterThan(600_000);
  });

  it("never drops below the baseline, so a low stall timeout is not a hair trigger", () => {
    expect(resolveForceReleaseThresholdMs(60_000)).toBe(
      TURN_FORCE_RELEASE_THRESHOLD_MS,
    );
    expect(resolveForceReleaseThresholdMs(180_000)).toBe(
      TURN_FORCE_RELEASE_THRESHOLD_MS,
    );
  });

  it("degrades to the baseline on unusable input (fail-safe, = pre-999.114)", () => {
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveForceReleaseThresholdMs(bad as number | undefined)).toBe(
        TURN_FORCE_RELEASE_THRESHOLD_MS,
      );
    }
  });

  it("holds force > stall across the whole plausible range", () => {
    for (const stall of [30_000, 120_000, 180_000, 300_000, 600_000, 1_800_000]) {
      expect(resolveForceReleaseThresholdMs(stall)).toBeGreaterThan(stall);
    }
  });
});

describe("describeStallNotice — stop blaming a tool that was never running", () => {
  it("does NOT claim a tool wedged when no tool was in flight", () => {
    const msg = describeStallNotice({
      reason: "no-useful-tokens",
      inFlightToolNames: [],
    } as never);
    // The old copy said "a tool wedged" unconditionally; every one of the 17
    // no-useful-tokens trips in the 7-day prod sweep had inFlightTools: [].
    expect(msg).not.toMatch(/tool wedged/i);
    expect(msg).toMatch(/No tool was involved/i);
    expect(msg).toMatch(/slow first token/i);
  });

  it("names the actual tool when one WAS in flight", () => {
    expect(
      describeStallNotice({
        reason: "no-useful-tokens",
        inFlightToolNames: ["Bash"],
      } as never),
    ).toContain("`Bash`");
    expect(
      describeStallNotice({
        reason: "no-useful-tokens",
        inFlightToolNames: ["Bash", "Read"],
      } as never),
    ).toContain("2 tools");
  });

  it("distinguishes a max-turn-duration stop from a silent stream", () => {
    const msg = describeStallNotice({
      reason: "max-turn-duration",
      inFlightToolNames: [],
    } as never);
    expect(msg).toMatch(/maximum turn duration/i);
    expect(msg).not.toMatch(/tool wedged/i);
  });

  it("stays sane when wedge info is absent entirely", () => {
    expect(describeStallNotice(undefined)).toMatch(/⚠️/);
  });
});
