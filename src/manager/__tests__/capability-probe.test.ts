import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";

/**
 * Phase 94 Plan 01 Task 1 — capability-probe primitive tests (RED).
 *
 * Tests pin:
 *   - PT-1 ready outcome → status "ready" + lastSuccessAt set to deps.now()
 *   - PT-2 degraded outcome → status "degraded" + error captured + lastSuccessAt
 *     preserved from prevSnapshot
 *   - PT-3 timeout enforcement (PROBE_TIMEOUT_MS = 10_000)
 *   - PT-4 verbatim error pass-through (Playwright sentinel "Executable doesn't
 *     exist at /home/clawcode/.cache/ms-playwright/...")
 *   - PT-5 reconnecting → ready transition
 *   - PT-6 lastSuccessAt preserved on degraded
 *   - PT-7 lastSuccessAt updated on ready
 *   - PT-PARALLEL-INDEPENDENCE — one probe failure does not block siblings
 *   - PT-IMMUT — orchestrator returns NEW Map; never mutates prevByName
 *   - PT-NO-LEAK — verbatim error pass-through documented (env values are
 *     never seen by the probe layer; this test asserts the truth)
 *
 * RED: src/manager/capability-probe.ts does not exist yet — imports fail.
 */

import {
  probeMcpCapability,
  probeAllMcpCapabilities,
  PROBE_TIMEOUT_MS,
  type ProbeOrchestratorDeps,
} from "../capability-probe.js";
import type { ProbeFn } from "../capability-probes.js";
import type { CapabilityProbeSnapshot } from "../persistent-session-handle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLog,
} as unknown as Logger;

function makeDeps(overrides: Partial<ProbeOrchestratorDeps> = {}): ProbeOrchestratorDeps {
  return {
    callTool: overrides.callTool ?? vi.fn().mockResolvedValue({}),
    listTools: overrides.listTools ?? vi.fn().mockResolvedValue([{ name: "x" }]),
    getProbeFor: overrides.getProbeFor,
    now: overrides.now ?? (() => new Date("2026-04-25T12:00:00.000Z")),
    log: overrides.log ?? noopLog,
  };
}

function fixedTime(iso: string): () => Date {
  return () => new Date(iso);
}

// ---------------------------------------------------------------------------
// Single-probe behaviour
// ---------------------------------------------------------------------------

