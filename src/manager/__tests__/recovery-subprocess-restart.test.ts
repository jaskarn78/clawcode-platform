import { describe, it, expect, vi, afterEach } from "vitest";
import type { Logger } from "pino";

/**
 * Phase 94 Plan 03 Task 1 — subprocess-restart handler tests (RED).
 *
 * Pin matches/recover behavior for D-05 pattern 3:
 *   Last-resort: matches when state.capabilityProbe.status === "degraded"
 *   AND degraded duration > 5min. recover() kills the MCP subprocess via
 *   deps.killSubprocess; SDK respawns the subprocess automatically.
 */

import type { RecoveryDeps } from "../recovery/types.js";
import type { McpServerState } from "../../mcp/readiness.js";
import { subprocessRestartHandler } from "../recovery/subprocess-restart.js";

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

function makeState(degradedSinceMsAgo: number): McpServerState {
  const lastSuccessAt = new Date(Date.now() - degradedSinceMsAgo).toISOString();
  return {
    name: "browser",
    status: "degraded",
    lastSuccessAt: Date.now() - degradedSinceMsAgo,
    lastFailureAt: Date.now() - 1000,
    lastError: { message: "transient" },
    failureCount: 4,
    optional: false,
    capabilityProbe: {
      lastRunAt: new Date().toISOString(),
      status: "degraded",
      error: "transient mystery error",
      lastSuccessAt,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("subprocessRestartHandler", () => {
  it("REC-SR-MATCH-AFTER-5MIN: state.capabilityProbe.status='degraded' + lastSuccessAt 6min ago → matches() returns true", () => {
    const state = makeState(6 * 60 * 1000);
    expect(subprocessRestartHandler.matches("any error", state)).toBe(true);
  });

  it("REC-SR-NO-MATCH-WITHIN-5MIN: state.capabilityProbe.status='degraded' + lastSuccessAt 4min ago → matches() returns false", () => {
    const state = makeState(4 * 60 * 1000);
    expect(subprocessRestartHandler.matches("any error", state)).toBe(false);
  });

  it("REC-SR-NO-MATCH-WHEN-READY: status !== 'degraded' → matches() returns false regardless of duration", () => {
    const lastSuccessAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const state: McpServerState = {
      name: "browser",
      status: "ready",
      lastSuccessAt: Date.now(),
      lastFailureAt: null,
      lastError: null,
      failureCount: 0,
      optional: false,
      capabilityProbe: {
        lastRunAt: new Date().toISOString(),
        status: "ready",
        lastSuccessAt,
      },
    };
    expect(subprocessRestartHandler.matches("any error", state)).toBe(false);
  });

  it("REC-SR-RECOVER-OK: deps.killSubprocess succeeds → outcome.kind='recovered' + handlerName='subprocess-restart'", async () => {
    const killSubprocess = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ killSubprocess });
    const outcome = await subprocessRestartHandler.recover("browser", deps);
    expect(outcome.kind).toBe("recovered");
    if (outcome.kind === "recovered") {
      expect(outcome.serverName).toBe("browser");
      expect(outcome.handlerName).toBe("subprocess-restart");
    }
    expect(killSubprocess).toHaveBeenCalledWith("browser");
  });
});
