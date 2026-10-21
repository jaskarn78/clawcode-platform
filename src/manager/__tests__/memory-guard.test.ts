/**
 * 2026-07-31 — MemoryGuard tests: classification, budget evaluation, and
 * the alert-only service loop (summary cadence, dedup/cooldown,
 * escalation, recovery, disabled). Fake readers throughout — no /proc.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  MemoryGuard,
  type MemoryGuardReaders,
  type ProcSample,
  buildCensusContext,
  classifyProc,
  evaluateBudgets,
  evaluateDaemonHeap,
  type CensusSnapshot,
} from "../memory-guard.js";
import { defaultsSchema } from "../../config/schema.js";
import { resolveTier } from "../memory-imminence.js";

/**
 * True when `key` reaches a tier by an EXPLICIT rule rather than by
 * resolveTier's unknown-key fall-through. Detected by asking whether a
 * deliberately absurd sibling key — same shape, name nobody has tiered —
 * lands on the same answer as the fall-through default.
 */
function isExplicitlyTiered(key: string): boolean {
  const fallthrough = resolveTier("zzz:nobody:tiered-this");
  const tier = resolveTier(key);
  if (tier !== fallthrough) return true;
  // Same answer as the default: only explicit if a wildcard/exact entry
  // actually names it. Probe by overriding to a different value and seeing
  // whether the override is honoured at THIS key's specificity.
  return resolveTier(key, { [key]: "page" }) === "page" && key.includes(":");
}

const DAEMON_PID = 1000;

const proc = (over: Partial<ProcSample>): ProcSample => ({
  pid: 2000,
  ppid: DAEMON_PID,
  rssKb: 100_000,
  // QW-6 — anon+swap default to 0 so pre-existing fixtures are unchanged.
  anonKb: 0,
  swapKb: 0,
  comm: "node",
  args: "",
  ...over,
});

/** Context builder for classifier fixtures (P1 registry-membership census). */
function ctxOf(args: {
  procs?: readonly ProcSample[];
  managed?: ReadonlyArray<{ pid: number; sessionName: string }> | null;
  bridgePids?: ReadonlySet<number>;
}) {
  return buildCensusContext({
    daemonPid: DAEMON_PID,
    procs: args.procs ?? [],
    managed: args.managed === undefined ? [] : args.managed,
    bridgePids: args.bridgePids ?? new Set(),
  });
}

describe("classifyProc — P1 registry-membership census", () => {
  const CLAUDE = { comm: "claude", args: "/opt/clawcode/claude-pin/claude --resume x" };

  it("daemon pid → daemon regardless of registry", () => {
    expect(classifyProc(proc({ pid: DAEMON_PID }), ctxOf({}))).toBe("daemon");
  });

  it("managed agent + managed worker split by session kind, NOT ppid", () => {
    const ctx = ctxOf({
      managed: [
        { pid: 2001, sessionName: "fin-client" },
        { pid: 2002, sessionName: "fin-client-sub-4XZKL0" },
        { pid: 2003, sessionName: "test-agent-pool-Rl31xm" },
        { pid: 2004, sessionName: "personal-fork-a1b2c3" },
      ],
    });
    expect(classifyProc(proc({ pid: 2001, ...CLAUDE }), ctx)).toBe(
      "managed-agent-cli",
    );
    // All daemon children (same ppid) — kind decides worker status.
    expect(classifyProc(proc({ pid: 2002, ...CLAUDE }), ctx)).toBe(
      "managed-worker-cli",
    );
    expect(classifyProc(proc({ pid: 2003, ...CLAUDE }), ctx)).toBe(
      "managed-worker-cli",
    );
    expect(classifyProc(proc({ pid: 2004, ...CLAUDE }), ctx)).toBe(
      "managed-worker-cli",
    );
  });

  it("bwrap hop: inner claude under a managed bwrap pid inherits the managed class", () => {
    const bwrap = proc({ pid: 3001, comm: "bwrap", args: "bwrap --die-with-parent" });
    const inner = proc({ pid: 3002, ppid: 3001, ...CLAUDE });
    const ctx = ctxOf({
      procs: [bwrap, inner],
      managed: [{ pid: 3001, sessionName: "personal" }],
    });
    expect(classifyProc(bwrap, ctx)).toBe("managed-agent-cli");
    expect(classifyProc(inner, ctx)).toBe("managed-agent-cli");
  });

  it("nested claude under a MANAGED claude (Task lane / Bash spawn) → unmanaged-cli", () => {
    const parent = proc({ pid: 4001, ...CLAUDE });
    const nested = proc({ pid: 4002, ppid: 4001, ...CLAUDE });
    const ctx = ctxOf({
      procs: [parent, nested],
      managed: [{ pid: 4001, sessionName: "fin-client" }],
    });
    // Parent comm is "claude", not "bwrap" — no membership inheritance.
    expect(classifyProc(nested, ctx)).toBe("unmanaged-cli");
  });

  it("claude at ppid=1 not in the registry → survivor-cli", () => {
    const ctx = ctxOf({ managed: [] });
    expect(classifyProc(proc({ pid: 5001, ppid: 1, ...CLAUDE }), ctx)).toBe(
      "survivor-cli",
    );
  });

  it("claude at ppid=1 that IS in the registry stays managed (restart reparent is legitimate)", () => {
    const ctx = ctxOf({ managed: [{ pid: 5002, sessionName: "personal" }] });
    expect(classifyProc(proc({ pid: 5002, ppid: 1, ...CLAUDE }), ctx)).toBe(
      "managed-agent-cli",
    );
  });

  it("bridge-registered pid → bridge-cli", () => {
    const ctx = ctxOf({ managed: [], bridgePids: new Set([6001]) });
    expect(classifyProc(proc({ pid: 6001, ...CLAUDE }), ctx)).toBe(
      "bridge-cli",
    );
  });

  it("live-set unavailable → legacy ppid fallback mapped onto new names", () => {
    const ctx = ctxOf({ managed: null });
    expect(ctx.liveSetUnavailable).toBe(true);
    expect(classifyProc(proc({ pid: 7001, ...CLAUDE }), ctx)).toBe(
      "managed-agent-cli",
    );
    expect(classifyProc(proc({ pid: 7002, ppid: 4242, ...CLAUDE }), ctx)).toBe(
      "unmanaged-cli",
    );
  });

  it("recognises shim runtimes, sidecars, npm chains, chrome, python (unchanged)", () => {
    const ctx = ctxOf({});
    expect(classifyProc(proc({ args: "clawcode browser-mcp" }), ctx)).toBe(
      "mcp-node-shim",
    );
    expect(
      classifyProc(
        proc({ comm: "clawcode-mcp-sh", args: "/opt/clawcode/bin/clawcode-mcp-shim --type search" }),
        ctx,
      ),
    ).toBe("mcp-go-shim");
    expect(classifyProc(proc({ args: "clawcode mcp" }), ctx)).toBe(
      "clawcode-mcp",
    );
    expect(
      classifyProc(proc({ args: "clawcode mcp-broker-shim --pool 1password" }), ctx),
    ).toBe("clawcode-mcp");
    // P2 slim sidecar — same logical sidecar, must NOT fall through to mcp-node.
    expect(
      classifyProc(
        proc({ args: "node /opt/clawcode/dist/channels/clawcode-mcp-standalone.js" }),
        ctx,
      ),
    ).toBe("clawcode-mcp");
    expect(
      classifyProc(
        proc({ comm: "npm", args: "npm exec npx -y @playwright/mcp@latest" }),
        ctx,
      ),
    ).toBe("npm");
    expect(
      classifyProc(proc({ comm: "sh", args: "sh -c npx -y @playwright/mcp@latest" }), ctx),
    ).toBe("npm");
    expect(classifyProc(proc({ comm: "chrome-headless" }), ctx)).toBe("chrome");
    expect(classifyProc(proc({ comm: "python3.11" }), ctx)).toBe("mcp-python");
    expect(classifyProc(proc({}), ctx)).toBe("mcp-node");
  });
});

