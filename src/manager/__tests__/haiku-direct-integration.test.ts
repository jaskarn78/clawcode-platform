/**
 * Phase 999.58 Plan 02 T03 — integration tests for the per-consumer
 * site-tag wiring.
 *
 * Four integration tests:
 *   IT1 — summarize-with-haiku (Phase 99 session summarizer) passes
 *         site="summarizer" to callHaikuDirect.
 *   IT2 — auto-ingest-handler default chartVisionCall (callHaikuVision)
 *         propagates site="vision-pre-pass" through the DI seam by
 *         relying on the haiku-direct default. Verified by calling
 *         callHaikuVision with no `site` arg and asserting the bridge
 *         receives "vision-pre-pass".
 *   IT3 — explicit "dream-pass" site tag (used by daemon.ts dream-pass
 *         dispatch closure) propagates through callHaikuDirect to the
 *         bridge.
 *   IT4 — explicit "skill-distiller" site tag (used by daemon.ts
 *         phase132 distiller closure) propagates through callHaikuDirect
 *         to the bridge.
 *
 * Note on scope: we do NOT instantiate the daemon to exercise the two
 * daemon-internal call sites end-to-end — the daemon's startup graph
 * pulls in too many side-effect imports. Instead, IT3 + IT4 verify
 * that the explicit site-tag PROPAGATION works (the daemon's closures
 * forward the literal "dream-pass" / "skill-distiller" tags through
 * callHaikuDirect to runHaikuViaBridge). The actual closures in
 * daemon.ts are verified by static grep + the standalone callHaikuDirect
 * 4-arg behavior in HT1 of haiku-direct.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunHaikuViaBridge = vi.fn();
vi.mock("../../bridge/haiku-via-bridge.js", () => ({
  runHaikuViaBridge: mockRunHaikuViaBridge,
}));

const {
  callHaikuDirect,
  callHaikuVision,
  __setHaikuRoutingForTests,
  _resetClientForTests,
} = await import("../haiku-direct.js");

const { summarizeWithHaiku } = await import("../summarize-with-haiku.js");

beforeEach(() => {
  mockRunHaikuViaBridge.mockReset();
  mockRunHaikuViaBridge.mockResolvedValue({
    text: "ok",
    durationMs: 1,
    costUsd: null,
    succeeded: true,
  });
  _resetClientForTests();
  __setHaikuRoutingForTests("bridge");
});

// ----------------------------------------------------------------
// IT1 — summarize-with-haiku → site=summarizer
// ----------------------------------------------------------------

describe("IT1 — summarize-with-haiku → site='summarizer'", () => {
  it("propagates site='summarizer' through callHaikuDirect to the bridge", async () => {
    await summarizeWithHaiku("session summary prompt", {});
    expect(mockRunHaikuViaBridge).toHaveBeenCalledTimes(1);
    const args = mockRunHaikuViaBridge.mock.calls[0]![0] as { site: string };
    expect(args.site).toBe("summarizer");
  });
});

// ----------------------------------------------------------------
// IT2 — chart-vision default site=vision-pre-pass via DI seam
// ----------------------------------------------------------------

describe("IT2 — auto-ingest-handler chart-vision default site='vision-pre-pass'", () => {
  it("callHaikuVision with no `site` arg defaults to vision-pre-pass (matches DI seam expectation)", async () => {
    // The auto-ingest-handler DI seam invokes
    // `chartVisionCall(systemPrompt, userPrompt, fileBuffer, mediaType,
    // opts)` with NO 6th argument — callHaikuVision applies its default
    // site="vision-pre-pass". This test asserts the default propagates.
    await callHaikuVision(
      "vision system prompt",
      "describe the chart",
      Buffer.from("fake-png-bytes"),
      "image/png",
      {},
    );
    expect(mockRunHaikuViaBridge).toHaveBeenCalledTimes(1);
    const args = mockRunHaikuViaBridge.mock.calls[0]![0] as { site: string };
    expect(args.site).toBe("vision-pre-pass");
  });
});

// ----------------------------------------------------------------
// IT3 — dream-pass dispatch propagates site='dream-pass'
// ----------------------------------------------------------------

describe("IT3 — dream-pass closure → site='dream-pass'", () => {
  it("explicit 4th-arg site='dream-pass' reaches the bridge", async () => {
    // This mirrors what daemon.ts dream-pass dispatch closure does
    // post-T03: callHaikuDirect(systemPrompt, userPrompt, opts,
    // "dream-pass").
    await callHaikuDirect("sys", "user", { maxTokens: 4096 }, "dream-pass");
    expect(mockRunHaikuViaBridge).toHaveBeenCalledTimes(1);
    const args = mockRunHaikuViaBridge.mock.calls[0]![0] as {
      site: string;
      maxTokens?: number;
    };
    expect(args.site).toBe("dream-pass");
    expect(args.maxTokens).toBe(4096);
  });
});

// ----------------------------------------------------------------
// IT4 — phase132 skill-distiller propagates site='skill-distiller'
// ----------------------------------------------------------------

describe("IT4 — phase132 distiller closure → site='skill-distiller'", () => {
  it("explicit 4th-arg site='skill-distiller' reaches the bridge", async () => {
    // Mirrors daemon.ts phase132 distiller closure post-T03:
    // callHaikuDirect(systemPrompt, userPrompt, opts, "skill-distiller").
    await callHaikuDirect(
      "distiller-sys",
      "distiller-user",
      { maxTokens: 4096, signal: new AbortController().signal },
      "skill-distiller",
    );
    expect(mockRunHaikuViaBridge).toHaveBeenCalledTimes(1);
    const args = mockRunHaikuViaBridge.mock.calls[0]![0] as {
      site: string;
      maxTokens?: number;
      signal?: AbortSignal;
    };
    expect(args.site).toBe("skill-distiller");
    expect(args.maxTokens).toBe(4096);
    expect(args.signal).toBeDefined();
  });
});
