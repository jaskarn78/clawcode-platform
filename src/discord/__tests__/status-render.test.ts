/**
 * Phase 93 Plan 01 + Phase 103 Plan 01 — status-render module unit tests.
 *
 * R-01..R-08 (Phase 93): pin the 9-line OpenClaw-parity skeleton.
 * Phase 103 OBS-01/02/03 (this file): pin live-wired fields, OpenClaw-only
 * field drops (Fast/Elevated/Harness), and the in-memory compaction counter.
 *
 * Locked decisions (Phase 93):
 *   D-93-01-1 — output ALL lines unconditionally; mark gaps as unknown/n/a.
 *   D-93-01-2 — abbreviated session id (last 12 chars of handle.sessionId).
 *   D-93-01-3 — relative updated-time via date-fns/formatDistanceToNow.
 *   D-93-01-4 — no token-counter plumbing in Phase 93.
 *
 * Phase 103 changes:
 *   - Tokens, Context %, Compactions, Activation, Queue, Reasoning all wired
 *     to live SessionManager / UsageTracker accessors.
 *   - "Fast: n/a", "Elevated: n/a", "Harness: n/a" substrings DROPPED — the
 *     OpenClaw-only fields have no ClawCode analog.
 *   - "Fallbacks: n/a" REMAINS — no current source.
 *
 * Pitfall 6 closure: every accessor in `buildStatusData` is try/catch'd so a
 * thrown SessionError on `getEffortForAgent` collapses to `unknown` instead
 * of dropping the entire render to "Failed to read status".
 */
import { describe, it, expect } from "vitest";
import {
  renderStatus,
  buildStatusData,
  deriveDreamAttemptAnnotation,
  deriveConsolidationStatus,
  type StatusData,
  type BuildStatusDataInput,
} from "../status-render.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { UsageAggregate } from "../../usage/types.js";
// Phase 999.113 WS-6 — run-log row shapes for the annotation fixtures.
import type { DreamRunRow } from "../../manager/dream-run-log.js";
import type { ConsolidationRunRow } from "../../manager/consolidation-run-log.js";

const SAMPLE_SESSION_ID = "01234567-89ab-cdef-0123-4567890abcdef";
const NOW = new Date("2026-04-24T12:00:00Z").getTime();
const TWENTY_FOUR_MIN_AGO = NOW - 24 * 60 * 1000;

function makeData(overrides: Partial<StatusData> = {}): StatusData {
  return {
    agentName: "fin",
    agentVersion: "1.2.8",
    commitSha: "abc1234",
    liveModel: "sonnet",
    configModel: "sonnet",
    effort: "medium",
    permissionMode: "default",
    sessionId: SAMPLE_SESSION_ID,
    lastActivityAt: TWENTY_FOUR_MIN_AGO,
    hasActiveTurn: false,
    contextFillPercentage: undefined,
    lastConsolidationAt: undefined,
    lastDreamAt: undefined,
    lastDreamWikilinks: undefined,
    tokensIn: undefined,
    tokensOut: undefined,
    activationAt: undefined,
    now: NOW,
    ...overrides,
  };
}

/**
 * Build a stub BuildStatusDataInput with safe defaults for all 8 Pick'd
 * SessionManager accessors. Tests pass a partial override to vary behavior.
 */
type StubInputOverrides = {
  effort?: string;
  liveModel?: string;
  permissionMode?: string;
  sessionId?: string;
  hasActiveTurn?: boolean;
  contextFillPercentage?: number | undefined;
  activationAt?: number | undefined;
  sessionUsage?: UsageAggregate | undefined;
  /** When provided AND sessionUsage is set, used as the latest event timestamp. */
  lastEventTs?: string;
  configModel?: string;
  lastConsolidationAt?: number | undefined;
  lastDreamAt?: number | undefined;
  lastDreamWikilinks?: number | undefined;
  /** Phase 999.113 WS-6 — optional run-log rows. */
  dreamRuns?: BuildStatusDataInput["dreamRuns"];
  consolidationRuns?: BuildStatusDataInput["consolidationRuns"];
};

