/**
 * Phase 999.14 Plan 00 — orphan-reaper.ts unit + Linux integration tests.
 *
 * Covers MCP-03 + MCP-05 substrate:
 *   - scanForOrphanMcps filter: ppid==1 AND uid match AND cmdline match AND age>=5s
 *   - reapOrphans canonical pino warn log shape (pinned exactly per CONTEXT.md)
 *   - SIGTERM-then-SIGKILL with grace; ESRCH idempotency
 *   - startOrphanReaper interval handle; clearInterval stops scans
 *   - boot-scan reason flows through to log fields
 *   - Linux integration: real orphan via bash double-fork
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { spawn } from "node:child_process";

const {
  listAllPidsMock,
  readProcInfoMock,
  buildPipeOwnerMapMock,
  readStdinPipeInodeMock,
} = vi.hoisted(() => ({
  listAllPidsMock: vi.fn(),
  readProcInfoMock: vi.fn(),
  buildPipeOwnerMapMock: vi.fn(),
  readStdinPipeInodeMock: vi.fn(),
}));

vi.mock("../proc-scan.js", async () => {
  const actual = await vi.importActual<typeof import("../proc-scan.js")>(
    "../proc-scan.js",
  );
  return {
    ...actual,
    listAllPids: listAllPidsMock,
    readProcInfo: readProcInfoMock,
    buildPipeOwnerMap: buildPipeOwnerMapMock,
    readStdinPipeInode: readStdinPipeInodeMock,
  };
});

import {
  scanForOrphanMcps,
  reapOrphans,
  startOrphanReaper,
  scanForOrphanBrowsers,
  reapOrphanBrowsers,
  BROWSER_ORPHAN_MIN_AGE_SECONDS,
} from "../orphan-reaper.js";
import { buildMcpCommandRegexes } from "../proc-scan.js";

const isLinux = process.platform === "linux";

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

function silentLogger(): pino.Logger {
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  return pino({ level: "silent" }, sink);
}

const TEST_PATTERNS = buildMcpCommandRegexes({
  mysql: { command: "sh", args: ["-c", "mcp-server-mysql"] },
});

const NOW_SEC = Math.floor(Date.now() / 1000);
const BOOT_TIME_UNIX = NOW_SEC - 100_000; // boot was 100k seconds ago
const CLOCK_TICKS = 100;
/** Helper: starttime in jiffies for a given age in seconds. */
const startTimeFor = (ageSec: number): number =>
  (NOW_SEC - ageSec - BOOT_TIME_UNIX) * CLOCK_TICKS;

