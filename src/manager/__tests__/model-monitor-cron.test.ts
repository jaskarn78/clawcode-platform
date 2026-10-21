import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ModelCatalogStore } from "../model-catalog-store.js";
import {
  registerModelMonitorCron,
  MODEL_MONITOR_CRON_PATTERN,
  type ModelMonitorCronDeps,
  type ModelMonitorCronFactory,
  type ModelMonitorHandleLike,
} from "../model-monitor-cron.js";
import type { ModelInfo } from "../sdk-types.js";

/**
 * Phase 999.98 D9 — registerModelMonitorCron tests, including the two BLOCKING
 * INC-2026-06-04 croner-landmine cases:
 *   - factory throws at CONSTRUCTION → {registered:false} (NOT a thrown error)
 *   - onTick throws → caught/logged, a SECOND trigger still fires the body
 */

interface StubCron {
  pattern: string;
  name?: string;
  stopped: boolean;
  trigger: () => Promise<void>;
}

function makeStubCronFactory(): {
  factory: ModelMonitorCronFactory;
  crons: StubCron[];
} {
  const crons: StubCron[] = [];
  const factory: ModelMonitorCronFactory = (pattern, opts, callback) => {
    const stub: StubCron = {
      pattern,
      name: opts.name,
      stopped: false,
      trigger: async () => {
        if (!stub.stopped) await callback();
      },
    };
    crons.push(stub);
    return {
      stop: () => {
        stub.stopped = true;
      },
    };
  };
  return { factory, crons };
}

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function handleWith(models: readonly ModelInfo[]): ModelMonitorHandleLike {
  return { getSupportedModels: async () => models };
}

function buildDeps(
  overrides: Partial<ModelMonitorCronDeps> = {},
): { deps: ModelMonitorCronDeps; crons: StubCron[]; store: ModelCatalogStore } {
  const stub = makeStubCronFactory();
  const store = overrides.catalogStore ?? new ModelCatalogStore(new Database(":memory:"));
  const deps: ModelMonitorCronDeps = {
    catalogStore: store,
    getRunningAgents: overrides.getRunningAgents ?? (() => []),
    getHandle: overrides.getHandle ?? (() => undefined),
    getPinnedAgents: overrides.getPinnedAgents ?? (() => []),
    refreshSnapshot: overrides.refreshSnapshot ?? (() => {}),
    postToAdminClawdy: overrides.postToAdminClawdy ?? (async () => {}),
    now: overrides.now ?? (() => 1_000),
    log: overrides.log ?? noopLog,
    cronFactory: overrides.cronFactory ?? stub.factory,
  };
  return { deps, crons: stub.crons, store };
}

