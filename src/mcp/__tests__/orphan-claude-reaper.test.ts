import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import {
  redactCmdline,
  scanForOrphanClaudes,
  tickOrphanClaudeReaper,
} from "../orphan-claude-reaper.js";
import * as procScan from "../proc-scan.js";
import type { McpProcessTracker, RegisteredAgent } from "../process-tracker.js";

function captureLogger() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  const lines = () =>
    chunks
      .join("")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  return { log, lines };
}

function makeTracker(entries: Map<string, RegisteredAgent>): McpProcessTracker {
  return {
    getRegisteredAgents: () => entries,
  } as unknown as McpProcessTracker;
}

function mockProc(opts: {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly cmdline: readonly string[];
  readonly startTimeJiffies?: number;
}): procScan.ProcInfo {
  return {
    pid: opts.pid,
    ppid: opts.ppid,
    uid: opts.uid,
    cmdline: opts.cmdline,
    startTimeJiffies: opts.startTimeJiffies ?? 0,
  };
}

const SCAN_BASE = {
  uid: 1000,
  minAgeSeconds: 30,
  bootTimeUnix: 0,
  clockTicksPerSec: 100,
};

// -----------------------------------------------------------------------------
// Security regression — redactCmdline masks --mcp-config secrets.
//
// A `claude` cmdline carries `--mcp-config {JSON}` where the JSON embeds
// plaintext secrets (1Password token, MySQL password, third-party API keys).
// The orphan-claude reaper logs the cmdline at three sites; without redaction
// those secrets land in journald (confirmed leak, 2026-05-20 fin-client
// crash investigation). These tests use ONLY synthetic fixtures.
// -----------------------------------------------------------------------------
const SYNTHETIC_SECRET = "ops_FAKE_SECRET_DO_NOT_USE";
const SYNTHETIC_MCP_JSON = `{"opToken":"${SYNTHETIC_SECRET}","mysqlPw":"FAKE_PW_123"}`;

describe("redactCmdline", () => {
  it("masks the two-element --mcp-config <value> form, preserving other args", () => {
    const out = redactCmdline([
      "claude",
      "--mcp-config",
      '{"token":"ops_FAKE"}',
      "--resume",
      "abc",
    ]);
    expect(out).toContain("--mcp-config [redacted]");
    expect(out).toContain("--resume abc");
    expect(out).not.toContain("ops_FAKE");
  });

  it("masks the single-element --mcp-config=<value> form", () => {
    const out = redactCmdline([
      "claude",
      '--mcp-config={"token":"ops_FAKE"}',
    ]);
    expect(out).toContain("--mcp-config=[redacted]");
    expect(out).not.toContain("ops_FAKE");
  });

  it("is a no-op (equals join) for a cmdline with no --mcp-config", () => {
    const cmdline = ["claude", "--resume", "abc", "--model", "opus"];
    expect(redactCmdline(cmdline)).toBe(cmdline.join(" "));
  });

  it("does not throw when --mcp-config is the last element with no value", () => {
    let out = "";
    expect(() => {
      out = redactCmdline(["claude", "--mcp-config"]);
    }).not.toThrow();
    expect(out).toBe("claude --mcp-config");
  });

  it("does not mutate the input array", () => {
    const cmdline = ["claude", "--mcp-config", '{"token":"ops_FAKE"}'];
    const snapshot = [...cmdline];
    redactCmdline(cmdline);
    expect(cmdline).toEqual(snapshot);
  });
});

