/**
 * P3 (memory program, 3b) — SpawnGovernor unit tests.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  SpawnGovernor,
  SpawnAdmissionError,
  spawnClassOf,
  type ResolvedSpawnGovernorConfig,
} from "../spawn-governor.js";

const silent = pino({ level: "silent" });

function makeGovernor(args: {
  cfg?: ResolvedSpawnGovernorConfig;
  memoryPct?: () => Promise<number | null>;
  sink?: Record<string, unknown>[];
}) {
  const sink = args.sink ?? [];
  const log = args.sink
    ? pino(
        { level: "info" },
        {
          write(line: string) {
            try {
              sink.push(JSON.parse(line) as Record<string, unknown>);
            } catch {
              /* ignore */
            }
          },
        },
      )
    : silent;
  return new SpawnGovernor({
    resolveConfig: () => args.cfg,
    readMemoryPercent: args.memoryPct ?? (async () => 40),
    log,
    sleep: () => new Promise((r) => setImmediate(r)),
  });
}

describe("spawnClassOf", () => {
  it("maps kinds to governance classes", () => {
    expect(spawnClassOf("personal")).toBe("agent");
    expect(spawnClassOf("a-sub-x1y2z3")).toBe("worker");
    expect(spawnClassOf("a-via-b-x1y2z3")).toBe("worker");
    expect(spawnClassOf("a-thread-w")).toBe("worker");
    expect(spawnClassOf("a-fork-x1y2z3")).toBe("fork");
    expect(spawnClassOf("a-fork-x1y2z3-opt")).toBe("fork");
    expect(spawnClassOf("a-pool-x1y2z3")).toBe("pool");
  });
});

describe("SpawnGovernor", () => {
  it("fast path: acquire + release turn slots over; release is idempotent", async () => {
    const g = makeGovernor({});
    const r1 = await g.acquire("a-fork-aaaaaa");
    expect(g.stats.fork.active).toBe(1);
    r1();
    r1(); // idempotent
    expect(g.stats.fork.active).toBe(0);
  });

  it("enforce: FIFO ordering under contention — late arrival cannot jump the queue", async () => {
    const g = makeGovernor({
      cfg: { classes: { fork: { maxConcurrentSpawns: 1, mode: "enforce" } } },
    });
    const order: string[] = [];
    const r1 = await g.acquire("a-fork-aaaaaa");
    const p2 = g.acquire("a-fork-bbbbbb").then((r) => {
      order.push("second");
      return r;
    });
    const p3 = g.acquire("a-fork-cccccc").then((r) => {
      order.push("third");
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]); // both queued behind the held slot
    r1();
    const r2 = await p2;
    r2();
    const r3 = await p3;
    r3();
    expect(order).toEqual(["second", "third"]);
  });

  it("advisory (agent class): admits over the cap with an advisory-block line, never throws", async () => {
    const sink: Record<string, unknown>[] = [];
    const g = makeGovernor({
      cfg: { classes: { agent: { maxConcurrentSpawns: 1, mode: "advisory" } } },
      sink,
    });
    const r1 = await g.acquire("alpha");
    const r2 = await g.acquire("beta"); // over cap — admitted anyway
    expect(g.stats.agent.active).toBe(2);
    expect(
      sink.some(
        (l) => l.action === "advisory-block" && l.reason === "concurrency",
      ),
    ).toBe(true);
    r1();
    r2();
  });

  it("advisory under memory pressure: admits with advisory-block(memory)", async () => {
    const sink: Record<string, unknown>[] = [];
    const g = makeGovernor({ memoryPct: async () => 99, sink });
    const r = await g.acquire("alpha");
    expect(
      sink.some((l) => l.action === "advisory-block" && l.reason === "memory"),
    ).toBe(true);
    r();
  });

  it("enforce: memory pressure defers, then admits when pressure clears", async () => {
    let pct = 99;
    const sink: Record<string, unknown>[] = [];
    const g = makeGovernor({ memoryPct: async () => pct, sink });
    const p = g.acquire("a-fork-aaaaaa");
    await new Promise((r) => setTimeout(r, 20));
    expect(g.stats.fork.active).toBe(0);
    pct = 40;
    const rel = await p;
    expect(g.stats.fork.active).toBe(1);
    expect(sink.some((l) => l.action === "deferred")).toBe(true);
    rel();
  });

  it("enforce: admission timeout throws SpawnAdmissionError with the blocking reason", async () => {
    const g = makeGovernor({
      cfg: {
        admissionTimeoutMs: 1_000,
        classes: { fork: { maxConcurrentSpawns: 1, mode: "enforce" } },
      },
    });
    const hold = await g.acquire("a-fork-aaaaaa");
    await expect(g.acquire("a-fork-bbbbbb")).rejects.toMatchObject({
      name: "SpawnAdmissionError",
      reason: "concurrency",
    });
    hold();
  });

  it("enforce: queue-depth cap rejects immediately", async () => {
    const g = makeGovernor({
      cfg: {
        queueDepthPerClass: 1,
        admissionTimeoutMs: 60_000,
        classes: { fork: { maxConcurrentSpawns: 1, mode: "enforce" } },
      },
    });
    const hold = await g.acquire("a-fork-aaaaaa");
    const queued = g.acquire("a-fork-bbbbbb"); // fills the queue
    await new Promise((r) => setTimeout(r, 5));
    await expect(g.acquire("a-fork-cccccc")).rejects.toMatchObject({
      reason: "queue-full",
    });
    hold();
    (await queued)();
  });

  it("fail-open: throwing memory reader admits", async () => {
    const g = makeGovernor({
      memoryPct: async () => {
        throw new Error("cgroup gone");
      },
    });
    const r = await g.acquire("a-fork-aaaaaa");
    expect(g.stats.fork.active).toBe(1);
    r();
  });

  it("enabled:false → no-op acquire", async () => {
    const g = makeGovernor({ cfg: { enabled: false } });
    const r = await g.acquire("a-fork-aaaaaa");
    expect(g.stats.fork.active).toBe(0);
    r();
  });

  it("maxResidentForks resolves from config with kill-switch bypass", () => {
    expect(makeGovernor({}).maxResidentForks()).toBe(4);
    expect(
      makeGovernor({ cfg: { maxResidentForks: 2 } }).maxResidentForks(),
    ).toBe(2);
    expect(
      makeGovernor({ cfg: { enabled: false } }).maxResidentForks(),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("schema defaults.spawnGovernor", () => {
  it("empty block fills defaults; bad class key rejected", async () => {
    const { defaultsSchema } = await import("../../config/schema.js");
    const filled = defaultsSchema.parse({ spawnGovernor: {} }).spawnGovernor;
    expect(filled).toMatchObject({
      enabled: true,
      memoryWatermarkPercent: 85,
      admissionTimeoutMs: 120_000,
      queueDepthPerClass: 16,
      maxResidentForks: 4,
    });
    expect(() =>
      defaultsSchema.parse({
        spawnGovernor: { classes: { daemon: { mode: "enforce" } } },
      }),
    ).toThrow();
  });
});
