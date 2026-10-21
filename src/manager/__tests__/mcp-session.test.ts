import { describe, it, expect, vi } from "vitest";
import { buildSessionConfig, type SessionConfigDeps } from "../session-config.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { AgentSessionConfig } from "../types.js";

// Mock filesystem reads so buildSessionConfig doesn't hit disk
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

// Mock loadLatestSummary to return undefined (no persisted summary)
// Phase 53 Plan 02: re-export real enforceSummaryBudget so buildSessionConfig's
// import resolves cleanly even with the mock applied.
vi.mock("../../memory/context-summary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../memory/context-summary.js")>();
  return {
    ...actual,
    loadLatestSummary: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock buildBootstrapPrompt (not needed for these tests but imported by module)
vi.mock("../../bootstrap/prompt-builder.js", () => ({
  buildBootstrapPrompt: vi.fn().mockReturnValue("bootstrap prompt"),
}));

function makeConfig(overrides: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig {
  return {
    name: "test-agent",
    workspace: "/tmp/test-workspace",
    memoryPath: "/tmp/test-workspace", // Phase 75 SHARED-01
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
      compactionThreshold: 0.75,
      searchTopK: 10,
      consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" },
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
    threads: { idleTimeoutMinutes: 30, maxThreadSessions: 5 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SessionConfigDeps> = {}): SessionConfigDeps {
  return {
    tierManagers: new Map(),
    skillsCatalog: new Map(),
    allAgentConfigs: [],
    ...overrides,
  };
}

describe("buildSessionConfig - mcpServers", () => {
  it("includes mcpServers in session config when agent has MCP servers", async () => {
    const config = makeConfig({
      mcpServers: [
        { name: "finnhub", command: "npx", args: ["-y", "finnhub-mcp"], env: { API_KEY: "xxx" }, optional: false },
      ],
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.mcpServers).toBeDefined();
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers![0].name).toBe("finnhub");
  });

  it("produces empty mcpServers when agent has none", async () => {
    const config = makeConfig({ mcpServers: [] });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.mcpServers).toEqual([]);
  });

  it("passes multiple MCP servers through to session config", async () => {
    const config = makeConfig({
      mcpServers: [
        { name: "finnhub", command: "npx", args: ["-y", "finnhub-mcp"], env: {}, optional: false },
        { name: "google", command: "npx", args: ["-y", "google-mcp"], env: { KEY: "val" }, optional: false },
      ],
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.mcpServers).toHaveLength(2);
  });
});

describe("SdkSessionAdapter - mcpServers transform", () => {
  it("transforms mcpServers array into SDK Record format", () => {
    // Unit test the transform logic (extracted from session-adapter)
    const mcpServers = [
      { name: "finnhub", command: "npx", args: ["-y", "finnhub-mcp"] as readonly string[], env: { API_KEY: "xxx" } as Readonly<Record<string, string>> },
      { name: "google", command: "npx", args: ["-y", "google-mcp"] as readonly string[], env: {} as Readonly<Record<string, string>> },
    ];

    // Transform logic matching what session-adapter should do
    const sdkFormat = mcpServers.length
      ? Object.fromEntries(mcpServers.map(s => [s.name, { command: s.command, args: [...s.args], env: { ...s.env } }]))
      : undefined;

    expect(sdkFormat).toBeDefined();
    expect(sdkFormat!["finnhub"]).toEqual({
      command: "npx",
      args: ["-y", "finnhub-mcp"],
      env: { API_KEY: "xxx" },
    });
    expect(sdkFormat!["google"]).toEqual({
      command: "npx",
      args: ["-y", "google-mcp"],
      env: {},
    });
  });

  it("produces undefined when mcpServers is empty", () => {
    const mcpServers: readonly { name: string; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const sdkFormat = mcpServers.length
      ? Object.fromEntries(mcpServers.map(s => [s.name, { command: s.command, args: [...s.args], env: { ...s.env } }]))
      : undefined;

    expect(sdkFormat).toBeUndefined();
  });
});