describe("scanForOrphanMcps", () => {
  beforeEach(() => {
    listAllPidsMock.mockReset();
    readProcInfoMock.mockReset();
    buildPipeOwnerMapMock.mockReset();
    readStdinPipeInodeMock.mockReset();
    // Default: no pipe partners — orphans get reaped as before (preserves
    // existing test expectations). Tests that care about the partner-check
    // can override.
    buildPipeOwnerMapMock.mockResolvedValue(new Map());
    readStdinPipeInodeMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Test 1: filters on ppid==1 AND uid match AND cmdline match AND age>=5s", async () => {
    const procs: Record<number, ReturnType<typeof Object>> = {
      100: {
        pid: 100,
        ppid: 1,
        uid: 999,
        cmdline: ["sh", "-c", "mcp-server-mysql"],
        startTimeJiffies: startTimeFor(10),
      }, // MATCH
      101: {
        pid: 101,
        ppid: 5000,
        uid: 999,
        cmdline: ["sh", "-c", "mcp-server-mysql"],
        startTimeJiffies: startTimeFor(10),
      }, // skip — has parent
      102: {
        pid: 102,
        ppid: 1,
        uid: 0,
        cmdline: ["sh", "-c", "mcp-server-mysql"],
        startTimeJiffies: startTimeFor(10),
      }, // skip — wrong uid
      103: {
        pid: 103,
        ppid: 1,
        uid: 999,
        cmdline: ["bash"],
        startTimeJiffies: startTimeFor(10),
      }, // skip — cmdline mismatch
      104: {
        pid: 104,
        ppid: 1,
        uid: 999,
        cmdline: ["sh", "-c", "mcp-server-mysql"],
        startTimeJiffies: startTimeFor(2),
      }, // skip — too young
    };

    listAllPidsMock.mockResolvedValue(Object.keys(procs).map(Number));
    readProcInfoMock.mockImplementation(async (pid: number) => procs[pid] ?? null);

    const orphans = await scanForOrphanMcps({
      uid: 999,
      patterns: TEST_PATTERNS,
      minAgeSeconds: 5,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });

    expect(orphans.length).toBe(1);
    expect(orphans[0].pid).toBe(100);
  });

  it("Test 1a-npx: SKIPS orphan whose cmdline points at a /.npm/_npx/ cached binary (npm-managed transient — orphaned by design)", async () => {
    // The Anthropic SDK proxies MCP IPC through an internal path whose fd
    // ownership doesn't surface in /proc walks, so the partner check can't
    // see a live writer. The cmdline path is the reliable signal.
    listAllPidsMock.mockResolvedValue([150]);
    readProcInfoMock.mockImplementation(async (pid: number) =>
      pid === 150
        ? {
            pid: 150,
            ppid: 1,
            uid: 999,
            cmdline: [
              "node",
              "/home/clawcode/.npm/_npx/ffa4ba40a56a3486/node_modules/.bin/mcp-server-mysql",
            ],
            startTimeJiffies: startTimeFor(60),
          }
        : null,
    );
    // Even with NO partner visible, the .npm/_npx/ path keeps it alive.
    readStdinPipeInodeMock.mockResolvedValue("socket:99999");
    buildPipeOwnerMapMock.mockResolvedValue(new Map([["socket:99999", [150]]]));

    const orphans = await scanForOrphanMcps({
      uid: 999,
      patterns: TEST_PATTERNS,
      minAgeSeconds: 5,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });

    expect(orphans.length).toBe(0);
  });

  it("Test 1b: SKIPS orphan whose stdin pipe is held by another live process (npx-launched MCP serving live claude)", async () => {
    // ppid===1 candidate that LOOKS orphaned but is still wired to claude.
    listAllPidsMock.mockResolvedValue([200]);
    readProcInfoMock.mockImplementation(async (pid: number) =>
      pid === 200
        ? {
            pid: 200,
            ppid: 1,
            uid: 999,
            cmdline: ["node", "/home/clawcode/.npm/_npx/abc/node_modules/.bin/mcp-server-mysql"],
            startTimeJiffies: startTimeFor(60),
          }
        : null,
    );
    // stdin pipe inode "pipe:555" — also held by pid 9999 (claude), so the
    // partner check should preserve the orphan.
    readStdinPipeInodeMock.mockImplementation(async (pid: number) =>
      pid === 200 ? "pipe:555" : null,
    );
    buildPipeOwnerMapMock.mockResolvedValue(
      new Map([["pipe:555", [200, 9999]]]),
    );

    const orphans = await scanForOrphanMcps({
      uid: 999,
      patterns: TEST_PATTERNS,
      minAgeSeconds: 5,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });

    expect(orphans.length).toBe(0);
  });

  it("Test 1b-socket: SKIPS orphan whose stdin SOCKET is held by another live process (SDK socketpair MCP)", async () => {
    // The Anthropic SDK uses socketpair(2), not pipes, for child stdio.
    // /proc/<pid>/fd/0 → socket:[N]. Same skip semantics as the pipe case.
    listAllPidsMock.mockResolvedValue([300]);
    readProcInfoMock.mockImplementation(async (pid: number) =>
      pid === 300
        ? {
            pid: 300,
            ppid: 1,
            uid: 999,
            cmdline: ["node", "/home/clawcode/.npm/_npx/abc/node_modules/.bin/mcp-server-mysql"],
            startTimeJiffies: startTimeFor(60),
          }
        : null,
    );
    readStdinPipeInodeMock.mockImplementation(async (pid: number) =>
      pid === 300 ? "socket:110342801" : null,
    );
    buildPipeOwnerMapMock.mockResolvedValue(
      new Map([["socket:110342801", [300, 8888]]]),
    );

    const orphans = await scanForOrphanMcps({
      uid: 999,
      patterns: TEST_PATTERNS,
      minAgeSeconds: 5,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });

    expect(orphans.length).toBe(0);
  });

  it("Test 1c: REAPS orphan whose stdin pipe has NO other holder AND is NOT an npm-managed binary (truly abandoned non-npx server)", async () => {
    listAllPidsMock.mockResolvedValue([201]);
    readProcInfoMock.mockImplementation(async (pid: number) =>
      pid === 201
        ? {
            pid: 201,
            ppid: 1,
            uid: 999,
            // Non-npx path — e.g. a Python MCP server whose parent crashed.
            cmdline: ["/usr/bin/python", "/opt/clawcode-mcp-servers/python/mcp-server-mysql.py"],
            startTimeJiffies: startTimeFor(60),
          }
        : null,
    );
    // stdin pipe inode 777 — ONLY held by pid 201 itself (no claude partner).
    // Represents a truly orphaned MCP whose owning claude died.
    readStdinPipeInodeMock.mockImplementation(async (pid: number) =>
      pid === 201 ? "pipe:777" : null,
    );
    buildPipeOwnerMapMock.mockResolvedValue(
      new Map([["pipe:777", [201]]]),
    );

    const orphans = await scanForOrphanMcps({
      uid: 999,
      patterns: TEST_PATTERNS,
      minAgeSeconds: 5,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });

    expect(orphans.length).toBe(1);
    expect(orphans[0]!.pid).toBe(201);
  });

  it("Test 1d: REAPS orphan whose stdin is NOT a pipe (no pipe to check — fallback to existing heuristic)", async () => {
    listAllPidsMock.mockResolvedValue([202]);
    readProcInfoMock.mockImplementation(async (pid: number) =>
      pid === 202
        ? {
            pid: 202,
            ppid: 1,
            uid: 999,
            cmdline: ["sh", "-c", "mcp-server-mysql"],
            startTimeJiffies: startTimeFor(60),
          }
        : null,
    );
    readStdinPipeInodeMock.mockResolvedValue(null); // stdin is /dev/null or closed
    buildPipeOwnerMapMock.mockResolvedValue(new Map());

    const orphans = await scanForOrphanMcps({
      uid: 999,
      patterns: TEST_PATTERNS,
      minAgeSeconds: 5,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });

    expect(orphans.length).toBe(1);
    expect(orphans[0]!.pid).toBe(202);
  });
});