describe("scanForOrphanClaudes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns nothing when daemonPid is 1 (defensive)", async () => {
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([100]);
    vi.spyOn(procScan, "readProcInfo").mockResolvedValue(
      mockProc({ pid: 100, ppid: 1, uid: 1000, cmdline: ["/usr/bin/claude"] }),
    );
    const tracker = makeTracker(new Map());
    const out = await scanForOrphanClaudes({
      daemonPid: 1,
      tracker,
      ...SCAN_BASE,
    });
    expect(out).toEqual([]);
  });

  it("yields claude procs whose ppid matches daemonPid and are NOT in tracker", async () => {
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([100, 200]);
    vi.spyOn(procScan, "readProcInfo").mockImplementation(async (pid) => {
      const map: Record<number, procScan.ProcInfo> = {
        100: mockProc({
          pid: 100,
          ppid: 99,
          uid: 1000,
          cmdline: ["/usr/bin/claude"],
        }),
        200: mockProc({
          pid: 200,
          ppid: 99,
          uid: 1000,
          cmdline: ["claude"],
        }),
      };
      return map[pid] ?? null;
    });
    const tracker = makeTracker(
      new Map([
        [
          "agent-a",
          { claudePid: 100, mcpPids: [], registeredAt: 0 } as RegisteredAgent,
        ],
      ]),
    );
    const out = await scanForOrphanClaudes({
      daemonPid: 99,
      tracker,
      ...SCAN_BASE,
    });
    expect(out.map((c) => c.pid)).toEqual([200]);
  });

  it("skips entries whose name starts with __broker: when reading tracker", async () => {
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([300]);
    vi.spyOn(procScan, "readProcInfo").mockResolvedValue(
      mockProc({
        pid: 300,
        ppid: 99,
        uid: 1000,
        cmdline: ["/usr/bin/claude"],
      }),
    );
    // Tracker has __broker:* entry with claudePid=300 — broker-owned
    // synthetic owners must NOT save this PID from being treated as
    // a tracked claude (the broker-owned PID is the daemon PID 99 in
    // production, not a real claude proc — the regex already excludes
    // it; still, the orphan-claude reaper must skip __broker: rows
    // when computing the tracked set).
    const tracker = makeTracker(
      new Map([
        [
          "__broker:1password:abc",
          { claudePid: 300, mcpPids: [], registeredAt: 0 } as RegisteredAgent,
        ],
      ]),
    );
    const out = await scanForOrphanClaudes({
      daemonPid: 99,
      tracker,
      ...SCAN_BASE,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.pid).toBe(300);
  });

  it("skips procs younger than minAgeSeconds", async () => {
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([100]);
    // bootTimeUnix=0 + clockTicksPerSec=100 → procStartUnix = 1/100 = 0.01s.
    // Age = Date.now()/1000 - 0.01 ≈ now seconds. To force age < 30 we set
    // startTimeJiffies very high → procStartUnix near now() so age is ~0.
    const nowSec = Date.now() / 1000;
    vi.spyOn(procScan, "readProcInfo").mockResolvedValue(
      mockProc({
        pid: 100,
        ppid: 99,
        uid: 1000,
        cmdline: ["/usr/bin/claude"],
        startTimeJiffies: Math.floor(nowSec * 100),
      }),
    );
    const out = await scanForOrphanClaudes({
      daemonPid: 99,
      tracker: makeTracker(new Map()),
      ...SCAN_BASE,
    });
    expect(out).toEqual([]);
  });
});