describe("probeMcpCapability — single-server probe primitive", () => {
  it("PT-1 ready: probe ok → status='ready' + lastSuccessAt set to now", async () => {
    const okProbe: ProbeFn = async () => ({ kind: "ok" });
    const deps = makeDeps({
      now: fixedTime("2026-04-25T13:00:00.000Z"),
      getProbeFor: () => okProbe,
    });
    const snap = await probeMcpCapability("1password", deps);
    expect(snap.status).toBe("ready");
    expect(snap.lastRunAt).toBe("2026-04-25T13:00:00.000Z");
    expect(snap.lastSuccessAt).toBe("2026-04-25T13:00:00.000Z");
    expect(snap.error).toBeUndefined();
  });

  it("PT-2 degraded: probe failure → status='degraded' + error captured + lastSuccessAt preserved", async () => {
    const failProbe: ProbeFn = async () => ({ kind: "failure", error: "401 unauthorized" });
    const deps = makeDeps({
      now: fixedTime("2026-04-25T14:00:00.000Z"),
      getProbeFor: () => failProbe,
    });
    const prev: CapabilityProbeSnapshot = {
      lastRunAt: "2026-04-25T11:00:00.000Z",
      status: "ready",
      lastSuccessAt: "2026-04-25T11:00:00.000Z",
    };
    const snap = await probeMcpCapability("1password", deps, prev);
    expect(snap.status).toBe("degraded");
    expect(snap.error).toBe("401 unauthorized");
    expect(snap.lastSuccessAt).toBe("2026-04-25T11:00:00.000Z");
    expect(snap.lastRunAt).toBe("2026-04-25T14:00:00.000Z");
  });

  it("PT-3 timeout: probe never resolves → status='degraded' + error contains 'timeout' (PROBE_TIMEOUT_MS=10000)", async () => {
    expect(PROBE_TIMEOUT_MS).toBe(10_000);
    vi.useFakeTimers();
    try {
      const neverProbe: ProbeFn = () => new Promise(() => { /* hangs forever */ });
      const deps = makeDeps({
        now: fixedTime("2026-04-25T15:00:00.000Z"),
        getProbeFor: () => neverProbe,
      });
      const probePromise = probeMcpCapability("playwright", deps);
      // Advance fake timers past 10s so the timeout sentinel fires.
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 100);
      const snap = await probePromise;
      expect(snap.status).toBe("degraded");
      expect(snap.error).toMatch(/timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("PT-4 verbatim error pass-through: rejection with Playwright Executable doesn't exist at sentinel preserved", async () => {
    const sentinel =
      "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome";
    const throwingProbe: ProbeFn = async () => {
      throw new Error(sentinel);
    };
    const deps = makeDeps({ getProbeFor: () => throwingProbe });
    const snap = await probeMcpCapability("playwright", deps);
    expect(snap.status).toBe("degraded");
    expect(snap.error).toContain("Executable doesn't exist at");
    expect(snap.error).toContain("/home/clawcode/.cache/ms-playwright/");
    expect(snap.error!.length).toBeLessThan(500);
  });

  it("PT-5 reconnecting → ready: prior status='reconnecting' + probe ok → snapshot.status='ready'", async () => {
    const okProbe: ProbeFn = async () => ({ kind: "ok" });
    const deps = makeDeps({
      now: fixedTime("2026-04-25T16:00:00.000Z"),
      getProbeFor: () => okProbe,
    });
    const prev: CapabilityProbeSnapshot = {
      lastRunAt: "2026-04-25T15:30:00.000Z",
      status: "reconnecting",
    };
    const snap = await probeMcpCapability("browser", deps, prev);
    expect(snap.status).toBe("ready");
    expect(snap.lastSuccessAt).toBe("2026-04-25T16:00:00.000Z");
  });

  it("PT-6 lastSuccessAt preserved on degraded: prev had successAt → degraded snapshot keeps it", async () => {
    const failProbe: ProbeFn = async () => ({ kind: "failure", error: "boom" });
    const deps = makeDeps({
      now: fixedTime("2026-04-25T17:00:00.000Z"),
      getProbeFor: () => failProbe,
    });
    const prev: CapabilityProbeSnapshot = {
      lastRunAt: "2026-04-25T12:00:00.000Z",
      status: "ready",
      lastSuccessAt: "2026-04-25T12:00:00.000Z",
    };
    const snap = await probeMcpCapability("finnhub", deps, prev);
    expect(snap.status).toBe("degraded");
    expect(snap.lastSuccessAt).toBe("2026-04-25T12:00:00.000Z");
  });

  it("PT-7 lastSuccessAt updated on ready: probe ok → snapshot.lastSuccessAt === deps.now()", async () => {
    const okProbe: ProbeFn = async () => ({ kind: "ok" });
    const fixed = "2026-04-25T18:00:00.000Z";
    const deps = makeDeps({
      now: fixedTime(fixed),
      getProbeFor: () => okProbe,
    });
    const prev: CapabilityProbeSnapshot = {
      lastRunAt: "2026-04-25T17:00:00.000Z",
      status: "degraded",
      error: "old failure",
      lastSuccessAt: "2026-04-25T10:00:00.000Z",
    };
    const snap = await probeMcpCapability("brave-search", deps, prev);
    expect(snap.status).toBe("ready");
    expect(snap.lastSuccessAt).toBe(fixed);
    expect(snap.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Parallel orchestrator behaviour
// ---------------------------------------------------------------------------

describe("probeAllMcpCapabilities — parallel orchestrator", () => {
  it("PT-PARALLEL-INDEPENDENCE: one probe throwing does NOT block siblings (parallel independence)", async () => {
    const aProbe: ProbeFn = async () => ({ kind: "ok" });
    const bProbe: ProbeFn = async () => {
      throw new Error("b exploded");
    };
    const cProbe: ProbeFn = async () => ({ kind: "ok" });
    const lookup = (name: string): ProbeFn => {
      if (name === "a") return aProbe;
      if (name === "b") return bProbe;
      return cProbe;
    };
    const deps = makeDeps({
      now: fixedTime("2026-04-25T19:00:00.000Z"),
      getProbeFor: lookup,
    });

    const result = await probeAllMcpCapabilities(["a", "b", "c"], deps);
    expect(result.size).toBe(3);
    expect(result.get("a")!.status).toBe("ready");
    expect(result.get("b")!.status).toBe("degraded");
    expect(result.get("b")!.error).toMatch(/b exploded/);
    expect(result.get("c")!.status).toBe("ready");
  });

  it("PT-IMMUT: orchestrator returns NEW Map — input prevByName is not the same reference as output", async () => {
    const okProbe: ProbeFn = async () => ({ kind: "ok" });
    const deps = makeDeps({
      now: fixedTime("2026-04-25T20:00:00.000Z"),
      getProbeFor: () => okProbe,
    });
    const prev = new Map<string, CapabilityProbeSnapshot>([
      [
        "a",
        {
          lastRunAt: "2026-04-25T18:00:00.000Z",
          status: "ready",
          lastSuccessAt: "2026-04-25T18:00:00.000Z",
        },
      ],
    ]);
    const result = await probeAllMcpCapabilities(["a"], deps, prev);
    expect(Object.is(prev, result)).toBe(false);
    // Calling twice with the same prev produces independent results.
    const result2 = await probeAllMcpCapabilities(["a"], deps, prev);
    expect(Object.is(result, result2)).toBe(false);
  });

  it("PT-NO-LEAK: probe error message containing an env-shaped sentinel passes through verbatim (TOOL-04 truth check)", async () => {
    // Phase 85 TOOL-04 honours verbatim pass-through. The probe layer
    // never receives env values directly (only name + args are passed),
    // but if a server ECHOES an env-shaped sentinel back in its own error
    // text we surface it verbatim — operators see the truth. This test
    // pins the verbatim contract; future redaction (if added) will
    // require an explicit decision and will fail this test.
    const sentinel = "auth failed for env value SECRET_42";
    const errProbe: ProbeFn = async () => ({ kind: "failure", error: sentinel });
    const deps = makeDeps({
      now: fixedTime("2026-04-25T21:00:00.000Z"),
      getProbeFor: () => errProbe,
    });
    const snap = await probeMcpCapability("test-server", deps);
    expect(snap.status).toBe("degraded");
    // Verbatim — "auth failed" present (the actual error class)
    expect(snap.error).toContain("auth failed");
    // And the env-shaped sentinel passes through unredacted (current
    // verbatim contract). When/if redaction is added, flip this assertion.
    expect(snap.error).toContain("SECRET_42");
  });
});