describe("reapOrphans", () => {
  beforeEach(() => {
    listAllPidsMock.mockReset();
    readProcInfoMock.mockReset();
    buildPipeOwnerMapMock.mockReset();
    readStdinPipeInodeMock.mockReset();
    // Default: no pipe partners — orphans get reaped as before (preserves
    // existing test expectations). Tests that care about the partner-check
    // can override.
    buildPipeOwnerMapMock.mockResolvedValue(new Map());
    readStdinPipeInodeMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupOneOrphan() {
    listAllPidsMock.mockResolvedValue([100]);
    readProcInfoMock.mockResolvedValue({
      pid: 100,
      ppid: 1,
      uid: 999,
      cmdline: ["sh", "-c", "mcp-server-mysql"],
      startTimeJiffies: startTimeFor(10),
    });
  }

  it("Test 2: canonical SIGTERM warn log shape", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    setupOneOrphan();
    // After kill, second scan returns empty (proc died)
    let firstScan = true;
    listAllPidsMock.mockImplementation(async () => (firstScan ? [100] : []));
    readProcInfoMock.mockImplementation(async (pid: number) => {
      if (firstScan) {
        return {
          pid,
          ppid: 1,
          uid: 999,
          cmdline: ["sh", "-c", "mcp-server-mysql"],
          startTimeJiffies: startTimeFor(10),
        };
      }
      return null;
    });
    // Toggle firstScan after first scan completes — emulate proc dying.
    setTimeout(() => {
      firstScan = false;
    }, 5);

    const { log, lines } = captureLogger();
    await reapOrphans({
      uid: 999,
      patterns: TEST_PATTERNS,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
      reason: "orphan-ppid-1",
      log,
      graceMs: 50,
    });

    const sigterm = lines().find(
      (l) => l.component === "mcp-reaper" && l.action === "sigterm",
    );
    expect(sigterm).toBeDefined();
    expect(sigterm!.pid).toBe(100);
    expect(sigterm!.cmdline).toBe("sh -c mcp-server-mysql");
    expect(sigterm!.reason).toBe("orphan-ppid-1");
    expect(sigterm!.msg).toBe("reaping orphaned MCP server");
  });

  it("Test 3: SIGKILL after grace if orphan stays alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    // Orphan stays alive forever — both scans return it
    setupOneOrphan();

    const { log, lines } = captureLogger();
    await reapOrphans({
      uid: 999,
      patterns: TEST_PATTERNS,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
      reason: "orphan-ppid-1",
      log,
      graceMs: 50,
    });

    // SIGTERM was called with positive pid (orphans don't reliably retain pgid)
    expect(killSpy).toHaveBeenCalledWith(100, "SIGTERM");
    // SIGKILL also called (still alive after grace)
    expect(killSpy).toHaveBeenCalledWith(100, "SIGKILL");

    const sigkill = lines().find(
      (l) => l.component === "mcp-reaper" && l.action === "sigkill",
    );
    expect(sigkill).toBeDefined();
    expect(sigkill!.pid).toBe(100);
    expect(sigkill!.reason).toBe("orphan-ppid-1");
    expect(sigkill!.graceMs).toBe(50);
  });

  it("Test 4: ESRCH idempotency — process.kill throwing ESRCH does not crash reapOrphans", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("no such process") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    });
    setupOneOrphan();

    await expect(
      reapOrphans({
        uid: 999,
        patterns: TEST_PATTERNS,
        clockTicksPerSec: CLOCK_TICKS,
        bootTimeUnix: BOOT_TIME_UNIX,
        reason: "orphan-ppid-1",
        log: silentLogger(),
        graceMs: 50,
      }),
    ).resolves.not.toThrow();
  });

  it("Test 6: boot-scan reason flows into log entries", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    setupOneOrphan();
    // After SIGTERM the orphan dies on the next scan
    let scanCount = 0;
    listAllPidsMock.mockImplementation(async () => {
      scanCount++;
      return scanCount === 1 ? [100] : [];
    });

    const { log, lines } = captureLogger();
    await reapOrphans({
      uid: 999,
      patterns: TEST_PATTERNS,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
      reason: "boot-scan",
      log,
      graceMs: 50,
    });

    const entries = lines().filter((l) => l.component === "mcp-reaper");
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.reason).toBe("boot-scan");
    }
  });
});

