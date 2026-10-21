/**
 * Phase 96 Plan 07 Task 1 — `fs-probe` heartbeat check tests.
 *
 * Mirrors src/heartbeat/checks/__tests__/mcp-reconnect.test.ts (Phase 85).
 *
 * The heartbeat runner already iterates agents and calls execute(ctx)
 * per-agent — so this check is a per-agent execute() (not a tick(deps)
 * iterating agents itself). Same shape as mcp-reconnect.
 *
 * Behaviors pinned (FPC-):
 *   - FPC-INTERVAL-LOCKED:    interval === 60 (D-01 60s, same cadence as mcp-reconnect)
 *   - FPC-MODULE-SHAPE:       exports CheckModule with name='fs-probe' + execute()
 *   - FPC-HAPPY-TICK:         runFsProbe completed → writeFsSnapshot + setFsCapabilitySnapshot called
 *   - FPC-AGENT-NOT-RUNNING:  no SessionHandle → graceful warning, no probe
 *   - FPC-PARALLEL-INDEPENDENCE: per-agent failures don't break siblings (executed by runner; we test per-agent failure-isolation in execute() boundary)
 *   - FPC-PROBE-FAILED-OUTCOME: outcome.kind='failed' → no persist, no in-memory update
 *   - FPC-PREV-SNAPSHOT-THREADED: handle.getFsCapabilitySnapshot() result threaded as prev arg
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";

import type {
  CheckContext,
  CheckResult,
  HeartbeatConfig,
} from "../../types.js";
import type { Registry } from "../../../manager/types.js";
import type { ResolvedAgentConfig } from "../../../shared/types.js";
import type {
  FsCapabilitySnapshot,
} from "../../../manager/persistent-session-handle.js";

// Mock the runFsProbe primitive (96-01) so tests drive outcomes deterministically.
vi.mock("../../../manager/fs-probe.js", async () => {
  const actual = await vi.importActual<typeof import("../../../manager/fs-probe.js")>(
    "../../../manager/fs-probe.js",
  );
  return {
    ...actual,
    runFsProbe: vi.fn(),
  };
});
import { runFsProbe } from "../../../manager/fs-probe.js";
const mockedRunFsProbe = vi.mocked(runFsProbe);

// Mock writeFsSnapshot (96-01) so tests inspect persistence calls.
vi.mock("../../../manager/fs-snapshot-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../../manager/fs-snapshot-store.js")>(
    "../../../manager/fs-snapshot-store.js",
  );
  return {
    ...actual,
    writeFsSnapshot: vi.fn(),
  };
});
import { writeFsSnapshot } from "../../../manager/fs-snapshot-store.js";
const mockedWriteFsSnapshot = vi.mocked(writeFsSnapshot);

import fsProbeCheck from "../fs-probe.js";

// ---------------------------------------------------------------------------
// Helpers — stub context (mirror mcp-reconnect.test.ts)
// ---------------------------------------------------------------------------

function makeAgentConfig(overrides?: Partial<ResolvedAgentConfig>): ResolvedAgentConfig {
  return {
    name: "test-agent",
    workspace: "/tmp/test-agent",
    memoryPath: "/tmp/test-agent",
    channels: [],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    memoryAutoLoad: true,
    memoryRetrievalTopK: 5,
    memoryScannerEnabled: true,
    memoryFlushIntervalMs: 900_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    skills: [],
    soul: undefined,
    identity: undefined,
    memory: {
      compactionThreshold: 0.75,
      searchTopK: 10,
      consolidation: {
        enabled: true,
        weeklyThreshold: 7,
        monthlyThreshold: 4,
        schedule: "0 3 * * *",
      },
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: true, similarityThreshold: 0.85 },
    },
    schedules: [],
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    },
    skillsPath: "/tmp/skills",
    admin: false,
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
    fileAccess: ["/home/example-user/.openclaw/workspace-acme/"],
    ...overrides,
  } as ResolvedAgentConfig;
}

function makeStub(opts: {
  agentName?: string;
  agentConfig?: ResolvedAgentConfig;
  /** undefined → no SessionHandle (agent-not-running path). */
  handlePresent?: boolean;
  priorSnapshot?: ReadonlyMap<string, FsCapabilitySnapshot>;
}) {
  const agentName = opts.agentName ?? "test-agent";
  const setSnapshotCalls: Array<ReadonlyMap<string, FsCapabilitySnapshot>> = [];
  let storedSnapshot: ReadonlyMap<string, FsCapabilitySnapshot> =
    opts.priorSnapshot ?? new Map();

  const fakeHandle = opts.handlePresent === false
    ? undefined
    : {
        getFsCapabilitySnapshot: () => storedSnapshot,
        setFsCapabilitySnapshot: (next: ReadonlyMap<string, FsCapabilitySnapshot>) => {
          setSnapshotCalls.push(new Map(next));
          storedSnapshot = new Map(next);
        },
      };

  const sessionManager = {
    getAgentConfig: (_name: string) => opts.agentConfig,
    getSessionHandle: (_name: string) => fakeHandle,
  } as unknown as CheckContext["sessionManager"];

  const config: HeartbeatConfig = {
    enabled: true,
    intervalSeconds: 60,
    checkTimeoutSeconds: 10,
    contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
  };

  const registry: Registry = { entries: [], updatedAt: Date.now() };

  const ctx: CheckContext = {
    agentName,
    sessionManager,
    registry,
    config,
  };
  return { ctx, setSnapshotCalls, getStoredSnapshot: () => storedSnapshot };
}