function makeInput(overrides: StubInputOverrides = {}): BuildStatusDataInput {
  const effort = overrides.effort ?? "medium";
  const liveModel = overrides.liveModel ?? "claude-sonnet-4";
  const permissionMode = overrides.permissionMode ?? "bypass";
  const sessionId = overrides.sessionId ?? SAMPLE_SESSION_ID;
  const hasActiveTurn = overrides.hasActiveTurn ?? false;
  const contextFillPercentage = overrides.contextFillPercentage;
  const activationAt = overrides.activationAt;
  const sessionUsage = overrides.sessionUsage;
  const configModel = overrides.configModel ?? "sonnet";

  // Stub UsageTracker — only present when sessionUsage is provided. The stub
  // exposes getSessionUsage and a minimal getDatabase whose prepare(...).get(...)
  // returns a row with a `ts` field (when lastEventTs is given) so the
  // buildStatusData lastActivityAt path is exercised.
  const usageTracker = sessionUsage !== undefined
    ? {
        getSessionUsage: (_sid: string) => sessionUsage,
        getDatabase: () => ({
          prepare: (_sql: string) => ({
            get: (_param: string) => ({
              ts: overrides.lastEventTs ?? new Date(NOW - 60_000).toISOString(),
            }),
          }),
        }),
      }
    : undefined;

  const sessionManager = {
    getEffortForAgent: (_n: string) => effort,
    getModelForAgent: (_n: string) => liveModel,
    getPermissionModeForAgent: (_n: string) => permissionMode,
    getSessionHandle: (_n: string) =>
      ({
        sessionId,
        hasActiveTurn: () => hasActiveTurn,
      }) as unknown,
    getContextFillPercentageForAgent: (_n: string) => contextFillPercentage,
    getActivationAtForAgent: (_n: string) => activationAt,
    getUsageTracker: (_n: string) => usageTracker,
  } as unknown as Pick<
    SessionManager,
    | "getEffortForAgent"
    | "getModelForAgent"
    | "getPermissionModeForAgent"
    | "getSessionHandle"
    | "getContextFillPercentageForAgent"
    | "getActivationAtForAgent"
    | "getUsageTracker"
  >;

  const resolvedAgents: readonly ResolvedAgentConfig[] = [
    { name: "fin", model: configModel } as unknown as ResolvedAgentConfig,
  ];

  return {
    sessionManager,
    resolvedAgents,
    agentName: "fin",
    agentVersion: "1.2.8",
    commitSha: "abc1234",
    now: NOW,
    lastConsolidationAt: overrides.lastConsolidationAt,
    lastDreamAt: overrides.lastDreamAt,
    lastDreamWikilinks: overrides.lastDreamWikilinks,
    dreamRuns: overrides.dreamRuns,
    consolidationRuns: overrides.consolidationRuns,
  };
}