describe("startOrphanReaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listAllPidsMock.mockReset();
    readProcInfoMock.mockReset();
    listAllPidsMock.mockResolvedValue([]); // no orphans, fast scans
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Test 5: clearInterval stops further scans", async () => {
    const handle = startOrphanReaper({
      uid: 999,
      patterns: TEST_PATTERNS,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
      intervalMs: 1000,
      log: silentLogger(),
      graceMs: 50,
    });

    // First tick fires AFTER intervalMs (not immediately).
    expect(listAllPidsMock.mock.calls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(listAllPidsMock.mock.calls.length).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(1000);
    const callsAfterTwo = listAllPidsMock.mock.calls.length;
    expect(callsAfterTwo).toBeGreaterThanOrEqual(2);

    clearInterval(handle);
    await vi.advanceTimersByTimeAsync(5000);
    // No further scans (allow for any in-flight)
    expect(listAllPidsMock.mock.calls.length).toBe(callsAfterTwo);
  });

  it("Test 8: onTickAfter callback runs AFTER reapOrphans completes (sequence pinned)", async () => {
    // Pinned ordering — locks the Wave 1 MCP-09 sweep wiring decision:
    // "stale-binding sweep runs AFTER orphan reaper on each tick".
    const callOrder: string[] = [];

    // Wire reapOrphans to log when it finishes via the listAllPids mock
    // (called inside scanForOrphanMcps, which reapOrphans calls twice).
    listAllPidsMock.mockImplementation(async () => {
      callOrder.push("reapOrphans-scan");
      return [];
    });

    const onTickAfter = vi.fn(async () => {
      callOrder.push("onTickAfter");
    });

    const handle = startOrphanReaper({
      uid: 999,
      patterns: TEST_PATTERNS,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
      intervalMs: 1000,
      log: silentLogger(),
      graceMs: 50,
      onTickAfter,
    });

    await vi.advanceTimersByTimeAsync(1000);
    // Stop the interval so the next advance doesn't loop forever, then
    // drain any in-flight microtasks (the async wrapper inside the tick).
    clearInterval(handle);
    await vi.advanceTimersByTimeAsync(100);

    // Reap MUST complete before onTickAfter — sequence pinned.
    expect(onTickAfter).toHaveBeenCalled();
    const lastReapIdx = callOrder.lastIndexOf("reapOrphans-scan");
    const firstAfterIdx = callOrder.indexOf("onTickAfter");
    expect(lastReapIdx).toBeGreaterThanOrEqual(0);
    expect(firstAfterIdx).toBeGreaterThan(lastReapIdx);
  });
});

