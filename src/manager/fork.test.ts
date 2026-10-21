import { describe, it, expect } from "vitest";
import { buildForkName, buildForkConfig } from "./fork.js";
import type { ResolvedAgentConfig } from "../shared/types.js";

describe("buildForkName", () => {
  it("generates name with agent prefix and fork suffix", () => {
    const name = buildForkName("researcher");
    expect(name).toMatch(/^researcher-fork-[a-zA-Z0-9_-]{6}$/);
  });

  it("generates unique names on each call", () => {
    const a = buildForkName("agent");
    const b = buildForkName("agent");
    expect(a).not.toBe(b);
  });
});

describe("buildForkConfig", () => {
  const parentConfig: ResolvedAgentConfig = {
    name: "researcher",
    workspace: "/home/test/.clawcode/agents/researcher",
    memoryPath: "/home/test/.clawcode/agents/researcher", // Phase 75 SHARED-01
    channels: ["123456"],
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
    skills: ["search"],
    soul: "You are a researcher.",
    identity: "Research agent",
    memory: {
      compactionThreshold: 0.75,
      searchTopK: 10,
      consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" },
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: true, similarityThreshold: 0.85 },
    },
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    },
    skillsPath: "/home/test/.clawcode/skills",
    schedules: [{ name: "daily-check", cron: "0 9 * * *", prompt: "Check news", enabled: true }],
    admin: false,
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    slashCommands: [{ name: "search", description: "Search", claudeCommand: "search", options: [] }],
    reactions: false,
    mcpServers: [],
  };

  it("creates config with fork name and no channels", () => {
    const config = buildForkConfig(parentConfig, "researcher-fork-abc123");
    expect(config.name).toBe("researcher-fork-abc123");
    expect(config.channels).toEqual([]);
  });

  it("inherits parent model by default", () => {
    const config = buildForkConfig(parentConfig, "fork-1");
    expect(config.model).toBe("sonnet");
  });

  it("overrides model when specified", () => {
    const config = buildForkConfig(parentConfig, "fork-1", { modelOverride: "opus" });
    expect(config.model).toBe("opus");
  });

  it("includes fork context in soul", () => {
    const config = buildForkConfig(parentConfig, "fork-1");
    expect(config.soul).toContain("Fork Context");
    expect(config.soul).toContain("researcher");
  });

  it("overrides system prompt when specified", () => {
    const config = buildForkConfig(parentConfig, "fork-1", {
      systemPromptOverride: "Custom prompt.",
    });
    expect(config.soul).toContain("Custom prompt.");
    expect(config.soul).not.toContain("You are a researcher.");
  });

  it("clears schedules and slash commands", () => {
    const config = buildForkConfig(parentConfig, "fork-1");
    expect(config.schedules).toEqual([]);
    expect(config.slashCommands).toEqual([]);
  });

  it("preserves workspace and memory config", () => {
    const config = buildForkConfig(parentConfig, "fork-1");
    expect(config.workspace).toBe(parentConfig.workspace);
    expect(config.memory).toBe(parentConfig.memory);
  });

  it("does not mutate parent config", () => {
    const originalName = parentConfig.name;
    buildForkConfig(parentConfig, "fork-1");
    expect(parentConfig.name).toBe(originalName);
    expect(parentConfig.channels).toEqual(["123456"]);
  });

  // Phase 83 Plan 02 EFFORT-06 — fork quarantine regression pins.
  //
  // buildForkConfig reads from `ResolvedAgentConfig.effort`, which is the
  // CONFIG-level default — NOT the parent's live handle.getEffort(). These
  // tests pin that buildForkConfig's output carries the config default,
  // which is the quarantine invariant: a refactor that threads runtime
  // state into fork config would flip `fork.effort` to a different value
  // and fail these tests.
  it("resets effort to parent config default, not to a runtime override (EFFORT-06)", () => {
    const parent = { ...parentConfig, effort: "low" as const };
    const fork = buildForkConfig(parent, "parent-fork-abc123");
    expect(fork.effort).toBe("low");
  });

  it("preserves parent config effort when modelOverride is passed (EFFORT-06)", () => {
    const parent = { ...parentConfig, effort: "medium" as const };
    const fork = buildForkConfig(parent, "parent-fork-xyz", { modelOverride: "opus" });
    expect(fork.effort).toBe("medium");
    expect(fork.model).toBe("opus");
  });

  it("mirrors parent config effort through systemPromptOverride path (EFFORT-06)", () => {
    // Ensure the custom-soul path doesn't accidentally drop the effort field.
    const parent = { ...parentConfig, effort: "max" as const };
    const fork = buildForkConfig(parent, "parent-fork-qqq", {
      systemPromptOverride: "Opus advisor prompt.",
    });
    expect(fork.effort).toBe("max");
    expect(fork.soul).toContain("Opus advisor prompt.");
  });

  // Quick 260715-j1j review CR-03 — native-Workflow TOOL quarantine for
  // forks. The D9 effort clamp removes only the orchestration MODE; these
  // pins prove a fork of an opted-in parent also loses the TOOL access and
  // the opt-in flag itself.
  describe("native-Workflow quarantine (quick 260715-j1j CR-03)", () => {
    it("fork of an OPTED-IN parent gets 'Workflow' back in disallowedTools + nativeWorkflow false", () => {
      const parent: ResolvedAgentConfig = {
        ...parentConfig,
        effort: "ultracode",
        nativeWorkflow: true,
        // Opted-in parent: the loader SUBTRACTED "Workflow" from the fleet
        // list (D5) — simulate the post-subtraction resolved shape.
        disallowedTools: ["ScheduleWakeup", "CronCreate", "AskUserQuestion"],
      };
      const fork = buildForkConfig(parent, "fork-uc");
      expect(fork.nativeWorkflow).toBe(false);
      expect(fork.disallowedTools).toContain("Workflow");
      // Union, not clobber — inherited entries survive.
      expect(fork.disallowedTools).toContain("ScheduleWakeup");
      expect(fork.disallowedTools).toContain("CronCreate");
      expect(fork.disallowedTools).toContain("AskUserQuestion");
      // And the D9 effort clamp still holds alongside.
      expect(fork.effort).toBe("xhigh");
    });

    it("fork of a NON-opted parent whose list already carries 'Workflow' is unchanged (Set dedupe — no double entry)", () => {
      const parent: ResolvedAgentConfig = {
        ...parentConfig,
        disallowedTools: [
          "ScheduleWakeup",
          "CronCreate",
          "AskUserQuestion",
          "Workflow",
        ],
      };
      const fork = buildForkConfig(parent, "fork-fleet");
      expect(fork.disallowedTools).toEqual([
        "ScheduleWakeup",
        "CronCreate",
        "AskUserQuestion",
        "Workflow",
      ]);
      expect(fork.nativeWorkflow).toBe(false);
    });

    it("does not mutate the parent's disallowedTools (immutable union)", () => {
      const parentTools = ["ScheduleWakeup", "CronCreate"];
      const parent: ResolvedAgentConfig = {
        ...parentConfig,
        nativeWorkflow: true,
        disallowedTools: parentTools,
      };
      buildForkConfig(parent, "fork-immut");
      expect(parent.disallowedTools).toBe(parentTools);
      expect(parentTools).toEqual(["ScheduleWakeup", "CronCreate"]);
      expect(parent.nativeWorkflow).toBe(true);
    });
  });
});
