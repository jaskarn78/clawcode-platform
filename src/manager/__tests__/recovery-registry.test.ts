import { describe, it, expect, vi, afterEach } from "vitest";
import type { Logger } from "pino";

/**
 * Phase 94 Plan 03 Task 1 — recovery registry orchestrator tests (RED).
 *
 * Pin invariants:
 *   - REC-REG-PRIORITY: error matches both playwright AND fallback;
 *     playwright wins (lower priority number).
 *   - REC-BUDGET: 4th invocation within 1hr returns 'give-up' WITHOUT
 *     calling any handler (execFile/killSubprocess never invoked).
 *   - REC-ALERT-3RD: feeding 3 consecutive failure outcomes → adminAlert
 *     called exactly once.
 *   - REC-NOT-APPLICABLE: error matches no handler AND degraded duration
 *     < 5min → 'not-applicable'.
 *   - REC-IMMUT: history Map updated in-place; new attempt appended,
 *     prev array's reference identity may differ but old entries
 *     preserved (immutability invariant).
 */

import type { RecoveryDeps, AttemptRecord } from "../recovery/types.js";
import type { McpServerState } from "../../mcp/readiness.js";
import { runRecoveryForServer, RECOVERY_REGISTRY } from "../recovery/registry.js";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLog,
} as unknown as Logger;

function makeDeps(overrides: Partial<RecoveryDeps> = {}): RecoveryDeps {
  return {
    execFile: overrides.execFile ?? vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    killSubprocess: overrides.killSubprocess ?? vi.fn().mockResolvedValue(undefined),
    adminAlert: overrides.adminAlert ?? vi.fn().mockResolvedValue(undefined),
    opRead: overrides.opRead ?? vi.fn().mockResolvedValue("x"),
    readEnvForServer: overrides.readEnvForServer ?? vi.fn().mockReturnValue({}),
    writeEnvForServer: overrides.writeEnvForServer ?? vi.fn().mockResolvedValue(undefined),
    now: overrides.now,
    log: overrides.log ?? noopLog,
  };
}