describe("renderStatus — R-01..R-07 line shape (Phase 93 + 103 reshape)", () => {
  it("R-01 happy path renders ALL 10 lines with concrete values", () => {
    const out = renderStatus(makeData()).split("\n");
    expect(out).toHaveLength(10);
    expect(out[0]).toBe("ClawCode v1.2.8 (abc1234)");
    expect(out[1]).toBe("Agent: fin");
    expect(out[2]).toBe("Model: sonnet · sdk");
    expect(out[3]).toBe("Consolidated: never");
    // Context defaults to "unknown" when fillPercentage undefined; Dreamt: never when no dream.
    expect(out[4]).toBe("Context: unknown · Dreamt: never");
    // Phase 103 — Tokens emits "n/a" when tokensIn/Out undefined.
    expect(out[5]).toBe("Tokens: n/a");
    // Last 12 chars of SAMPLE_SESSION_ID via slice(-12) — assert via computed
    // expected so test stays robust to id-shape drift.
    const expectedSession = `…${SAMPLE_SESSION_ID.slice(-12)}`;
    expect(out[6]).toContain(expectedSession);
    expect(out[6]).toContain(" • updated ");
    expect(out[7]).toBe("Task: idle");
    // Phase 103 — Fast/Harness/Elevated DROPPED; Reasoning is now a label.
    expect(out[8]).toBe(
      "Runtime: SDK session · Think: medium · Reasoning: medium effort · Permissions: default",
    );
    // Phase 103 — Activation from registry (undefined → "unknown"); Queue from
    // hasActiveTurn (false → "idle").
    expect(out[9]).toBe("Activation: unknown · Queue: idle");
  });

  it("R-02 hasActiveTurn=true → Task: busy AND Queue: 1 in-flight", () => {
    const out = renderStatus(makeData({ hasActiveTurn: true })).split("\n");
    expect(out[7]).toBe("Task: busy");
    expect(out[9]).toContain("Queue: 1 in-flight");
  });

  it("R-03 liveModel undefined falls back to configModel", () => {
    const out = renderStatus(
      makeData({ liveModel: undefined, configModel: "haiku" }),
    ).split("\n");
    expect(out[2]).toBe("Model: haiku · sdk");
  });

  it("R-04 both models missing → Model: unknown", () => {
    const out = renderStatus(
      makeData({ liveModel: undefined, configModel: undefined }),
    ).split("\n");
    expect(out[2]).toBe("Model: unknown · sdk");
  });

  it("R-05 missing commit sha → (unknown)", () => {
    const out = renderStatus(makeData({ commitSha: undefined })).split("\n");
    expect(out[0]).toBe("ClawCode v1.2.8 (unknown)");
  });

  it("R-06 missing session id → Session: unknown • updated unknown", () => {
    const out = renderStatus(
      makeData({ sessionId: undefined, lastActivityAt: undefined }),
    ).split("\n");
    expect(out[6]).toBe("Session: unknown • updated unknown");
  });

  it("R-07 lastActivityAt undefined but sessionId set → updated unknown", () => {
    const out = renderStatus(makeData({ lastActivityAt: undefined })).split("\n");
    expect(out[6]).toBe(
      `Session: …${SAMPLE_SESSION_ID.slice(-12)} • updated unknown`,
    );
  });
});

describe("buildStatusData — R-08 defensive read", () => {
  it("R-08 throwing accessors collapse to unknown placeholders, NEVER 'Failed to read status'", () => {
    const throwingSm = {
      getEffortForAgent: () => {
        throw new Error("not running");
      },
      getModelForAgent: () => {
        throw new Error("not running");
      },
      getPermissionModeForAgent: () => {
        throw new Error("not running");
      },
      getSessionHandle: () => undefined,
      // Phase 103 — new accessors also throw to validate defensive reads.
      getContextFillPercentageForAgent: () => {
        throw new Error("not running");
      },
      getActivationAtForAgent: () => {
        throw new Error("not running");
      },
      getUsageTracker: () => {
        throw new Error("not running");
      },
    } as unknown as SessionManager;
    const resolvedAgents: readonly ResolvedAgentConfig[] = [];
    const data = buildStatusData({
      sessionManager: throwingSm,
      resolvedAgents,
      agentName: "ghost",
      agentVersion: "1.2.8",
      commitSha: undefined,
      now: NOW,
      lastConsolidationAt: undefined,
      lastDreamAt: undefined,
      lastDreamWikilinks: undefined,
    });
    expect(data.liveModel).toBeUndefined();
    expect(data.effort).toBe("unknown");
    expect(data.permissionMode).toBe("unknown");
    expect(data.sessionId).toBeUndefined();
    expect(data.hasActiveTurn).toBe(false);
    expect(data.lastConsolidationAt).toBeUndefined();
    expect(data.lastDreamAt).toBeUndefined();
    expect(data.contextFillPercentage).toBeUndefined();
    expect(data.activationAt).toBeUndefined();
    expect(data.tokensIn).toBeUndefined();
    expect(data.tokensOut).toBeUndefined();

    const out = renderStatus(data);
    expect(out).not.toContain("Failed to read status");
    expect(out.split("\n")).toHaveLength(10);
  });
});