describe("registerModelMonitorCron — wiring", () => {
  beforeEach(() => {
    noopLog.info.mockClear();
    noopLog.warn.mockClear();
    noopLog.error.mockClear();
  });

  it("registers with the STATIC six-hourly pattern (not derived from input)", () => {
    const { deps, crons } = buildDeps();
    const result = registerModelMonitorCron(deps);
    expect(result.registered).toBe(true);
    expect(crons).toHaveLength(1);
    expect(crons[0]!.pattern).toBe(MODEL_MONITOR_CRON_PATTERN);
    expect(crons[0]!.pattern).toBe("0 */6 * * *");
    expect(crons[0]!.name).toBe("model-monitor");
  });

  it("stop() halts the cron — subsequent triggers no-op", async () => {
    const refreshSnapshot = vi.fn();
    const { deps, crons } = buildDeps({ refreshSnapshot });
    const result = registerModelMonitorCron(deps);
    result.stop!();
    await crons[0]!.trigger();
    expect(refreshSnapshot).not.toHaveBeenCalled();
  });

  it("a normal tick upserts the entitled set + refreshes the snapshot", async () => {
    const refreshSnapshot = vi.fn();
    const { deps, crons, store } = buildDeps({
      getRunningAgents: () => ["a1"],
      getHandle: () => handleWith([{ value: "claude-opus-4-8", displayName: "Opus 4.8" }]),
      refreshSnapshot,
    });
    registerModelMonitorCron(deps);
    await crons[0]!.trigger();
    expect(store.snapshot().map((r) => r.model_id)).toContain("claude-opus-4-8");
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a per-agent getSupportedModels rejection is caught — the tick still upserts other agents", async () => {
    const refreshSnapshot = vi.fn();
    const { deps, crons, store } = buildDeps({
      getRunningAgents: () => ["bad", "good"],
      getHandle: (name) =>
        name === "bad"
          ? { getSupportedModels: async () => Promise.reject(new Error("handle dead")) }
          : handleWith([{ value: "claude-haiku-4-5", displayName: "Haiku 4.5" }]),
      refreshSnapshot,
      log: noopLog,
    });
    registerModelMonitorCron(deps);
    await crons[0]!.trigger();
    // The good agent's model still landed; the tick did not abort.
    expect(store.snapshot().map((r) => r.model_id)).toContain("claude-haiku-4-5");
    expect(noopLog.warn).toHaveBeenCalled();
  });

  it("COLD-START GUARD: first tick against an empty catalog seeds the baseline but surfaces NOTHING", async () => {
    // On a fresh deploy the catalog is empty → every currently-entitled family
    // would otherwise be flagged a "new tier" (4 spurious Admin-Clawdy posts).
    const posted: string[] = [];
    const store = new ModelCatalogStore(new Database(":memory:"));
    const { deps, crons } = buildDeps({
      catalogStore: store,
      getRunningAgents: () => ["a1"],
      getHandle: () =>
        handleWith([
          { value: "claude-opus-4-8", displayName: "Opus 4.8" },
          { value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
        ]),
      postToAdminClawdy: async (msg) => {
        posted.push(msg);
      },
    });
    registerModelMonitorCron(deps);
    await crons[0]!.trigger();
    // Baseline seeded (models recorded) ...
    expect(store.snapshot().map((r) => r.model_id).sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-8",
    ]);
    // ... but ZERO surfaces (the cold-start false-positive is suppressed).
    expect(posted).toHaveLength(0);
  });

  it("the SECOND tick (populated baseline) surfaces only a GENUINELY-new family", async () => {
    const posted: string[] = [];
    const store = new ModelCatalogStore(new Database(":memory:"));
    let discovered: ModelInfo[] = [{ value: "claude-opus-4-8", displayName: "Opus 4.8" }];
    const { deps, crons } = buildDeps({
      catalogStore: store,
      getRunningAgents: () => ["a1"],
      getHandle: () => handleWith(discovered),
      postToAdminClawdy: async (msg) => {
        posted.push(msg);
      },
    });
    registerModelMonitorCron(deps);
    // Tick 1 — empty catalog → baseline seed, no surface.
    await crons[0]!.trigger();
    expect(posted).toHaveLength(0);
    // Tick 2 — a NEW family appears; the populated baseline surfaces just it.
    discovered = [
      { value: "claude-opus-4-8", displayName: "Opus 4.8" },
      { value: "claude-fable-5", displayName: "Fable 5" },
    ];
    await crons[0]!.trigger();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("fable@latest");
  });
});

describe("registerModelMonitorCron — INC-2026-06-04 croner-landmine [BLOCKING]", () => {
  beforeEach(() => {
    noopLog.info.mockClear();
    noopLog.warn.mockClear();
    noopLog.error.mockClear();
  });

  it("factory throws at CONSTRUCTION → {registered:false}, NOT a thrown error", () => {
    const throwingFactory: ModelMonitorCronFactory = () => {
      throw new Error(
        "CronPattern: Syntax error, steps cannot be greater than maximum value of part (60)",
      );
    };
    const { deps } = buildDeps({ cronFactory: throwingFactory, log: noopLog });
    let result: ReturnType<typeof registerModelMonitorCron> | undefined;
    expect(() => {
      result = registerModelMonitorCron(deps);
    }).not.toThrow();
    expect(result!.registered).toBe(false);
    expect(result!.reason).toBe("pattern-error");
    expect(noopLog.error).toHaveBeenCalled();
  });

  it("onTick throws → caught/logged; a SECOND trigger still fires the body", async () => {
    // Drive the catalog store's snapshot() to throw on the FIRST tick only, so
    // the body throws inside the try/catch; the second tick proceeds normally.
    let calls = 0;
    const refreshSnapshot = vi.fn();
    const store = new ModelCatalogStore(new Database(":memory:"));
    const realSnapshot = store.snapshot.bind(store);
    vi.spyOn(store, "snapshot").mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error("boom — tick 1");
      return realSnapshot();
    });

    const { deps, crons } = buildDeps({
      catalogStore: store,
      getRunningAgents: () => [],
      refreshSnapshot,
      log: noopLog,
    });
    registerModelMonitorCron(deps);

    // Tick 1 — body throws internally, caught + logged, does NOT escape.
    await expect(crons[0]!.trigger()).resolves.toBeUndefined();
    expect(noopLog.error).toHaveBeenCalled();
    expect(refreshSnapshot).not.toHaveBeenCalled(); // threw before refresh

    // Tick 2 — the cron is still alive; the body runs to completion.
    await expect(crons[0]!.trigger()).resolves.toBeUndefined();
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });
});
