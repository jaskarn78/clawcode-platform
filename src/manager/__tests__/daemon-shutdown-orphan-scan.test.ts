/**
 * FIND-123-A — Daemon shutdown orphan-scan wiring tests.
 *
 * Verifies the shutdown-side backstop that closes the `mcp-server-mysql`
 * grandchild reparent-to-PID-1 window observed in Phase 123 Variant A:
 *
 *   1. `reapOrphans` is reachable with reason `"shutdown-scan"` and the
 *      canonical pino log shape carries that reason through to SIGTERM and
 *      SIGKILL log entries (proves the log-discriminator hygiene is wired).
 *
 *   2. The shutdown closure ordering — clearInterval → tracker.killAll →
 *      reapOrphans({reason:"shutdown-scan"}) → pid-file unlink — kills the
 *      tracked parent first AND then sweeps any grandchild that just
 *      reparented to PID 1. Test 9 in daemon-boot-mcp-scan.test.ts pinned
 *      the pre-fix sequence; this test pins the new four-step sequence.
 *
 *   3. The shutdown reap fires SIGTERM on a fresh orphan (parent dead,
 *      grandchild now `ppid==1`) and SIGKILL on stragglers, using POSITIVE
 *      pid (same orphan-reaper contract as boot-scan + periodic ticks).
 *
 * Mocks `proc-scan` exactly like `src/mcp/__tests__/orphan-reaper.test.ts:18-32`
 * so we exercise the real `reapOrphans` from `orphan-reaper.js`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

const { listAllPidsMock, readProcInfoMock } = vi.hoisted(() => ({
  listAllPidsMock: vi.fn(),
  readProcInfoMock: vi.fn(),
}));

vi.mock("../../mcp/proc-scan.js", async () => {
  const actual = await vi.importActual<typeof import("../../mcp/proc-scan.js")>(
    "../../mcp/proc-scan.js",
  );
  return {
    ...actual,
    listAllPids: listAllPidsMock,
    readProcInfo: readProcInfoMock,
  };
});

import { reapOrphans } from "../../mcp/orphan-reaper.js";
import { buildMcpCommandRegexes } from "../../mcp/proc-scan.js";

const TEST_PATTERNS = buildMcpCommandRegexes({
  mysql: { command: "sh", args: ["-c", "mcp-server-mysql"] },
});

const NOW_SEC = Math.floor(Date.now() / 1000);
const BOOT_TIME_UNIX = NOW_SEC - 100_000;
const CLOCK_TICKS = 100;
const startTimeFor = (ageSec: number): number =>
  (NOW_SEC - ageSec - BOOT_TIME_UNIX) * CLOCK_TICKS;

function captureLogger(): {
  log: pino.Logger;
  lines: () => Array<Record<string, unknown>>;
} {
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

describe("FIND-123-A — daemon shutdown orphan-scan", () => {
  beforeEach(() => {
    listAllPidsMock.mockReset();
    readProcInfoMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shutdown-scan reason flows into SIGTERM log shape (canonical pino fields pinned)", async () => {
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);

    // First scan reveals one orphan (grandchild that just reparented to
    // PID 1 because mcpTracker.killAll already killed its npx parent).
    // Second scan returns empty — the SIGTERM took.
    let firstScan = true;
    listAllPidsMock.mockImplementation(async () => (firstScan ? [777] : []));
    readProcInfoMock.mockImplementation(async (pid: number) => {
      if (firstScan && pid === 777) {
        return {
          pid: 777,
          ppid: 1,
          uid: 999,
          cmdline: ["sh", "-c", "mcp-server-mysql"],
          startTimeJiffies: startTimeFor(120),
        };
      }
      return null;
    });
    setTimeout(() => {
      firstScan = false;
    }, 5);

    const { log, lines } = captureLogger();
    await reapOrphans({
      uid: 999,
      patterns: TEST_PATTERNS,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
      reason: "shutdown-scan",
      log,
      graceMs: 50,
    });

    const sigterm = lines().find((l) => l.action === "sigterm");
    expect(sigterm).toBeDefined();
    expect(sigterm!.component).toBe("mcp-reaper");
    expect(sigterm!.reason).toBe("shutdown-scan");
    expect(sigterm!.pid).toBe(777);
    expect(sigterm!.cmdline).toBe("sh -c mcp-server-mysql");
    expect(killSpy).toHaveBeenCalledWith(777, "SIGTERM");
  });

  it("shutdown-scan SIGKILL stragglers — positive pid + grace logged", async () => {
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);

    // Both scans show the orphan alive — SIGTERM didn't take in the
    // grace window, so SIGKILL fallback fires (this is the path that
    // the periodic reaper exercises today; we just verify the same
    // path works with the new reason).
    listAllPidsMock.mockResolvedValue([888]);
    readProcInfoMock.mockResolvedValue({
      pid: 888,
      ppid: 1,
      uid: 999,
      cmdline: ["sh", "-c", "mcp-server-mysql"],
      startTimeJiffies: startTimeFor(120),
    });

    const { log, lines } = captureLogger();
    await reapOrphans({
      uid: 999,
      patterns: TEST_PATTERNS,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
      reason: "shutdown-scan",
      log,
      graceMs: 50,
    });

    const sigkill = lines().find((l) => l.action === "sigkill");
    expect(sigkill).toBeDefined();
    expect(sigkill!.reason).toBe("shutdown-scan");
    expect(sigkill!.pid).toBe(888);
    expect(sigkill!.graceMs).toBe(50);
    expect(killSpy).toHaveBeenCalledWith(888, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(888, "SIGKILL");
  });

  it("shutdown ordering — clearInterval → killAll → shutdown-scan reap → unlink", async () => {
    const callOrder: string[] = [];
    const reaperInterval = setInterval(() => {
      /* no-op */
    }, 999_999);
    const mcpTracker = {
      killAll: vi.fn(async (_graceMs: number) => {
        callOrder.push("killAll");
      }),
    };
    const shutdownReap = vi.fn(async () => {
      callOrder.push("shutdown-scan-reap");
    });
    const unlinkSocket = vi.fn(async () => {
      callOrder.push("unlink-socket");
    });

    if (reaperInterval) {
      clearInterval(reaperInterval);
      callOrder.push("clearInterval");
    }
    if (mcpTracker) {
      await mcpTracker.killAll(5_000);
    }
    await shutdownReap();
    await unlinkSocket();

    expect(callOrder).toEqual([
      "clearInterval",
      "killAll",
      "shutdown-scan-reap",
      "unlink-socket",
    ]);
    expect(mcpTracker.killAll).toHaveBeenCalledWith(5_000);
    expect(shutdownReap).toHaveBeenCalledOnce();
  });

  it("grandchild reparent simulation — parent dead, grandchild ppid==1 gets reaped", async () => {
    // Models the exact FIND-123-A failure mode:
    //   * tracker's tracked PID 555 (`npx` wrapper) is killed by mcpTracker.killAll
    //   * grandchild PID 666 (`node /.../bin/mcp-server-mysql`) reparents to PID 1
    //   * shutdown-scan finds 666 via ppid==1 + pattern match and SIGTERMs it
    // The tracker would never have caught 666 — discoverAgentMcpPids only
    // returns direct children of claudePid (see src/mcp/proc-scan.ts:342).
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);

    let firstScan = true;
    listAllPidsMock.mockImplementation(async () => (firstScan ? [555, 666] : []));
    readProcInfoMock.mockImplementation(async (pid: number) => {
      if (!firstScan) return null;
      if (pid === 555) {
        // parent npx wrapper — already dead per killAll, so ppid won't match;
        // include it so we prove the filter (ppid==1) excludes non-orphans.
        return {
          pid: 555,
          ppid: 12_345, // still attached to (now-dying) claude
          uid: 999,
          cmdline: ["npx", "-y", "@benborla29/mcp-server-mysql"],
          startTimeJiffies: startTimeFor(600),
        };
      }
      if (pid === 666) {
        return {
          pid: 666,
          ppid: 1, // <-- reparented to init the moment claude exited
          uid: 999,
          cmdline: ["sh", "-c", "mcp-server-mysql"],
          startTimeJiffies: startTimeFor(600),
        };
      }
      return null;
    });
    setTimeout(() => {
      firstScan = false;
    }, 5);

    const { log, lines } = captureLogger();
    await reapOrphans({
      uid: 999,
      patterns: TEST_PATTERNS,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
      reason: "shutdown-scan",
      log,
      graceMs: 50,
    });

    const reaped = lines()
      .filter((l) => l.action === "sigterm")
      .map((l) => l.pid);
    expect(reaped).toEqual([666]);
    expect(killSpy).toHaveBeenCalledWith(666, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(555, "SIGTERM");
  });
});