describe("Linux real-orphan integration", () => {
  it.skipIf(!isLinux)(
    "Test 7: terminates a real orphan via bash double-fork pattern",
    async () => {
      // Strategy: spawn a node setInterval with a unique arg, disown it from
      // bash. When bash exits, the node child reparents to PID 1.
      // node accepts trailing positional args (sleep does not), so this gives
      // us a unique cmdline we can match against.
      const tag = `cc-orphan-fixture-${process.pid}-${Date.now()}`;
      const child = spawn("bash", [
        "-c",
        `node -e "setInterval(()=>{},10000)" ${tag} & disown`,
      ]);

      // Wait for bash to exit — the node child is now an orphan (PPID=1).
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
      });
      // Small settle so /proc reflects the reparent
      await new Promise((r) => setTimeout(r, 300));

      const patterns = buildMcpCommandRegexes({
        nodeFixture: {
          command: "node",
          args: ["-e", "setInterval(()=>{},10000)", tag],
        },
      });

      const myUid = (process.getuid as () => number)();

      // Bypass the module-level mocks for this test — route to the real
      // proc-scan helpers so /proc is actually walked.
      const real = await vi.importActual<typeof import("../proc-scan.js")>(
        "../proc-scan.js",
      );
      listAllPidsMock.mockImplementation(() => real.listAllPids());
      readProcInfoMock.mockImplementation((pid: number) =>
        real.readProcInfo(pid),
      );

      const realReaper = await import("../orphan-reaper.js");
      // Use the REAL boot time — starttime jiffies are measured from real
      // boot, so the age math must use the matching epoch.
      const realBootTimeUnix = await real.readBootTimeUnix();
      const orphans = await realReaper.scanForOrphanMcps({
        uid: myUid,
        patterns,
        minAgeSeconds: 0,
        clockTicksPerSec: 100,
        bootTimeUnix: realBootTimeUnix,
      });

      const ours = orphans.find((o) => o.cmdline.join(" ").includes(tag));
      expect(ours).toBeDefined();
      expect(ours!.pid).toBeGreaterThan(0);

      // Cleanup — SIGKILL the orphan so the test host stays clean.
      try {
        process.kill(ours!.pid, "SIGKILL");
      } catch {
        /* may already be dead */
      }
    },
  );
});

/**
 * INC-2026-07-27 — orphaned headless-browser reaping.
 *
 * A crash-looping `smarthome` MCP drove an agent-browser respawn churn; each
 * dead agent-browser left its chrome master reparented to pid 1 (~1/min,
 * ~200-280MB each). The MCP scan cannot see them (chrome is not a configured
 * MCP command), so 32 masters / 337 processes / ~8G accumulated and the 20G
 * cgroup OOM-killed agent sessions fleet-wide.
 */