const BUDGET_CFG = {
  warnPct: 0.8,
  critPct: 0.9,
  hostMinAvailableMb: 2048,
  hostMinRootDiskFreeGb: 5,
  // QW-6 — mirror MEMORY_GUARD_DEFAULTS.
  balloonWarnMb: 4096,
  swapWarnMb: 1024,
};

const baseSnap = (over: Partial<CensusSnapshot>): CensusSnapshot => ({
  currentBytes: 10 * 1024 ** 3,
  ceilingBytes: 17 * 1024 ** 3,
  anonBytes: 8 * 1024 ** 3,
  fileBytes: 2 * 1024 ** 3,
  classes: {},
  hostAvailableMb: 8000,
  hostSwapFreeMb: 8000,
  hostRootDiskFreeGb: 50,
  ...over,
});

describe("evaluateBudgets", () => {
  it("healthy snapshot → no breaches", () => {
    expect(evaluateBudgets(baseSnap({}), BUDGET_CFG)).toEqual([]);
  });

  it("total watermark: warn at 80%, critical at 90% of the ceiling", () => {
    const warn = evaluateBudgets(
      baseSnap({ currentBytes: 0.85 * 17 * 1024 ** 3 }),
      BUDGET_CFG,
    );
    expect(warn).toMatchObject([{ key: "total:pct", severity: "warn" }]);
    const crit = evaluateBudgets(
      baseSnap({ currentBytes: 0.95 * 17 * 1024 ** 3 }),
      BUDGET_CFG,
    );
    expect(crit).toMatchObject([{ key: "total:pct", severity: "critical" }]);
  });

  // ---- INC-2026-08-09: the reported false alarm --------------------------
  // `⚠️ MemoryGuard: chrome count 17 over budget 12 (1598MB)` fired while the
  // co-located RSS rule PASSED (1598 < 2560) and every kernel pressure metric
  // read zero. 22 procs were 2 browsers. These pin that it cannot recur.

  it("REGRESSION: the exact reported chrome scenario produces NO breach", () => {
    const breaches = evaluateBudgets(
      baseSnap({
        classes: { chrome: { count: 17, rssMb: 1598, instanceCount: 2 } },
      }),
      BUDGET_CFG,
    );
    expect(breaches).toEqual([]);
  });

  it("chrome is judged on INSTANCES, not helper process count", () => {
    // 40 helper processes but still only 2 browsers ⇒ silence. This is the
    // whole point: process count measures how Chrome is built, not load.
    expect(
      evaluateBudgets(
        baseSnap({
          classes: { chrome: { count: 40, rssMb: 2000, instanceCount: 2 } },
        }),
        BUDGET_CFG,
      ),
    ).toEqual([]);
  });

  it("chrome does NOT breach at 4 instances - one slot is the report renderer", () => {
    // INC-2026-08-10: the workflow report renderer launches its own headless
    // Chromium whose comm is `chrome-headless` with no --type=, so it counts as
    // an instance. It is single-flight by construction, so exactly one slot is
    // reserved for it; a render landing while shopping works must not alert.
    expect(
      evaluateBudgets(
        baseSnap({ classes: { chrome: { count: 28, rssMb: 2000, instanceCount: 4 } } }),
        BUDGET_CFG,
      ),
    ).toEqual([]);
  });

  it("chrome DOES breach once real browser instances exceed the budget", () => {
    const breaches = evaluateBudgets(
      baseSnap({
        classes: { chrome: { count: 37, rssMb: 2000, instanceCount: 5 } },
      }),
      BUDGET_CFG,
    );
    expect(breaches).toMatchObject([
      { key: "class:chrome:instances", severity: "warn", kind: "proxy" },
    ]);
  });

  it("the runaway-renderer backstop still catches a helper explosion", () => {
    const breaches = evaluateBudgets(
      baseSnap({
        classes: { chrome: { count: 80, rssMb: 2000, instanceCount: 2 } },
      }),
      BUDGET_CFG,
    );
    expect(breaches).toMatchObject([{ key: "class:chrome:procs" }]);
  });

  it("chrome RSS remains enforced — helpers must stay in the rollup", () => {
    const breaches = evaluateBudgets(
      baseSnap({
        classes: { chrome: { count: 22, rssMb: 3000, instanceCount: 2 } },
      }),
      BUDGET_CFG,
    );
    expect(breaches).toMatchObject([{ key: "class:chrome:rss" }]);
  });

  it("structural vs proxy is DERIVED from maxCount===0, surviving new classes", () => {
    const breaches = evaluateBudgets(
      baseSnap({ classes: { "mcp-node-shim": { count: 3, rssMb: 720 } } }),
      BUDGET_CFG,
    );
    // budget 0 ⇒ structural ⇒ will page ungated once WS4 lands.
    expect(breaches[0]).toMatchObject({ kind: "structural" });
  });

  it("an operator override merges PER FIELD and cannot discard sibling defaults", () => {
    // Pre-fix, object-level ?? meant chrome:{maxInstances:9} threw away
    // maxRssMb:2560 entirely and blinded the one rule that works.
    const breaches = evaluateBudgets(
      baseSnap({
        classes: { chrome: { count: 22, rssMb: 3000, instanceCount: 4 } },
      }),
      { ...BUDGET_CFG, classBudgets: { chrome: { maxInstances: 9 } } },
    );
    expect(breaches.map((b) => b.key)).toEqual(["class:chrome:rss"]);
  });

  it("ANY node shim → Phase 110 drift warn (budget 0)", () => {
    const breaches = evaluateBudgets(
      baseSnap({ classes: { "mcp-node-shim": { count: 3, rssMb: 720 } } }),
      BUDGET_CFG,
    );
    expect(breaches).toMatchObject([
      { key: "class:mcp-node-shim:count", severity: "warn" },
    ]);
    expect(breaches[0]!.message).toContain("Phase 110 runtime drift");
  });

  it("unmanaged-cli (the true unregistered class) breaches as CRITICAL", () => {
    const breaches = evaluateBudgets(
      baseSnap({ classes: { "unmanaged-cli": { count: 30, rssMb: 9000 } } }),
      BUDGET_CFG,
    );
    const keys = breaches.map((b) => b.key).sort();
    expect(keys).toEqual([
      "class:unmanaged-cli:count",
      "class:unmanaged-cli:rss",
    ]);
    for (const b of breaches) expect(b.severity).toBe("critical");
  });

  it("ANY survivor-cli (budget 0) breaches as CRITICAL", () => {
    const breaches = evaluateBudgets(
      baseSnap({ classes: { "survivor-cli": { count: 1, rssMb: 300 } } }),
      BUDGET_CFG,
    );
    expect(breaches).toMatchObject([
      { key: "class:survivor-cli:count", severity: "critical" },
    ]);
  });

  it("legacy classBudgets keys still apply via the alias map", () => {
    // Operator config written pre-P1: caps 'subagent-cli', which now
    // aliases to unmanaged-cli.
    const breaches = evaluateBudgets(
      baseSnap({ classes: { "unmanaged-cli": { count: 3, rssMb: 100 } } }),
      { ...BUDGET_CFG, classBudgets: { "subagent-cli": { maxCount: 2 } } },
    );
    expect(breaches).toMatchObject([
      { key: "class:unmanaged-cli:count", severity: "critical" },
    ]);
  });

  it("managed worker count over budget breaches as warn", () => {
    const breaches = evaluateBudgets(
      baseSnap({ classes: { "managed-worker-cli": { count: 19, rssMb: 100 } } }),
      BUDGET_CFG,
    );
    expect(breaches).toMatchObject([
      { key: "class:managed-worker-cli:count", severity: "warn" },
    ]);
  });

  it("config classBudgets override beats the built-in default", () => {
    const breaches = evaluateBudgets(
      baseSnap({ classes: { npm: { count: 3, rssMb: 100 } } }),
      { ...BUDGET_CFG, classBudgets: { npm: { maxCount: 2 } } },
    );
    expect(breaches).toMatchObject([
      { key: "class:npm:count", severity: "warn" },
    ]);
  });

  it("host breaches: low MemAvailable and low root-disk are critical", () => {
    const breaches = evaluateBudgets(
      baseSnap({ hostAvailableMb: 500, hostRootDiskFreeGb: 2 }),
      BUDGET_CFG,
    );
    expect(breaches.map((b) => b.key).sort()).toEqual([
      "host:disk",
      "host:mem",
    ]);
    for (const b of breaches) expect(b.severity).toBe("critical");
  });

  it("unset ceiling (memory.high and max both 'max') → no total breach", () => {
    expect(
      evaluateBudgets(
        baseSnap({ ceilingBytes: null, currentBytes: 25 * 1024 ** 3 }),
        BUDGET_CFG,
      ),
    ).toEqual([]);
  });
});