describe("/clawcode-status — Phase 103 OBS-01/02/03 wiring", () => {
  it("emits Consolidated: never when no digest files", () => {
    const out = renderStatus(buildStatusData(makeInput({ lastConsolidationAt: undefined })));
    expect(out).toContain("Consolidated: never");
  });

  it("emits Consolidated: X ago when lastConsolidationAt is set", () => {
    const oneHourAgo = Date.now() - 3_600_000;
    const out = renderStatus(buildStatusData(makeInput({ lastConsolidationAt: oneHourAgo })));
    expect(out).toMatch(/Consolidated: about 1 hour ago/);
  });

  it("emits Dreamt: never when no dream files", () => {
    const out = renderStatus(buildStatusData(makeInput({ lastDreamAt: undefined })));
    expect(out).toContain("Dreamt: never");
  });

  it("emits Dreamt: X ago with link count when lastDreamAt + wikilinks set", () => {
    const twoHoursAgo = Date.now() - 7_200_000;
    const out = renderStatus(
      buildStatusData(makeInput({ lastDreamAt: twoHoursAgo, lastDreamWikilinks: 3 })),
    );
    expect(out).toMatch(/Dreamt: about 2 hours ago \(3 links\)/);
  });

  it("emits Dreamt: X ago WITHOUT link count when wikilinks undefined", () => {
    const twoHoursAgo = Date.now() - 7_200_000;
    const out = renderStatus(
      buildStatusData(makeInput({ lastDreamAt: twoHoursAgo, lastDreamWikilinks: undefined })),
    );
    expect(out).toMatch(/Dreamt: about 2 hours ago$/m);
    expect(out).not.toContain("links)");
  });

  it("emits Context % from getContextFillPercentageForAgent", () => {
    const out = renderStatus(
      buildStatusData(makeInput({ contextFillPercentage: 0.42 })),
    );
    expect(out).toContain("Context: 42%");
  });

  it("emits Tokens from UsageTracker.getSessionUsage", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          sessionId: "sess-abc-123",
          sessionUsage: {
            tokens_in: 1234,
            tokens_out: 567,
            cost_usd: 0,
            turns: 1,
            duration_ms: 10,
            event_count: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
        }),
      ),
    );
    expect(out).toContain("Tokens: 1234 in / 567 out");
  });

  it("emits Activation relative time from getActivationAtForAgent", () => {
    const oneHourAgo = Date.now() - 3_600_000;
    const out = renderStatus(buildStatusData(makeInput({ activationAt: oneHourAgo })));
    expect(out).toMatch(/Activation: about 1 hour ago/);
  });

  it("emits Queue '1 in-flight' when hasActiveTurn", () => {
    const out = renderStatus(buildStatusData(makeInput({ hasActiveTurn: true })));
    expect(out).toContain("Queue: 1 in-flight");
  });

  it("emits Queue 'idle' when not hasActiveTurn", () => {
    const out = renderStatus(buildStatusData(makeInput({ hasActiveTurn: false })));
    expect(out).toContain("Queue: idle");
  });

  it("DOES NOT emit Fast: (OBS-03 OpenClaw drop)", () => {
    const out = renderStatus(buildStatusData(makeInput({})));
    expect(out).not.toContain("Fast:");
  });

  it("DOES NOT emit Elevated: (OBS-03 OpenClaw drop)", () => {
    const out = renderStatus(buildStatusData(makeInput({})));
    expect(out).not.toContain("Elevated:");
  });

  it("DOES NOT emit Harness: (OBS-03 OpenClaw drop)", () => {
    const out = renderStatus(buildStatusData(makeInput({})));
    expect(out).not.toContain("Harness:");
  });

  it("DOES NOT emit Fallbacks: (replaced by Consolidated)", () => {
    const out = renderStatus(buildStatusData(makeInput({})));
    expect(out).not.toContain("Fallbacks:");
    expect(out).toContain("Consolidated:");
  });

  it("renders Reasoning as a label (not n/a)", () => {
    const out = renderStatus(buildStatusData(makeInput({ effort: "medium" })));
    expect(out).toContain("Reasoning: medium effort");
    expect(out).not.toContain("Reasoning: n/a");
  });

  it("DOES NOT emit Compactions: (replaced by Dreamt)", () => {
    const out = renderStatus(buildStatusData(makeInput({})));
    expect(out).not.toContain("Compactions:");
    expect(out).toContain("Dreamt:");
  });
});

