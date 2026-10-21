import { describe, it, expect } from "vitest";
import { diffConfigs } from "../differ.js";
import type { Config } from "../schema.js";
import { RELOADABLE_FIELDS, NON_RELOADABLE_FIELDS } from "../types.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    defaults: {
      model: "sonnet",
      effort: "low" as const,
      // Phase 96 D-09 — fleet-wide outputDir template; matches DEFAULT_OUTPUT_DIR.
      outputDir: "outputs/{date}/",
      // Phase 86 MODEL-01 — defaults carry the full allowlist so back-compat
      // tests that build a base Config don't produce a spurious diff on
      // the defaults.allowedModels field.
      allowedModels: ["haiku", "sonnet", "opus"],
      // Phase 89 GREET-07/10 — defaults carry the zod-populated values.
      greetOnRestart: true,
      greetCoolDownMs: 300_000,
      // Phase 90 MEM-01 — defaults carry the zod-populated value.
      memoryAutoLoad: true,
      memoryRetrievalTokenBudget: 1500, // Phase 115 sub-scope 3 (was 2000 pre-115)
      memoryRetrievalExcludeTags: ["session-summary", "mid-session", "raw-fallback"], // Phase 115 sub-scope 4
      excludeDynamicSections: true, // Phase 115 sub-scope 2
      cacheBreakpointPlacement: "static-first" as const, // Phase 115 sub-scope 5
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    autonomousSkillDrafting: false, // Phase 132 D-08
    skillDistiller: { minToolCalls: 6, minDurationMs: 180_000, outcomeFilter: ["success"] as ("success" | "partial" | "failed")[], suggestPatches: false }, // Phase 132 D-03 + Phase 999.42 D7 suggestPatches
      // Phase 94 TOOL-10 — defaults carry the fleet-wide directives.
      systemPromptDirectives: {
        "file-sharing": {
          enabled: true,
          text: "When you produce a file the user wants to access, ALWAYS upload via Discord (the channel/thread you're answering in) and return the CDN URL. NEVER just tell the user a local file path they can't reach (e.g., '/home/clawcode/...'). If unsure where to send it, ask which channel.",
        },
        "cross-agent-routing": {
          enabled: true,
          text: "If a user asks you to do something requiring a tool you don't have, check your tool list. If unavailable, suggest the user ask another agent (mention specific channel/agent name) that has the tool ready.",
        },
      },
      // Phase 90 Plan 04 HUB-01/HUB-08 — defaults carry the zod-populated values.
      clawhubBaseUrl: "https://clawhub.ai",
      clawhubCacheTtlMs: 600_000,
      skills: [],
      basePath: "~/.clawcode/agents",
      skillsPath: "~/.clawcode/skills",
      memory: {
        compactionThreshold: 0.75,
        searchTopK: 10,
        consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" },
        decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
        deduplication: { enabled: true, similarityThreshold: 0.85 },
        tiers: { hotAccessThreshold: 3, hotAccessWindowDays: 7, hotDemotionDays: 7, coldRelevanceThreshold: 0.05, hotBudget: 20, centralityPromoteThreshold: 5 },
        episodes: { archivalAgeDays: 90 },
      },
      heartbeat: {
        enabled: true,
        intervalSeconds: 60,
        checkTimeoutSeconds: 10,
        contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75, zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 } },
      },
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
      openai: { enabled: true, port: 3101, host: "0.0.0.0", maxRequestBodyBytes: 1048576, streamKeepaliveMs: 15000 },
      browser: {
        enabled: true,
        headless: true,
        warmOnBoot: true,
        navigationTimeoutMs: 30000,
        actionTimeoutMs: 10000,
        viewport: { width: 1280, height: 720 },
        userAgent: null,
        maxScreenshotInlineBytes: 524288,
      },
      search: {
        enabled: true,
        backend: "brave" as const,
        brave: { apiKeyEnv: "BRAVE_API_KEY", safeSearch: "moderate" as const, country: "us" },
        exa: { apiKeyEnv: "EXA_API_KEY", useAutoprompt: false },
        maxResults: 20,
        timeoutMs: 10000,
        fetch: { timeoutMs: 30000, maxBytes: 1048576, userAgentSuffix: null },
      },
      image: {
        enabled: true,
        backend: "openai" as const,
        openai: { apiKeyEnv: "OPENAI_API_KEY", model: "gpt-image-1" },
        minimax: { apiKeyEnv: "MINIMAX_API_KEY", model: "image-01" },
        fal: { apiKeyEnv: "FAL_API_KEY", model: "fal-ai/flux-pro" },
        maxImageBytes: 10485760,
        timeoutMs: 60000,
        workspaceSubdir: "generated-images",
      },
      // Phase 95 — fleet-wide dream defaults mirror defaultsSchema.
      dream: { enabled: false, idleMinutes: 30, model: "haiku" as const },
      // Phase 96 D-05 — fleet-wide fileAccess defaults.
      fileAccess: ["/home/clawcode/.clawcode/agents/{agent}/"],
      autoStart: true, // Phase 100 follow-up
      // Phase 116-06 T08 — cutover redirect default. FALSE = dual-mode.
      dashboardCutoverRedirect: false,
      "auto-compact-at": 0.7, // Phase 124 D-06
    },
    mcpServers: {},
    agents: [
      {
        name: "researcher",
        channels: ["123"],
        skills: [],
        effort: "low",
        heartbeat: true,
        schedules: [],
        admin: false,
        slashCommands: [],
        reactions: true,
        mcpServers: [],
      },
    ],
    ...overrides,
  };
}