describe("evaluateDaemonHeap — P1 (1b)", () => {
  const heap = (over: Partial<Parameters<typeof evaluateDaemonHeap>[0] & object>) => ({
    rssMb: 2100,
    heapUsedMb: 800,
    heapTotalMb: 1200,
    externalMb: 300,
    arrayBuffersMb: 50,
    heapLimitMb: 4096,
    mallocedMb: 100,
    nativeContexts: 3,
    detachedContexts: 0,
    ...over,
  });

  it("healthy heap → null; ≥85% of the V8 limit → daemon:heap warn", () => {
    expect(evaluateDaemonHeap(heap({}))).toBeNull();
    const breach = evaluateDaemonHeap(heap({ heapUsedMb: 3600 }));
    expect(breach).toMatchObject({ key: "daemon:heap", severity: "warn" });
  });

  it("null sample / zero limit → null (degrade silently)", () => {
    expect(evaluateDaemonHeap(null)).toBeNull();
    expect(evaluateDaemonHeap(heap({ heapLimitMb: 0 }))).toBeNull();
  });
});

// ── Service loop ─────────────────────────────────────────────────────────────

function makeCapturingLogger(sink: Record<string, unknown>[]) {
  return pino(
    { level: "info" },
    {
      write(line: string) {
        try {
          sink.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // ignore
        }
      },
    },
  );
}

function makeGuard(opts: {
  sink: Record<string, unknown>[];
  procs?: () => ReturnType<MemoryGuardReaders["listProcs"]>;
  cgroup?: () => ReturnType<MemoryGuardReaders["readCgroup"]>;
  config?: () => Record<string, unknown> | undefined;
  now: () => number;
}) {
  const alerts: string[] = [];
  const readers: MemoryGuardReaders = {
    readCgroup:
      opts.cgroup ??
      (() => ({
        currentBytes: 10 * 1024 ** 3,
        ceilingBytes: 17 * 1024 ** 3,
        anonBytes: 8 * 1024 ** 3,
        fileBytes: 2 * 1024 ** 3,
      })),
    listProcs: opts.procs ?? (() => []),
    readHost: () => ({
      availableMb: 8000,
      swapFreeMb: 8000,
      rootDiskFreeGb: 50,
    }),
  };
  const guard = new MemoryGuard({
    log: makeCapturingLogger(opts.sink),
    postToAdminClawdy: async (msg) => {
      alerts.push(msg);
    },
    resolveConfig: () =>
      ({
        // 999.147 — these suites exercise the ALERT MACHINERY (dedup,
        // cooldown, clear-hysteresis, escalation, the WS4 corroboration
        // gate), all of which is tier-independent. Pinning the rollback knob
        // here keeps each test measuring its own mechanism instead of
        // silently re-testing the tier router — and doubles as the proof that
        // `tiering: false` restores pre-999.147 delivery exactly. The router
        // itself has its own suite below.
        tiering: false,
        ...(opts.config?.() ?? {}),
      }) as never,
    daemonPid: DAEMON_PID,
    readers,
    now: opts.now,
  });
  return { guard, alerts };
}

