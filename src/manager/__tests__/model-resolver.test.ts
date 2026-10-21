import { describe, it, expect } from "vitest";
import { resolveModelId } from "../model-resolver.js";

describe("resolveModelId", () => {
  it("maps 'sonnet' to the pinned Sonnet 5 ID", () => {
    expect(resolveModelId("sonnet")).toBe("claude-sonnet-5");
  });

  it("maps the 'sonnet-4-6' escape hatch to the pinned Sonnet 4.6 ID", () => {
    expect(resolveModelId("sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("maps 'opus' to the pinned Opus 5.5 ID", () => {
    // Opus 5.5 (2026-09) — executor bumped 5 → 5.5.
    expect(resolveModelId("opus")).toBe("claude-opus-5-5");
  });

  it("maps the 'opus-5' escape hatch to the pinned Opus 5 ID", () => {
    expect(resolveModelId("opus-5")).toBe("claude-opus-5");
  });

  it("maps the 'opus-4-8' escape hatch to the pinned Opus 4.8 ID", () => {
    expect(resolveModelId("opus-4-8")).toBe("claude-opus-4-8");
  });

  it("maps 'haiku' to the pinned Haiku 4.5 ID", () => {
    expect(resolveModelId("haiku")).toBe("claude-haiku-4-5");
  });

  it("passes explicit model IDs through unchanged", () => {
    expect(resolveModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });

  it("passes unknown strings through unchanged (no silent alias fallback)", () => {
    expect(resolveModelId("gpt-5")).toBe("gpt-5");
  });
});