describe("tickOrphanClaudeReaper", () => {
  let cap: ReturnType<typeof captureLogger>;
  beforeEach(() => {
    cap = captureLogger();
    delete process.env.CLAWCODE_ORPHAN_CLAUDE_REAPER_DISABLE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CLAWCODE_ORPHAN_CLAUDE_REAPER_DISABLE;
  });

  it("noops when mode is 'off'", async () => {
    const killFn = vi.fn();
    await tickOrphanClaudeReaper({
      daemonPid: 99,
      tracker: makeTracker(new Map()),
      ...SCAN_BASE,
      mode: "off",
      log: cap.log,
      killFn,
    });
    expect(killFn).not.toHaveBeenCalled();
    expect(cap.lines()).toEqual([]);
  });

  it("noops when CLAWCODE_ORPHAN_CLAUDE_REAPER_DISABLE=1", async () => {
    process.env.CLAWCODE_ORPHAN_CLAUDE_REAPER_DISABLE = "1";
    const killFn = vi.fn();
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([100]);
    vi.spyOn(procScan, "readProcInfo").mockResolvedValue(
      mockProc({ pid: 100, ppid: 99, uid: 1000, cmdline: ["claude"] }),
    );
    await tickOrphanClaudeReaper({
      daemonPid: 99,
      tracker: makeTracker(new Map()),
      ...SCAN_BASE,
      mode: "reap",
      log: cap.log,
      killFn,
    });
    expect(killFn).not.toHaveBeenCalled();
  });

  it("alert mode emits pino warn per orphan and DOES NOT kill", async () => {
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([100, 200]);
    vi.spyOn(procScan, "readProcInfo").mockImplementation(async (pid) => {
      const map: Record<number, procScan.ProcInfo> = {
        100: mockProc({ pid: 100, ppid: 99, uid: 1000, cmdline: ["/usr/bin/claude"] }),
        200: mockProc({ pid: 200, ppid: 99, uid: 1000, cmdline: ["claude"] }),
      };
      return map[pid] ?? null;
    });
    const killFn = vi.fn();
    await tickOrphanClaudeReaper({
      daemonPid: 99,
      tracker: makeTracker(new Map()),
      ...SCAN_BASE,
      mode: "alert",
      log: cap.log,
      killFn,
    });
    expect(killFn).not.toHaveBeenCalled();
    const alerts = cap.lines().filter(
      (l) => l.component === "orphan-claude-reaper" && l.action === "alert",
    );
    expect(alerts).toHaveLength(2);
    expect(alerts[0]!.mode).toBe("alert");
    expect(alerts[0]!.msg).toBe("orphan claude proc detected");
  });

  it("reap mode SIGTERMs candidates and SIGKILLs survivors after grace", async () => {
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([200]);
    vi.spyOn(procScan, "readProcInfo").mockResolvedValue(
      mockProc({ pid: 200, ppid: 99, uid: 1000, cmdline: ["claude"] }),
    );
    const killFn = vi.fn();
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await tickOrphanClaudeReaper({
      daemonPid: 99,
      tracker: makeTracker(new Map()),
      ...SCAN_BASE,
      mode: "reap",
      log: cap.log,
      killFn,
      sleepFn,
    });
    // Alert + SIGTERM in first pass.
    expect(killFn).toHaveBeenCalledWith(200, "SIGTERM");
    expect(sleepFn).toHaveBeenCalledWith(10_000);
    // Survivor on rescan → SIGKILL.
    expect(killFn).toHaveBeenCalledWith(200, "SIGKILL");
    const lines = cap.lines();
    expect(lines.some((l) => l.action === "alert")).toBe(true);
    expect(lines.some((l) => l.action === "sigterm")).toBe(true);
    expect(lines.some((l) => l.action === "sigkill")).toBe(true);
  });

  it("never reaps a claude that became tracked between snapshot and kill", async () => {
    // Race scenario: scan returns pid 200 as a candidate (not in tracker
    // at scan time). Between scan and the second tickOrphanClaudeReaper
    // call, session-manager registers it. The next tick MUST NOT touch it.
    const tracker = makeTracker(new Map());
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([200]);
    vi.spyOn(procScan, "readProcInfo").mockResolvedValue(
      mockProc({ pid: 200, ppid: 99, uid: 1000, cmdline: ["claude"] }),
    );
    // First tick (alert) — emits one alert.
    const killFn = vi.fn();
    await tickOrphanClaudeReaper({
      daemonPid: 99,
      tracker,
      ...SCAN_BASE,
      mode: "alert",
      log: cap.log,
      killFn,
    });
    expect(cap.lines().filter((l) => l.action === "alert")).toHaveLength(1);

    // Now session-manager registers it.
    const trackedEntries = new Map([
      [
        "agent-a",
        { claudePid: 200, mcpPids: [], registeredAt: 0 } as RegisteredAgent,
      ],
    ]);
    const trackedTracker = makeTracker(trackedEntries);

    // Second tick — should be a noop since pid 200 is now tracked.
    const cap2 = captureLogger();
    await tickOrphanClaudeReaper({
      daemonPid: 99,
      tracker: trackedTracker,
      ...SCAN_BASE,
      mode: "reap",
      log: cap2.log,
      killFn,
    });
    expect(killFn).not.toHaveBeenCalled();
    expect(cap2.lines()).toEqual([]);
  });

  it("alert action redacts --mcp-config secrets in the logged cmdline field", async () => {
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([200]);
    vi.spyOn(procScan, "readProcInfo").mockResolvedValue(
      mockProc({
        pid: 200,
        ppid: 99,
        uid: 1000,
        cmdline: ["claude", "--mcp-config", SYNTHETIC_MCP_JSON, "--resume", "abc"],
      }),
    );
    await tickOrphanClaudeReaper({
      daemonPid: 99,
      tracker: makeTracker(new Map()),
      ...SCAN_BASE,
      mode: "alert",
      log: cap.log,
      killFn: vi.fn(),
    });
    const alert = cap
      .lines()
      .find((l) => l.action === "alert" && l.component === "orphan-claude-reaper");
    expect(alert).toBeDefined();
    const cmdline = alert!.cmdline;
    expect(typeof cmdline).toBe("string");
    expect(cmdline as string).not.toHaveLength(0);
    expect(cmdline).toContain("[redacted]");
    expect(cmdline).not.toContain(SYNTHETIC_SECRET);
    expect(cmdline).not.toContain("FAKE_PW_123");
    // Non-secret parts of the cmdline survive for operator readability.
    expect(cmdline).toContain("--resume abc");
  });

  it("sigterm and sigkill actions redact --mcp-config secrets in the logged cmdline field", async () => {
    vi.spyOn(procScan, "listAllPids").mockResolvedValue([200]);
    vi.spyOn(procScan, "readProcInfo").mockResolvedValue(
      mockProc({
        pid: 200,
        ppid: 99,
        uid: 1000,
        cmdline: ["claude", "--mcp-config", SYNTHETIC_MCP_JSON],
      }),
    );
    await tickOrphanClaudeReaper({
      daemonPid: 99,
      tracker: makeTracker(new Map()),
      ...SCAN_BASE,
      mode: "reap",
      log: cap.log,
      killFn: vi.fn(),
      sleepFn: vi.fn().mockResolvedValue(undefined),
    });
    const lines = cap.lines();
    for (const action of ["sigterm", "sigkill"]) {
      const line = lines.find(
        (l) => l.action === action && l.component === "orphan-claude-reaper",
      );
      expect(line, `expected a ${action} log line`).toBeDefined();
      const cmdline = line!.cmdline;
      expect(typeof cmdline).toBe("string");
      expect(cmdline as string).not.toHaveLength(0);
      expect(cmdline).toContain("[redacted]");
      expect(cmdline).not.toContain(SYNTHETIC_SECRET);
      expect(cmdline).not.toContain("FAKE_PW_123");
    }
  });
});