describe("MemoryGuard service", () => {
  it("emits a summary line on the first tick, then respects summaryIntervalMs", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard } = makeGuard({ sink, now: () => t });
    guard.tick();
    guard.tick(); // within the summary interval — no second summary
    t += 700_000;
    guard.tick();
    const summaries = sink.filter((r) => r.msg === "memory-guard summary");
    expect(summaries.length).toBe(2);
    expect(summaries[0]).toHaveProperty("currentMb");
    expect(summaries[0]).toHaveProperty("classes");
  });

  it("breach alerts once with ⚠️, dedups until cooldown, re-alerts after", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, alerts } = makeGuard({
      sink,
      procs: () => [
        proc({ pid: 2001, args: "clawcode browser-mcp", rssKb: 240_000 }),
      ],
      now: () => t,
    });
    guard.tick();
    guard.tick();
    guard.tick();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("⚠️ MemoryGuard");
    expect(alerts[0]).toContain("Phase 110 runtime drift");
    // After the cooldown the still-active breach re-alerts once.
    t += 7 * 60 * 60 * 1000;
    guard.tick();
    expect(alerts.length).toBe(2);
  });

  // ---- INC-2026-08-09: the flap / cooldown-bypass fix --------------------

  it("REGRESSION: a flapping breach does NOT re-alert on every cycle", () => {
    // The bug: alertState.delete() on clear meant a re-breach saw
    // prev===undefined and skipped the cooldown guard entirely. chrome crossed
    // its threshold every time the shopping agent started/finished work, so it
    // paged on each cycle — 18 breaches / 14 clears in ~9 days despite a 6h
    // cooldown. Flap it 5 times well inside the cooldown: exactly ONE page.
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    let breaching = true;
    const { guard, alerts } = makeGuard({
      sink,
      procs: () =>
        breaching
          ? [proc({ pid: 2001, args: "clawcode browser-mcp", rssKb: 240_000 })]
          : [],
      now: () => t,
    });
    for (let cycle = 0; cycle < 5; cycle += 1) {
      breaching = true;
      guard.tick();
      t += 60_000;
      breaching = false;
      guard.tick(); // one healthy sample — oscillation, not recovery
      t += 60_000;
    }
    expect(alerts.length).toBe(1);
  });

  it("a single healthy sample does not clear a breach (hysteresis)", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    let breaching = true;
    const { guard } = makeGuard({
      sink,
      procs: () =>
        breaching
          ? [proc({ pid: 2001, args: "clawcode browser-mcp", rssKb: 240_000 })]
          : [],
      now: () => t,
    });
    guard.tick();
    breaching = false;
    t += 60_000;
    guard.tick();
    expect(sink.filter((r) => r.msg === "memory-guard breach cleared")).toHaveLength(0);
    // Sustained recovery DOES clear, exactly once.
    for (let i = 0; i < 5; i += 1) {
      t += 60_000;
      guard.tick();
    }
    expect(sink.filter((r) => r.msg === "memory-guard breach cleared")).toHaveLength(1);
  });

  it("after a genuine recovery + full cooldown, a new breach pages again", () => {
    // The tombstone must not suppress forever — it expires with the cooldown.
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    let breaching = true;
    const { guard, alerts } = makeGuard({
      sink,
      procs: () =>
        breaching
          ? [proc({ pid: 2001, args: "clawcode browser-mcp", rssKb: 240_000 })]
          : [],
      now: () => t,
    });
    guard.tick();
    expect(alerts.length).toBe(1);
    breaching = false;
    for (let i = 0; i < 6; i += 1) {
      t += 60_000;
      guard.tick();
    }
    t += 7 * 60 * 60 * 1000; // past the 6h cooldown
    guard.tick(); // retires the tombstone
    breaching = true;
    guard.tick();
    expect(alerts.length).toBe(2);
  });

  it("critical breach alerts with 🚨 and warn→critical escalation re-alerts immediately", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    let currentBytes = 0.85 * 17 * 1024 ** 3; // warn band
    const { guard, alerts } = makeGuard({
      sink,
      cgroup: () => ({
        currentBytes,
        ceilingBytes: 17 * 1024 ** 3,
        anonBytes: 8 * 1024 ** 3,
        fileBytes: 2 * 1024 ** 3,
      }),
      now: () => t,
    });
    guard.tick();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("⚠️");
    // Escalate into the critical band — re-alert bypasses the cooldown.
    currentBytes = 0.95 * 17 * 1024 ** 3;
    t += 60_000;
    guard.tick();
    expect(alerts.length).toBe(2);
    expect(alerts[1]).toContain("🚨 **MemoryGuard CRITICAL**");
  });

  it("sustained recovery logs a cleared line; a re-breach inside the cooldown does NOT re-alert", () => {
    // INTENT CHANGED (INC-2026-08-09). This test previously asserted
    // "re-breach → fresh alert (state was cleared, no cooldown carryover)".
    // That carryover loss WAS the bug: clearing deleted the dedup entry, so a
    // breach oscillating around its threshold re-alerted on every cycle and
    // the 6h cooldown never applied. The cooldown is now measured from the
    // last time the breach actually PAGED, across clear/re-breach cycles.
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    let shims = 1;
    const { guard, alerts } = makeGuard({
      sink,
      procs: () =>
        shims > 0
          ? [proc({ pid: 2001, args: "clawcode browser-mcp", rssKb: 240_000 })]
          : [],
      now: () => t,
    });
    guard.tick();
    expect(alerts.length).toBe(1);
    // Sustained recovery (past the hysteresis window) logs exactly one clear.
    shims = 0;
    for (let i = 0; i < 6; i += 1) {
      t += 60_000;
      guard.tick();
    }
    expect(sink.some((r) => r.msg === "memory-guard breach cleared")).toBe(true);
    // Re-breach while still inside the cooldown → silence, not a second page.
    shims = 1;
    t += 60_000;
    guard.tick();
    expect(alerts.length).toBe(1);
  });

  it("enabled:false → tick does nothing", () => {
    const sink: Record<string, unknown>[] = [];
    const { guard, alerts } = makeGuard({
      sink,
      config: () => ({ enabled: false }),
      procs: () => [
        proc({ pid: 2001, args: "clawcode browser-mcp", rssKb: 240_000 }),
      ],
      now: () => 1_000_000,
    });
    guard.tick();
    expect(alerts.length).toBe(0);
    expect(sink.length).toBe(0);
  });
});

describe("defaults.memoryGuard schema", () => {
  it("empty block fills the documented defaults; omission stays undefined", () => {
    const filled = defaultsSchema.parse({ memoryGuard: {} });
    expect(filled.memoryGuard).toMatchObject({
      enabled: true,
      sampleIntervalMs: 60_000,
      summaryIntervalMs: 600_000,
      warnPct: 0.8,
      critPct: 0.9,
      alertCooldownMs: 21_600_000,
      hostMinAvailableMb: 2048,
      hostMinRootDiskFreeGb: 5,
    });
    expect(defaultsSchema.parse({}).memoryGuard).toBeUndefined();
  });

  it("classBudgets record accepts per-class overrides and rejects negatives", () => {
    const parsed = defaultsSchema.parse({
      memoryGuard: { classBudgets: { npm: { maxCount: 2 } } },
    });
    expect(parsed.memoryGuard?.classBudgets).toEqual({
      npm: { maxCount: 2 },
    });
    expect(() =>
      defaultsSchema.parse({
        memoryGuard: { classBudgets: { npm: { maxRssMb: -5 } } },
      }),
    ).toThrow();
  });
});

// ── QW-6: anon+swap census (INC-2026-08-14 ugrep balloon) ────────────────────

describe("evaluateBudgets — anon+swap rules (999.106 QW-6)", () => {
  it("CAPABILITY: a swap-hidden balloon (0.5GiB RSS + 5.5GiB swap) fires proc:anon-balloon — the VmRSS rules stay silent", () => {
    // The incident shape: most of the balloon parked in swap, VmRSS tiny.
    // Pre-QW-6 the census summed VmRSS only → 512MB in `other` (budget
    // 2048MB) → NOTHING fired. The balloon rule reads anon+swap.
    const breaches = evaluateBudgets(
      baseSnap({
        classes: { other: { count: 1, rssMb: 512, anonMb: 512, swapMb: 5632 } },
        fattestAnonProc: {
          pid: 4242,
          cls: "other",
          comm: "ugrep",
          anonSwapMb: 6144,
        },
      }),
      BUDGET_CFG,
    );
    const balloon = breaches.find((b) => b.key === "proc:anon-balloon");
    expect(balloon).toBeDefined();
    expect(balloon!.severity).toBe("warn");
    expect(balloon!.message).toContain("ugrep");
    expect(balloon!.message).toContain("4242");
    // The class anonswap ceiling (other: 4096) fires too — attribution at
    // both granularities.
    expect(breaches.find((b) => b.key === "class:other:anonswap")).toBeDefined();
    // And the old RSS rule correctly does NOT (512 < 2048) — pins that the
    // new rules are the ONLY coverage for this shape.
    expect(breaches.find((b) => b.key === "class:other:rss")).toBeUndefined();
  });

  it("balloon + class anonswap breaches are STRUCTURAL — a future corroboration gate must never silence them", () => {
    const breaches = evaluateBudgets(
      baseSnap({
        classes: { other: { count: 1, rssMb: 100, anonMb: 5000, swapMb: 0 } },
        fattestAnonProc: {
          pid: 1,
          cls: "other",
          comm: "x",
          anonSwapMb: 5000,
        },
      }),
      BUDGET_CFG,
    );
    for (const key of ["proc:anon-balloon", "class:other:anonswap"]) {
      const b = breaches.find((x) => x.key === key);
      expect(b, key).toBeDefined();
      expect(b!.kind, key).toBe("structural");
    }
  });

  it("under the balloon line → silent; missing fattestAnonProc → silent (fail-open)", () => {
    expect(
      evaluateBudgets(
        baseSnap({
          fattestAnonProc: { pid: 1, cls: "other", comm: "x", anonSwapMb: 4000 },
        }),
        BUDGET_CFG,
      ),
    ).toEqual([]);
    expect(evaluateBudgets(baseSnap({}), BUDGET_CFG)).toEqual([]);
  });

  it("cgroup:swap warns over the line; null/absent swap reading fails open", () => {
    const hot = evaluateBudgets(
      baseSnap({ swapBytes: 1.5 * 1024 ** 3 }),
      BUDGET_CFG,
    );
    expect(hot).toMatchObject([{ key: "cgroup:swap", severity: "warn" }]);
    // Direct measurement — deliberately NOT kind-tagged (host-rule precedent:
    // never corroboration-gated, never proxy-classified).
    expect(hot[0]!.kind).toBeUndefined();
    expect(evaluateBudgets(baseSnap({ swapBytes: null }), BUDGET_CFG)).toEqual([]);
    expect(evaluateBudgets(baseSnap({}), BUDGET_CFG)).toEqual([]);
  });
});

