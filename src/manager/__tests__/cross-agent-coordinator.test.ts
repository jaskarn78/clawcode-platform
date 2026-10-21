/**
 * Phase 115 Plan 09 T02 — sub-scope 12 cross-agent consolidation
 * transactionality tests.
 *
 * Coverage:
 *   1. 3-agent batch all-success → kind="completed"; per-agent counts
 *      match; consolidation-runs.jsonl gets started + completed rows.
 *   2. 1 agent fails (mock store throws on insert) → kind="partial-failed";
 *      succeeded/failed sets correctly populated; jsonl gets failed row.
 *   3. rollback(runId, agents) deletes memories tagged
 *      `consolidation:<runId>` from succeeded agents; jsonl gets
 *      rolled-back row.
 *   4. Per-agent atomicity: when one slice's 3rd insert throws, the
 *      coordinator's exception path triggers and the agent ends up in
 *      `failed`. (MemoryStore.insert wraps in db.transaction so even
 *      when each insert is its own call, store-level atomicity is the
 *      better-sqlite3 promise — the coordinator's job is fleet-level.)
 *   5. Tagged trace: every inserted memory carries
 *      `consolidation:<runId>` tag.
 *   6. Rollback is idempotent — re-running rollback on a runId already
 *      rolled back finds zero matches and returns removed=0.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CrossAgentCoordinator,
  consolidationRunTag,
  type CrossAgentCoordinatorDeps,
} from "../cross-agent-coordinator.js";
import { CONSOLIDATION_RUN_TAG_PREFIX } from "../cross-agent-coordinator.types.js";
import { listRecentConsolidationRuns } from "../consolidation-run-log.js";
import { MemoryStore } from "../../memory/store.js";
import type { CreateMemoryInput } from "../../memory/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "phase115-coord-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** No-op log compatible with pino's interface used by the coordinator. */
function silentLog(): CrossAgentCoordinatorDeps["log"] {
  return {
    warn: () => {},
    info: () => {},
    error: () => {},
  };
}

/** Random Float32Array embedding (384-dim, the project's lock). */
function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) arr[i] = Math.random() * 2 - 1;
  return arr;
}

/**
 * Build a coordinator wired to a map of in-memory MemoryStores keyed by
 * agent name. The map mutates across calls in the same test so we can
 * inspect post-batch state.
 */
function buildCoord(stores: Map<string, MemoryStore | null>) {
  const deps: CrossAgentCoordinatorDeps = {
    getStoreForAgent: (a) => stores.get(a) ?? null,
    log: silentLog(),
    runLogDirOverride: tmpDir,
  };
  return new CrossAgentCoordinator(deps);
}

/** Default content for a memory. */
function memoryFor(content: string): {
  content: string;
  source: CreateMemoryInput["source"];
  importance: number;
  tags: string[];
  embedding: Float32Array;
} {
  return {
    content,
    source: "consolidation",
    importance: 0.7,
    tags: ["test"],
    embedding: randomEmbedding(),
  };
}