describe("scanForOrphanBrowsers (INC-2026-07-27)", () => {
  const CHROME = "/opt/chrome/chrome";
  const PROFILE = "--user-data-dir=/tmp/agent-browser-chrome-abc123";

  beforeEach(() => {
    listAllPidsMock.mockReset();
    readProcInfoMock.mockReset();
  });

  function mockProcs(procs: Record<number, unknown>): void {
    listAllPidsMock.mockResolvedValue(Object.keys(procs).map(Number));
    readProcInfoMock.mockImplementation(
      async (pid: number) => (procs as Record<number, unknown>)[pid] ?? null,
    );
  }

  it("reaps an orphaned agent-browser chrome MASTER (ppid 1, right profile, old enough)", async () => {
    mockProcs({
      100: {
        pid: 100,
        ppid: 1,
        uid: 999,
        cmdline: [CHROME, PROFILE, "--headless"],
        startTimeJiffies: startTimeFor(BROWSER_ORPHAN_MIN_AGE_SECONDS + 60),
      },
    });
    const found = await scanForOrphanBrowsers({
      uid: 999,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });
    expect(found.map((c) => c.pid)).toEqual([100]);
  });

  it("SKIPS a live browser (ppid != 1 — its agent-browser owner is still alive)", async () => {
    mockProcs({
      101: {
        pid: 101,
        ppid: 4242,
        uid: 999,
        cmdline: [CHROME, PROFILE, "--headless"],
        startTimeJiffies: startTimeFor(3600),
      },
    });
    const found = await scanForOrphanBrowsers({
      uid: 999,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });
    expect(found).toEqual([]);
  });

  it("SKIPS chrome with a NON-agent-browser profile (operator/other browser never touched)", async () => {
    mockProcs({
      102: {
        pid: 102,
        ppid: 1,
        uid: 999,
        cmdline: [CHROME, "--user-data-dir=/home/clawcode/.config/google-chrome"],
        startTimeJiffies: startTimeFor(3600),
      },
    });
    const found = await scanForOrphanBrowsers({
      uid: 999,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });
    expect(found).toEqual([]);
  });

  it("SKIPS renderer/zygote children (--type=) — only the master is targeted", async () => {
    mockProcs({
      103: {
        pid: 103,
        ppid: 1,
        uid: 999,
        cmdline: [CHROME, "--type=renderer", PROFILE],
        startTimeJiffies: startTimeFor(3600),
      },
    });
    const found = await scanForOrphanBrowsers({
      uid: 999,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });
    expect(found).toEqual([]);
  });

  it("SKIPS a too-young orphan (double-fork handoff race guard)", async () => {
    mockProcs({
      104: {
        pid: 104,
        ppid: 1,
        uid: 999,
        cmdline: [CHROME, PROFILE],
        startTimeJiffies: startTimeFor(BROWSER_ORPHAN_MIN_AGE_SECONDS - 30),
      },
    });
    const found = await scanForOrphanBrowsers({
      uid: 999,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });
    expect(found).toEqual([]);
  });

  it("SKIPS another user's browser (uid mismatch)", async () => {
    mockProcs({
      105: {
        pid: 105,
        ppid: 1,
        uid: 1000,
        cmdline: [CHROME, PROFILE],
        startTimeJiffies: startTimeFor(3600),
      },
    });
    const found = await scanForOrphanBrowsers({
      uid: 999,
      clockTicksPerSec: CLOCK_TICKS,
      bootTimeUnix: BOOT_TIME_UNIX,
    });
    expect(found).toEqual([]);
  });

  it("reapOrphanBrowsers logs the canonical shape with reason=orphan-browser and SIGTERMs the master", async () => {
    const { log, lines } = captureLogger();
    mockProcs({
      106: {
        pid: 106,
        ppid: 1,
        uid: 999,
        cmdline: [CHROME, PROFILE],
        startTimeJiffies: startTimeFor(3600),
      },
    });
    // Record into a local array: mockRestore() wipes the spy's call history,
    // so asserting on the spy after restore would always see zero calls.
    const kills: Array<[number, string]> = [];
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, sig?: string | number) => {
        kills.push([pid, String(sig)]);
        return true;
      }) as unknown as typeof process.kill);
    try {
      await reapOrphanBrowsers({
        uid: 999,
        clockTicksPerSec: CLOCK_TICKS,
        bootTimeUnix: BOOT_TIME_UNIX,
        log,
        graceMs: 1,
      });
    } finally {
      killSpy.mockRestore();
    }
    const warn = lines().find(
      (l) => l.reason === "orphan-browser" && l.action === "sigterm",
    );
    expect(warn).toBeDefined();
    expect(warn?.component).toBe("mcp-reaper");
    expect(warn?.pid).toBe(106);
    expect(kills).toContainEqual([106, "SIGTERM"]);
  });

  it("reapOrphanBrowsers is a no-op (no logs, no kills) when nothing is orphaned", async () => {
    const { log, lines } = captureLogger();
    mockProcs({});
    const kills: Array<[number, string]> = [];
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, sig?: string | number) => {
        kills.push([pid, String(sig)]);
        return true;
      }) as unknown as typeof process.kill);
    try {
      await reapOrphanBrowsers({
        uid: 999,
        clockTicksPerSec: CLOCK_TICKS,
        bootTimeUnix: BOOT_TIME_UNIX,
        log,
        graceMs: 1,
      });
    } finally {
      killSpy.mockRestore();
    }
    expect(lines().filter((l) => l.reason === "orphan-browser")).toEqual([]);
    expect(kills).toEqual([]);
  });
});