describe("MemoryGuard service — anon+swap census (999.106 QW-6)", () => {
  it("excludes the DAEMON from the balloon scan but not from class rollups", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, alerts } = makeGuard({
      sink,
      // The daemon itself carries a huge anon footprint; everything else is
      // small. memwatch makes the same MainPID exclusion — the daemon is
      // covered by its class budget + the heap rider.
      procs: () => [
        proc({ pid: DAEMON_PID, comm: "node", anonKb: 8 * 1024 * 1024 }),
        proc({ pid: 2001, comm: "claude", anonKb: 100_000 }),
      ],
      now: () => t,
    });
    guard.tick();
    expect(alerts.filter((a) => a.includes("balloon"))).toHaveLength(0);
    const summary = sink.find((r) => r.msg === "memory-guard summary");
    expect(summary).toBeDefined();
    const fattest = summary!.fattestAnonProc as { pid: number } | null;
    expect(fattest?.pid).toBe(2001);
    void t;
  });

  it("a non-daemon balloon pages once with pid+comm attribution", () => {
    const sink: Record<string, unknown>[] = [];
    const { guard, alerts } = makeGuard({
      sink,
      procs: () => [
        // classifier: unknown comm → other. 0.5GiB RSS + 5.5GiB swap.
        proc({
          pid: 4242,
          comm: "ugrep",
          rssKb: 512 * 1024,
          anonKb: 512 * 1024,
          swapKb: 5632 * 1024,
        }),
      ],
      now: () => 1_000_000,
    });
    guard.tick();
    const balloonAlerts = alerts.filter((a) => a.includes("balloon"));
    expect(balloonAlerts).toHaveLength(1);
    expect(balloonAlerts[0]).toContain("ugrep");
    expect(balloonAlerts[0]).toContain("4242");
  });

  it("summary carries the swapCurrentMb rider when the reader provides it", () => {
    const sink: Record<string, unknown>[] = [];
    const { guard } = makeGuard({
      sink,
      cgroup: () => ({
        currentBytes: 10 * 1024 ** 3,
        ceilingBytes: 17 * 1024 ** 3,
        anonBytes: 8 * 1024 ** 3,
        fileBytes: 2 * 1024 ** 3,
        swapCurrentBytes: 512 * 1024 ** 2,
      }),
      now: () => 1_000_000,
    });
    guard.tick();
    const summary = sink.find((r) => r.msg === "memory-guard summary");
    expect(summary?.swapCurrentMb).toBe(512);
  });

  it("schema round-trip: balloonWarnMb / swapWarnMb / maxAnonSwapMb survive the parse", () => {
    const parsed = defaultsSchema.shape.memoryGuard.parse({
      balloonWarnMb: 6144,
      swapWarnMb: 512,
      classBudgets: { other: { maxAnonSwapMb: 8192 } },
    });
    expect(parsed?.balloonWarnMb).toBe(6144);
    expect(parsed?.swapWarnMb).toBe(512);
    expect(parsed?.classBudgets?.other?.maxAnonSwapMb).toBe(8192);
    // Defaults mirror MEMORY_GUARD_DEFAULTS (the lockstep rule).
    const bare = defaultsSchema.shape.memoryGuard.parse({});
    expect(bare?.balloonWarnMb).toBe(4096);
    expect(bare?.swapWarnMb).toBe(1024);
  });
});

// ---------------------------------------------------------------------------
// WS4 (2026-09-02) — corroboration gate on the Discord leg
// ---------------------------------------------------------------------------

/**
 * Variant of makeGuard that injects a PSI/events reader, so the gate has
 * something to judge. The stock makeGuard deliberately injects no
 * readPressure at all — that is the fail-open path, pinned by its own test.
 */
function makeGatedGuard(opts: {
  sink: Record<string, unknown>[];
  procs?: () => ProcSample[];
  cgroup?: () => ReturnType<MemoryGuardReaders["readCgroup"]>;
  config?: () => Record<string, unknown> | undefined;
  pressure: () => {
    available: boolean;
    cgSome60: number | null;
    cgFull60: number | null;
    cgFull10: number | null;
    hostSome60: number | null;
    events: {
      low: number;
      high: number;
      max: number;
      oom: number;
      oomKill: number;
    } | null;
  };
  now: () => number;
}) {
  const alerts: string[] = [];
  const readers: MemoryGuardReaders = {
    readCgroup:
      opts.cgroup ??
      (() => ({
        currentBytes: 10 * 1024 ** 3,
        ceilingBytes: 17 * 1024 ** 3,
        anonBytes: 8 * 1024 ** 3,
        fileBytes: 2 * 1024 ** 3,
      })),
    listProcs: opts.procs ?? (() => []),
    readHost: () => ({
      availableMb: 8000,
      swapFreeMb: 8000,
      rootDiskFreeGb: 50,
    }),
    readPressure: opts.pressure as never,
  };
  const guard = new MemoryGuard({
    log: makeCapturingLogger(opts.sink),
    postToAdminClawdy: async (msg) => {
      alerts.push(msg);
    },
    resolveConfig: () =>
      ({
        // 999.147 — these suites exercise the ALERT MACHINERY (dedup,
        // cooldown, clear-hysteresis, escalation, the WS4 corroboration
        // gate), all of which is tier-independent. Pinning the rollback knob
        // here keeps each test measuring its own mechanism instead of
        // silently re-testing the tier router — and doubles as the proof that
        // `tiering: false` restores pre-999.147 delivery exactly. The router
        // itself has its own suite below.
        tiering: false,
        ...(opts.config?.() ?? {}),
      }) as never,
    daemonPid: DAEMON_PID,
    readers,
    now: opts.now,
  });
  return { guard, alerts };
}

/** Kernel is quiet: no throttle events, no measurable stall. */
const QUIET = () => ({
  available: true,
  cgSome60: 0,
  cgFull60: 0,
  cgFull10: 0,
  hostSome60: 0,
  events: { low: 0, high: 100, max: 0, oom: 0, oomKill: 0 },
});

/**
 * A genuine PROXY warn breach: `other` RSS over its 2048MB budget.
 *
 * Deliberately NOT the mcp-node-shim fixture the older tests use — that
 * budget is `maxCount: 0`, which budgetKind() reads as STRUCTURAL, so the
 * gate correctly refuses to touch it. anon/swap stay at 0 so neither the
 * `class:*:anonswap` nor the `proc:anon-balloon` structural rule fires and
 * this exercises the proxy path alone.
 */
