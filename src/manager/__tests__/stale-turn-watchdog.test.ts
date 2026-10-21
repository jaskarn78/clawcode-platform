/**
 * Quick task 260521-4sa (999.64) — heartbeat stale-lock watchdog tests.
 *
 * Drives the inbox heartbeat check's `hasActiveTurn` branch to verify:
 *   - watchdog: a turn-in-flight lock with no SDK activity past the
 *     force-release threshold is force-released + logged forensically, and
 *     the check falls through to the message-drain logic.
 *   - warning: a turn-in-flight lock stale past the warning threshold but
 *     below force-release returns `status: "warning"` and does NOT release.
 *   - active: a genuinely active turn (recent activity) keeps the existing
 *     healthy "skipped: turn in flight" result, untouched.
 *   - fallback: when getLastTurnActivityAt is null, the watchdog keys off
 *     getTurnStartedAt instead.
 *
 * Mocks collaboration/inbox so no fs is touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { InboxMessage } from "../../collaboration/types.js";
import type { CheckContext } from "../../heartbeat/types.js";

// ---------------------------------------------------------------------------
// Mock collaboration/inbox
// ---------------------------------------------------------------------------

const mockReadMessages = vi.fn<(dir: string) => Promise<readonly InboxMessage[]>>();
const mockMarkProcessed = vi.fn<(dir: string, id: string) => Promise<void>>();

vi.mock("../../collaboration/inbox.js", () => ({
  readMessages: (...args: unknown[]) => mockReadMessages(args[0] as string),
  markProcessed: (...args: unknown[]) =>
    mockMarkProcessed(args[0] as string, args[1] as string),
}));

// Import after mocks.
import inboxCheck, { setInboxSourceActive } from "../../heartbeat/checks/inbox.js";

// ---------------------------------------------------------------------------
// Constants — must mirror inbox.ts
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const WARNING_MS = 60_000;
const FORCE_RELEASE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SessionManagerStub = {
  hasActiveTurn: ReturnType<typeof vi.fn>;
  getLastTurnActivityAt: ReturnType<typeof vi.fn>;
  getTurnStartedAt: ReturnType<typeof vi.fn>;
  forceReleaseTurn: ReturnType<typeof vi.fn>;
  getAgentConfig: ReturnType<typeof vi.fn>;
  dispatchTurn: ReturnType<typeof vi.fn>;
};

function makeContext(opts: {
  hasActiveTurn: boolean;
  lastActivityAt: number | null;
  turnStartedAt?: number | null;
  forceReleaseResult?: boolean;
}): { context: CheckContext; sm: SessionManagerStub } {
  const sm: SessionManagerStub = {
    hasActiveTurn: vi.fn().mockReturnValue(opts.hasActiveTurn),
    getLastTurnActivityAt: vi.fn().mockReturnValue(opts.lastActivityAt),
    getTurnStartedAt: vi.fn().mockReturnValue(opts.turnStartedAt ?? null),
    forceReleaseTurn: vi.fn().mockReturnValue(opts.forceReleaseResult ?? true),
    getAgentConfig: vi.fn().mockReturnValue({ memoryPath: "/mem/agent-b" }),
    dispatchTurn: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    agentName: "agent-b",
    sessionManager: sm,
    registry: { entries: [], updatedAt: 0 },
    config: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    },
  } as unknown as CheckContext;
  return { context, sm };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("heartbeat inbox check — stale-lock watchdog (999.64)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setInboxSourceActive(false);
    mockReadMessages.mockResolvedValue([]);
    mockMarkProcessed.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("(b) watchdog: activity 6 min stale → forceReleaseTurn called once, forensic log emitted, falls through to drain", async () => {
    const { context, sm } = makeContext({
      hasActiveTurn: true,
      lastActivityAt: NOW - 6 * 60_000,
      turnStartedAt: NOW - 7 * 60_000,
    });

    const result = await inboxCheck.execute(context);

    // Force-released exactly once.
    expect(sm.forceReleaseTurn).toHaveBeenCalledTimes(1);
    expect(sm.forceReleaseTurn).toHaveBeenCalledWith("agent-b");

    // Forensic log line emitted with the expected label + payload.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toBe("phase999.64-stale-lock-force-release");
    const payload = JSON.parse(warnSpy.mock.calls[0][1] as string);
    expect(payload.agent).toBe("agent-b");
    expect(payload.priorTurnStartedAt).toBe(NOW - 7 * 60_000);
    expect(payload.staleMs).toBe(6 * 60_000);
    expect(payload.forceReleaseThresholdMs).toBe(FORCE_RELEASE_MS);

    // Fell through to drain — readMessages was reached (no early return).
    expect(mockReadMessages).toHaveBeenCalledOnce();
    expect(result.status).toBe("healthy");
  });

  it("(c) warning: activity 90s stale → status warning, reason turn-stale, forceReleaseTurn NOT called", async () => {
    const { context, sm } = makeContext({
      hasActiveTurn: true,
      lastActivityAt: NOW - 90_000,
      turnStartedAt: NOW - 120_000,
    });

    const result = await inboxCheck.execute(context);

    expect(result.status).toBe("warning");
    expect(result.message).toContain("turn-stale");
    expect((result.metadata as { reason?: string }).reason).toBe("turn-stale");
    expect((result.metadata as { staleMs?: number }).staleMs).toBe(90_000);
    expect((result.metadata as { skipped?: boolean }).skipped).toBe(true);

    expect(sm.forceReleaseTurn).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    // Did NOT fall through to drain.
    expect(mockReadMessages).not.toHaveBeenCalled();
  });

  it("(d) regression: activity 5s ago → status healthy, skipped: turn in flight, forceReleaseTurn NOT called", async () => {
    const { context, sm } = makeContext({
      hasActiveTurn: true,
      lastActivityAt: NOW - 5_000,
      turnStartedAt: NOW - 5_000,
    });

    const result = await inboxCheck.execute(context);

    expect(result.status).toBe("healthy");
    expect(result.message).toBe("skipped: turn in flight");
    expect(sm.forceReleaseTurn).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockReadMessages).not.toHaveBeenCalled();
  });

  it("fallback: activity slot null but getTurnStartedAt 6 min ago → watchdog still fires", async () => {
    const { context, sm } = makeContext({
      hasActiveTurn: true,
      lastActivityAt: null,
      turnStartedAt: NOW - 6 * 60_000,
    });

    const result = await inboxCheck.execute(context);

    expect(sm.forceReleaseTurn).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toBe("phase999.64-stale-lock-force-release");
    const payload = JSON.parse(warnSpy.mock.calls[0][1] as string);
    expect(payload.staleMs).toBe(6 * 60_000);
    expect(mockReadMessages).toHaveBeenCalledOnce();
    expect(result.status).toBe("healthy");
  });

  it("cannot-measure: both activity slot and turn-start null → keeps healthy skip (treated as fresh)", async () => {
    const { context, sm } = makeContext({
      hasActiveTurn: true,
      lastActivityAt: null,
      turnStartedAt: null,
    });

    const result = await inboxCheck.execute(context);

    expect(result.status).toBe("healthy");
    expect(result.message).toBe("skipped: turn in flight");
    expect(sm.forceReleaseTurn).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warning boundary: activity exactly at warning threshold + 1ms warns", async () => {
    const { context } = makeContext({
      hasActiveTurn: true,
      lastActivityAt: NOW - (WARNING_MS + 1),
    });

    const result = await inboxCheck.execute(context);
    expect(result.status).toBe("warning");
  });

  it("no active turn → watchdog skipped entirely, normal drain path runs", async () => {
    const { context, sm } = makeContext({
      hasActiveTurn: false,
      lastActivityAt: null,
    });

    const result = await inboxCheck.execute(context);

    expect(sm.forceReleaseTurn).not.toHaveBeenCalled();
    expect(sm.getLastTurnActivityAt).not.toHaveBeenCalled();
    expect(mockReadMessages).toHaveBeenCalledOnce();
    expect(result.status).toBe("healthy");
  });
});
