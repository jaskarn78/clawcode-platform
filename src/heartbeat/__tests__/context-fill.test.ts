import { describe, it, expect, vi } from "vitest";
import contextFillCheck from "../checks/context-fill.js";
import type { CheckContext } from "../types.js";

/**
 * Create a mock CheckContext with a configurable fill provider.
 * Includes zoneThresholds in the config alongside legacy warning/critical thresholds.
 */
function createMockContext(
  fillPercentage: number | null,
  thresholds = {
    warningThreshold: 0.6,
    criticalThreshold: 0.75,
    zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 },
  },
): CheckContext {
  const mockProvider = fillPercentage !== null
    ? { getContextFillPercentage: () => fillPercentage, addTurn: vi.fn(), reset: vi.fn() }
    : undefined;

  return {
    agentName: "test-agent",
    sessionManager: {
      getContextFillProvider: vi.fn().mockReturnValue(mockProvider),
      getRunningAgents: vi.fn().mockReturnValue([]),
      getCompactionManager: vi.fn().mockReturnValue(undefined),
    } as any,
    registry: { entries: [], updatedAt: Date.now() },
    config: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: thresholds,
    },
  };
}

describe("context-fill check", () => {
  it("returns healthy with green zone when fill < yellow threshold", async () => {
    const context = createMockContext(0.3);
    const result = await contextFillCheck.execute(context);

    expect(result.status).toBe("healthy");
    expect(result.message).toContain("Context fill: 30%");
    expect(result.message).toContain("[green]");
    expect(result.metadata).toEqual({ fillPercentage: 0.3, zone: "green" });
  });

  it("returns warning with yellow zone when fill >= yellow and < orange", async () => {
    const context = createMockContext(0.55);
    const result = await contextFillCheck.execute(context);

    expect(result.status).toBe("warning");
    expect(result.message).toContain("Context fill: 55%");
    expect(result.message).toContain("[yellow]");
    expect(result.metadata).toEqual({ fillPercentage: 0.55, zone: "yellow" });
  });

  it("returns warning with orange zone when fill >= orange and < red", async () => {
    const context = createMockContext(0.72);
    const result = await contextFillCheck.execute(context);

    expect(result.status).toBe("warning");
    expect(result.message).toContain("Context fill: 72%");
    expect(result.message).toContain("[orange]");
    expect(result.metadata).toEqual({ fillPercentage: 0.72, zone: "orange" });
  });

  it("returns critical with red zone and recommend compaction when fill >= red", async () => {
    const context = createMockContext(0.9);
    const result = await contextFillCheck.execute(context);

    expect(result.status).toBe("critical");
    expect(result.message).toContain("Context fill: 90%");
    expect(result.message).toContain("[red]");
    expect(result.message).toContain("recommend compaction");
    expect(result.metadata).toEqual({ fillPercentage: 0.9, zone: "red" });
  });

  it("returns healthy with no memory system message when no fill provider", async () => {
    const context = createMockContext(null);
    const result = await contextFillCheck.execute(context);

    expect(result.status).toBe("healthy");
    expect(result.message).toBe("No memory system configured");
    expect(result.metadata).toBeUndefined();
  });

  it("metadata includes fillPercentage and zone", async () => {
    const context = createMockContext(0.42);
    const result = await contextFillCheck.execute(context);

    expect(result.metadata).toBeDefined();
    expect(result.metadata!.fillPercentage).toBe(0.42);
    expect(result.metadata!.zone).toBe("green");
  });

  it("returns critical at exactly the red threshold (0.85)", async () => {
    const context = createMockContext(0.85);
    const result = await contextFillCheck.execute(context);

    expect(result.status).toBe("critical");
    expect(result.metadata!.zone).toBe("red");
  });

  it("returns warning at exactly the yellow threshold (0.50)", async () => {
    const context = createMockContext(0.50);
    const result = await contextFillCheck.execute(context);

    expect(result.status).toBe("warning");
    expect(result.metadata!.zone).toBe("yellow");
  });

  it("returns warning at exactly the orange threshold (0.70)", async () => {
    const context = createMockContext(0.70);
    const result = await contextFillCheck.execute(context);

    expect(result.status).toBe("warning");
    expect(result.metadata!.zone).toBe("orange");
  });

  it("falls back to default zone thresholds when not configured", async () => {
    const context = createMockContext(0.55, {
      warningThreshold: 0.6,
      criticalThreshold: 0.75,
    } as any);
    const result = await contextFillCheck.execute(context);

    // Should still classify using DEFAULT_ZONE_THRESHOLDS (yellow at 0.50)
    expect(result.status).toBe("warning");
    expect(result.metadata!.zone).toBe("yellow");
  });

  it("has name 'context-fill'", () => {
    expect(contextFillCheck.name).toBe("context-fill");
  });
});