const PROXY_BREACH = () => [
  proc({
    pid: 2001,
    comm: "whisper",
    args: "whisper --model large-v3",
    rssKb: 2_200_000,
  }),
];

describe("MemoryGuard — WS4 corroboration gate", () => {
  it("suppresses an uncorroborated warn-tier proxy breach", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, alerts } = makeGatedGuard({
      sink,
      procs: PROXY_BREACH,
      pressure: QUIET,
      now: () => t,
    });
    guard.tick();
    t += 60_000;
    guard.tick();
    expect(alerts).toEqual([]);
    const suppressed = sink.filter(
      (r) =>
        typeof r.msg === "string" &&
        r.msg.startsWith("memory-guard breach suppressed"),
    );
    // Transition-logged: entering suppression logs ONCE, not per tick.
    expect(suppressed.length).toBe(1);
    // First tick after a restart has no delta baseline — isCorroborated says so
    // explicitly, and that is the correct (documented) reason on tick 1.
    expect(String(suppressed[0].reason)).toMatch(
      /no prior sample yet|no kernel pressure/,
    );
  });

  it("posts the same breach once the kernel throttles, with the reason", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    let high = 100;
    const { guard, alerts } = makeGatedGuard({
      sink,
      procs: PROXY_BREACH,
      pressure: () => ({ ...QUIET(), events: { ...QUIET().events!, high } }),
      now: () => t,
    });
    guard.tick(); // first tick — no previousEvents baseline yet
    t += 60_000;
    guard.tick(); // quiet: suppressed
    expect(alerts).toEqual([]);
    high += 5; // the cgroup got throttled since the last sample
    t += 60_000;
    guard.tick();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("⚠️ MemoryGuard");
    expect(alerts[0]).toContain("cgroup throttled since last sample");
  });

  it("REGRESSION: a suppressed breach must NOT start the 6h cooldown", () => {
    // The trap this change had to avoid. `lastAlertAt` means "last time this
    // paged a human". If a gate-suppressed sample advanced it, a quiet
    // uncorroborated tick would open a 6h window that then swallows the
    // corroborated breach arriving minutes later — strictly worse than the
    // pre-WS4 behavior it replaces.
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    let high = 100;
    const { guard, alerts } = makeGatedGuard({
      sink,
      procs: PROXY_BREACH,
      pressure: () => ({ ...QUIET(), events: { ...QUIET().events!, high } }),
      now: () => t,
    });
    // Ten quiet minutes — all suppressed, none of them paging.
    for (let i = 0; i < 10; i += 1) {
      guard.tick();
      t += 60_000;
    }
    expect(alerts).toEqual([]);
    // Now real pressure arrives, WELL inside what would have been a cooldown.
    high += 1;
    guard.tick();
    expect(alerts.length).toBe(1);
  });

  it("never gates critical-tier breaches", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, alerts } = makeGatedGuard({
      sink,
      // 95% of ceiling → total:pct at critical.
      cgroup: () => ({
        currentBytes: Math.round(16.15 * 1024 ** 3),
        ceilingBytes: 17 * 1024 ** 3,
        anonBytes: 14 * 1024 ** 3,
        fileBytes: 1 * 1024 ** 3,
      }),
      pressure: QUIET,
      now: () => t,
    });
    guard.tick();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("🚨 **MemoryGuard CRITICAL**");
  });

  it("never gates STRUCTURAL warn breaches (proc:anon-balloon)", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, alerts } = makeGatedGuard({
      sink,
      procs: () => [
        proc({
          pid: 3001,
          comm: "ugrep",
          args: "ugrep -r pattern",
          rssKb: 100_000,
          anonKb: 5_000_000,
          swapKb: 0,
        }),
      ],
      pressure: QUIET,
      now: () => t,
    });
    guard.tick();
    const balloon = alerts.filter((a) => a.includes("anon+swap balloon"));
    expect(balloon.length).toBe(1);
  });

  it("corroborateWarnings:false restores pre-WS4 behavior", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, alerts } = makeGatedGuard({
      sink,
      procs: PROXY_BREACH,
      pressure: QUIET,
      config: () => ({ corroborateWarnings: false }),
      now: () => t,
    });
    guard.tick();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("⚠️ MemoryGuard");
  });

  it("FAILS OPEN when PSI is unavailable on this kernel", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, alerts } = makeGatedGuard({
      sink,
      procs: PROXY_BREACH,
      pressure: () => ({ ...QUIET(), available: false }),
      now: () => t,
    });
    guard.tick();
    expect(alerts.length).toBe(1);
  });

  it("REGRESSION: total:pct warn is NEVER gated (the 08-14 early signal)", () => {
    // Reverted decision, pinned. Through the 90 min climbing into the
    // 2026-08-14 OOM kill, PSI read zero and memory.events was flat — so a
    // corroboration gate suppresses every warn on the way up. The 84%
    // warn was the only pre-critical page in that window. Tagging total:pct
    // `proxy` would have bought 11% more suppression and cost the one signal
    // that works during a slow, quiet ceiling approach.
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, alerts } = makeGatedGuard({
      sink,
      // 84% of ceiling — the exact band from the incident.
      cgroup: () => ({
        currentBytes: Math.round(0.84 * 17 * 1024 ** 3),
        ceilingBytes: 17 * 1024 ** 3,
        anonBytes: 12 * 1024 ** 3,
        fileBytes: 1 * 1024 ** 3,
      }),
      pressure: QUIET,
      now: () => t,
    });
    guard.tick();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("cgroup at 84% of ceiling");
  });

  it("schema: corroborateWarnings defaults ON and is overridable", () => {
    const bare = defaultsSchema.shape.memoryGuard.parse({});
    expect(bare?.corroborateWarnings).toBe(true);
    const off = defaultsSchema.shape.memoryGuard.parse({
      corroborateWarnings: false,
    });
    expect(off?.corroborateWarnings).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 999.147 — the tier router, end to end through the service
// ---------------------------------------------------------------------------

/**
 * Variant that drives a LIVE cgroup reader (so anon can climb across ticks),
 * injects pressure, and captures both sinks separately — `postPage` is the
 * tier-A leg that carries the relief button; `postToAdminClawdy` carries
 * digests and the legacy fallback.
 */
function makeTieredGuard(opts: {
  sink: Record<string, unknown>[];
  procs?: () => ProcSample[];
  cgroup: () => ReturnType<MemoryGuardReaders["readCgroup"]>;
  host?: () => ReturnType<MemoryGuardReaders["readHost"]>;
  pressure?: () => unknown;
  config?: () => Record<string, unknown> | undefined;
  now: () => number;
}) {
  const pages: { key: string; message: string; offenderPid?: number }[] = [];
  const texts: string[] = [];
  const guard = new MemoryGuard({
    log: makeCapturingLogger(opts.sink),
    postToAdminClawdy: async (msg) => {
      texts.push(msg);
    },
    postPage: async (page) => {
      pages.push({
        key: page.key,
        message: page.message,
        ...(page.offender ? { offenderPid: page.offender.pid } : {}),
      });
    },
    resolveConfig: () => (opts.config?.() ?? {}) as never,
    daemonPid: DAEMON_PID,
    readers: {
      readCgroup: opts.cgroup,
      listProcs: opts.procs ?? (() => []),
      readHost:
        opts.host ??
        (() => ({ availableMb: 23_000, swapFreeMb: 8000, rootDiskFreeGb: 50 })),
      ...(opts.pressure ? { readPressure: opts.pressure as never } : {}),
    },
    now: opts.now,
  });
  return { guard, pages, texts };
}

const GB = 1024 ** 3;

describe("999.147 — SC-1: the operator's 2026-09-16 screenshot pages NOTHING", () => {
  /**
   * Reconstructs the census behind all eight alerts in that screenshot, with
   * the cgroup numbers the prod journal actually recorded:
   *   currentMb 16914 / ceiling 17408 (97%) — but anon only 6524MB,
   *   i.e. ~10GB of it reclaimable page cache.
   */
  const screenshotProcs = (): ProcSample[] => [
    // `other` class: a Firefox tree. 20 procs whose summed VmRSS reads
    // 38717MB because each shared page is counted once per process — the
    // measurement that proved class:*:rss invalid.
    ...Array.from({ length: 19 }, (_, i) => ({
      pid: 3000 + i,
      ppid: DAEMON_PID,
      rssKb: 1_780_000,
      anonKb: 30_000,
      swapKb: 0,
      comm: "Web Content",
      args: "/usr/lib/firefox/firefox -contentproc",
    })),
    {
      pid: 574_875,
      ppid: DAEMON_PID,
      rssKb: 4_946_000,
      anonKb: 5_064_704, // 4946MB — the proc:anon-balloon line
      swapKb: 0,
      comm: "Web",
      args: "/usr/lib/firefox/firefox",
    },
    // chrome: 45 procs, 4640MB summed RSS.
    ...Array.from({ length: 45 }, (_, i) => ({
      pid: 4000 + i,
      ppid: DAEMON_PID,
      rssKb: 105_600,
      anonKb: 20_000,
      swapKb: 0,
      comm: "chrome",
      args: i === 0 ? "/opt/chrome" : "/opt/chrome --type=renderer",
    })),
    // mcp-python: 36 procs, 3203MB summed RSS.
    ...Array.from({ length: 36 }, (_, i) => ({
      pid: 5000 + i,
      ppid: DAEMON_PID,
      rssKb: 91_100,
      anonKb: 20_000,
      swapKb: 0,
      comm: "python3",
      args: "/opt/mcp/server.py",
    })),
  ];

  const cgroupAt97 = () => ({
    currentBytes: 16_914 * 1024 ** 2,
    ceilingBytes: 17_408 * 1024 ** 2,
    anonBytes: 6_524 * 1024 ** 2, // the honest number
    fileBytes: 10_390 * 1024 ** 2, // reclaimable
  });

  it("posts ZERO pages across a full hour of that census", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, pages, texts } = makeTieredGuard({
      sink,
      procs: screenshotProcs,
      cgroup: cgroupAt97,
      pressure: QUIET, // PSI flat, events flat — as prod actually read
      now: () => t,
    });
    for (let i = 0; i < 60; i++) {
      guard.tick();
      t += 60_000;
    }
    expect(pages).toEqual([]);
    expect(texts).toEqual([]);
  });

  it("still SEES all of it — the summary line reports every breach", () => {
    const sink: Record<string, unknown>[] = [];
    const t = 1_000_000;
    const { guard } = makeTieredGuard({
      sink,
      procs: screenshotProcs,
      cgroup: cgroupAt97,
      pressure: QUIET,
      now: () => t,
    });
    guard.tick();
    const summary = sink.find((r) => r.msg === "memory-guard summary");
    const keys = (summary?.activeBreaches ?? []) as string[];
    // Demoting a rule must never cost observability, only interruption.
    expect(keys).toContain("total:pct");
    expect(keys).toContain("class:chrome:rss");
    expect(keys).toContain("class:other:rss");
    expect(keys).toContain("class:mcp-python:rss");
    expect(keys).toContain("proc:anon-balloon");
  });

  it("rolls the demoted-but-real ones into ONE digest a day", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, texts } = makeTieredGuard({
      sink,
      procs: screenshotProcs,
      cgroup: cgroupAt97,
      pressure: QUIET,
      now: () => t,
    });
    guard.tick(); // establishes the digest window
    for (let i = 0; i < 30; i++) {
      t += 60_000;
      guard.tick();
    }
    expect(texts).toEqual([]); // nothing yet — well inside 24h
    t += 24 * 60 * 60 * 1000;
    guard.tick();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("MemoryGuard digest");
    expect(texts[0]).toContain("proc:anon-balloon");
    // …and the telemetry tier stays out of it entirely.
    expect(texts[0]).not.toContain("class:chrome:rss");
  });

  it("tiering:false restores pre-999.147 delivery (the 999.115 gate still applies)", () => {
    const sink: Record<string, unknown>[] = [];
    const t = 1_000_000;
    const { guard, pages } = makeTieredGuard({
      sink,
      procs: screenshotProcs,
      cgroup: cgroupAt97,
      pressure: QUIET,
      config: () => ({ tiering: false }),
      now: () => t,
    });
    guard.tick();
    const keys = pages.map((p) => p.key);
    // total:pct is back on the page tier — it is deliberately never
    // corroboration-gated, so rolling back 999.147 alone restores it.
    expect(keys).toContain("total:pct");
    // The class proxies stay suppressed, because rolling back the TIER router
    // does not roll back the 999.115 corroboration gate — the two knobs are
    // independent, which is the point of having both.
    expect(keys).not.toContain("class:chrome:rss");
  });

  it("both knobs off restores the original 2026-07-31 firehose", () => {
    const sink: Record<string, unknown>[] = [];
    const t = 1_000_000;
    const { guard, pages } = makeTieredGuard({
      sink,
      procs: screenshotProcs,
      cgroup: cgroupAt97,
      pressure: QUIET,
      config: () => ({ tiering: false, corroborateWarnings: false }),
      now: () => t,
    });
    guard.tick();
    const keys = pages.map((p) => p.key);
    expect(keys).toContain("total:pct");
    expect(keys).toContain("class:chrome:rss");
    expect(keys).toContain("class:other:rss");
    expect(keys).toContain("class:mcp-python:rss");
  });
});

