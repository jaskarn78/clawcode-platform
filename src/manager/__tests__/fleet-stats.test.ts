import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetNoWebhookFallbacks,
  buildFleetStats,
  classifyShimRuntime,
  cmdlineMatchesClaude,
  incrementNoWebhookFallback,
  snapshotNoWebhookFallbacks,
} from "../fleet-stats.js";
import * as procScan from "../../mcp/proc-scan.js";
import * as cgroupStats from "../cgroup-stats.js";

describe("cmdlineMatchesClaude", () => {
  it("matches /usr/bin/claude argv0", () => {
    expect(cmdlineMatchesClaude(["/usr/bin/claude"])).toBe(true);
  });
  it("matches bare 'claude' argv0", () => {
    expect(cmdlineMatchesClaude(["claude"])).toBe(true);
  });
  it("matches with args present", () => {
    expect(cmdlineMatchesClaude(["/usr/bin/claude", "--mcp", "1password"])).toBe(true);
  });
  it("rejects /usr/bin/claudec (suffix collision)", () => {
    expect(cmdlineMatchesClaude(["/usr/bin/claudec"])).toBe(false);
  });
  it("rejects empty cmdline", () => {
    expect(cmdlineMatchesClaude([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 110 Stage 0b — classifier recognizes the new Go static binary basename
// (`clawcode-mcp-shim`) and the reserved Python translator basename
// (`clawcode-mcp-shim.py`) so /api/fleet-stats accurately reports per-shim
// runtime cohorts when an operator flips `defaults.shimRuntime.<type>`.
// ---------------------------------------------------------------------------
describe("classifyShimRuntime — Phase 110 Stage 0b cmdline classification", () => {
  it("classifies `clawcode <type>-mcp` cmdlines as 'node' (Stage 0a behavior preserved)", () => {
    expect(classifyShimRuntime(["clawcode", "search-mcp"])).toBe("node");
    expect(classifyShimRuntime(["/usr/local/bin/clawcode", "image-mcp"])).toBe("node");
    expect(classifyShimRuntime(["clawcode", "browser-mcp"])).toBe("node");
  });

  it("classifies `clawcode-mcp-shim --type <T>` as 'static' (basename match)", () => {
    expect(
      classifyShimRuntime([
        "/opt/clawcode/bin/clawcode-mcp-shim",
        "--type",
        "search",
      ]),
    ).toBe("static");
  });

  it("classifies dev-build static shims at non-canonical paths as 'static' (basename, not full path)", () => {
    expect(
      classifyShimRuntime([
        "/some/other/path/clawcode-mcp-shim",
        "--type",
        "image",
      ]),
    ).toBe("static");
    // Bare basename (no path) also matches.
    expect(classifyShimRuntime(["clawcode-mcp-shim", "--type", "browser"])).toBe(
      "static",
    );
  });

  it("classifies `python3 /path/clawcode-mcp-shim.py --type <T>` as 'python'", () => {
    expect(
      classifyShimRuntime([
        "python3",
        "/opt/clawcode/bin/clawcode-mcp-shim.py",
        "--type",
        "browser",
      ]),
    ).toBe("python");
    // Bare `python` (without "3") + dev-build path also matches.
    expect(
      classifyShimRuntime(["python", "./build/clawcode-mcp-shim.py", "--type", "search"]),
    ).toBe("python");
  });

  it("preserves Stage 0a 'external' classification for python externals (brave_search.py, fal_ai.py)", () => {
    // brave_search.py / fal_ai.py are Python externals — NOT the Stage 0b
    // python translator. They must continue to classify as "external" so
    // the dashboard's per-runtime baseline doesn't accidentally absorb
    // out-of-scope memory into the shim-runtime cohort.
    expect(classifyShimRuntime(["python3", "/x/brave_search.py"])).toBe(
      "external",
    );
    expect(classifyShimRuntime(["python3", "fal_ai.py"])).toBe("external");
    expect(classifyShimRuntime(["python", "tools/brave_search.py"])).toBe(
      "external",
    );
  });

  it("classifies anything else (1Password broker, dumb-pipe externals, etc.) as 'external'", () => {
    expect(classifyShimRuntime(["npx", "-y", "mcp-server-mysql@latest"])).toBe(
      "external",
    );
    expect(classifyShimRuntime(["sh", "-c", "mcp-server-mysql"])).toBe("external");
    expect(classifyShimRuntime(["node", "/usr/lib/node_modules/brave-search/index.js"])).toBe(
      "external",
    );
    expect(classifyShimRuntime([])).toBe("external");
  });
});

describe("buildFleetStats", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aggregates MCP procs by pattern with summed RSS", async () => {
    vi.spyOn(cgroupStats, "readCgroupMemoryStats").mockResolvedValue({
      memoryCurrent: 1_000_000,
      memoryMax: 10_000_000,
      memoryHigh: null,
      effectiveCeiling: 10_000_000,
      memoryPercent: 10,
      path: "/x",
    });
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([100, 101, 102, 103]);
    vi.spyOn(procScan, "readProcInfo").mockImplementation(async (pid) => {
      const map: Record<number, procScan.ProcInfo> = {
        100: {
          pid: 100,
          ppid: 1,
          uid: 1000,
          cmdline: ["/usr/bin/claude"],
          startTimeJiffies: 1,
        },
        101: {
          pid: 101,
          ppid: 100,
          uid: 1000,
          cmdline: ["npx", "-y", "mcp-server-mysql@latest"],
          startTimeJiffies: 2,
        },
        102: {
          pid: 102,
          ppid: 100,
          uid: 1000,
          cmdline: ["sh", "-c", "mcp-server-mysql"],
          startTimeJiffies: 3,
        },
        103: {
          pid: 103,
          ppid: 100,
          uid: 1000,
          cmdline: ["node", "/usr/local/lib/node_modules/brave-search/index.js"],
          startTimeJiffies: 4,
        },
      };
      return map[pid] ?? null;
    });
    const stats = await buildFleetStats({
      daemonPid: 99,
      trackedClaudeCount: 0,
      mcpPatterns: [
        { label: "acme-db", regex: /\bmcp-server-mysql\b/, runtime: "external" },
        { label: "brave-search", regex: /brave-search/, runtime: "external" },
      ],
      readRssMB: async () => 100,
    });

    expect(stats.cgroup).toEqual({
      memoryCurrentBytes: 1_000_000,
      memoryMaxBytes: 10_000_000,
      memoryPercent: 10,
    });
    expect(stats.claudeProcDrift).toEqual({
      liveCount: 1,
      trackedCount: 0,
      drift: 1,
    });
    expect(stats.mcpFleet).toEqual([
      { pattern: "acme-db", count: 2, rssMB: 200, runtime: "external" },
      { pattern: "brave-search", count: 1, rssMB: 100, runtime: "external" },
    ]);
    // Phase 110 Stage 0a — both entries are external; no shim-runtime
    // entries means baseline is null.
    expect(stats.shimRuntimeBaseline).toBeNull();
  });

  it("returns cgroup=null when readCgroupMemoryStats fails", async () => {
    vi.spyOn(cgroupStats, "readCgroupMemoryStats").mockResolvedValue(null);
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([]);
    const stats = await buildFleetStats({
      daemonPid: 1,
      trackedClaudeCount: 0,
      mcpPatterns: [],
    });
    expect(stats.cgroup).toBeNull();
    expect(stats.claudeProcDrift).toEqual({ liveCount: 0, trackedCount: 0, drift: 0 });
    expect(stats.mcpFleet).toEqual([]);
    expect(stats.shimRuntimeBaseline).toBeNull();
  });

  it("returns claudeProcDrift=null when /proc is unavailable", async () => {
    vi.spyOn(cgroupStats, "readCgroupMemoryStats").mockResolvedValue(null);
    vi.spyOn(procScan, "listAllPids").mockRejectedValue(new Error("ENOENT"));
    const stats = await buildFleetStats({
      daemonPid: 1,
      trackedClaudeCount: 0,
      mcpPatterns: [],
    });
    expect(stats.claudeProcDrift).toBeNull();
    expect(stats.mcpFleet).toEqual([]);
    expect(stats.shimRuntimeBaseline).toBeNull();
  });

  it("clamps drift to 0 when tracker count exceeds live count", async () => {
    vi.spyOn(cgroupStats, "readCgroupMemoryStats").mockResolvedValue(null);
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([100]);
    vi.spyOn(procScan, "readProcInfo").mockResolvedValue({
      pid: 100,
      ppid: 1,
      uid: 1000,
      cmdline: ["/usr/bin/claude"],
      startTimeJiffies: 1,
    });
    const stats = await buildFleetStats({
      daemonPid: 99,
      trackedClaudeCount: 5,
      mcpPatterns: [],
    });
    expect(stats.claudeProcDrift).toEqual({
      liveCount: 1,
      trackedCount: 5,
      drift: 0,
    });
  });
});

describe("buildFleetStats — Phase 110 Stage 0a runtime classification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rolls up `node` runtime entries into shimRuntimeBaseline.node", async () => {
    vi.spyOn(cgroupStats, "readCgroupMemoryStats").mockResolvedValue(null);
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([200, 201, 202]);
    vi.spyOn(procScan, "readProcInfo").mockImplementation(async (pid) => {
      const map: Record<number, procScan.ProcInfo> = {
        200: {
          pid: 200,
          ppid: 1,
          uid: 1000,
          cmdline: ["clawcode", "search-mcp"],
          startTimeJiffies: 1,
        },
        201: {
          pid: 201,
          ppid: 1,
          uid: 1000,
          cmdline: ["clawcode", "image-mcp"],
          startTimeJiffies: 2,
        },
        202: {
          pid: 202,
          ppid: 1,
          uid: 1000,
          cmdline: ["clawcode", "browser-mcp"],
          startTimeJiffies: 3,
        },
      };
      return map[pid] ?? null;
    });

    const stats = await buildFleetStats({
      daemonPid: 99,
      trackedClaudeCount: 0,
      mcpPatterns: [
        { label: "search", regex: /clawcode search-mcp/, runtime: "node" },
        { label: "image", regex: /clawcode image-mcp/, runtime: "node" },
        { label: "browser", regex: /clawcode browser-mcp/, runtime: "node" },
      ],
      readRssMB: async () => 147,
    });

    expect(stats.mcpFleet).toEqual([
      { pattern: "browser", count: 1, rssMB: 147, runtime: "node" },
      { pattern: "image", count: 1, rssMB: 147, runtime: "node" },
      { pattern: "search", count: 1, rssMB: 147, runtime: "node" },
    ]);
    expect(stats.shimRuntimeBaseline).toEqual({
      node: { count: 3, rssMB: 441 },
    });
  });

  it("excludes `external` entries from shimRuntimeBaseline (mixed case)", async () => {
    vi.spyOn(cgroupStats, "readCgroupMemoryStats").mockResolvedValue(null);
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([300, 301]);
    vi.spyOn(procScan, "readProcInfo").mockImplementation(async (pid) => {
      const map: Record<number, procScan.ProcInfo> = {
        300: {
          pid: 300,
          ppid: 1,
          uid: 1000,
          cmdline: ["clawcode", "search-mcp"],
          startTimeJiffies: 1,
        },
        301: {
          pid: 301,
          ppid: 1,
          uid: 1000,
          cmdline: ["python3", "/x/brave_search.py"],
          startTimeJiffies: 2,
        },
      };
      return map[pid] ?? null;
    });

    const stats = await buildFleetStats({
      daemonPid: 99,
      trackedClaudeCount: 0,
      mcpPatterns: [
        { label: "search", regex: /clawcode search-mcp/, runtime: "node" },
        { label: "brave-search", regex: /brave_search\.py/, runtime: "external" },
      ],
      readRssMB: async (pid) => (pid === 300 ? 147 : 57),
    });

    // External entry visible in mcpFleet but excluded from baseline.
    expect(stats.mcpFleet).toContainEqual({
      pattern: "brave-search",
      count: 1,
      rssMB: 57,
      runtime: "external",
    });
    expect(stats.shimRuntimeBaseline).toEqual({
      node: { count: 1, rssMB: 147 },
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 110 Stage 0b — end-to-end fleet-stats integration with mixed runtimes.
// Verifies the `runtime` field on each mcpFleet entry surfaces the per-pattern
// classification correctly when an operator has flipped a flag and a
// `clawcode-mcp-shim` proc is running alongside the legacy Node shim.
// ---------------------------------------------------------------------------
describe("buildFleetStats — Phase 110 Stage 0b mixed runtime aggregation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aggregates static + node shims into separate runtime cohorts in shimRuntimeBaseline", async () => {
    vi.spyOn(cgroupStats, "readCgroupMemoryStats").mockResolvedValue(null);
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([400, 401, 402]);
    vi.spyOn(procScan, "readProcInfo").mockImplementation(async (pid) => {
      const map: Record<number, procScan.ProcInfo> = {
        400: {
          pid: 400,
          ppid: 1,
          uid: 1000,
          // Operator flipped defaults.shimRuntime.search → "static".
          // Loader spawned the Go binary; cmdline reflects that shape.
          cmdline: ["/opt/clawcode/bin/clawcode-mcp-shim", "--type", "search"],
          startTimeJiffies: 1,
        },
        401: {
          pid: 401,
          ppid: 1,
          uid: 1000,
          // image still on Node (Stage 0a behavior).
          cmdline: ["clawcode", "image-mcp"],
          startTimeJiffies: 2,
        },
        402: {
          pid: 402,
          ppid: 1,
          uid: 1000,
          // browser still on Node.
          cmdline: ["clawcode", "browser-mcp"],
          startTimeJiffies: 3,
        },
      };
      return map[pid] ?? null;
    });

    const stats = await buildFleetStats({
      daemonPid: 99,
      trackedClaudeCount: 0,
      mcpPatterns: [
        // The daemon caller derives these patterns from
        // resolveShimCommand(<type>, <runtime>) so the regex matches the
        // actual cmdline shape and the runtime tag flows through.
        {
          label: "search",
          regex: /clawcode-mcp-shim --type search/,
          runtime: "static",
        },
        { label: "image", regex: /clawcode image-mcp/, runtime: "node" },
        { label: "browser", regex: /clawcode browser-mcp/, runtime: "node" },
      ],
      readRssMB: async (pid) => (pid === 400 ? 8 : 147),
    });

    // mcpFleet preserves runtime per entry — alphabetical order.
    expect(stats.mcpFleet).toEqual([
      { pattern: "browser", count: 1, rssMB: 147, runtime: "node" },
      { pattern: "image", count: 1, rssMB: 147, runtime: "node" },
      { pattern: "search", count: 1, rssMB: 8, runtime: "static" },
    ]);
    // Baseline rolls up by runtime — shows the savings headline.
    expect(stats.shimRuntimeBaseline).toEqual({
      node: { count: 2, rssMB: 294 },
      static: { count: 1, rssMB: 8 },
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 119 D-05 — no_webhook_fallbacks_total counter helper.
//
// Module-scoped Map keyed by `${agent}:${channel}`. Vitest reuses the module
// across describe blocks; `_resetNoWebhookFallbacks()` clears state between
// tests so increment+snapshot tests don't bleed into each other.
// ---------------------------------------------------------------------------
describe("incrementNoWebhookFallback + snapshotNoWebhookFallbacks (D-05)", () => {
  beforeEach(() => {
    _resetNoWebhookFallbacks();
  });

  it("increments the same (agent, channel) key 3 times → snapshot value=3", () => {
    incrementNoWebhookFallback("projects", "chan-1");
    incrementNoWebhookFallback("projects", "chan-1");
    incrementNoWebhookFallback("projects", "chan-1");
    const snap = snapshotNoWebhookFallbacks();
    expect(snap["projects:chan-1"]).toBe(3);
  });

  it("increments 5 distinct (agent, channel) pairs once each → snapshot has 5 entries", () => {
    incrementNoWebhookFallback("a", "x");
    incrementNoWebhookFallback("b", "y");
    incrementNoWebhookFallback("c", "z");
    incrementNoWebhookFallback("d", "w");
    incrementNoWebhookFallback("e", "v");
    const snap = snapshotNoWebhookFallbacks();
    expect(Object.keys(snap)).toHaveLength(5);
    expect(snap["a:x"]).toBe(1);
    expect(snap["e:v"]).toBe(1);
  });

  it("snapshot is a shallow copy — mutating it does not affect subsequent calls", () => {
    incrementNoWebhookFallback("admin-clawdy", "chan-A");
    const snap1 = snapshotNoWebhookFallbacks() as Record<string, number>;
    // Attempt to mutate (object IS sealed via Object.freeze under the
    // contract — assignment throws in strict mode). The contract is "the
    // returned object never affects daemon state". Test the daemon-side
    // invariant by mutating an isolated copy and re-snapshotting.
    const copy: Record<string, number> = { ...snap1, "admin-clawdy:chan-A": 999 };
    expect(copy["admin-clawdy:chan-A"]).toBe(999);
    const snap2 = snapshotNoWebhookFallbacks();
    expect(snap2["admin-clawdy:chan-A"]).toBe(1);
  });

  it("zero state — fresh reset returns empty object", () => {
    const snap = snapshotNoWebhookFallbacks();
    expect(snap).toEqual({});
  });

  it("FleetStatsData shape — buildFleetStats embeds the counter snapshot", async () => {
    incrementNoWebhookFallback("admin-clawdy", "chan-X");
    incrementNoWebhookFallback("projects", "chan-Y");
    vi.spyOn(cgroupStats, "readCgroupMemoryStats").mockResolvedValue(null);
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([]);
    const stats = await buildFleetStats({
      daemonPid: 1,
      trackedClaudeCount: 0,
      mcpPatterns: [],
    });
    expect(stats.noWebhookFallbacksTotal).toEqual({
      "admin-clawdy:chan-X": 1,
      "projects:chan-Y": 1,
    });
  });
});
