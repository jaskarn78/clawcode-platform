import { describe, it, expect } from "vitest";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import {
  buildRoutingTable,
  getAgentForChannel,
  getChannelsForAgent,
} from "../router.js";

/**
 * Helper to build a minimal ResolvedAgentConfig for testing.
 */
function makeAgent(
  name: string,
  channels: string[] = [],
): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/agents/${name}`,
    memoryPath: `/tmp/agents/${name}`, // Phase 75 SHARED-01
    channels,
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
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: {
        warningThreshold: 0.6,
        criticalThreshold: 0.75,
      },
    },
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

describe("buildRoutingTable", () => {
  it("maps 2 agents with 1 channel each to correct channelToAgent and agentToChannels", () => {
    const configs = [
      makeAgent("alice", ["ch-1"]),
      makeAgent("bob", ["ch-2"]),
    ];
    const table = buildRoutingTable(configs);

    expect(table.channelToAgent.get("ch-1")).toBe("alice");
    expect(table.channelToAgent.get("ch-2")).toBe("bob");
    expect(table.agentToChannels.get("alice")).toEqual(["ch-1"]);
    expect(table.agentToChannels.get("bob")).toEqual(["ch-2"]);
  });

  it("maps 1 agent with 3 channels to all 3 channel IDs (D-08)", () => {
    const configs = [makeAgent("multi", ["ch-a", "ch-b", "ch-c"])];
    const table = buildRoutingTable(configs);

    expect(table.channelToAgent.get("ch-a")).toBe("multi");
    expect(table.channelToAgent.get("ch-b")).toBe("multi");
    expect(table.channelToAgent.get("ch-c")).toBe("multi");
    expect(table.agentToChannels.get("multi")).toEqual(["ch-a", "ch-b", "ch-c"]);
  });

  it("throws when two agents share the same channel ID (Pitfall 1)", () => {
    const configs = [
      makeAgent("alice", ["ch-1"]),
      makeAgent("bob", ["ch-1"]),
    ];

    expect(() => buildRoutingTable(configs)).toThrow(/duplicate/i);
  });

  it("excludes agent with empty channels from agentToChannels without error (Pitfall 4)", () => {
    const configs = [
      makeAgent("active", ["ch-1"]),
      makeAgent("idle", []),
    ];
    const table = buildRoutingTable(configs);

    expect(table.channelToAgent.get("ch-1")).toBe("active");
    expect(table.agentToChannels.has("idle")).toBe(false);
    expect(table.agentToChannels.get("active")).toEqual(["ch-1"]);
  });

  it("returns empty maps for empty configs array", () => {
    const table = buildRoutingTable([]);

    expect(table.channelToAgent.size).toBe(0);
    expect(table.agentToChannels.size).toBe(0);
  });
});

describe("getAgentForChannel", () => {
  it("returns agent name for bound channel, undefined for unbound (D-07)", () => {
    const table = buildRoutingTable([makeAgent("alice", ["ch-1"])]);

    expect(getAgentForChannel(table, "ch-1")).toBe("alice");
    expect(getAgentForChannel(table, "ch-unknown")).toBeUndefined();
  });
});

describe("getChannelsForAgent", () => {
  it("returns channel list for agent, empty array for unknown agent", () => {
    const table = buildRoutingTable([
      makeAgent("alice", ["ch-1", "ch-2"]),
    ]);

    expect(getChannelsForAgent(table, "alice")).toEqual(["ch-1", "ch-2"]);
    expect(getChannelsForAgent(table, "nobody")).toEqual([]);
  });
});