describe("999.147 — SC-2: the 2026-08-14 OOM shape pages BEFORE the kill", () => {
  /**
   * That afternoon a tool-child ballooned to 16.8GB of anon while PSI read
   * zero and `memory.events` stayed FLAT — so a kernel-corroboration gate was
   * structurally blind to it — and the one warn that did fire opened a 6h
   * cooldown that swallowed every later page. The daemon died at 19:42:38.
   */
  it("pages on the anon climb while PSI is still flat at zero", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    let anonMb = 13_200; // 76% of ceiling and rising
    const { guard, pages } = makeTieredGuard({
      sink,
      cgroup: () => ({
        currentBytes: (anonMb + 2000) * 1024 ** 2,
        ceilingBytes: 17_408 * 1024 ** 2,
        anonBytes: anonMb * 1024 ** 2,
        fileBytes: 2000 * 1024 ** 2,
      }),
      pressure: QUIET, // PSI zero, events flat — exactly as the journal read
      now: () => t,
    });
    // Five minutes of climbing at 250MB/min.
    for (let i = 0; i < 5; i++) {
      guard.tick();
      t += 60_000;
      anonMb += 250;
    }
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0].key).toBe("imminent:anon-ceiling");
    expect(pages[0].message).toMatch(/min to exhaustion/);
  });

  it("an OOM kill is NOT swallowed by a cooldown a benign warn opened", () => {
    // The precise INC-2026-08-14 failure: a 6h window, already running, meant
    // the page that mattered never fired.
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    let oomKill = 0;
    const { guard, pages } = makeTieredGuard({
      sink,
      cgroup: () => ({
        currentBytes: 15_000 * 1024 ** 2,
        ceilingBytes: 17_408 * 1024 ** 2,
        anonBytes: 15_000 * 1024 ** 2, // 86% — critical, pages every tick it can
        fileBytes: 0,
      }),
      pressure: () => ({
        available: true,
        cgSome60: 0,
        cgFull60: 0,
        cgFull10: 0,
        hostSome60: 0,
        events: { low: 0, high: 100, max: 0, oom: 0, oomKill },
      }),
      now: () => t,
    });
    guard.tick(); // opens the 6h cooldown on imminent:anon-ceiling
    const firstRound = pages.length;
    expect(firstRound).toBeGreaterThan(0);

    // 20 minutes later the kernel kills something. The 6h cooldown is still
    // running. It must NOT suppress this.
    t += 20 * 60_000;
    oomKill = 3;
    guard.tick();
    const keys = pages.map((p) => p.key);
    expect(keys).toContain("imminent:oom-kill");
    const killPage = pages.find((p) => p.key === "imminent:oom-kill");
    expect(killPage?.message).toContain("OOM-killed 3");
  });

  it("actNow still serves its own short floor — it cannot machine-gun", () => {
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    const { guard, pages } = makeTieredGuard({
      sink,
      cgroup: () => ({
        currentBytes: 15_000 * 1024 ** 2,
        ceilingBytes: 17_408 * 1024 ** 2,
        anonBytes: 15_000 * 1024 ** 2,
        fileBytes: 0,
      }),
      pressure: QUIET,
      now: () => t,
    });
    for (let i = 0; i < 10; i++) {
      guard.tick();
      t += 60_000; // 10 minutes — inside the 15-min actNow floor
    }
    expect(pages.filter((p) => p.key === "imminent:anon-ceiling")).toHaveLength(
      1,
    );
  });

  it("names the offending process on the page, for the relief button", () => {
    const sink: Record<string, unknown>[] = [];
    const t = 1_000_000;
    const { guard, pages } = makeTieredGuard({
      sink,
      procs: () => [
        proc({
          pid: 574_875,
          rssKb: 6_000_000,
          anonKb: 6_000_000,
          comm: "ugrep",
          args: "ugrep -o -i -E",
          startTicks: 998877,
        }),
      ],
      cgroup: () => ({
        currentBytes: 15_000 * 1024 ** 2,
        ceilingBytes: 17_408 * 1024 ** 2,
        anonBytes: 15_000 * 1024 ** 2,
        fileBytes: 0,
      }),
      pressure: QUIET,
      now: () => t,
    });
    guard.tick();
    expect(pages[0].offenderPid).toBe(574_875);
  });
});