// Phase 103 OBS-08 — optional 5h+7d bar suffix appended to /clawcode-status
// when rate-limit snapshots are present. Pure helper, lives alongside
// renderStatus so the bar vocabulary stays consistent across surfaces.
import { renderUsageBars } from "../status-render.js";
import type { RateLimitSnapshot } from "../../usage/rate-limit-tracker.js";

function snapshot(overrides: Partial<RateLimitSnapshot>): RateLimitSnapshot {
  return Object.freeze({
    rateLimitType: "five_hour",
    status: "allowed" as const,
    utilization: undefined,
    resetsAt: undefined,
    surpassedThreshold: undefined,
    overageStatus: undefined,
    overageResetsAt: undefined,
    overageDisabledReason: undefined,
    isUsingOverage: undefined,
    recordedAt: Date.now(),
    ...overrides,
  });
}

describe("renderUsageBars (OBS-08)", () => {
  it("returns empty string when no five_hour or seven_day snapshot", () => {
    expect(renderUsageBars([])).toBe("");
    expect(
      renderUsageBars([
        snapshot({ rateLimitType: "seven_day_opus", utilization: 0.5 }),
      ]),
    ).toBe("");
  });

  it("five_hour snapshot alone produces no output (5h line removed)", () => {
    const out = renderUsageBars([
      snapshot({ rateLimitType: "five_hour", utilization: 0.5 }),
    ]);
    expect(out).toBe("");
  });

  it("renders 7-day weekly line when seven_day snapshot present", () => {
    const out = renderUsageBars([
      snapshot({
        rateLimitType: "seven_day",
        utilization: 0.71,
        resetsAt: Date.now() + 86_400_000 * 4,
      }),
    ]);
    expect(out).toContain("7-day weekly:");
    expect(out).toContain("71%");
  });

  it("renders only 7-day line even when both snapshots present", () => {
    const out = renderUsageBars([
      snapshot({ rateLimitType: "five_hour", utilization: 0.5 }),
      snapshot({ rateLimitType: "seven_day", utilization: 0.7 }),
    ]);
    expect(out.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(out).toContain("7-day weekly:");
  });

  it("output begins with newline so it appends cleanly to renderStatus", () => {
    const out = renderUsageBars([
      snapshot({ rateLimitType: "seven_day", utilization: 0.7 }),
    ]);
    expect(out.startsWith("\n")).toBe(true);
  });
});

/**
 * Phase 999.113 WS-6 — run-log-backed panel accuracy.
 *
 * The Dreamt:/Consolidated: lines must report last ATTEMPT + outcome, not
 * just the last artifact mtime. All new StatusData fields are optional —
 * undefined must keep the render byte-identical to the pre-WS-6 output.
 */
describe("Phase 999.113 WS-6 — dream/consolidation run-log annotations", () => {
  // formatDistanceToNow compares against REAL wall-clock time (not
  // data.now), so relative-time fixtures must anchor on Date.now() — same
  // convention as the Phase 103 OBS-01 tests above.
  const REAL_NOW = Date.now();
  const THIRTY_MIN_AGO = REAL_NOW - 30 * 60 * 1000;
  const TWO_HOURS_AGO = REAL_NOW - 2 * 60 * 60 * 1000;
  const ONE_HOUR_AGO = REAL_NOW - 60 * 60 * 1000;
  const THREE_HOURS_AGO = REAL_NOW - 3 * 60 * 60 * 1000;

  function dreamRow(overrides: Partial<DreamRunRow> = {}): DreamRunRow {
    return {
      run_id: "dr-default",
      agent: "fin",
      status: "applied",
      started_at: new Date(THIRTY_MIN_AGO).toISOString(),
      duration_ms: 900,
      ...overrides,
    };
  }

  function consolidationRow(
    overrides: Partial<ConsolidationRunRow> = {},
  ): ConsolidationRunRow {
    return {
      run_id: "cr-default",
      target_agents: ["fin"],
      memories_added: 0,
      status: "completed",
      errors: [],
      started_at: new Date(ONE_HOUR_AGO).toISOString(),
      completed_at: new Date(ONE_HOUR_AGO).toISOString(),
      ...overrides,
    };
  }

  it("no run data → output is byte-identical to the pre-WS-6 render", () => {
    const base = renderStatus(
      makeData({
        lastDreamAt: TWO_HOURS_AGO,
        lastDreamWikilinks: 2,
        lastConsolidationAt: ONE_HOUR_AGO,
      }),
    );
    const withExplicitUndefineds = renderStatus(
      makeData({
        lastDreamAt: TWO_HOURS_AGO,
        lastDreamWikilinks: 2,
        lastConsolidationAt: ONE_HOUR_AGO,
        lastDreamAttemptAt: undefined,
        lastDreamAttemptOutcome: undefined,
        lastConsolidationAttemptAt: undefined,
        lastConsolidationAttemptOutcome: undefined,
      }),
    );
    expect(withExplicitUndefineds).toBe(base);

    // Same guarantee end-to-end through buildStatusData: absent run arrays
    // and empty run arrays both render the exact same block.
    const inputNoRuns = renderStatus(
      buildStatusData(
        makeInput({ lastDreamAt: TWO_HOURS_AGO, lastConsolidationAt: ONE_HOUR_AGO }),
      ),
    );
    const inputEmptyRuns = renderStatus(
      buildStatusData(
        makeInput({
          lastDreamAt: TWO_HOURS_AGO,
          lastConsolidationAt: ONE_HOUR_AGO,
          dreamRuns: [],
          consolidationRuns: [],
        }),
      ),
    );
    expect(inputEmptyRuns).toBe(inputNoRuns);
    expect(inputNoRuns).not.toContain("last attempt");
  });

  it("failed dream attempt newer than the last success → annotation present", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          lastDreamAt: TWO_HOURS_AGO,
          lastDreamWikilinks: 0,
          dreamRuns: [
            dreamRow({
              run_id: "dr-fail",
              status: "failed",
              started_at: new Date(THIRTY_MIN_AGO).toISOString(),
              reason: "parse-failed: Unexpected token",
            }),
          ],
        }),
      ),
    );
    expect(out).toContain(
      "Dreamt: about 2 hours ago (0 links) · last attempt 30 minutes ago failed",
    );
  });

  it("no-op dream attempt renders the no-op wording", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          lastDreamAt: TWO_HOURS_AGO,
          dreamRuns: [dreamRow({ status: "noop", reason: "pass-skipped: agent-active" })],
        }),
      ),
    );
    expect(out).toContain("· last attempt 30 minutes ago no-op");
  });

  it("failed dream attempt OLDER than the last success → no annotation", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          lastDreamAt: ONE_HOUR_AGO,
          dreamRuns: [
            dreamRow({
              status: "failed",
              started_at: new Date(THREE_HOURS_AGO).toISOString(),
            }),
          ],
        }),
      ),
    );
    expect(out).not.toContain("last attempt");
  });

  it("newest APPLIED dream row → no annotation (success already shown)", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          lastDreamAt: ONE_HOUR_AGO,
          dreamRuns: [
            dreamRow({ run_id: "dr-old-fail", status: "failed", started_at: new Date(TWO_HOURS_AGO).toISOString() }),
            dreamRow({ run_id: "dr-ok", status: "applied", started_at: new Date(ONE_HOUR_AGO).toISOString() }),
          ],
        }),
      ),
    );
    expect(out).not.toContain("last attempt");
  });

  it("dream rows for OTHER agents are ignored", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          lastDreamAt: TWO_HOURS_AGO,
          dreamRuns: [dreamRow({ agent: "other-agent", status: "failed" })],
        }),
      ),
    );
    expect(out).not.toContain("last attempt");
  });

  it("consolidation run with 0 digests → Consolidated shows a timestamp, not never", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          lastConsolidationAt: undefined, // no digest files on disk
          consolidationRuns: [consolidationRow({ memories_added: 0 })],
        }),
      ),
    );
    expect(out).toContain("Consolidated: about 1 hour ago");
    expect(out).not.toContain("Consolidated: never");
  });

  it("consolidation run-log reduces by run_id (started → completed)", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          lastConsolidationAt: undefined,
          consolidationRuns: [
            consolidationRow({ run_id: "cr-1", status: "started", completed_at: undefined }),
            consolidationRow({ run_id: "cr-1", status: "completed" }),
          ],
        }),
      ),
    );
    expect(out).toContain("Consolidated: about 1 hour ago");
    expect(out).not.toContain("last attempt");
  });

  it("failed consolidation newer than last success → annotation on the line", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          lastConsolidationAt: TWO_HOURS_AGO,
          consolidationRuns: [
            consolidationRow({
              run_id: "cr-bad",
              status: "failed",
              started_at: new Date(THIRTY_MIN_AGO).toISOString(),
              completed_at: new Date(THIRTY_MIN_AGO).toISOString(),
              errors: ["synthetic-error"],
            }),
          ],
        }),
      ),
    );
    expect(out).toContain(
      "Consolidated: about 2 hours ago · last attempt 30 minutes ago failed",
    );
  });

  it("dangling started-only consolidation run → no annotation (in-flight, not failed)", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          lastConsolidationAt: TWO_HOURS_AGO,
          consolidationRuns: [
            consolidationRow({
              run_id: "cr-inflight",
              status: "started",
              started_at: new Date(THIRTY_MIN_AGO).toISOString(),
              completed_at: undefined,
            }),
          ],
        }),
      ),
    );
    expect(out).not.toContain("last attempt");
  });

  it("deriveDreamAttemptAnnotation surfaces an attempt when there was never a success", () => {
    const derived = deriveDreamAttemptAnnotation(
      [dreamRow({ status: "failed" })],
      "fin",
      undefined,
    );
    expect(derived.lastDreamAttemptAt).toBe(THIRTY_MIN_AGO);
    expect(derived.lastDreamAttemptOutcome).toBe("failed");
  });

  it("deriveConsolidationStatus prefers the newer of run-log row and digest mtime", () => {
    const derived = deriveConsolidationStatus(
      [consolidationRow()],
      "fin",
      THIRTY_MIN_AGO, // digest mtime NEWER than the completed row
    );
    expect(derived.lastConsolidationAt).toBe(THIRTY_MIN_AGO);
  });

  it("rolled-back consolidation renders 'rolled back' wording", () => {
    const out = renderStatus(
      buildStatusData(
        makeInput({
          lastConsolidationAt: undefined,
          consolidationRuns: [
            consolidationRow({
              run_id: "cr-rb",
              status: "rolled-back",
              started_at: new Date(THIRTY_MIN_AGO).toISOString(),
              completed_at: new Date(THIRTY_MIN_AGO).toISOString(),
            }),
          ],
        }),
      ),
    );
    expect(out).toContain(
      "Consolidated: never · last attempt 30 minutes ago rolled back",
    );
  });
});
