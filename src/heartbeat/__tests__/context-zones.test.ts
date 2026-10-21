import { describe, it, expect, vi } from "vitest";
import {
  classifyZone,
  DEFAULT_ZONE_THRESHOLDS,
  ZONE_SEVERITY,
  ContextZoneTracker,
} from "../context-zones.js";
import type { ContextZone, ZoneThresholds, ZoneTransition } from "../context-zones.js";

describe("classifyZone", () => {
  const thresholds = DEFAULT_ZONE_THRESHOLDS;

  it("returns green for low fill (0.3)", () => {
    expect(classifyZone(0.3, thresholds)).toBe("green");
  });

  it("returns yellow for moderate fill (0.55)", () => {
    expect(classifyZone(0.55, thresholds)).toBe("yellow");
  });

  it("returns orange for high fill (0.72)", () => {
    expect(classifyZone(0.72, thresholds)).toBe("orange");
  });

  it("returns red for very high fill (0.90)", () => {
    expect(classifyZone(0.90, thresholds)).toBe("red");
  });

  it("returns yellow at exactly 0.50 (>= yellow threshold)", () => {
    expect(classifyZone(0.50, thresholds)).toBe("yellow");
  });

  it("returns orange at exactly 0.70 (>= orange threshold)", () => {
    expect(classifyZone(0.70, thresholds)).toBe("orange");
  });

  it("returns red at exactly 0.85 (>= red threshold)", () => {
    expect(classifyZone(0.85, thresholds)).toBe("red");
  });

  it("returns green for 0", () => {
    expect(classifyZone(0, thresholds)).toBe("green");
  });

  it("returns red for 1.0", () => {
    expect(classifyZone(1.0, thresholds)).toBe("red");
  });

  it("uses custom thresholds", () => {
    const custom: ZoneThresholds = { yellow: 0.3, orange: 0.5, red: 0.7 };
    expect(classifyZone(0.25, custom)).toBe("green");
    expect(classifyZone(0.35, custom)).toBe("yellow");
    expect(classifyZone(0.55, custom)).toBe("orange");
    expect(classifyZone(0.75, custom)).toBe("red");
  });
});

describe("ZONE_SEVERITY", () => {
  it("maps zones to numeric severity", () => {
    expect(ZONE_SEVERITY.green).toBe(0);
    expect(ZONE_SEVERITY.yellow).toBe(1);
    expect(ZONE_SEVERITY.orange).toBe(2);
    expect(ZONE_SEVERITY.red).toBe(3);
  });
});

describe("ContextZoneTracker", () => {
  it("starts in green zone", () => {
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
    });
    expect(tracker.zone).toBe("green");
  });

  it("returns transition on first update to yellow", async () => {
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
    });
    const transition = await tracker.update(0.55);
    expect(transition).not.toBeNull();
    expect(transition!.from).toBe("green");
    expect(transition!.to).toBe("yellow");
    expect(transition!.fillPercentage).toBe(0.55);
    expect(typeof transition!.timestamp).toBe("string");
  });

  it("returns null on second update in same zone", async () => {
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
    });
    await tracker.update(0.55);
    const second = await tracker.update(0.55);
    expect(second).toBeNull();
  });

  it("detects transition from yellow to orange", async () => {
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
    });
    await tracker.update(0.55); // green -> yellow
    const transition = await tracker.update(0.72); // yellow -> orange
    expect(transition).not.toBeNull();
    expect(transition!.from).toBe("yellow");
    expect(transition!.to).toBe("orange");
  });

  it("detects transition from orange back to green", async () => {
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
    });
    await tracker.update(0.55); // green -> yellow
    await tracker.update(0.72); // yellow -> orange
    const transition = await tracker.update(0.30); // orange -> green
    expect(transition).not.toBeNull();
    expect(transition!.from).toBe("orange");
    expect(transition!.to).toBe("green");
  });

  it("triggers snapshot callback on upward transition to yellow+", async () => {
    const onSnapshot = vi.fn().mockResolvedValue(undefined);
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
      onSnapshot,
    });
    await tracker.update(0.55); // green -> yellow (upward, yellow+)
    expect(onSnapshot).toHaveBeenCalledWith("test-agent", "yellow", 0.55);
  });

  it("does NOT trigger snapshot on transition to green", async () => {
    const onSnapshot = vi.fn().mockResolvedValue(undefined);
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
      onSnapshot,
    });
    await tracker.update(0.55); // green -> yellow
    onSnapshot.mockClear();
    await tracker.update(0.30); // yellow -> green (downward)
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("does NOT trigger snapshot on downward transition (orange to yellow)", async () => {
    const onSnapshot = vi.fn().mockResolvedValue(undefined);
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
      onSnapshot,
    });
    await tracker.update(0.55); // green -> yellow
    await tracker.update(0.72); // yellow -> orange
    onSnapshot.mockClear();
    await tracker.update(0.55); // orange -> yellow (downward, no snapshot)
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("triggers snapshot on upward transition to orange", async () => {
    const onSnapshot = vi.fn().mockResolvedValue(undefined);
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
      onSnapshot,
    });
    await tracker.update(0.55); // green -> yellow
    onSnapshot.mockClear();
    await tracker.update(0.72); // yellow -> orange (upward, orange+)
    expect(onSnapshot).toHaveBeenCalledWith("test-agent", "orange", 0.72);
  });

  it("triggers snapshot on upward transition to red", async () => {
    const onSnapshot = vi.fn().mockResolvedValue(undefined);
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
      onSnapshot,
    });
    await tracker.update(0.90); // green -> red (upward, red)
    expect(onSnapshot).toHaveBeenCalledWith("test-agent", "red", 0.90);
  });

  it("reset sets zone back to green", async () => {
    const tracker = new ContextZoneTracker({
      agentName: "test-agent",
      thresholds: DEFAULT_ZONE_THRESHOLDS,
    });
    await tracker.update(0.72); // green -> orange
    tracker.reset();
    expect(tracker.zone).toBe("green");
  });
});