describe("diffConfigs", () => {
  it("returns empty changes for identical configs", () => {
    const config = makeConfig();
    const result = diffConfigs(config, config);
    expect(result.changes).toEqual([]);
    expect(result.hasReloadableChanges).toBe(false);
    expect(result.hasNonReloadableChanges).toBe(false);
  });

  it("detects channel change as reloadable", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      agents: [
        { ...oldConfig.agents[0], channels: ["123", "456"] },
      ],
    });
    const result = diffConfigs(oldConfig, newConfig);
    expect(result.changes.length).toBeGreaterThan(0);
    const channelChange = result.changes.find((c) =>
      c.fieldPath.includes("channels"),
    );
    expect(channelChange).toBeDefined();
    expect(channelChange!.reloadable).toBe(true);
    expect(result.hasReloadableChanges).toBe(true);
  });

  it("claudeAiConnectors (agent + defaults) is restart-required", () => {
    const oldConfig = makeConfig();
    const agentFlip = diffConfigs(
      oldConfig,
      makeConfig({ agents: [{ ...oldConfig.agents[0], claudeAiConnectors: true }] }),
    );
    const agentChange = agentFlip.changes.find((c) => c.fieldPath.endsWith("claudeAiConnectors"));
    expect(agentChange).toBeDefined();
    expect(agentChange!.reloadable).toBe(false);

    const defaultsFlip = diffConfigs(
      oldConfig,
      makeConfig({ defaults: { ...oldConfig.defaults, claudeAiConnectors: { allowedOwners: ["owner_a"] } } }),
    );
    const defaultsChange = defaultsFlip.changes.find((c) => c.fieldPath.startsWith("defaults.claudeAiConnectors"));
    expect(defaultsChange).toBeDefined();
    expect(defaultsChange!.reloadable).toBe(false);
  });

  it("detects model change as non-reloadable", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      agents: [
        { ...oldConfig.agents[0], model: "opus" },
      ],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const modelChange = result.changes.find((c) =>
      c.fieldPath.includes("model"),
    );
    expect(modelChange).toBeDefined();
    expect(modelChange!.reloadable).toBe(false);
    expect(result.hasNonReloadableChanges).toBe(true);
  });

  // Phase 142 follow-up — optimizer config is restart-required (NON_RELOADABLE).
  // Locks the classification: the `/clawcode-optimize` trigger reads the
  // boot-time `resolvedAgents` const, so a hot edit is a no-op. A future
  // "make it reloadable" edit must fail RED here.
  it("detects agents.*.optimizer change as non-reloadable", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      agents: [
        {
          ...oldConfig.agents[0],
          optimizer: {
            enabled: true,
            evalSet: "optimizer/eval-set.yaml",
            model: "opus" as const,
            maxActionsPerRun: 3,
            samplesPerTask: 3,
            minImprovementMargin: 0.1,
            eligibleSkills: ["*"],
            evalMcpServers: [],
            cadence: "manual",
          },
        },
      ],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const optChange = result.changes.find((c) =>
      c.fieldPath.includes("optimizer"),
    );
    expect(optChange).toBeDefined();
    expect(optChange!.reloadable).toBe(false);
    expect(result.hasNonReloadableChanges).toBe(true);
  });

  it("detects agent added", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      agents: [
        ...oldConfig.agents,
        {
          name: "coder",
          channels: ["789"],
          skills: [],
          effort: "low",
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
          mcpServers: [],
        },
      ],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const addedChange = result.changes.find((c) =>
      c.fieldPath.includes("coder") && c.oldValue === undefined,
    );
    expect(addedChange).toBeDefined();
  });

  it("detects agent removed", () => {
    const oldConfig = makeConfig({
      agents: [
        {
          name: "researcher",
          channels: ["123"],
          skills: [],
          effort: "low",
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
          mcpServers: [],
        },
        {
          name: "coder",
          channels: ["789"],
          skills: [],
          effort: "low",
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
          mcpServers: [],
        },
      ],
    });
    const newConfig = makeConfig({
      agents: [
        {
          name: "researcher",
          channels: ["123"],
          skills: [],
          effort: "low",
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
          mcpServers: [],
        },
      ],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const removedChange = result.changes.find((c) =>
      c.fieldPath.includes("coder") && c.newValue === undefined,
    );
    expect(removedChange).toBeDefined();
  });

  it("detects schedule change as reloadable", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      agents: [
        {
          ...oldConfig.agents[0],
          schedules: [{ name: "daily", cron: "0 9 * * *", prompt: "report", enabled: true }],
        },
      ],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const scheduleChange = result.changes.find((c) =>
      c.fieldPath.includes("schedules"),
    );
    expect(scheduleChange).toBeDefined();
    expect(scheduleChange!.reloadable).toBe(true);
  });

  it("detects multiple changes at once", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      defaults: { ...oldConfig.defaults, model: "opus" },
      agents: [
        { ...oldConfig.agents[0], channels: ["123", "456"] },
      ],
    });
    const result = diffConfigs(oldConfig, newConfig);
    expect(result.changes.length).toBeGreaterThanOrEqual(2);
    expect(result.hasReloadableChanges).toBe(true);
    expect(result.hasNonReloadableChanges).toBe(true);
  });

  it("detects defaults.heartbeat change as reloadable", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      defaults: {
        ...oldConfig.defaults,
        heartbeat: { ...oldConfig.defaults.heartbeat, intervalSeconds: 120 },
      },
    });
    const result = diffConfigs(oldConfig, newConfig);
    const hbChange = result.changes.find((c) =>
      c.fieldPath.includes("defaults.heartbeat"),
    );
    expect(hbChange).toBeDefined();
    expect(hbChange!.reloadable).toBe(true);
  });

  it("detects defaults.basePath change as non-reloadable", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      defaults: { ...oldConfig.defaults, basePath: "/new/path" },
    });
    const result = diffConfigs(oldConfig, newConfig);
    const pathChange = result.changes.find((c) =>
      c.fieldPath.includes("defaults.basePath"),
    );
    expect(pathChange).toBeDefined();
    expect(pathChange!.reloadable).toBe(false);
  });

  // Phase 83 EFFORT-01 — effort is reloadable because setEffort() invokes
  // q.setMaxThinkingTokens on the live handle; no restart required.
  it("detects agents.*.effort change as reloadable", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      agents: [
        { ...oldConfig.agents[0], effort: "high" as const },
      ],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const effortChange = result.changes.find((c) =>
      c.fieldPath === "agents.researcher.effort",
    );
    expect(effortChange).toBeDefined();
    expect(effortChange!.oldValue).toBe("low");
    expect(effortChange!.newValue).toBe("high");
    expect(effortChange!.reloadable).toBe(true);
    expect(result.hasReloadableChanges).toBe(true);
  });

  it("detects defaults.effort change as reloadable", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      defaults: { ...oldConfig.defaults, effort: "medium" as const },
    });
    const result = diffConfigs(oldConfig, newConfig);
    const effortChange = result.changes.find((c) =>
      c.fieldPath === "defaults.effort",
    );
    expect(effortChange).toBeDefined();
    expect(effortChange!.reloadable).toBe(true);
  });

  // Phase 86 MODEL-01 — allowedModels is reloadable because the Discord
  // picker re-reads on every invocation; no session restart needed.
  // Runtime model SWITCHES stay non-reloadable (see agents.*.model below).
  it("detects agents.*.allowedModels change as reloadable", () => {
    const baseAgent = makeConfig().agents[0];
    const oldConfig = makeConfig({
      agents: [{ ...baseAgent, allowedModels: ["haiku"] } as typeof baseAgent],
    });
    const newConfig = makeConfig({
      agents: [
        {
          ...baseAgent,
          allowedModels: ["haiku", "sonnet"],
        } as typeof baseAgent,
      ],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const change = result.changes.find((c) =>
      c.fieldPath.includes("allowedModels"),
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(true);
    expect(result.hasReloadableChanges).toBe(true);
  });

  it("detects defaults.allowedModels change as reloadable", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      defaults: {
        ...oldConfig.defaults,
        allowedModels: ["haiku"],
      } as typeof oldConfig.defaults,
    });
    const result = diffConfigs(oldConfig, newConfig);
    const change = result.changes.find((c) =>
      c.fieldPath === "defaults.allowedModels",
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(true);
  });

  it("keeps agents.*.model classified as non-reloadable (no regression from allowedModels)", () => {
    // Regression pin: adding allowedModels must NOT reclassify `model` as
    // reloadable — runtime model switches use SessionHandle.setModel, not
    // the hot-reload path.
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      agents: [
        { ...oldConfig.agents[0], model: "opus" as const },
      ],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const modelChange = result.changes.find((c) =>
      c.fieldPath === "agents.researcher.model",
    );
    expect(modelChange).toBeDefined();
    expect(modelChange!.reloadable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 110 Stage 0a — shimRuntime + brokers reloadable
// ---------------------------------------------------------------------------

describe("diffConfigs - Phase 110 Stage 0a reloadable additions", () => {
  it("classifies a defaults.shimRuntime.search edit as reloadable", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      defaults: {
        ...oldConfig.defaults,
        // Cast through unknown — the Config type forbids the field today
        // but the differ classifies via fieldPath, not type. Stage 0b
        // widens the enum and the cast goes away.
        shimRuntime: { search: "node", image: "node", browser: "node" },
      } as unknown as Config["defaults"],
    });
    // Force a perceived change by making the new object have a populated
    // shimRuntime where the old one had undefined.
    const result = diffConfigs(oldConfig, newConfig);
    const change = result.changes.find((c) =>
      c.fieldPath.startsWith("defaults.shimRuntime"),
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(true);
  });

  it("classifies a defaults.brokers.<name>.enabled edit as reloadable", () => {
    const oldConfig = makeConfig({
      defaults: {
        ...makeConfig().defaults,
        brokers: { "1password": { enabled: true } },
      } as unknown as Config["defaults"],
    });
    const newConfig = makeConfig({
      defaults: {
        ...oldConfig.defaults,
        brokers: { "1password": { enabled: false } },
      } as unknown as Config["defaults"],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const change = result.changes.find((c) =>
      c.fieldPath.startsWith("defaults.brokers"),
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.X — defaults.subagentReaper reloadable
// ---------------------------------------------------------------------------

describe("diffConfigs - subagentReaper reloadable", () => {
  it("classifies a defaults.subagentReaper.mode edit as reloadable", () => {
    const oldConfig = makeConfig({
      defaults: {
        ...makeConfig().defaults,
        subagentReaper: {
          mode: "alert",
          idleTimeoutMinutes: 1440,
          minAgeSeconds: 300,
        },
      } as unknown as Config["defaults"],
    });
    const newConfig = makeConfig({
      defaults: {
        ...oldConfig.defaults,
        subagentReaper: {
          mode: "reap",
          idleTimeoutMinutes: 1440,
          minAgeSeconds: 300,
        },
      } as unknown as Config["defaults"],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const change = result.changes.find((c) =>
      c.fieldPath.startsWith("defaults.subagentReaper"),
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(true);
  });

  it("classifies idleTimeoutMinutes + minAgeSeconds edits as reloadable too", () => {
    const oldConfig = makeConfig({
      defaults: {
        ...makeConfig().defaults,
        subagentReaper: {
          mode: "reap",
          idleTimeoutMinutes: 1440,
          minAgeSeconds: 300,
        },
      } as unknown as Config["defaults"],
    });
    const newConfig = makeConfig({
      defaults: {
        ...oldConfig.defaults,
        subagentReaper: {
          mode: "reap",
          idleTimeoutMinutes: 60,
          minAgeSeconds: 30,
        },
      } as unknown as Config["defaults"],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const changes = result.changes.filter((c) =>
      c.fieldPath.startsWith("defaults.subagentReaper"),
    );
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) expect(c.reloadable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.25 — defaults.subagentCompletion reloadable
// ---------------------------------------------------------------------------

describe("diffConfigs - subagentCompletion reloadable", () => {
  it("classifies a defaults.subagentCompletion.enabled edit as reloadable", () => {
    const oldConfig = makeConfig({
      defaults: {
        ...makeConfig().defaults,
        subagentCompletion: { enabled: true, quiescenceMinutes: 5 },
      } as unknown as Config["defaults"],
    });
    const newConfig = makeConfig({
      defaults: {
        ...oldConfig.defaults,
        subagentCompletion: { enabled: false, quiescenceMinutes: 5 },
      } as unknown as Config["defaults"],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const change = result.changes.find((c) =>
      c.fieldPath.startsWith("defaults.subagentCompletion"),
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(true);
  });

  it("classifies a quiescenceMinutes edit as reloadable", () => {
    const oldConfig = makeConfig({
      defaults: {
        ...makeConfig().defaults,
        subagentCompletion: { enabled: true, quiescenceMinutes: 5 },
      } as unknown as Config["defaults"],
    });
    const newConfig = makeConfig({
      defaults: {
        ...oldConfig.defaults,
        subagentCompletion: { enabled: true, quiescenceMinutes: 10 },
      } as unknown as Config["defaults"],
    });
    const result = diffConfigs(oldConfig, newConfig);
    const change = result.changes.find((c) =>
      c.fieldPath.startsWith("defaults.subagentCompletion"),
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 75 Plan 01 — SHARED-01: memoryPath classified as non-reloadable
// ---------------------------------------------------------------------------

describe("diffConfigs - memoryPath non-reloadable", () => {
  it("marks a changed memoryPath as non-reloadable (swapping memoryPath requires daemon restart)", () => {
    const oldCfg = makeConfig({
      agents: [
        {
          name: "fin-client",
          channels: [],
          skills: [],
          effort: "low",
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
          mcpServers: [],
          memoryPath: "~/shared/acme/fin-client",
        },
      ],
    });
    const newCfg = makeConfig({
      agents: [
        { ...oldCfg.agents[0], memoryPath: "~/shared/acme/fin-research" },
      ],
    });
    const diff = diffConfigs(oldCfg, newCfg);
    const change = diff.changes.find(
      (c) => c.fieldPath === "agents.fin-client.memoryPath",
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(false);
    expect(diff.hasNonReloadableChanges).toBe(true);
  });

  it("produces no diff entry when memoryPath is identical on both sides", () => {
    const agent = {
      name: "fin-client",
      channels: [],
      skills: [],
      effort: "low" as const,
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
      memoryPath: "~/shared/acme/fin-client",
    };
    const oldCfg = makeConfig({ agents: [agent] });
    const newCfg = makeConfig({ agents: [{ ...agent }] });
    const diff = diffConfigs(oldCfg, newCfg);
    const change = diff.changes.find((c) => c.fieldPath.includes("memoryPath"));
    expect(change).toBeUndefined();
  });

  it("marks adding memoryPath (undefined -> defined) as non-reloadable", () => {
    const agent = {
      name: "fin-client",
      channels: [],
      skills: [],
      effort: "low" as const,
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };
    const oldCfg = makeConfig({ agents: [agent] });
    const newCfg = makeConfig({
      agents: [{ ...agent, memoryPath: "~/shared/acme/fin-client" }],
    });
    const diff = diffConfigs(oldCfg, newCfg);
    const change = diff.changes.find(
      (c) => c.fieldPath === "agents.fin-client.memoryPath",
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(false);
  });

  it("marks removing memoryPath (defined -> undefined) as non-reloadable", () => {
    const agentWithMemoryPath = {
      name: "fin-client",
      channels: [],
      skills: [],
      effort: "low" as const,
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
      memoryPath: "~/shared/acme/fin-client",
    };
    const agentWithoutMemoryPath = {
      name: "fin-client",
      channels: [],
      skills: [],
      effort: "low" as const,
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };
    const oldCfg = makeConfig({ agents: [agentWithMemoryPath] });
    const newCfg = makeConfig({ agents: [agentWithoutMemoryPath] });
    const diff = diffConfigs(oldCfg, newCfg);
    const change = diff.changes.find(
      (c) => c.fieldPath === "agents.fin-client.memoryPath",
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(false);
  });

  it("hasNonReloadableChanges is true when only a memoryPath change is present", () => {
    const agent = {
      name: "fin-client",
      channels: [],
      skills: [],
      effort: "low" as const,
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
      memoryPath: "~/shared/acme/fin-client",
    };
    const oldCfg = makeConfig({ agents: [agent] });
    const newCfg = makeConfig({
      agents: [{ ...agent, memoryPath: "~/shared/acme/fin-research" }],
    });
    const diff = diffConfigs(oldCfg, newCfg);
    expect(diff.hasNonReloadableChanges).toBe(true);
    // Should NOT also set hasReloadableChanges (memoryPath-only diff).
    expect(diff.hasReloadableChanges).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 100 GSD-07 — settingSources + gsd.projectDir agent-restart classification
// ---------------------------------------------------------------------------
//
// The differ classifies field paths as RELOADABLE (live-mutable) or
// NON-RELOADABLE (agent-restart-required). Phase 100's settingSources +
// gsd.projectDir fields are SDK session-boot baseOptions (captured at
// `sdk.query` start, NOT re-read per turn — see RESEARCH.md Architecture
// Pattern 5 + Plan 100-02 session-adapter wiring at lines 588/592/627/631).
// They MUST classify as NON_RELOADABLE so the watcher emits an
// "agent restart needed" notification rather than silently failing.
//
// 1st application of an agent-restart classification in Phase 100 (vs. the
// 11 prior reloadable classifications in Phases 83/86/89/90/94/95/96).
// Mirrors the v2.5 memoryPath documentation-of-intent pattern at
// types.ts:138-154.

describe("Phase 100 — settingSources + gsd.projectDir agent-restart classification", () => {
  // Helper to build a minimal agent block with the Phase 100 fields available
  // for inline override. Mirrors the existing inline-fixture pattern from
  // earlier tests in this file.
  function makeAgent(
    overrides: {
      readonly name?: string;
      readonly settingSources?: readonly ("project" | "user" | "local")[];
      readonly gsd?: { readonly projectDir?: string };
      readonly effort?: "low" | "medium" | "high";
    } = {},
  ): Record<string, unknown> {
    const agent: Record<string, unknown> = {
      name: overrides.name ?? "admin-clawdy",
      channels: ["999"],
      skills: [],
      effort: overrides.effort ?? "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };
    if (overrides.settingSources !== undefined) {
      agent["settingSources"] = overrides.settingSources;
    }
    if (overrides.gsd !== undefined) {
      agent["gsd"] = overrides.gsd;
    }
    return agent;
  }

  // ---------------------------------------------------------------------
  // DI1 — settingSources change ['project'] → ['project','user']
  // ---------------------------------------------------------------------
  it("DI1 — classifies agent settingSources change as NON-reloadable", () => {
    const oldConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [makeAgent({ settingSources: ["project"] }) as any],
    });
    const newConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [makeAgent({ settingSources: ["project", "user"] }) as any],
    });
    const diff = diffConfigs(oldConfig, newConfig);
    const change = diff.changes.find(
      (c) => c.fieldPath === "agents.admin-clawdy.settingSources",
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(false);
    expect(diff.hasReloadableChanges).toBe(false);
    expect(diff.hasNonReloadableChanges).toBe(true);
  });

  // ---------------------------------------------------------------------
  // DI2 — gsd.projectDir change '/a' → '/b'
  // ---------------------------------------------------------------------
  it("DI2 — classifies agents.X.gsd.projectDir change as NON-reloadable", () => {
    const oldConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [makeAgent({ gsd: { projectDir: "/opt/a" } }) as any],
    });
    const newConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [makeAgent({ gsd: { projectDir: "/opt/b" } }) as any],
    });
    const diff = diffConfigs(oldConfig, newConfig);
    const change = diff.changes.find(
      (c) => c.fieldPath === "agents.admin-clawdy.gsd.projectDir",
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(false);
    expect(change!.oldValue).toBe("/opt/a");
    expect(change!.newValue).toBe("/opt/b");
    expect(diff.hasNonReloadableChanges).toBe(true);
  });

  // ---------------------------------------------------------------------
  // DI3 — gsd block added (undefined → { projectDir: '/x' })
  // The diff path may be 'agents.X.gsd' OR 'agents.X.gsd.projectDir'
  // depending on how diffObject recurses. Either way reloadable=false.
  // ---------------------------------------------------------------------
  it("DI3 — classifies adding gsd block as NON-reloadable (whole-block OR leaf-level)", () => {
    const oldConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [makeAgent({}) as any],
    });
    const newConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [makeAgent({ gsd: { projectDir: "/opt/x" } }) as any],
    });
    const diff = diffConfigs(oldConfig, newConfig);
    const gsdChange = diff.changes.find(
      (c) =>
        c.fieldPath === "agents.admin-clawdy.gsd" ||
        c.fieldPath === "agents.admin-clawdy.gsd.projectDir",
    );
    expect(gsdChange).toBeDefined();
    expect(gsdChange!.reloadable).toBe(false);
    expect(diff.hasNonReloadableChanges).toBe(true);
  });

  // ---------------------------------------------------------------------
  // DI4 — gsd block removed (inverse of DI3)
  // ---------------------------------------------------------------------
  it("DI4 — classifies removing gsd block as NON-reloadable (inverse of DI3)", () => {
    const oldConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [makeAgent({ gsd: { projectDir: "/opt/x" } }) as any],
    });
    const newConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [makeAgent({}) as any],
    });
    const diff = diffConfigs(oldConfig, newConfig);
    const gsdChange = diff.changes.find(
      (c) =>
        c.fieldPath === "agents.admin-clawdy.gsd" ||
        c.fieldPath === "agents.admin-clawdy.gsd.projectDir",
    );
    expect(gsdChange).toBeDefined();
    expect(gsdChange!.reloadable).toBe(false);
    expect(diff.hasNonReloadableChanges).toBe(true);
  });

  // ---------------------------------------------------------------------
  // DI5 — settingSources unchanged + gsd unchanged → 0 changes (no false-positive)
  // ---------------------------------------------------------------------
  it("DI5 — no diff entry when settingSources + gsd are identical (no false-positive)", () => {
    const agent = makeAgent({
      settingSources: ["project", "user"],
      gsd: { projectDir: "/opt/sandbox" },
    });
    const oldConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [agent as any],
    });
    const newConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [{ ...agent } as any],
    });
    const diff = diffConfigs(oldConfig, newConfig);
    const ssChange = diff.changes.find((c) =>
      c.fieldPath.includes("settingSources"),
    );
    const gsdChange = diff.changes.find((c) => c.fieldPath.includes("gsd"));
    expect(ssChange).toBeUndefined();
    expect(gsdChange).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // DI6 — settingSources order change ['project','user'] → ['user','project']
  // isDeepEqual respects array order (differ.ts:178-181 — element-wise compare),
  // so reordering produces a change. Still NON-reloadable.
  // ---------------------------------------------------------------------
  it("DI6 — classifies settingSources order change as NON-reloadable", () => {
    const oldConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [makeAgent({ settingSources: ["project", "user"] }) as any],
    });
    const newConfig = makeConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agents: [makeAgent({ settingSources: ["user", "project"] }) as any],
    });
    const diff = diffConfigs(oldConfig, newConfig);
    const change = diff.changes.find(
      (c) => c.fieldPath === "agents.admin-clawdy.settingSources",
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(false);
  });

  // ---------------------------------------------------------------------
  // DI7 — multi-field-mix: settingSources change AND a reloadable field
  // (effort) change in the same diff. Both flags asserted true.
  // ---------------------------------------------------------------------
  it("DI7 — multi-field-mix surfaces BOTH reloadable + non-reloadable flags", () => {
    const oldConfig = makeConfig({
      agents: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeAgent({ settingSources: ["project"], effort: "low" }) as any,
      ],
    });
    const newConfig = makeConfig({
      agents: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeAgent({ settingSources: ["project", "user"], effort: "high" }) as any,
      ],
    });
    const diff = diffConfigs(oldConfig, newConfig);
    const ssChange = diff.changes.find(
      (c) => c.fieldPath === "agents.admin-clawdy.settingSources",
    );
    const effortChange = diff.changes.find(
      (c) => c.fieldPath === "agents.admin-clawdy.effort",
    );
    expect(ssChange).toBeDefined();
    expect(ssChange!.reloadable).toBe(false);
    expect(effortChange).toBeDefined();
    expect(effortChange!.reloadable).toBe(true);
    expect(diff.hasReloadableChanges).toBe(true);
    expect(diff.hasNonReloadableChanges).toBe(true);
  });

  // ---------------------------------------------------------------------
  // DI8 — Regression pin: NON_RELOADABLE_FIELDS contains the explicit entries
  // for documentation-of-intent. The classifier in differ.ts:144-149 already
  // falls through to false for unclassified paths, so the explicit listing is
  // documentation (matching the v2.5 SHARED-01 memoryPath pattern). This test
  // pins against accidental promotion to RELOADABLE_FIELDS in a future edit.
  // ---------------------------------------------------------------------
  it("DI8 — settingSources + gsd are explicitly listed in NON_RELOADABLE_FIELDS for documentation-of-intent", () => {
    expect(NON_RELOADABLE_FIELDS.has("agents.*.settingSources")).toBe(true);
    expect(NON_RELOADABLE_FIELDS.has("agents.*.gsd")).toBe(true);
    // Regression pin: must NOT have been accidentally promoted to RELOADABLE.
    expect(RELOADABLE_FIELDS.has("agents.*.settingSources")).toBe(false);
    expect(RELOADABLE_FIELDS.has("agents.*.gsd")).toBe(false);
    expect(RELOADABLE_FIELDS.has("agents.*.gsd.projectDir")).toBe(false);
    expect(RELOADABLE_FIELDS.has("defaults.settingSources")).toBe(false);
    expect(RELOADABLE_FIELDS.has("defaults.gsd")).toBe(false);
    expect(RELOADABLE_FIELDS.has("defaults.gsd.projectDir")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.54 D-04 — mcpServers.alwaysLoad NON-reloadable classification.
//
// Architectural rationale: Claude Agent SDK reads `alwaysLoad` ONCE during
// session creation (sdk.d.ts:1067-1076). Toggling it at runtime cannot
// retroactively load or unload tools into an existing agent session — the
// change takes effect ONLY on agent restart.
//
// Plan 03 added two doc-of-intent entries to NON_RELOADABLE_FIELDS:
//   - "defaults.mcpServers.*.alwaysLoad"
//   - "agents.*.mcpServers.*.alwaysLoad"
//
// Empirical note (worked out during executor orientation, recorded in
// SUMMARY deviations): the differ's `diffConfigs` does NOT examine the
// top-level shared `mcpServers` Record (it only walks `defaults` and
// `agents` — see src/config/differ.ts:23-30). It also does NOT recurse
// into arrays (isPlainObject excludes them at diffObject), so an array
// element-level leaf path like `agents.<name>.mcpServers.0.alwaysLoad`
// is unreachable too. Both of Plan 03's NON_RELOADABLE_FIELDS entries
// are therefore PURE doc-of-intent — same status as the v2.5 SHARED-01
// memoryPath entries and the DI8 settingSources/gsd entries above.
//
// Following the precedent of the DI8 test immediately above (lines
// 929-939), we pin both paths via NON_RELOADABLE_FIELDS.has(...) set
// membership. Two it() cases — one per yaml path shape — mirror the
// CONTEXT.md D-04 split.
// ---------------------------------------------------------------------------
describe("diffConfigs - Phase 999.54 D-04 mcpServers.alwaysLoad NON-reloadable", () => {
  it("classifies defaults.mcpServers.<name>.alwaysLoad as non-reloadable (NON_RELOADABLE_FIELDS doc-of-intent pin)", () => {
    expect(
      NON_RELOADABLE_FIELDS.has("defaults.mcpServers.*.alwaysLoad"),
    ).toBe(true);
    // Regression pin: must NOT have been accidentally promoted to RELOADABLE.
    expect(
      RELOADABLE_FIELDS.has("defaults.mcpServers.*.alwaysLoad"),
    ).toBe(false);
  });

  it("classifies agents.<name>.mcpServers.<idx>.alwaysLoad as non-reloadable (NON_RELOADABLE_FIELDS doc-of-intent pin)", () => {
    expect(
      NON_RELOADABLE_FIELDS.has("agents.*.mcpServers.*.alwaysLoad"),
    ).toBe(true);
    // Regression pin: must NOT have been accidentally promoted to RELOADABLE.
    expect(
      RELOADABLE_FIELDS.has("agents.*.mcpServers.*.alwaysLoad"),
    ).toBe(false);
  });
});
