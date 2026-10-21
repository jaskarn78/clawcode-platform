import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runWarmPathCheck,
  WARM_PATH_TIMEOUT_MS,
  type WarmPathResult,
} from "../warm-path-check.js";
import { MCP_HANDSHAKE_TIMEOUT_WARMPATH_MS } from "../../mcp/readiness.js";

/**
 * Phase 56 Plan 01 — composite warm-path readiness helper tests.
 *
 * Coverage:
 *   1. Happy path returns ready:true with all 3 duration fields populated.
 *   2. Embedder not ready → ready:false with "embedder: not ready" error.
 *   3. Embedder probe throw → ready:false with embedder-scoped error message.
 *   4. sqliteWarm throw → error captured; ready:false.
 *   5. sessionProbe throw → error captured; ready:false.
 *   6. No sessionProbe supplied → session duration measured but no error.
 *   7. Timeout via fake timers → "timeout after 10000ms" error.
 *   8. Result object and its arrays/records are frozen.
 *   9. WARM_PATH_TIMEOUT_MS exported and exceeds the cold MCP handshake
 *      budget (so the overall warm-path race never kills a cold
 *      `clawcode mcp` handshake before it can finish).
 */

function makeSqliteWarmOk(): (name: string) => Promise<{ memories_ms: number; usage_ms: number; traces_ms: number }> {
  return async (_name: string) => ({ memories_ms: 5, usage_ms: 3, traces_ms: 4 });
}

function makeEmbedderOk(): { isReady: () => boolean; embed: (t: string) => Promise<Float32Array> } {
  return {
    isReady: () => true,
    embed: vi.fn(async (_t: string) => new Float32Array(384)),
  };
}

describe("runWarmPathCheck", () => {
  it("happy path: returns ready:true with all 3 durations and no errors", async () => {
    const result = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: makeSqliteWarmOk(),
      embedder: makeEmbedderOk(),
    });

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.durations_ms.sqlite).toBeGreaterThanOrEqual(0);
    expect(result.durations_ms.embedder).toBeGreaterThanOrEqual(0);
    expect(result.durations_ms.session).toBeGreaterThanOrEqual(0);
    expect(result.total_ms).toBeGreaterThanOrEqual(0);
  });

  it("sqlite sum is propagated from sqliteWarm result", async () => {
    const result = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: async () => ({ memories_ms: 10, usage_ms: 20, traces_ms: 30 }),
      embedder: makeEmbedderOk(),
    });
    // sqlite duration captures the sum of the sub-durations
    expect(result.durations_ms.sqlite).toBe(60);
  });

  it("embedder not ready → ready:false with 'embedder: not ready' error", async () => {
    const result = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: makeSqliteWarmOk(),
      embedder: {
        isReady: () => false,
        embed: vi.fn(),
      },
    });
    expect(result.ready).toBe(false);
    expect(result.errors).toContain("embedder: not ready");
  });

  it("embedder probe throw → ready:false with embedder-scoped error", async () => {
    const result = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: makeSqliteWarmOk(),
      embedder: {
        isReady: () => true,
        embed: async () => {
          throw new Error("onnx runtime exploded");
        },
      },
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.startsWith("embedder:"))).toBe(true);
    expect(result.errors.some((e) => e.includes("onnx runtime exploded"))).toBe(true);
  });

  it("sqliteWarm throw → ready:false with sqlite-scoped error", async () => {
    const result = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: async () => {
        throw new Error("no memory store");
      },
      embedder: makeEmbedderOk(),
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.startsWith("sqlite:"))).toBe(true);
    expect(result.errors.some((e) => e.includes("no memory store"))).toBe(true);
  });

  it("sessionProbe throw → ready:false with session-scoped error", async () => {
    const result = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: makeSqliteWarmOk(),
      embedder: makeEmbedderOk(),
      sessionProbe: async () => {
        throw new Error("session adapter offline");
      },
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.startsWith("session:"))).toBe(true);
  });

  it("no sessionProbe → session duration measured, no error", async () => {
    const result = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: makeSqliteWarmOk(),
      embedder: makeEmbedderOk(),
    });
    expect(result.errors.filter((e) => e.startsWith("session:"))).toHaveLength(0);
    expect(result.durations_ms.session).toBeGreaterThanOrEqual(0);
  });

  // Phase 70 Plan 03 — browser probe integration.
  it("browserProbe success → durations_ms.browser populated, no error", async () => {
    const browserProbe = vi.fn(async () => {
      // Tiny delay so measured duration is > 0ms.
      await new Promise((r) => setTimeout(r, 1));
    });
    const result = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: makeSqliteWarmOk(),
      embedder: makeEmbedderOk(),
      browserProbe,
    });
    expect(browserProbe).toHaveBeenCalledTimes(1);
    expect(result.ready).toBe(true);
    expect(result.durations_ms.browser).toBeGreaterThan(0);
    expect(result.errors.filter((e) => e.startsWith("browser:"))).toHaveLength(0);
  });

  it("no browserProbe → durations_ms.browser === 0 and no error", async () => {
    const result = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: makeSqliteWarmOk(),
      embedder: makeEmbedderOk(),
    });
    expect(result.durations_ms.browser).toBe(0);
    expect(result.errors.filter((e) => e.startsWith("browser:"))).toHaveLength(0);
  });

  it("browserProbe failure → ready:false with 'browser: <msg>' error", async () => {
    const result = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: makeSqliteWarmOk(),
      embedder: makeEmbedderOk(),
      browserProbe: async () => {
        throw new Error("chromium not warmed");
      },
    });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.startsWith("browser:"))).toBe(true);
    expect(result.errors.some((e) => e.includes("chromium not warmed"))).toBe(true);
  });

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sqliteWarm that never resolves triggers timeout error", async () => {
      const promise = runWarmPathCheck({
        agent: "alice",
        sqliteWarm: () =>
          new Promise(() => {
            /* never resolves */
          }),
        embedder: makeEmbedderOk(),
        timeoutMs: 10_000,
      });
      // Advance past the timeout.
      await vi.advanceTimersByTimeAsync(10_001);
      const result = await promise;
      expect(result.ready).toBe(false);
      expect(result.errors).toContain("timeout after 10000ms");
    });
  });

  it("returns a frozen result object with frozen nested durations_ms and errors", async () => {
    const result: WarmPathResult = await runWarmPathCheck({
      agent: "alice",
      sqliteWarm: makeSqliteWarmOk(),
      embedder: makeEmbedderOk(),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.durations_ms)).toBe(true);
    expect(Object.isFrozen(result.errors)).toBe(true);
  });

  it("WARM_PATH_TIMEOUT_MS exceeds the cold MCP handshake budget", () => {
    // The overall warm-path race must comfortably outlast the cold
    // `clawcode mcp` handshake run inside Step 5's mcpProbe, plus
    // headroom for the sqlite / embedder / session / browser steps.
    // A budget <= the handshake timeout would race-kill the work
    // before a cold MCP boot could finish — the fin-client
    // recovery-loop incident (2026-05-21).
    expect(WARM_PATH_TIMEOUT_MS).toBeGreaterThan(
      MCP_HANDSHAKE_TIMEOUT_WARMPATH_MS,
    );
  });
});