function makeState(opts: { error: string; degradedSinceMsAgo?: number }): McpServerState {
  const ago = opts.degradedSinceMsAgo ?? 60_000;
  const lastSuccessAt = new Date(Date.now() - ago).toISOString();
  return {
    name: "browser",
    status: "degraded",
    lastSuccessAt: Date.now() - ago,
    lastFailureAt: Date.now() - 1000,
    lastError: { message: opts.error },
    failureCount: 1,
    optional: false,
    capabilityProbe: {
      lastRunAt: new Date().toISOString(),
      status: "degraded",
      error: opts.error,
      lastSuccessAt,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RECOVERY_REGISTRY", () => {
  it("contains the 3 default handlers in priority order (lower priority number first)", () => {
    expect(RECOVERY_REGISTRY.length).toBe(3);
    const names = RECOVERY_REGISTRY.map((h) => h.name);
    expect(names).toEqual(["playwright-chromium", "op-refresh", "subprocess-restart"]);
    // Priority numbers are non-decreasing
    for (let i = 1; i < RECOVERY_REGISTRY.length; i++) {
      expect(RECOVERY_REGISTRY[i]!.priority).toBeGreaterThanOrEqual(
        RECOVERY_REGISTRY[i - 1]!.priority,
      );
    }
  });

  it("is frozen (Object.freeze) — cannot push new entries at runtime", () => {
    expect(Object.isFrozen(RECOVERY_REGISTRY)).toBe(true);
  });
});

describe("runRecoveryForServer — orchestrator", () => {
  it("REC-REG-PRIORITY: Playwright error → playwright handler wins, NOT subprocess-restart", async () => {
    // 6min degraded so subprocess-restart would also match, but playwright
    // is lower priority and runs first.
    const state = makeState({
      error:
        "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
      degradedSinceMsAgo: 6 * 60 * 1000,
    });
    const execFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const killSubprocess = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ execFile, killSubprocess });
    const history = new Map<string, AttemptRecord[]>();
    const outcome = await runRecoveryForServer("browser", state, history, deps);
    expect(outcome.kind).toBe("recovered");
    if (outcome.kind === "recovered") {
      expect(outcome.handlerName).toBe("playwright-chromium");
    }
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(killSubprocess).not.toHaveBeenCalled();
  });

  it("REC-BUDGET: 4th attempt within 1hr returns 'give-up' WITHOUT invoking any handler", async () => {
    const state = makeState({
      error:
        "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
    });
    const execFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const killSubprocess = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ execFile, killSubprocess });
    const recentIso = new Date(Date.now() - 5 * 60_000).toISOString(); // 5min ago
    const history = new Map<string, AttemptRecord[]>([
      [
        "browser",
        [
          { serverName: "browser", attemptedAt: recentIso, handlerName: "playwright-chromium", outcomeKind: "give-up" },
          { serverName: "browser", attemptedAt: recentIso, handlerName: "playwright-chromium", outcomeKind: "give-up" },
          { serverName: "browser", attemptedAt: recentIso, handlerName: "playwright-chromium", outcomeKind: "give-up" },
        ],
      ],
    ]);

    const outcome = await runRecoveryForServer("browser", state, history, deps);
    expect(outcome.kind).toBe("give-up");
    if (outcome.kind === "give-up") {
      expect(outcome.reason.toLowerCase()).toContain("budget");
    }
    expect(execFile).not.toHaveBeenCalled();
    expect(killSubprocess).not.toHaveBeenCalled();
  });

  it("REC-BUDGET-PRUNE: attempts older than 1hr are pruned and DON'T count toward budget", async () => {
    const state = makeState({
      error:
        "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
    });
    const execFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const deps = makeDeps({ execFile });
    const oldIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2hr ago
    const history = new Map<string, AttemptRecord[]>([
      [
        "browser",
        [
          { serverName: "browser", attemptedAt: oldIso, handlerName: "playwright-chromium", outcomeKind: "give-up" },
          { serverName: "browser", attemptedAt: oldIso, handlerName: "playwright-chromium", outcomeKind: "give-up" },
          { serverName: "browser", attemptedAt: oldIso, handlerName: "playwright-chromium", outcomeKind: "give-up" },
        ],
      ],
    ]);

    const outcome = await runRecoveryForServer("browser", state, history, deps);
    expect(outcome.kind).toBe("recovered"); // budget reset; handler runs
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("REC-ALERT-3RD: 3rd failure within 1hr → deps.adminAlert called exactly once with server name + recent error", async () => {
    const errorMsg =
      "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome";
    const state = makeState({ error: errorMsg });
    // Handler returns give-up (non-zero exit) so the failure counter accrues.
    const execFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "fatal", exitCode: 1 });
    const adminAlert = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ execFile, adminAlert });

    const recentIso1 = new Date(Date.now() - 30 * 60_000).toISOString(); // 30min ago
    const recentIso2 = new Date(Date.now() - 10 * 60_000).toISOString(); // 10min ago
    const history = new Map<string, AttemptRecord[]>([
      [
        "browser",
        [
          { serverName: "browser", attemptedAt: recentIso1, handlerName: "playwright-chromium", outcomeKind: "give-up" },
          { serverName: "browser", attemptedAt: recentIso2, handlerName: "playwright-chromium", outcomeKind: "give-up" },
        ],
      ],
    ]);

    const outcome = await runRecoveryForServer("browser", state, history, deps);
    expect(outcome.kind).toBe("give-up");
    expect(adminAlert).toHaveBeenCalledTimes(1);
    const alertText = adminAlert.mock.calls[0]?.[0];
    expect(alertText).toContain("browser");
    // Some piece of the recent error should appear (verbatim error pass-through)
    expect(alertText).toMatch(/ms-playwright|Executable/);
  });

  it("REC-NOT-APPLICABLE: error matches no handler AND degraded < 5min → outcome.kind='not-applicable'", async () => {
    const state = makeState({
      error: "totally unknown wibble wobble error",
      degradedSinceMsAgo: 60_000, // 1min ago — under 5min threshold
    });
    const execFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const killSubprocess = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ execFile, killSubprocess });
    const history = new Map<string, AttemptRecord[]>();
    const outcome = await runRecoveryForServer("unknown-server", state, history, deps);
    expect(outcome.kind).toBe("not-applicable");
    expect(execFile).not.toHaveBeenCalled();
    expect(killSubprocess).not.toHaveBeenCalled();
  });

  it("REC-IMMUT: history Map records the new attempt; previous entries preserved", async () => {
    const state = makeState({
      error:
        "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
    });
    const execFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const deps = makeDeps({ execFile });
    const oldIso = new Date(Date.now() - 30 * 60_000).toISOString();
    const prev: AttemptRecord = {
      serverName: "browser",
      attemptedAt: oldIso,
      handlerName: "playwright-chromium",
      outcomeKind: "give-up",
    };
    const history = new Map<string, AttemptRecord[]>([["browser", [prev]]]);
    const prevLen = history.get("browser")!.length;
    await runRecoveryForServer("browser", state, history, deps);
    const updated = history.get("browser")!;
    expect(updated.length).toBe(prevLen + 1);
    // Old entry still present (preserved by reference equality on its fields)
    expect(updated[0]?.attemptedAt).toBe(oldIso);
    expect(updated[0]?.outcomeKind).toBe("give-up");
    // New entry was appended
    expect(updated[1]?.handlerName).toBe("playwright-chromium");
    expect(updated[1]?.outcomeKind).toBe("recovered");
  });
});