describe("999.147 — tier-map completeness + the escape hatch actually works", () => {
  it("every key the evaluator can emit is EXPLICITLY tiered", () => {
    // resolveTier is pure, so asserting resolveTier("daemon:heap") === "page"
    // proves nothing about whether that string is what the evaluator emits. A
    // rule added later without a tier entry falls through to the unknown-key
    // default and silently becomes a once-a-day line — for a daemon about to
    // OOM its own V8 heap, that is a real regression. So: trip every rule,
    // collect the real keys, and assert none of them reaches the fall-through.
    const snap = baseSnap({
      currentBytes: 17 * GB,
      ceilingBytes: 17 * GB,
      anonBytes: 16 * GB,
      swapBytes: 4 * GB,
      fattestAnonProc: {
        pid: 9001,
        cls: "other",
        comm: "ugrep",
        anonSwapMb: 9000,
      },
      classes: {
        chrome: {
          count: 99,
          rssMb: 99_999,
          anonMb: 99_999,
          swapMb: 0,
          instanceCount: 99,
        },
        other: { count: 99, rssMb: 99_999, anonMb: 99_999, swapMb: 0 },
        "survivor-cli": { count: 5, rssMb: 100, anonMb: 100, swapMb: 0 },
      },
      hostAvailableMb: 1,
      hostRootDiskFreeGb: 0.1,
    });
    const heap = evaluateDaemonHeap({
      rssMb: 9000,
      heapUsedMb: 3900,
      heapTotalMb: 4000,
      externalMb: 10,
      arrayBuffersMb: 1,
      heapLimitMb: 4096,
      mallocedMb: 10,
      nativeContexts: 1,
      detachedContexts: 0,
    });
    const keys = [
      ...evaluateBudgets(snap, BUDGET_CFG).map((b) => b.key),
      ...(heap ? [heap.key] : []),
    ];
    // Sanity: the fixture really does trip a broad set, not two rules.
    expect(keys.length).toBeGreaterThan(6);
    for (const key of keys) {
      expect(isExplicitlyTiered(key), `untiered breach key: ${key}`).toBe(true);
    }
  });

  it("promoting a telemetry rule to page takes effect on the NEXT tick", () => {
    // The escape hatch the schema comment advertises. A rule that has been
    // breaching quietly at telemetry tier for half an hour must not be sitting
    // inside a 6h cooldown that no human-visible alert ever opened.
    const sink: Record<string, unknown>[] = [];
    let t = 1_000_000;
    let tiers: Record<string, string> | undefined;
    const { guard, pages } = makeTieredGuard({
      sink,
      procs: () => [
        proc({ pid: 2001, comm: "chrome", args: "/opt/chrome", rssKb: 4_000_000 }),
      ],
      cgroup: () => ({
        currentBytes: 10 * GB,
        ceilingBytes: 17 * GB,
        anonBytes: 5 * GB,
        fileBytes: 5 * GB,
      }),
      // corroborateWarnings off so the WS4 gate is not the thing under test.
      config: () => ({
        corroborateWarnings: false,
        ...(tiers ? { alertTiers: tiers } : {}),
      }),
      now: () => t,
    });
    for (let i = 0; i < 30; i++) {
      guard.tick();
      t += 60_000;
    }
    expect(pages).toEqual([]);

    tiers = { "class:*:rss": "page" };
    guard.tick();
    expect(pages.map((p) => p.key)).toContain("class:chrome:rss");
  });

  it("with tiering ON and no postPage wired, a page still lands on the text sink", () => {
    // The live path until the WS-2 daemon wiring exists. A silent bifurcation
    // here would mean imminence pages vanish entirely on a daemon built
    // before the button.
    const sink: Record<string, unknown>[] = [];
    const t = 1_000_000;
    const texts: string[] = [];
    const guard = new MemoryGuard({
      log: makeCapturingLogger(sink),
      postToAdminClawdy: async (msg) => {
        texts.push(msg);
      },
      // postPage deliberately absent.
      resolveConfig: () => ({}) as never,
      daemonPid: DAEMON_PID,
      readers: {
        readCgroup: () => ({
          currentBytes: 15 * GB,
          ceilingBytes: 17 * GB,
          anonBytes: 15 * GB,
          fileBytes: 0,
        }),
        listProcs: () => [],
        readHost: () => ({
          availableMb: 23_000,
          swapFreeMb: 8000,
          rootDiskFreeGb: 50,
        }),
      },
      now: () => t,
    });
    guard.tick();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("unreclaimable memory");
  });
});
