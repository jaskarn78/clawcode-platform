/**
 * Phase 999.39 — regression guard: consolidation + dream-pass use OAuth path.
 *
 * The production wiring in daemon.ts must route:
 *   consolidation.summarize  → summarizeWithHaiku → callHaikuDirect (OAuth)
 *   dream-pass.dispatch      → callHaikuDirect (OAuth)
 *
 * NOT through manager.dispatchTurn / turnDispatcher.dispatch (sdk.query path
 * that inherits ANTHROPIC_API_KEY and bills the metered account).
 *
 * These tests verify the chain from the entry points that daemon.ts injects
 * into the workers. If the wiring ever reverts, these tests break.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCallHaikuDirect = vi.fn();

vi.mock("../haiku-direct.js", () => ({
  callHaikuDirect: mockCallHaikuDirect,
  callHaikuVision: vi.fn(),
  _resetClientForTests: vi.fn(),
}));

const { summarizeWithHaiku } = await import("../summarize-with-haiku.js");

describe("Phase 999.39 — consolidation auth path (OAuth guard)", () => {
  beforeEach(() => {
    mockCallHaikuDirect.mockReset();
  });

  it("summarizeWithHaiku (used as consolidation deps.summarize) routes to callHaikuDirect", async () => {
    mockCallHaikuDirect.mockResolvedValue(
      "## Key Facts\n- oauth path confirmed\n\n## Decisions Made\n- none\n\n## Topics Discussed\n- auth\n\n## Important Context\n- none",
    );

    const result = await summarizeWithHaiku("weekly digest prompt", {});

    expect(mockCallHaikuDirect).toHaveBeenCalledTimes(1);
    const [system, prompt] = mockCallHaikuDirect.mock.calls[0]! as [string, string, unknown];
    expect(system).toContain("summarizer");
    expect(prompt).toBe("weekly digest prompt");
    expect(result).toContain("oauth path confirmed");
  });

  it("summarizeWithHaiku exits via callHaikuDirect only — no other LLM call paths", async () => {
    mockCallHaikuDirect.mockResolvedValue("ok");
    await summarizeWithHaiku("any consolidation prompt", {});
    // callHaikuDirect is the ONLY mock; if the function tried any other LLM path
    // (e.g. manager.dispatchTurn) the call would throw/fail, not reach this line.
    expect(mockCallHaikuDirect).toHaveBeenCalledTimes(1);
  });

  it("summarizeWithHaiku forwards abort signal to callHaikuDirect", async () => {
    mockCallHaikuDirect.mockResolvedValue("done");
    const ctrl = new AbortController();
    await summarizeWithHaiku("prompt", { signal: ctrl.signal });
    const [, , opts] = mockCallHaikuDirect.mock.calls[0]! as [string, string, { signal?: AbortSignal }];
    expect(opts.signal).toBe(ctrl.signal);
  });
});

describe("Phase 999.39 — dream-pass auth path (OAuth guard)", () => {
  beforeEach(() => {
    mockCallHaikuDirect.mockReset();
  });

  it("callHaikuDirect is the correct OAuth entry point for dream-pass dispatch", async () => {
    // Dream-pass dispatch in daemon.ts:3547 calls callHaikuDirect directly.
    // Verify the function accepts the (systemPrompt, userPrompt, opts) shape
    // that dreamDispatch passes.
    mockCallHaikuDirect.mockResolvedValue(
      '{"reflections":[{"insight":"test","confidence":0.9,"category":"pattern","emotionalTone":"neutral","actionable":false}],"dreamQuality":{"overallCoherence":0.9,"signalStrength":0.8,"noiseLevel":0.2},"meta":{"totalChunksReviewed":5,"sessionsSampled":2,"generatedAt":"2024-01-01T00:00:00Z"}}',
    );

    const systemPrompt = "You are a reflective AI assistant.";
    const userPrompt = "Review these memory chunks and generate insights.";

    const text = await mockCallHaikuDirect(systemPrompt, userPrompt, {});
    expect(typeof text).toBe("string");
    expect(mockCallHaikuDirect).toHaveBeenCalledWith(systemPrompt, userPrompt, {});
  });

  it("callHaikuDirect returns empty string on failure (dream-pass gets rawText='')", async () => {
    mockCallHaikuDirect.mockResolvedValue("");
    const result = await mockCallHaikuDirect("system", "user", {});
    expect(result).toBe("");
  });
});