function makeReadySnapshot(): ReadonlyMap<string, FsCapabilitySnapshot> {
  return new Map([
    [
      "/home/example-user/.openclaw/workspace-acme/",
      {
        status: "ready" as const,
        mode: "ro" as const,
        lastProbeAt: "2026-04-25T20:00:00.000Z",
        lastSuccessAt: "2026-04-25T20:00:00.000Z",
      },
    ],
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 96 Plan 07 — fs-probe heartbeat check (FPC-)", () => {
  beforeEach(() => {
    mockedRunFsProbe.mockReset();
    mockedWriteFsSnapshot.mockReset();
    mockedWriteFsSnapshot.mockResolvedValue(undefined);
  });

  it("FPC-MODULE-SHAPE: exports CheckModule with correct shape", () => {
    expect(fsProbeCheck.name).toBe("fs-probe");
    expect(typeof fsProbeCheck.execute).toBe("function");
    expect(typeof fsProbeCheck.interval).toBe("number");
  });

  it("FPC-INTERVAL-LOCKED: interval === 60 (D-01 60s, same cadence as mcp-reconnect)", () => {
    // D-01 specifies 60s tick cadence — pinned at type-system level.
    expect(fsProbeCheck.interval).toBe(60);
  });

  it("FPC-HAPPY-TICK: completed outcome → writeFsSnapshot + setFsCapabilitySnapshot called", async () => {
    const snapshot = makeReadySnapshot();
    mockedRunFsProbe.mockResolvedValue({
      kind: "completed",
      snapshot,
      durationMs: 50,
    });

    const { ctx, setSnapshotCalls } = makeStub({
      agentConfig: makeAgentConfig(),
    });
    const result: CheckResult = await fsProbeCheck.execute(ctx);

    // runFsProbe invoked exactly once for this agent
    expect(mockedRunFsProbe).toHaveBeenCalledOnce();

    // writeFsSnapshot called with the agent name + snapshot + a path containing
    // fs-capability.json
    expect(mockedWriteFsSnapshot).toHaveBeenCalledOnce();
    const writeArgs = mockedWriteFsSnapshot.mock.calls[0]!;
    expect(writeArgs[0]).toBe("test-agent");
    expect(writeArgs[1]).toBe(snapshot);
    expect(writeArgs[2]).toContain("fs-capability.json");

    // SessionHandle.setFsCapabilitySnapshot called with the new snapshot.
    // Stub defensive-copies (mirroring production setFsCapabilitySnapshot),
    // so use semantic equality instead of identity equality.
    expect(setSnapshotCalls.length).toBe(1);
    expect(setSnapshotCalls[0]).toStrictEqual(snapshot);

    // Heartbeat result reports healthy with ready/degraded/unknown counts
    expect(result.status).toBe("healthy");
    expect(result.message).toMatch(/ready|probed/i);
  });

  it("FPC-AGENT-NOT-RUNNING: no SessionHandle → no probe, returns warning gracefully", async () => {
    const { ctx, setSnapshotCalls } = makeStub({
      agentConfig: makeAgentConfig(),
      handlePresent: false,
    });

    const result: CheckResult = await fsProbeCheck.execute(ctx);

    // No probe spawned, no write, no snapshot mutation
    expect(mockedRunFsProbe).not.toHaveBeenCalled();
    expect(mockedWriteFsSnapshot).not.toHaveBeenCalled();
    expect(setSnapshotCalls.length).toBe(0);

    // Returns warning (informational; not critical — agent simply not running)
    expect(result.status).toBe("warning");
    expect(result.message).toMatch(/not running|no session/i);
  });

  it("FPC-PARALLEL-INDEPENDENCE: runFsProbe rejection doesn't crash the check; returns warning with verbatim error", async () => {
    // Per-agent failure-isolation: the check catches probe rejections so the
    // heartbeat runner can keep going for OTHER agents on the next iteration.
    // Mirrors Phase 85 mcp-reconnect's per-agent try/catch idiom.
    mockedRunFsProbe.mockRejectedValue(new Error("probe primitive crashed"));

    const { ctx, setSnapshotCalls } = makeStub({
      agentConfig: makeAgentConfig(),
    });

    const result: CheckResult = await fsProbeCheck.execute(ctx);

    // Probe was attempted, then rejected — but we did NOT touch persistence
    // or the in-memory snapshot.
    expect(mockedRunFsProbe).toHaveBeenCalledOnce();
    expect(mockedWriteFsSnapshot).not.toHaveBeenCalled();
    expect(setSnapshotCalls.length).toBe(0);

    // Result reports warning with verbatim error
    expect(result.status).toBe("warning");
    expect(result.message).toContain("probe primitive crashed");
  });

  it("FPC-PROBE-FAILED-OUTCOME: outcome.kind='failed' → no persist, no in-memory update", async () => {
    mockedRunFsProbe.mockResolvedValue({
      kind: "failed",
      error: "IPC bridge unreachable",
    });

    const { ctx, setSnapshotCalls } = makeStub({
      agentConfig: makeAgentConfig(),
    });

    const result: CheckResult = await fsProbeCheck.execute(ctx);

    // Probe ran, but discriminated 'failed' outcome — no side-effect.
    expect(mockedRunFsProbe).toHaveBeenCalledOnce();
    expect(mockedWriteFsSnapshot).not.toHaveBeenCalled();
    expect(setSnapshotCalls.length).toBe(0);

    // Result reports warning (graceful no-op; not critical)
    expect(result.status).toBe("warning");
    expect(result.message).toContain("IPC bridge unreachable");
  });

  it("FPC-PREV-SNAPSHOT-THREADED: handle.getFsCapabilitySnapshot result passed as prev arg", async () => {
    const priorSnapshot = makeReadySnapshot();
    mockedRunFsProbe.mockResolvedValue({
      kind: "completed",
      snapshot: priorSnapshot,
      durationMs: 25,
    });

    const { ctx } = makeStub({
      agentConfig: makeAgentConfig(),
      priorSnapshot,
    });

    await fsProbeCheck.execute(ctx);

    // runFsProbe(paths, deps, prevSnapshot) — third arg should be the prior Map.
    // (Map identity preserved: handle returns the same instance from
    //  getFsCapabilitySnapshot; check threads it directly.)
    expect(mockedRunFsProbe).toHaveBeenCalledOnce();
    const runArgs = mockedRunFsProbe.mock.calls[0]!;
    expect(runArgs[2]).toBe(priorSnapshot);
  });
});