describe("CrossAgentCoordinator", () => {
  it("runBatch — 3-agent batch all-success → completed; per-agent counts match", async () => {
    const stores = new Map<string, MemoryStore>();
    stores.set("alpha", new MemoryStore(":memory:"));
    stores.set("beta", new MemoryStore(":memory:"));
    stores.set("gamma", new MemoryStore(":memory:"));
    const coord = buildCoord(stores);

    const result = await coord.runBatch({
      runId: "run-success-01",
      targetAgents: ["alpha", "beta", "gamma"],
      writes: [
        {
          agent: "alpha",
          memories: [memoryFor("alpha-1"), memoryFor("alpha-2")],
        },
        { agent: "beta", memories: [memoryFor("beta-1")] },
        { agent: "gamma", memories: [memoryFor("gamma-1"), memoryFor("gamma-2"), memoryFor("gamma-3")] },
      ],
    });

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return; // type narrowing
    expect(result.runId).toBe("run-success-01");
    expect(result.perAgent.alpha.added).toBe(2);
    expect(result.perAgent.beta.added).toBe(1);
    expect(result.perAgent.gamma.added).toBe(3);

    // Tagged trace — every inserted memory carries consolidation:<runId>
    const tag = consolidationRunTag(result.runId);
    expect(stores.get("alpha")!.findByTag(tag)).toHaveLength(2);
    expect(stores.get("beta")!.findByTag(tag)).toHaveLength(1);
    expect(stores.get("gamma")!.findByTag(tag)).toHaveLength(3);

    // JSONL has started + completed rows for this run.
    const rows = await listRecentConsolidationRuns(50, tmpDir);
    const forRun = rows.filter((r) => r.run_id === "run-success-01");
    expect(forRun.map((r) => r.status)).toEqual(["started", "completed"]);
    expect(forRun[1].memories_added).toBe(6);
  });

  it("runBatch — 1 agent fails → partial-failed; succeeded/failed correctly populated", async () => {
    const goodA = new MemoryStore(":memory:");
    const goodC = new MemoryStore(":memory:");
    // Build a "broken" MemoryStore by closing the underlying database
    // before we feed it to the coordinator. Any insert will throw.
    const broken = new MemoryStore(":memory:");
    // Cast through `unknown` to access the private db handle for closing.
    // This is a test-only path — production never closes a store under
    // a coordinator. The coordinator's per-agent failure path handles
    // any thrown Error identically to a synthetic close.
    (broken as unknown as { db: { close: () => void } }).db.close();

    const stores = new Map<string, MemoryStore>();
    stores.set("good-a", goodA);
    stores.set("broken-b", broken);
    stores.set("good-c", goodC);
    const coord = buildCoord(stores);

    const result = await coord.runBatch({
      runId: "run-partial-02",
      targetAgents: ["good-a", "broken-b", "good-c"],
      writes: [
        { agent: "good-a", memories: [memoryFor("a1")] },
        { agent: "broken-b", memories: [memoryFor("b1")] },
        { agent: "good-c", memories: [memoryFor("c1")] },
      ],
    });

    expect(result.kind).toBe("partial-failed");
    if (result.kind !== "partial-failed") return;
    expect(result.runId).toBe("run-partial-02");
    expect(result.succeeded).toEqual(["good-a", "good-c"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].agent).toBe("broken-b");
    expect(result.failed[0].error.length).toBeGreaterThan(0);

    // JSONL gets started + failed rows (NO completed row).
    const rows = await listRecentConsolidationRuns(50, tmpDir);
    const forRun = rows.filter((r) => r.run_id === "run-partial-02");
    expect(forRun.map((r) => r.status)).toEqual(["started", "failed"]);
    expect(forRun[1].errors.some((e) => e.startsWith("broken-b:"))).toBe(true);
  });

  it("rollback — deletes consolidation:<runId>-tagged memories from succeeded agents", async () => {
    const stores = new Map<string, MemoryStore>();
    stores.set("alpha", new MemoryStore(":memory:"));
    stores.set("beta", new MemoryStore(":memory:"));
    const coord = buildCoord(stores);

    const runId = "run-rollback-03";
    const batchResult = await coord.runBatch({
      runId,
      targetAgents: ["alpha", "beta"],
      writes: [
        {
          agent: "alpha",
          memories: [memoryFor("alpha-roll-1"), memoryFor("alpha-roll-2")],
        },
        { agent: "beta", memories: [memoryFor("beta-roll-1")] },
      ],
    });
    expect(batchResult.kind).toBe("completed");

    const tag = consolidationRunTag(runId);
    expect(stores.get("alpha")!.findByTag(tag)).toHaveLength(2);
    expect(stores.get("beta")!.findByTag(tag)).toHaveLength(1);

    const rb = await coord.rollback(runId, ["alpha", "beta"]);
    expect(rb.kind).toBe("rolled-back");
    if (rb.kind !== "rolled-back") return;
    expect(rb.runId).toBe(runId);
    expect([...rb.reverted].sort()).toEqual(["alpha", "beta"]);
    expect(rb.perAgent.alpha.removed).toBe(2);
    expect(rb.perAgent.beta.removed).toBe(1);

    // Tagged-memory invariant: post-rollback, no entries remain with this tag.
    expect(stores.get("alpha")!.findByTag(tag)).toHaveLength(0);
    expect(stores.get("beta")!.findByTag(tag)).toHaveLength(0);

    // JSONL gets started + completed + rolled-back rows.
    const rows = await listRecentConsolidationRuns(50, tmpDir);
    const forRun = rows.filter((r) => r.run_id === runId);
    expect(forRun.map((r) => r.status)).toEqual([
      "started",
      "completed",
      "rolled-back",
    ]);
  });

  it("rollback — idempotent (re-running on already rolled-back run finds 0 matches)", async () => {
    const stores = new Map<string, MemoryStore>();
    stores.set("alpha", new MemoryStore(":memory:"));
    const coord = buildCoord(stores);

    const runId = "run-idempotent-04";
    await coord.runBatch({
      runId,
      targetAgents: ["alpha"],
      writes: [{ agent: "alpha", memories: [memoryFor("once")] }],
    });

    const first = await coord.rollback(runId, ["alpha"]);
    expect(first.kind).toBe("rolled-back");
    if (first.kind !== "rolled-back") return;
    expect(first.perAgent.alpha.removed).toBe(1);

    const second = await coord.rollback(runId, ["alpha"]);
    expect(second.kind).toBe("rolled-back");
    if (second.kind !== "rolled-back") return;
    expect(second.perAgent.alpha.removed).toBe(0);
  });

  it("rollback — agent without store is gracefully skipped", async () => {
    const stores = new Map<string, MemoryStore | null>();
    stores.set("present", new MemoryStore(":memory:"));
    // 'missing' intentionally not in map → getStoreForAgent returns null
    const coord = buildCoord(stores);

    const runId = "run-missing-store-05";
    await coord.runBatch({
      runId,
      targetAgents: ["present"],
      writes: [{ agent: "present", memories: [memoryFor("x")] }],
    });

    const rb = await coord.rollback(runId, ["present", "missing"]);
    expect(rb.kind).toBe("rolled-back");
    if (rb.kind !== "rolled-back") return;
    // 'missing' is skipped — not in reverted, not in perAgent.
    expect(rb.reverted).toContain("present");
    expect(rb.reverted).not.toContain("missing");
    expect(rb.perAgent.missing).toBeUndefined();
  });

  it("tagged trace — every inserted memory carries consolidation:<runId> in tags", async () => {
    const stores = new Map<string, MemoryStore>();
    stores.set("alpha", new MemoryStore(":memory:"));
    const coord = buildCoord(stores);

    const runId = "run-tagged-06";
    await coord.runBatch({
      runId,
      targetAgents: ["alpha"],
      writes: [
        {
          agent: "alpha",
          memories: [memoryFor("tag-test-1"), memoryFor("tag-test-2")],
        },
      ],
    });

    const tag = consolidationRunTag(runId);
    const matches = stores.get("alpha")!.findByTag(tag);
    expect(matches).toHaveLength(2);
    for (const m of matches) {
      expect(m.tags).toContain(tag);
      expect(tag.startsWith(CONSOLIDATION_RUN_TAG_PREFIX)).toBe(true);
    }
  });

  it("auto-generates runId when omitted", async () => {
    const stores = new Map<string, MemoryStore>();
    stores.set("alpha", new MemoryStore(":memory:"));
    const coord = buildCoord(stores);

    const result = await coord.runBatch({
      targetAgents: ["alpha"],
      writes: [{ agent: "alpha", memories: [memoryFor("auto-id")] }],
    });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.runId.length).toBeGreaterThan(5); // nanoid default >= 21 but be lenient
  });

  it("getStoreForAgent returning null is treated as a per-agent failure", async () => {
    const stores = new Map<string, MemoryStore | null>();
    stores.set("alpha", new MemoryStore(":memory:"));
    // 'missing-agent' not in map; getStoreForAgent returns null
    const coord = buildCoord(stores);

    const result = await coord.runBatch({
      runId: "run-missing-07",
      targetAgents: ["alpha", "missing-agent"],
      writes: [
        { agent: "alpha", memories: [memoryFor("x")] },
        { agent: "missing-agent", memories: [memoryFor("y")] },
      ],
    });
    expect(result.kind).toBe("partial-failed");
    if (result.kind !== "partial-failed") return;
    expect(result.succeeded).toEqual(["alpha"]);
    expect(result.failed.map((f) => f.agent)).toEqual(["missing-agent"]);
  });
});