// -----------------------------------------------------------------------------
// Structural invariant — schema default minAgeSeconds vs polled-discovery budget
//
// Production hotfix 2026-05-07: the schema default (30) exactly equalled the
// polled-discovery budget (MCP_POLL_INTERVAL_MS × MCP_POLL_MAX_ATTEMPTS / 1000
// = 30s), leaving zero buffer. Under contended parallel boots the reaper
// killed legitimate-but-not-yet-tracked claude subprocesses on the first 60s
// tick, looping `consecutiveFailures` upward and surfacing as exit-143
// crashes on every first-message-after-idle for Admin Clawdy.
//
// This test pins the inequality: the schema default MUST exceed the discovery
// budget by at least 3×, so any future change to either constant fails CI
// before the race recurs.
// -----------------------------------------------------------------------------
describe("orphan-claude-reaper schema-default vs polled-discovery invariant", () => {
  it("minAgeSeconds default >= 3× MCP_POLL window", async () => {
    const { MCP_POLL_INTERVAL_MS, MCP_POLL_MAX_ATTEMPTS } = await import(
      "../../manager/session-manager.js"
    );
    const { defaultsSchema } = await import("../../config/schema.js");

    const polledDiscoverySec = (MCP_POLL_INTERVAL_MS * MCP_POLL_MAX_ATTEMPTS) / 1000;
    // Resolve the zod default for orphanClaudeReaper.minAgeSeconds.
    // The field is .optional() on defaultsSchema, so we explicitly pass `{}`
    // for orphanClaudeReaper to materialize the inner .default(120). Parsing
    // the inner schema directly avoids needing to satisfy the rest of
    // defaultsSchema's required fields.
    const reaperSchema = defaultsSchema.shape.orphanClaudeReaper.unwrap();
    const parsed = reaperSchema.parse({});
    const reaperDefault = parsed.minAgeSeconds;

    // Sanity: zod default fired (object materialized).
    expect(reaperDefault).toBeDefined();
    expect(typeof reaperDefault).toBe("number");

    // The structural inequality. 3× the polled-discovery budget gives slow,
    // contended parallel-boot startups room to register before the reaper sees
    // them. 30s budget × 3 = 90s; bumping above 90 stays safe.
    expect(reaperDefault!).toBeGreaterThanOrEqual(polledDiscoverySec * 3);
  });
});
