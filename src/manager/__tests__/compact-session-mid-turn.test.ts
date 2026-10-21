/**
 * Phase 124 Plan 01 T-06 — mid-turn safety + ERR_TURN_TOO_LONG paths.
 *
 * Pins the D-03 mid-turn budget on handleCompactSession:
 *   - In-flight turn within budget → compaction proceeds (logs the
 *     mid-turn note; does NOT block on the SerialTurnQueue at this seam
 *     because compactForAgent + sdk.forkSession are off-turn operations).
 *   - In-flight turn past the budget → returns {ok:false, error:"ERR_TURN_TOO_LONG"}.
 *   - No active turn → compaction proceeds regardless of turn-start map state.
 *
 * The "tool-chain completes intact" half of T-06's plan acceptance is
 * structural: handleCompactSession does NOT touch turnQueue at this seam
 * (Path B defers live-handle hot-swap). The mid-turn budget exists to
 * prevent the IPC reply from hanging when a slow turn would block the
 * eventual swap path (Phase 125 or follow-up). This test covers that
 * budget; the tool-chain-intact invariant is covered by the existing
 * SerialTurnQueue tests at src/manager/__tests__/persistent-session-queue.test.ts.
 */
import { describe, it, expect } from "vitest";
import pino from "pino";

import { handleCompactSession } from "../daemon-compact-session-ipc.js";
import type {
  CompactSessionDeps,
  CompactSessionResult,
} from "../daemon-compact-session-ipc.js";

const SILENT_LOG = pino({ level: "silent" });

/** Build a deps fixture with sensible defaults; override per-test. */
function buildDeps(
  overrides: Partial<CompactSessionDeps> & {
    activeTurn?: boolean;
    sessionId?: string;
  },
): CompactSessionDeps {
  const sessionId = overrides.sessionId ?? "session-fixture";
  return {
    manager: overrides.manager ?? {
      getSessionHandle: () => ({
        sessionId,
        hasActiveTurn: () => overrides.activeTurn === true,
      }),
      getConversationTurns: () => [],
      getContextFillProvider: () => undefined,
      compactForAgent: async () =>
        Object.freeze({
          logPath: "/tmp/x.log",
          memoriesCreated: 0,
          summary: "ok",
        }),
      hasCompactionManager: () => true,
    },
    sdkForkSession: overrides.sdkForkSession ?? (async () => ({ sessionId: "fork-id" })),
    extractMemories: overrides.extractMemories ?? (async () => []),
    log: overrides.log ?? SILENT_LOG,
    daemonReady: overrides.daemonReady ?? true,
    ...(overrides.maxTurnAgeMs !== undefined
      ? { maxTurnAgeMs: overrides.maxTurnAgeMs }
      : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.turnStartedAt !== undefined
      ? { turnStartedAt: overrides.turnStartedAt }
      : {}),
  };
}

describe("handleCompactSession — mid-turn safety (D-03)", () => {
  it("proceeds when no turn is active (turnStartedAt map empty)", async () => {
    const result: CompactSessionResult = await handleCompactSession(
      { agent: "a" },
      buildDeps({ activeTurn: false }),
    );
    expect(result.ok).toBe(true);
  });

  it("proceeds when an in-flight turn is within the budget", async () => {
    const NOW = 1_000_000;
    const TURN_STARTED = NOW - 60_000; // 1 minute ago
    const result = await handleCompactSession(
      { agent: "a" },
      buildDeps({
        activeTurn: true,
        now: () => NOW,
        turnStartedAt: new Map([["a", TURN_STARTED]]),
        maxTurnAgeMs: 10 * 60 * 1000, // 10 min budget
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects ERR_TURN_TOO_LONG when in-flight turn exceeds the budget", async () => {
    const NOW = 1_000_000;
    const TURN_STARTED = NOW - 11 * 60 * 1000; // 11 minutes ago — over budget
    const result = await handleCompactSession(
      { agent: "a" },
      buildDeps({
        activeTurn: true,
        now: () => NOW,
        turnStartedAt: new Map([["a", TURN_STARTED]]),
        maxTurnAgeMs: 10 * 60 * 1000,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("ERR_TURN_TOO_LONG");
    expect(result.message).toMatch(/in-flight for \d+s/);
  });

  it("proceeds when active-turn flag is set but no start timestamp exists", async () => {
    // Defensive — without a startedAt entry we cannot compute age. The handler
    // logs the mid-turn proceed-note and continues (the budget gate only
    // fires when we have BOTH active flag AND a timestamp).
    const result = await handleCompactSession(
      { agent: "a" },
      buildDeps({
        activeTurn: true,
        now: () => 1_000_000,
        turnStartedAt: new Map(),
        maxTurnAgeMs: 10 * 60 * 1000,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("uses default 10-min budget when maxTurnAgeMs is unset", async () => {
    const NOW = 1_000_000;
    const TURN_STARTED = NOW - 11 * 60 * 1000; // 11 min — over 10-min default
    const result = await handleCompactSession(
      { agent: "a" },
      buildDeps({
        activeTurn: true,
        now: () => NOW,
        turnStartedAt: new Map([["a", TURN_STARTED]]),
        // maxTurnAgeMs intentionally omitted
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("ERR_TURN_TOO_LONG");
  });
});
