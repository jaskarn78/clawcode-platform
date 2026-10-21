import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HeartbeatRunner } from "../runner.js";
import type { CheckModule, CheckResult, HeartbeatConfig } from "../types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { ZoneTransition } from "../context-zones.js";

function createMockSessionManager(agents: string[] = ["agent-a"]) {
  return {
    getRunningAgents: vi.fn().mockReturnValue(agents),
    getContextFillProvider: vi.fn().mockReturnValue(undefined),
    getCompactionManager: vi.fn().mockReturnValue(undefined),
    getMemoryStore: vi.fn().mockReturnValue(undefined),
  } as any;
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function createDefaultConfig(overrides?: Partial<HeartbeatConfig>): HeartbeatConfig {
  return {
    enabled: true,
    intervalSeconds: 60,
    checkTimeoutSeconds: 10,
    contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    ...overrides,
  };
}

function createMockCheck(
  name: string,
  result: CheckResult = { status: "healthy", message: "ok" },
  delay = 0,
): CheckModule {
  return {
    name,
    execute: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          if (delay > 0) {
            setTimeout(() => resolve(result), delay);
          } else {
            resolve(result);
          }
        }),
    ),
  };
}

describe("HeartbeatRunner", () => {
  let tempDir: string;
  let checksDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(join(tmpdir(), "heartbeat-runner-"));
    checksDir = join(tempDir, "checks");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("tick executes checks sequentially for each running agent", async () => {
    const sessionManager = createMockSessionManager(["agent-a", "agent-b"]);
    const log = createMockLogger();
    const config = createDefaultConfig();

    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config,
      checksDir,
      log,
    });

    const check1 = createMockCheck("check-1");
    const check2 = createMockCheck("check-2");

    // Inject checks directly (bypass discovery for unit test)
    (runner as any).checks = [check1, check2];

    // Set agent configs for logging
    const agentConfig: ResolvedAgentConfig = {
      name: "agent-a",
      workspace: join(tempDir, "agent-a"),
      memoryPath: join(tempDir, "agent-a"), // Phase 75 SHARED-01
      channels: [],
      model: "sonnet",
      effort: "low",
      allowedModels: ["haiku", "sonnet", "opus"], // Phase 86 MODEL-01
      greetOnRestart: true, // Phase 89 GREET-07
      greetCoolDownMs: 300_000, // Phase 89 GREET-10
      autoCompactAt: 0.7, // Phase 124 D-06
      memoryAutoLoad: true, // Phase 90 MEM-01
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
      skills: [],
      soul: undefined,
      identity: undefined,
      memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 } },
      schedules: [],
      heartbeat: config,
      skillsPath: "/tmp/skills",
      admin: false,
      sandbox: { enabled: false, allowRuntimeOp: false },
      subagentModel: undefined,
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
      reactions: false,
      mcpServers: [],
      slashCommands: [],
    };
    runner.setAgentConfigs([
      agentConfig,
      { ...agentConfig, name: "agent-b", workspace: join(tempDir, "agent-b"), memoryPath: join(tempDir, "agent-b") },
    ]);

    await runner.tick();

    // Both checks executed for both agents
    expect(check1.execute).toHaveBeenCalledTimes(2);
    expect(check2.execute).toHaveBeenCalledTimes(2);
  });

  it("skips checks whose per-check interval has not elapsed", async () => {
    const sessionManager = createMockSessionManager(["agent-a"]);
    const log = createMockLogger();
    const config = createDefaultConfig({ intervalSeconds: 60 });

    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config,
      checksDir,
      log,
    });

    // Check with 120s interval (longer than default 60s)
    const slowCheck: CheckModule = {
      name: "slow-check",
      interval: 120,
      execute: vi.fn().mockResolvedValue({ status: "healthy", message: "ok" }),
    };

    (runner as any).checks = [slowCheck];

    // First tick: should execute (never run before)
    await runner.tick();
    expect(slowCheck.execute).toHaveBeenCalledTimes(1);

    // Advance 60 seconds (less than check's 120s interval)
    vi.advanceTimersByTime(60_000);

    // Second tick: should skip
    await runner.tick();
    expect(slowCheck.execute).toHaveBeenCalledTimes(1);

    // Advance another 60 seconds (total 120s, now due)
    vi.advanceTimersByTime(60_000);

    await runner.tick();
    expect(slowCheck.execute).toHaveBeenCalledTimes(2);
  });

  it("timed-out check produces critical result", async () => {
    const sessionManager = createMockSessionManager(["agent-a"]);
    const log = createMockLogger();
    const config = createDefaultConfig({ checkTimeoutSeconds: 1 });

    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config,
      checksDir,
      log,
    });

    // Check that takes 5 seconds (longer than 1s timeout)
    const slowCheck = createMockCheck(
      "slow-check",
      { status: "healthy", message: "ok" },
      5000,
    );

    (runner as any).checks = [slowCheck];

    const agentConfig: ResolvedAgentConfig = {
      name: "agent-a",
      workspace: join(tempDir, "agent-a"),
      memoryPath: join(tempDir, "agent-a"), // Phase 75 SHARED-01
      channels: [],
      model: "sonnet",
      effort: "low",
      allowedModels: ["haiku", "sonnet", "opus"], // Phase 86 MODEL-01
      greetOnRestart: true, // Phase 89 GREET-07
      greetCoolDownMs: 300_000, // Phase 89 GREET-10
      autoCompactAt: 0.7, // Phase 124 D-06
      memoryAutoLoad: true, // Phase 90 MEM-01
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
      skills: [],
      soul: undefined,
      identity: undefined,
      memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 } },
      schedules: [],
      heartbeat: config,
      skillsPath: "/tmp/skills",
      admin: false,
      sandbox: { enabled: false, allowRuntimeOp: false },
      subagentModel: undefined,
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
      reactions: false,
      mcpServers: [],
      slashCommands: [],
    };
    runner.setAgentConfigs([agentConfig]);

    // Start tick (will race against timeout)
    const tickPromise = runner.tick();

    // Advance past the timeout
    vi.advanceTimersByTime(1100);

    await tickPromise;

    const results = runner.getLatestResults();
    const agentResults = results.get("agent-a");
    expect(agentResults).toBeDefined();

    const checkResult = agentResults!.get("slow-check");
    expect(checkResult).toBeDefined();
    expect(checkResult!.result.status).toBe("critical");
    expect(checkResult!.result.message).toContain("timed out");
  });

  it("start/stop manages interval lifecycle", () => {
    const sessionManager = createMockSessionManager();
    const log = createMockLogger();
    const config = createDefaultConfig();

    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config,
      checksDir,
      log,
    });

    runner.start();
    // Starting again should be a no-op
    runner.start();

    runner.stop();
    // Stopping again should be safe
    runner.stop();
  });

  it("latestResults updated after tick", async () => {
    const sessionManager = createMockSessionManager(["agent-a"]);
    const log = createMockLogger();
    const config = createDefaultConfig();

    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config,
      checksDir,
      log,
    });

    const check = createMockCheck("health", {
      status: "warning",
      message: "getting warm",
    });
    (runner as any).checks = [check];

    await runner.tick();

    const results = runner.getLatestResults();
    expect(results.has("agent-a")).toBe(true);

    const agentResults = results.get("agent-a")!;
    expect(agentResults.has("health")).toBe(true);

    const entry = agentResults.get("health")!;
    expect(entry.result.status).toBe("warning");
    expect(entry.result.message).toBe("getting warm");
    expect(entry.lastChecked).toBeTruthy();
  });

  it("critical results logged via pino warn", async () => {
    const sessionManager = createMockSessionManager(["agent-a"]);
    const log = createMockLogger();
    const config = createDefaultConfig();

    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config,
      checksDir,
      log,
    });

    const criticalCheck = createMockCheck("critical-check", {
      status: "critical",
      message: "bad things",
    });
    (runner as any).checks = [criticalCheck];

    const agentConfig: ResolvedAgentConfig = {
      name: "agent-a",
      workspace: join(tempDir, "agent-a"),
      memoryPath: join(tempDir, "agent-a"), // Phase 75 SHARED-01
      channels: [],
      model: "sonnet",
      effort: "low",
      allowedModels: ["haiku", "sonnet", "opus"], // Phase 86 MODEL-01
      greetOnRestart: true, // Phase 89 GREET-07
      greetCoolDownMs: 300_000, // Phase 89 GREET-10
      autoCompactAt: 0.7, // Phase 124 D-06
      memoryAutoLoad: true, // Phase 90 MEM-01
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
      skills: [],
      soul: undefined,
      identity: undefined,
      memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 } },
      schedules: [],
      heartbeat: config,
      skillsPath: "/tmp/skills",
      admin: false,
      sandbox: { enabled: false, allowRuntimeOp: false },
      subagentModel: undefined,
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
      reactions: false,
      mcpServers: [],
      slashCommands: [],
    };
    runner.setAgentConfigs([agentConfig]);

    await runner.tick();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "agent-a",
        check: "critical-check",
      }),
      "heartbeat check critical",
    );
  });

  it("logs results to NDJSON heartbeat.log in agent workspace", async () => {
    const sessionManager = createMockSessionManager(["agent-a"]);
    const log = createMockLogger();
    const config = createDefaultConfig();

    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config,
      checksDir,
      log,
    });

    const check = createMockCheck("test-check", {
      status: "healthy",
      message: "all good",
    });
    (runner as any).checks = [check];

    const workspace = join(tempDir, "agent-a");
    const agentConfig: ResolvedAgentConfig = {
      name: "agent-a",
      workspace,
      memoryPath: workspace, // Phase 75 SHARED-01
      channels: [],
      model: "sonnet",
      effort: "low",
      allowedModels: ["haiku", "sonnet", "opus"], // Phase 86 MODEL-01
      greetOnRestart: true, // Phase 89 GREET-07
      greetCoolDownMs: 300_000, // Phase 89 GREET-10
      autoCompactAt: 0.7, // Phase 124 D-06
      memoryAutoLoad: true, // Phase 90 MEM-01
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
      skills: [],
      soul: undefined,
      identity: undefined,
      memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 } },
      schedules: [],
      heartbeat: config,
      skillsPath: "/tmp/skills",
      admin: false,
      sandbox: { enabled: false, allowRuntimeOp: false },
      subagentModel: undefined,
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
      reactions: false,
      mcpServers: [],
      slashCommands: [],
    };
    runner.setAgentConfigs([agentConfig]);

    await runner.tick();

    const logPath = join(workspace, "memory", "heartbeat.log");
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.agent).toBe("agent-a");
    expect(entry.check).toBe("test-check");
    expect(entry.status).toBe("healthy");
    expect(entry.message).toBe("all good");
    expect(entry.timestamp).toBeTruthy();
  });

  describe("zone tracking", () => {
    function createAgentConfig(name: string, workspace: string, config: HeartbeatConfig): ResolvedAgentConfig {
      return {
        name,
        workspace,
        memoryPath: workspace, // Phase 75 SHARED-01
        channels: [],
        model: "sonnet",
        effort: "low",
        allowedModels: ["haiku", "sonnet", "opus"], // Phase 86 MODEL-01
        greetOnRestart: true, // Phase 89 GREET-07
        greetCoolDownMs: 300_000, // Phase 89 GREET-10
        autoCompactAt: 0.7, // Phase 124 D-06
      memoryAutoLoad: true, // Phase 90 MEM-01
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
        skills: [],
        soul: undefined,
        identity: undefined,
        memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 } },
        schedules: [],
        heartbeat: config,
        skillsPath: "/tmp/skills",
        admin: false,
        sandbox: { enabled: false, allowRuntimeOp: false },
        subagentModel: undefined,
        threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
        reactions: false,
        mcpServers: [],
        slashCommands: [],
      };
    }

    function createContextFillCheck(fillPercentage: number): CheckModule {
      return {
        name: "context-fill",
        execute: vi.fn().mockResolvedValue({
          status: fillPercentage >= 0.75 ? "critical" : fillPercentage >= 0.6 ? "warning" : "healthy",
          message: `Context fill: ${Math.round(fillPercentage * 100)}%`,
          metadata: { fillPercentage },
        }),
      };
    }

    it("getZoneStatuses returns correct zone after tick with fill metadata", async () => {
      const sessionManager = createMockSessionManager(["agent-a"]);
      const log = createMockLogger();
      const config = createDefaultConfig();

      const runner = new HeartbeatRunner({
        sessionManager,
        registryPath: join(tempDir, "registry.json"),
        config,
        checksDir,
        log,
      });

      const check = createContextFillCheck(0.55);
      (runner as any).checks = [check];
      runner.setAgentConfigs([createAgentConfig("agent-a", join(tempDir, "agent-a"), config)]);

      await runner.tick();

      const zones = runner.getZoneStatuses();
      expect(zones.has("agent-a")).toBe(true);
      expect(zones.get("agent-a")!.zone).toBe("yellow");
      expect(zones.get("agent-a")!.fillPercentage).toBe(0.55);
    });

    it("zone transition triggers pino log.info", async () => {
      const sessionManager = createMockSessionManager(["agent-a"]);
      const log = createMockLogger();
      const config = createDefaultConfig();

      const runner = new HeartbeatRunner({
        sessionManager,
        registryPath: join(tempDir, "registry.json"),
        config,
        checksDir,
        log,
      });

      // First tick at 55% (green -> yellow transition)
      const check = createContextFillCheck(0.55);
      (runner as any).checks = [check];
      runner.setAgentConfigs([createAgentConfig("agent-a", join(tempDir, "agent-a"), config)]);

      await runner.tick();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: "agent-a",
          from: "green",
          to: "yellow",
          fillPercentage: 0.55,
        }),
        "context zone transition",
      );
    });

    it("snapshotCallback called on upward transition to yellow+", async () => {
      const sessionManager = createMockSessionManager(["agent-a"]);
      const log = createMockLogger();
      const config = createDefaultConfig();
      const snapshotCallback = vi.fn().mockResolvedValue(undefined);

      const runner = new HeartbeatRunner({
        sessionManager,
        registryPath: join(tempDir, "registry.json"),
        config,
        checksDir,
        log,
        snapshotCallback,
      });

      const check = createContextFillCheck(0.55);
      (runner as any).checks = [check];
      runner.setAgentConfigs([createAgentConfig("agent-a", join(tempDir, "agent-a"), config)]);

      await runner.tick();

      expect(snapshotCallback).toHaveBeenCalledWith("agent-a", "yellow", 0.55);
    });

    it("notificationCallback called on any zone transition", async () => {
      const sessionManager = createMockSessionManager(["agent-a"]);
      const log = createMockLogger();
      const config = createDefaultConfig();
      const notificationCallback = vi.fn().mockResolvedValue(undefined);

      const runner = new HeartbeatRunner({
        sessionManager,
        registryPath: join(tempDir, "registry.json"),
        config,
        checksDir,
        log,
        notificationCallback,
      });

      const check = createContextFillCheck(0.55);
      (runner as any).checks = [check];
      runner.setAgentConfigs([createAgentConfig("agent-a", join(tempDir, "agent-a"), config)]);

      await runner.tick();

      expect(notificationCallback).toHaveBeenCalledWith(
        "agent-a",
        expect.objectContaining({
          from: "green",
          to: "yellow",
          fillPercentage: 0.55,
        }),
      );
    });

    it("agent cleanup removes zone tracker when agent no longer running", async () => {
      const sessionManager = createMockSessionManager(["agent-a"]);
      const log = createMockLogger();
      const config = createDefaultConfig();

      const runner = new HeartbeatRunner({
        sessionManager,
        registryPath: join(tempDir, "registry.json"),
        config,
        checksDir,
        log,
      });

      const check = createContextFillCheck(0.55);
      (runner as any).checks = [check];
      runner.setAgentConfigs([createAgentConfig("agent-a", join(tempDir, "agent-a"), config)]);

      await runner.tick();

      // agent-a should have a zone tracker
      expect(runner.getZoneStatuses().has("agent-a")).toBe(true);

      // Now agent-a is no longer running
      sessionManager.getRunningAgents.mockReturnValue([]);

      await runner.tick();

      // Zone tracker should be cleaned up
      expect(runner.getZoneStatuses().has("agent-a")).toBe(false);
    });
  });

  describe("inbox timeout override (Phase 999.12 HB-01)", () => {
    function makeAgentConfig(name: string, workspace: string, config: HeartbeatConfig): ResolvedAgentConfig {
      return {
        name,
        workspace,
        memoryPath: workspace,
        channels: [],
        model: "sonnet",
        effort: "low",
        allowedModels: ["haiku", "sonnet", "opus"],
        greetOnRestart: true,
        greetCoolDownMs: 300_000,
        autoCompactAt: 0.7, // Phase 124 D-06
        memoryAutoLoad: true,
        memoryRetrievalTopK: 5,
        memoryScannerEnabled: true,
        memoryFlushIntervalMs: 900_000,
        memoryCueEmoji: "✅",
        autoIngestAttachments: false, // Phase 999.43 D-09
        ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
        settingSources: ["project"],
        autoStart: true,
        skills: [],
        soul: undefined,
        identity: undefined,
        memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 } },
        schedules: [],
        heartbeat: config,
        skillsPath: "/tmp/skills",
        admin: false,
        sandbox: { enabled: false, allowRuntimeOp: false },
        subagentModel: undefined,
        threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
        reactions: false,
        mcpServers: [],
        slashCommands: [],
      };
    }

    it("uses HeartbeatConfig.inboxTimeoutMs for the inbox check when defined", async () => {
      const sessionManager = createMockSessionManager(["agent-a"]);
      const log = createMockLogger();
      const config = createDefaultConfig({
        checkTimeoutSeconds: 1,
        inboxTimeoutMs: 5000,
      });

      const runner = new HeartbeatRunner({
        sessionManager,
        registryPath: join(tempDir, "registry.json"),
        config,
        checksDir,
        log,
      });

      // Fake "inbox" check resolves after 1500ms — exceeds fleet-wide
      // 1000ms timeout (would race-win and produce "timed out") but is
      // comfortably under the 5000ms inbox-specific override. Without
      // HB-01 wiring this test FAILs (status critical / "timed out").
      const inboxFake = createMockCheck(
        "inbox",
        { status: "healthy", message: "ok-inbox" },
        1500,
      );
      (runner as any).checks = [inboxFake];

      const agentConfig = makeAgentConfig("agent-a", join(tempDir, "agent-a"), config);
      runner.setAgentConfigs([agentConfig]);

      const tickPromise = runner.tick();
      // Advance past the 1500ms check resolution but below 5000ms inbox timeout.
      vi.advanceTimersByTime(2000);
      await tickPromise;

      const results = runner.getLatestResults();
      const agentResults = results.get("agent-a");
      expect(agentResults).toBeDefined();

      const inboxResult = agentResults!.get("inbox");
      expect(inboxResult).toBeDefined();
      expect(inboxResult!.result.status).toBe("healthy");
      expect(inboxResult!.result.message).toBe("ok-inbox");
      // It must NOT have timed out.
      expect(inboxResult!.result.message).not.toContain("timed out");
    });

    it("uses checkTimeoutSeconds for non-inbox checks even when inboxTimeoutMs is set", async () => {
      const sessionManager = createMockSessionManager(["agent-a"]);
      const log = createMockLogger();
      const config = createDefaultConfig({
        checkTimeoutSeconds: 1,
        inboxTimeoutMs: 5000,
      });

      const runner = new HeartbeatRunner({
        sessionManager,
        registryPath: join(tempDir, "registry.json"),
        config,
        checksDir,
        log,
      });

      // Non-inbox check that resolves after 3000ms — exceeds 1000ms fleet
      // timeout but is below the inbox-specific 5000ms override.
      const slowCheck = createMockCheck(
        "context-fill",
        { status: "healthy", message: "ok" },
        3000,
      );
      (runner as any).checks = [slowCheck];

      const agentConfig = makeAgentConfig("agent-a", join(tempDir, "agent-a"), config);
      runner.setAgentConfigs([agentConfig]);

      const tickPromise = runner.tick();
      vi.advanceTimersByTime(1100);
      await tickPromise;

      const results = runner.getLatestResults();
      const agentResults = results.get("agent-a");
      const checkResult = agentResults!.get("context-fill");
      expect(checkResult!.result.status).toBe("critical");
      expect(checkResult!.result.message).toContain("timed out");
    });
  });

  describe("initialize() boot log (Phase 999.8 Plan 03 — HB-04)", () => {
    it("emits checkCount + checks array + 'heartbeat checks registered' message", async () => {
      const sessionManager = createMockSessionManager();
      const log = createMockLogger();
      const config = createDefaultConfig();

      const runner = new HeartbeatRunner({
        sessionManager,
        registryPath: join(tempDir, "registry.json"),
        config,
        // Static registry ignores this path — we still pass one for back-compat.
        checksDir: join(tempDir, "checks"),
        log,
      });

      await runner.initialize();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          // Phase 108 — added mcp-broker (POOL-07) brought the count to 12.
          // Phase 99-C — added summarize-pending (drains crashed-session summary backlog) → 13.
          // Phase 999.47 Plan 02 — added homelab-refresh (hourly inventory poller) → 14.
          // 2026-06-18 — added session-log-flush (daily-log materialiser) → 15.
          // P1-RESCAN — added auto-ingest-rescan (periodic inbox rescan) → 16.
          // Phase 999.119 pass 2 — added session-retention → 17.
          // Phase 999.122 — added memory-census → 18.
          checkCount: 18,
          checks: expect.arrayContaining([
            "tier-maintenance",
            "auto-linker",
            "inbox",
            "consolidation",
            "context-fill",
            "fs-probe",
            "homelab-refresh",
            "mcp-broker",
            "mcp-reconnect",
            "summarize-pending",
            "task-retention",
            "thread-idle",
            "trace-retention",
            "attachment-cleanup",
          ]),
        }),
        "heartbeat checks registered",
      );
    });
  });
});
