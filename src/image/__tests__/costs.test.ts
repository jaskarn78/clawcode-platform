import { describe, it, expect, vi } from "vitest";
import {
  IMAGE_PRICING,
  estimateImageCost,
  recordImageUsage,
} from "../costs.js";
import type { UsageTracker } from "../../usage/tracker.js";

describe("IMAGE_PRICING table", () => {
  it("is frozen at every level", () => {
    expect(Object.isFrozen(IMAGE_PRICING)).toBe(true);
    expect(Object.isFrozen(IMAGE_PRICING.openai)).toBe(true);
    expect(Object.isFrozen(IMAGE_PRICING.openai["gpt-image-1"])).toBe(true);
  });

  it("exposes pricing for all three backends", () => {
    expect(IMAGE_PRICING.openai).toBeDefined();
    expect(IMAGE_PRICING.minimax).toBeDefined();
    expect(IMAGE_PRICING.fal).toBeDefined();
  });
});

describe("estimateImageCost", () => {
  it("C1: openai/gpt-image-1/1024x1024/n=1 → 4 cents", () => {
    expect(estimateImageCost("openai", "gpt-image-1", "1024x1024", 1)).toBe(4);
  });

  it("C2: openai/gpt-image-1/1024x1792/n=2 → 16 cents (8 × 2)", () => {
    expect(estimateImageCost("openai", "gpt-image-1", "1024x1792", 2)).toBe(16);
  });

  it("C3: minimax/image-01 flat-rate (any size) = 1 cent × n", () => {
    expect(estimateImageCost("minimax", "image-01", "1024x1024", 1)).toBe(1);
    expect(estimateImageCost("minimax", "image-01", "512x512", 3)).toBe(3);
    expect(estimateImageCost("minimax", "image-01", "any-size-string", 1)).toBe(1);
  });

  it("C4: fal/fal-ai/flux-pro flat-rate = 5 cents × n", () => {
    expect(estimateImageCost("fal", "fal-ai/flux-pro", "1024x1024", 1)).toBe(5);
    expect(estimateImageCost("fal", "fal-ai/flux-pro", "1024x1024", 4)).toBe(20);
    expect(estimateImageCost("fal", "fal-ai/flux-schnell", "1024x1024", 2)).toBe(2);
  });

  it("C5: unknown backend → 0 (defensive default, never crashes)", () => {
    // @ts-expect-error intentionally invalid backend
    expect(estimateImageCost("midjourney", "v6", "1024x1024", 1)).toBe(0);
    expect(estimateImageCost("openai", "unknown-model", "1024x1024", 1)).toBe(0);
    expect(estimateImageCost("openai", "gpt-image-1", "9999x9999", 1)).toBe(0);
  });

  it("returns 0 for n <= 0 or non-finite", () => {
    expect(estimateImageCost("openai", "gpt-image-1", "1024x1024", 0)).toBe(0);
    expect(estimateImageCost("openai", "gpt-image-1", "1024x1024", -1)).toBe(0);
    expect(estimateImageCost("openai", "gpt-image-1", "1024x1024", NaN)).toBe(0);
  });

  it("dall-e-2 256x256 = 1 cent (cheapest tier)", () => {
    expect(estimateImageCost("openai", "dall-e-2", "256x256", 1)).toBe(1);
  });
});

describe("recordImageUsage", () => {
  it("C6: calls tracker.record exactly once with category='image' and cost_usd = cents/100", () => {
    const record = vi.fn();
    const tracker = { record } as unknown as UsageTracker;
    recordImageUsage(tracker, {
      agent: "clawdy",
      backend: "openai",
      model: "gpt-image-1",
      count: 2,
      cost_cents: 8,
      size: "1024x1024",
      timestamp: "2026-04-19T10:00:00Z",
      session_id: "sess-1",
    });
    expect(record).toHaveBeenCalledTimes(1);
    const arg = record.mock.calls[0][0];
    expect(arg.category).toBe("image");
    expect(arg.cost_usd).toBeCloseTo(0.08);
    expect(arg.tokens_in).toBe(0);
    expect(arg.tokens_out).toBe(0);
    expect(arg.turns).toBe(0);
    expect(arg.duration_ms).toBe(0);
    expect(arg.backend).toBe("openai");
    expect(arg.count).toBe(2);
    expect(arg.session_id).toBe("sess-1");
  });

  it("C7: model column is `${backend}:${model}` so CostByAgentModel splits image rows from token rows", () => {
    const record = vi.fn();
    const tracker = { record } as unknown as UsageTracker;
    recordImageUsage(tracker, {
      agent: "clawdy",
      backend: "fal",
      model: "fal-ai/flux-pro",
      count: 1,
      cost_cents: 5,
      size: "1024x1024",
      timestamp: "2026-04-19T10:00:00Z",
      session_id: "sess-1",
    });
    const arg = record.mock.calls[0][0];
    expect(arg.model).toBe("fal:fal-ai/flux-pro");
  });
});
