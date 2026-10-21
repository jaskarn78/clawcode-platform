import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigReloader } from "../config-reloader.js";
import type { ConfigDiff } from "../../config/types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { RoutingTable } from "../../discord/types.js";
import { pino } from "pino";

/**
 * Helper to create a minimal mock ResolvedAgentConfig.
 */
function makeAgent(overrides: Partial<ResolvedAgentConfig> & { name: string }): ResolvedAgentConfig {
  return {
    workspace: `/tmp/agents/${overrides.name}`,
    memoryPath: `/tmp/agents/${overrides.name}`, // Phase 75 SHARED-01
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
    memory: {
      compactionThreshold: 0.8,
      searchTopK: 10,
      consolidation: { enabled: false, weeklyThreshold: 7, monthlyThreshold: 30, schedule: "0 3 * * *" },
      decay: { halfLifeDays: 30, semanticWeight: 0.5, decayWeight: 0.5 },
      deduplication: { enabled: false, similarityThreshold: 0.9 },
    },
    heartbeat: { enabled: true, intervalSeconds: 60, checkTimeoutSeconds: 10, contextFill: { warningThreshold: 0.7, criticalThreshold: 0.9 } },
    skillsPath: "",
    schedules: [],
    admin: false,
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 30, maxThreadSessions: 5 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
    ...overrides,
  };
}

function makeDiff(changes: ConfigDiff["changes"]): ConfigDiff {
  return {
    changes,
    hasReloadableChanges: changes.some((c) => c.reloadable),
    hasNonReloadableChanges: changes.some((c) => !c.reloadable),
  };
}

const log = pino({ level: "silent" });

describe("ConfigReloader", () => {
  const mockSessionManager = {
    setAllAgentConfigs: vi.fn(),
  };
  const mockTaskScheduler = {
    removeAgent: vi.fn(),
    addAgent: vi.fn(),
  };
  const mockHeartbeatRunner = {
    setAgentConfigs: vi.fn(),
  };
  const mockWebhookManager = {
    destroy: vi.fn(),
  };
  const mockSkillsCatalog = new Map() as any;
  const routingTableRef: { current: RoutingTable } = {
    current: { channelToAgent: new Map(), agentToChannels: new Map() },
  };

  let reloader: ConfigReloader;

  beforeEach(() => {
    vi.clearAllMocks();
    routingTableRef.current = { channelToAgent: new Map(), agentToChannels: new Map() };

    reloader = new ConfigReloader({
      sessionManager: mockSessionManager as any,
      taskScheduler: mockTaskScheduler as any,
      heartbeatRunner: mockHeartbeatRunner as any,
      webhookManager: mockWebhookManager as any,
      skillsCatalog: mockSkillsCatalog,
      routingTableRef,
      log,
    });
  });

  it("rebuilds routing table on channel changes", async () => {
    const agents = [makeAgent({ name: "atlas", channels: ["ch-1"] })];
    const diff = makeDiff([
      { fieldPath: "agents.atlas.channels", oldValue: [], newValue: ["ch-1"], reloadable: true },
    ]);

    const summary = await reloader.applyChanges(diff, agents);

    expect(summary.subsystemsReloaded).toContain("routing");
    expect(routingTableRef.current.channelToAgent.get("ch-1")).toBe("atlas");
    expect(mockSessionManager.setAllAgentConfigs).toHaveBeenCalledWith(agents);
  });

  it("updates scheduler on schedule changes", async () => {
    const schedules = [{ name: "daily-review", cron: "0 9 * * *", prompt: "Review", enabled: true }];
    const agents = [makeAgent({ name: "atlas", schedules })];
    const diff = makeDiff([
      { fieldPath: "agents.atlas.schedules", oldValue: [], newValue: schedules, reloadable: true },
    ]);

    const summary = await reloader.applyChanges(diff, agents);

    expect(summary.subsystemsReloaded).toContain("scheduler");
    expect(summary.agentsAffected).toContain("atlas");
    expect(mockTaskScheduler.removeAgent).toHaveBeenCalledWith("atlas");
    expect(mockTaskScheduler.addAgent).toHaveBeenCalledWith("atlas", schedules);
  });

  it("updates heartbeat on heartbeat changes", async () => {
    const agents = [makeAgent({ name: "atlas" })];
    const diff = makeDiff([
      { fieldPath: "agents.atlas.heartbeat.intervalSeconds", oldValue: 60, newValue: 120, reloadable: true },
    ]);

    const summary = await reloader.applyChanges(diff, agents);

    expect(summary.subsystemsReloaded).toContain("heartbeat");
    expect(mockHeartbeatRunner.setAgentConfigs).toHaveBeenCalledWith(agents);
  });

  it("re-links skills on skill changes", async () => {
    const agents = [makeAgent({ name: "atlas", skills: ["research"] })];
    const diff = makeDiff([
      { fieldPath: "agents.atlas.skills", oldValue: [], newValue: ["research"], reloadable: true },
    ]);

    const summary = await reloader.applyChanges(diff, agents);

    expect(summary.subsystemsReloaded).toContain("skills");
    expect(summary.agentsAffected).toContain("atlas");
  });

  it("does not call any subsystem methods when no reloadable changes", async () => {
    const agents = [makeAgent({ name: "atlas" })];
    const diff = makeDiff([
      { fieldPath: "agents.atlas.model", oldValue: "sonnet", newValue: "opus", reloadable: false },
    ]);

    const summary = await reloader.applyChanges(diff, agents);

    expect(summary.subsystemsReloaded).toHaveLength(0);
    expect(mockSessionManager.setAllAgentConfigs).not.toHaveBeenCalled();
    expect(mockTaskScheduler.removeAgent).not.toHaveBeenCalled();
    expect(mockHeartbeatRunner.setAgentConfigs).not.toHaveBeenCalled();
  });

  it("updates multiple subsystems in one diff", async () => {
    const agents = [makeAgent({ name: "atlas", channels: ["ch-2"], skills: ["code-review"] })];
    const diff = makeDiff([
      { fieldPath: "agents.atlas.channels", oldValue: [], newValue: ["ch-2"], reloadable: true },
      { fieldPath: "agents.atlas.skills", oldValue: [], newValue: ["code-review"], reloadable: true },
    ]);

    const summary = await reloader.applyChanges(diff, agents);

    expect(summary.subsystemsReloaded).toContain("routing");
    expect(summary.subsystemsReloaded).toContain("skills");
    expect(summary.agentsAffected).toContain("atlas");
    expect(mockSessionManager.setAllAgentConfigs).toHaveBeenCalledWith(agents);
  });

  it("rebuilds webhook identities on webhook changes", async () => {
    const agents = [makeAgent({ name: "atlas", webhook: { displayName: "Atlas", webhookUrl: "https://example.com/hook" } })];
    const diff = makeDiff([
      { fieldPath: "agents.atlas.webhook.displayName", oldValue: "Old", newValue: "Atlas", reloadable: true },
    ]);

    // WebhookManager needs updateIdentities method - we'll test it's in the summary
    const summary = await reloader.applyChanges(diff, agents);

    expect(summary.subsystemsReloaded).toContain("webhooks");
  });
});
