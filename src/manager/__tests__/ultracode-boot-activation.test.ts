/**
 * Quick 260715-j1j review WR-01 + WR-02 — boot activation for a
 * config-default `effort: ultracode` and the runtime-model gate input.
 *
 * WR-01: ultracode cannot be expressed via the SDK session-start `effort`
 * option (D2 clamps it to "high"), so a `clawcode.yaml` default of
 * `effort: ultracode` needs an explicit boot-time `handle.setEffort`
 * activation after warm-path-ready. Pinned here:
 *   - eligible config-default ultracode agent → setEffort("ultracode")
 *     fires at boot; getEffortForAgent reports ultracode;
 *   - INELIGIBLE config-default ultracode (wrong model) → warn-and-degrade,
 *     boot continues, NO ultracode activation;
 *   - non-ultracode config defaults → boot path unchanged (zero setEffort
 *     calls when nothing is persisted).
 *
 * WR-02: the setEffortForAgent gate must check the CURRENT runtime model
 * (an operator may have /clawcode-model-switched since boot), falling back
 * to the config model when the handle has no runtime id.
 *
 * Focused fast file by design (review instruction): NOT inside
 * session-manager.test.ts. Same mock-adapter + warm-path-mock harness as
 * effort-state-store.test.ts, one agent per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { createMockAdapter, type MockSessionAdapter } from "../session-adapter.js";
import { SessionManager } from "../session-manager.js";
import { UltracodeNotAllowedError } from "../model-errors.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig } from "../types.js";

// Warm-path mock — same pattern as session-manager.test.ts /
// effort-state-store.test.ts.
vi.mock("../warm-path-check.js", async () => {
  const actual = await vi.importActual<typeof import("../warm-path-check.js")>(
    "../warm-path-check.js",
  );
  return {
    ...actual,
    runWarmPathCheck: vi.fn(async () => ({
      ready: true,
      durations_ms: { sqlite: 50, embedder: 80, session: 1, browser: 0 },
      total_ms: 131,
      errors: [],
    })),
  };
});

const TEST_BACKOFF: BackoffConfig = {
  baseMs: 100,
  maxMs: 1000,
  maxRetries: 3,
  stableAfterMs: 500,
};

function makeConfig(
  name: string,
  overrides: Partial<ResolvedAgentConfig>,
  workspaceDir: string,
): ResolvedAgentConfig {
  return {
    name,
    workspace: workspaceDir,
    memoryPath: workspaceDir,
    channels: [],
    model: "opus",
    effort: "high",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    autoCompactAt: 0.7,
    memoryAutoLoad: true,
    memoryRetrievalTopK: 5,
    memoryScannerEnabled: true,
    memoryFlushIntervalMs: 900_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false,
    ingestionPriority: "medium" as const,
    settingSources: ["project"],
    autoStart: true,
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
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
    ...overrides,
  } as ResolvedAgentConfig;
}

describe("quick 260715-j1j WR-01/WR-02 — ultracode boot activation + runtime-model gate", () => {
  // Generous budget — these boot a real (mock-adapter) SessionManager with
  // memory init; the box carries concurrent vitest pressure.
  const INTEGRATION_TIMEOUT_MS = 30_000;
  let tmpDir: string;
  let registryPath: string;
  let effortStatePath: string;
  let adapter: MockSessionAdapter;
  let manager: SessionManager;
  /** setEffort(level) calls observed across all handles created this test. */
  let setEffortCalls: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `uc-boot-${nanoid(6)}-`));
    registryPath = join(tmpDir, "registry.json");
    effortStatePath = join(tmpDir, "effort-state.json");
    adapter = createMockAdapter();
    setEffortCalls = [];
    // Wrap createSession to record every setEffort invocation (same probe
    // pattern as the 999.92 test in effort-state-store.test.ts).
    const originalCreate = adapter.createSession.bind(adapter);
    adapter.createSession = (async (
      cfgArg: Parameters<typeof originalCreate>[0],
    ) => {
      const handle = await originalCreate(cfgArg);
      const originalSetEffort = handle.setEffort.bind(handle);
      handle.setEffort = ((level: Parameters<typeof originalSetEffort>[0]) => {
        setEffortCalls.push(level);
        return originalSetEffort(level);
      }) as typeof originalSetEffort;
      return handle;
    }) as typeof originalCreate;
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      effortStatePath,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* best-effort */
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "WR-01: eligible config-default ultracode agent activates at boot (setEffort('ultracode') after warm-path-ready)",
    async () => {
      const name = `uc-a-${nanoid(4)}`;
      const cfg = makeConfig(
        name,
        { model: "opus", effort: "ultracode", nativeWorkflow: true },
        tmpDir,
      );
      await manager.startAgent(name, cfg);
      expect(setEffortCalls).toContain("ultracode");
      expect(manager.getEffortForAgent(name)).toBe("ultracode");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "WR-01: INELIGIBLE config-default ultracode (sonnet model) degrades — boot succeeds, no ultracode activation",
    async () => {
      const name = `uc-b-${nanoid(4)}`;
      // nativeWorkflow paired (D7-valid at load) but the model lacks xhigh
      // capability — only the runtime gate can see that.
      const cfg = makeConfig(
        name,
        { model: "sonnet", effort: "ultracode", nativeWorkflow: true },
        tmpDir,
      );
      await expect(manager.startAgent(name, cfg)).resolves.not.toThrow();
      expect(setEffortCalls).not.toContain("ultracode");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "WR-01: non-ultracode config default is unchanged — zero boot setEffort calls without a persisted override",
    async () => {
      const name = `uc-c-${nanoid(4)}`;
      const cfg = makeConfig(name, { model: "opus", effort: "high" }, tmpDir);
      await manager.startAgent(name, cfg);
      expect(setEffortCalls).toHaveLength(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "WR-02: runtime model switch to sonnet is rejected by the gate even though the CONFIG model is opus",
    async () => {
      const name = `uc-d-${nanoid(4)}`;
      const cfg = makeConfig(
        name,
        { model: "opus", nativeWorkflow: true },
        tmpDir,
      );
      await manager.startAgent(name, cfg);
      // Operator downgrades the RUNNING agent — config model stays "opus".
      manager.setModelForAgent(name, "sonnet");
      expect(() => manager.setEffortForAgent(name, "ultracode")).toThrow(
        UltracodeNotAllowedError,
      );
      expect(() => manager.setEffortForAgent(name, "ultracode")).toThrow(
        /does not support ultracode/,
      );
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "WR-02: without a runtime switch the gate falls back to the config model — eligible agent accepted",
    async () => {
      const name = `uc-e-${nanoid(4)}`;
      const cfg = makeConfig(
        name,
        { model: "opus", effort: "high", nativeWorkflow: true },
        tmpDir,
      );
      await manager.startAgent(name, cfg);
      expect(() => manager.setEffortForAgent(name, "ultracode")).not.toThrow();
      expect(manager.getEffortForAgent(name)).toBe("ultracode");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
