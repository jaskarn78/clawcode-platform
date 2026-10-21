import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  loadConfig,
  resolveAgentConfig,
  resolveAllAgents,
  resolveContent,
  resolveEnvVars,
  resolveSystemPromptDirectives,
  renderSystemPromptDirectiveBlock,
} from "../loader.js";
import {
  DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
  defaultsSchema,
  agentSchema,
} from "../schema.js";
import type { SystemPromptDirective } from "../schema.js";
import { expandHome } from "../defaults.js";
import { ConfigFileNotFoundError, ConfigValidationError } from "../../shared/errors.js";
import type { AgentConfig, DefaultsConfig, Config } from "../schema.js";

describe("resolveAgentConfig", () => {
  const defaults: DefaultsConfig = {
    model: "sonnet",
    effort: "low" as const,
    // Phase 96 D-09 — fleet-wide outputDir template; matches DEFAULT_OUTPUT_DIR.
    outputDir: "outputs/{date}/",
    // Phase 86 MODEL-01 — test fixture mirrors the defaultsSchema default.
    allowedModels: ["haiku", "sonnet", "opus"] as ("haiku" | "sonnet" | "opus")[],
    // Phase 89 GREET-07/10 — zod defaults these to true / 300_000 in defaultsSchema.
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    // Phase 90 MEM-01 — zod defaults this to true in defaultsSchema.
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
    // Phase 94 TOOL-10 — fleet-wide directives (D-09 file-sharing + D-07 cross-agent-routing).
    systemPromptDirectives: { ...DEFAULT_SYSTEM_PROMPT_DIRECTIVES },
    clawhubBaseUrl: "https://clawhub.ai",
    clawhubCacheTtlMs: 600_000,
    skills: ["default-skill"],
    basePath: "~/.clawcode/agents",
    skillsPath: "~/.clawcode/skills",
    memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 }, tiers: { hotAccessThreshold: 3, hotAccessWindowDays: 7, hotDemotionDays: 7, coldRelevanceThreshold: 0.05, hotBudget: 20, centralityPromoteThreshold: 5 }, episodes: { archivalAgeDays: 90 } },
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: {
        warningThreshold: 0.6,
        criticalThreshold: 0.75,
        zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 },
      },
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
  };

  it("applies default model when agent does not specify one", () => {
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.model).toBe("sonnet");
  });

  it("uses agent model when specified, overriding default", () => {
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      model: "opus",
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.model).toBe("opus");
  });

  it("carries a per-agent advisor override onto the resolved config (BUGFIX 2026-06-26)", () => {
    // Before the fix, ResolvedAgentConfig dropped `advisor`, so handleAskAdvisor
    // read getAgentConfig().advisor === undefined and the per-agent override was
    // silently ignored (every agent fell through to defaults.advisor.backend).
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
      advisor: { backend: "fork" },
    };
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.advisor?.backend).toBe("fork");
  });

  it("omits advisor on the resolved config when the agent has no override (byte-stable)", () => {
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved).not.toHaveProperty("advisor");
  });

  it("uses default skills when agent skills array is empty", () => {
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.skills).toEqual(["default-skill"]);
  });

  it("uses agent skills when agent skills array is non-empty", () => {
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      skills: ["custom-skill"],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.skills).toEqual(["custom-skill"]);
  });

  it("defaults workspace to basePath/agentName when not specified", () => {
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.workspace).toBe(join(homedir(), ".clawcode/agents", "writer"));
  });

  it("uses agent workspace when specified", () => {
    const agent: AgentConfig = {
      name: "writer",
      workspace: "/custom/path",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.workspace).toBe("/custom/path");
  });

  it("does not mutate input agent object", () => {
    const agent: AgentConfig = {
      name: "writer",
      channels: ["ch1"],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };
    const agentCopy = { ...agent };

    resolveAgentConfig(agent, defaults);

    expect(agent).toEqual(agentCopy);
  });

  it("does not mutate input defaults object", () => {
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };
    const defaultsCopy = { ...defaults };

    resolveAgentConfig(agent, defaults);

    expect(defaults).toEqual(defaultsCopy);
  });

  // Phase 75 Plan 02 — memoryPath resolution (SHARED-01, SHARED-02).
  // loader.ts guarantees ResolvedAgentConfig.memoryPath is populated:
  //   - expandHome(agent.memoryPath) when set (handles `~/...`)
  //   - resolvedWorkspace when unset (zero behavior change for dedicated
  //     workspace agents — they never set memoryPath)

  it("expands memoryPath with leading ~ when explicitly set", () => {
    const agent: AgentConfig = {
      name: "fin-client",
      memoryPath: "~/shared/acme/fin-client",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.memoryPath).toBe(
      join(homedir(), "shared/acme/fin-client"),
    );
  });

  it("falls back memoryPath to workspace when unset (zero behavior change for dedicated-workspace agents)", () => {
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.memoryPath).toBe(resolved.workspace);
    expect(resolved.memoryPath).toBe(
      join(homedir(), ".clawcode/agents", "writer"),
    );
  });

  it("passes ./relative memoryPath through expandHome unchanged (no ~ prefix)", () => {
    const agent: AgentConfig = {
      name: "writer",
      memoryPath: "./relative/subdir",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.memoryPath).toBe("./relative/subdir");
  });

  it("passes absolute memoryPath through unchanged", () => {
    const agent: AgentConfig = {
      name: "writer",
      memoryPath: "/var/lib/clawcode/writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.memoryPath).toBe("/var/lib/clawcode/writer");
    // workspace is unaffected by memoryPath override
    expect(resolved.workspace).toBe(
      join(homedir(), ".clawcode/agents", "writer"),
    );
  });

  it("resolveAllAgents: two agents sharing basePath with distinct memoryPaths get distinct resolved paths", () => {
    const config: Config = {
      version: 1,
      defaults,
      agents: [
        {
          name: "fin-client",
          workspace: "~/shared/acme",
          memoryPath: "~/shared/acme/fin-client",
          channels: [],
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
          name: "fin-research",
          workspace: "~/shared/acme",
          memoryPath: "~/shared/acme/fin-research",
          channels: [],
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
      mcpServers: {},
    } as unknown as Config;

    const resolved = resolveAllAgents(config);
    const acq = resolved.find((a) => a.name === "fin-client")!;
    const res = resolved.find((a) => a.name === "fin-research")!;

    // Shared workspace (same YAML value, same resolved string)
    expect(acq.workspace).toBe(res.workspace);

    // Distinct memoryPaths — the whole point of Phase 75
    expect(acq.memoryPath).not.toBe(res.memoryPath);
    expect(acq.memoryPath).toBe(
      join(homedir(), "shared/acme/fin-client"),
    );
    expect(res.memoryPath).toBe(
      join(homedir(), "shared/acme/fin-research"),
    );
  });

  // -------------------------------------------------------------------------
  // Phase 999.54 — mcpServers alwaysLoad cascade (D-03a, D-03/OQ-3, D-05a)
  // Phase 999.162 — the D-03a server-level pin is GONE (per-tool pins in
  // src/mcp/server.ts replace it); pins 1 and 3 below reflect that.
  //
  // Three pins (one it() each):
  //   1. auto-inject carries NO alwaysLoad on clawcode when agent yaml
  //      does NOT declare a clawcode entry (999.162; was D-03a's `true`).
  //   2. per-agent inline-object override wins over auto-inject — yaml
  //      `alwaysLoad: false` produces field-absent in resolved (Plan 02
  //      spread-conditional at loader.ts:498) which still signals "auto-
  //      inject bypassed". Forbidden outcome: alwaysLoad: true (D-03/OQ-3).
  //   3. console.info("phase999.54-resolver", ...) log line emitted with
  //      payload listing alwaysLoadServers: ["clawcode"] when an operator
  //      pins it inline (D-05a — closest
  //      automated proxy for the live-clawdy journalctl verification
  //      gated to Plan 05).
  // -------------------------------------------------------------------------
  it("Phase 999.162 — auto-inject carries NO server-level alwaysLoad (the hot tools pin themselves per-tool in src/mcp/server.ts)", () => {
    const config: Config = {
      version: 1,
      defaults,
      agents: [
        {
          name: "phase99954-default-agent",
          workspace: "~/test-ws",
          channels: [],
          skills: [],
          effort: "low",
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
          // No clawcode entry — auto-inject path.
          mcpServers: [],
        },
      ],
      mcpServers: {},
    } as unknown as Config;

    const resolved = resolveAllAgents(config);
    const agent = resolved.find((a) => a.name === "phase99954-default-agent");
    expect(agent).toBeDefined();
    const clawcodeServer = agent!.mcpServers.find((s) => s.name === "clawcode");
    expect(clawcodeServer).toBeDefined();
    expect(clawcodeServer!.alwaysLoad).toBeUndefined();
  });

  it("Phase 999.54 D-03/OQ-3 — per-agent inline-object clawcode override wins over auto-inject", () => {
    const config: Config = {
      version: 1,
      defaults,
      agents: [
        {
          name: "phase99954-override-agent",
          workspace: "~/test-ws",
          channels: [],
          skills: [],
          effort: "low",
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
          mcpServers: [
            // Inline-object form (not string-ref) — required to set alwaysLoad
            // per RESEARCH.md Pitfall 6. Operator opts OUT of preload.
            {
              name: "clawcode",
              command: "clawcode",
              args: ["mcp"],
              env: {},
              alwaysLoad: false,
            },
          ],
        },
      ],
      mcpServers: {},
    } as unknown as Config;

    const resolved = resolveAllAgents(config);
    const agent = resolved.find((a) => a.name === "phase99954-override-agent");
    expect(agent).toBeDefined();
    const clawcodeServer = agent!.mcpServers.find((s) => s.name === "clawcode");
    expect(clawcodeServer).toBeDefined();
    // Plan 02 Task 2's spread-conditional at loader.ts:498 emits the field ONLY
    // when `=== true`. Per-agent `alwaysLoad: false` in yaml → field absent in
    // resolved entry. Either explicit `false` or absent both satisfy
    // "auto-inject bypassed"; FORBIDDEN outcome is `alwaysLoad: true`.
    expect(clawcodeServer!.alwaysLoad).not.toBe(true);
  });

  it("Phase 999.54 D-05a — emits phase999.54-resolver console.info line listing alwaysLoad servers", () => {
    const config: Config = {
      version: 1,
      defaults,
      agents: [
        {
          name: "phase99954-log-agent",
          workspace: "~/test-ws",
          channels: [],
          skills: [],
          effort: "low",
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
          mcpServers: [
            // Phase 999.162 — the auto-inject no longer pins the server, so
            // the D-05a log line is exercised through an explicit operator
            // pin (inline-object form; the 999.54 rollback shape).
            {
              name: "clawcode",
              command: "clawcode",
              args: ["mcp"],
              env: {},
              alwaysLoad: true,
            },
          ],
        },
      ],
      mcpServers: {},
    } as unknown as Config;

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      resolveAllAgents(config);
      // Find the log call whose first arg is the D-05a key. Other log lines
      // from the loader are ignored.
      const call = infoSpy.mock.calls.find(
        (args) => args[0] === "phase999.54-resolver",
      );
      expect(call).toBeDefined();
      const payload = JSON.parse(call![1] as string);
      expect(payload.agent).toBe("phase99954-log-agent");
      expect(payload.alwaysLoadServers).toContain("clawcode");
    } finally {
      infoSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // Phase 78 Plan 01 — CONF-01: soulFile / identityFile expansion
  // loader.ts guarantees ResolvedAgentConfig.soulFile / .identityFile are
  //   - expandHome(agent.soulFile) when set (handles `~/...`)
  //   - undefined when unset (session-config.ts skips the file branch)
  // -------------------------------------------------------------------------

  it("expands soulFile with leading ~ when set", () => {
    const agent: AgentConfig = {
      name: "fin-client",
      soulFile: "~/workspace-fin-client/SOUL.md",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.soulFile).toBe(
      join(homedir(), "workspace-fin-client/SOUL.md"),
    );
  });

  it("leaves soulFile undefined when unset (no fallback to workspace/SOUL.md)", () => {
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.soulFile).toBeUndefined();
  });

  it("expands identityFile with leading ~ when set; leaves undefined when unset", () => {
    const agentSet: AgentConfig = {
      name: "fin-research",
      identityFile: "~/workspace-fin-research/IDENTITY.md",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };
    const resolvedSet = resolveAgentConfig(agentSet, defaults);
    expect(resolvedSet.identityFile).toBe(
      join(homedir(), "workspace-fin-research/IDENTITY.md"),
    );

    const agentUnset: AgentConfig = {
      name: "writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };
    const resolvedUnset = resolveAgentConfig(agentUnset, defaults);
    expect(resolvedUnset.identityFile).toBeUndefined();
  });

  it("expands soulFile independently of workspace (soulFile expansion doesn't depend on workspace being set)", () => {
    const agent: AgentConfig = {
      name: "fin-client",
      // workspace omitted — loader falls back to basePath + name
      soulFile: "~/external/custom-soul.md",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.soulFile).toBe(
      join(homedir(), "external/custom-soul.md"),
    );
    // Workspace still resolved from basePath — independent from soulFile.
    expect(resolved.workspace).toBe(
      join(homedir(), ".clawcode/agents", "fin-client"),
    );
  });

  // Phase 100 follow-up — dream config propagation (DR-A1/A2/A3).
  // Same root-cause shape as Phase 100 settingSources / gsd.projectDir
  // and Phase 96 fileAccess: schema parsed `dream` but resolver dropped
  // it, so daemon's getResolvedDreamConfig saw `undefined` and silently
  // disabled auto-fire. These tests pin the resolver behavior so the
  // ResolvedAgentConfig surfaces dream when the agent (or defaults)
  // declares it, while staying back-compat for opted-out agents.
  it("DR-A1: propagates per-agent dream config to ResolvedAgentConfig", () => {
    const agent: AgentConfig = {
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
      dream: { enabled: true, idleMinutes: 30, model: "haiku" as const },
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.dream).toBeDefined();
    expect(resolved.dream?.enabled).toBe(true);
    expect(resolved.dream?.idleMinutes).toBe(30);
    expect(resolved.dream?.model).toBe("haiku");
  });

  it("DR-A2: agent without dream block AND defaults.dream disabled → resolved dream falls back to defaults (enabled=false)", () => {
    // Back-compat — defaults.dream is the fleet-wide opt-in baseline.
    // When neither agent nor defaults enable it, resolved should still
    // surface the (disabled) default so consumers don't hit an
    // unexpected `undefined`.
    const agent: AgentConfig = {
      name: "writer",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    // defaults.dream is { enabled:false, idleMinutes:30, model:"haiku" }
    expect(resolved.dream).toBeDefined();
    expect(resolved.dream?.enabled).toBe(false);
  });

  it("DR-A3: defaults.dream propagates when agent has no dream block (fleet-wide enable)", () => {
    const fleetDreamDefaults: DefaultsConfig = {
      ...defaults,
      dream: { enabled: true, idleMinutes: 45, model: "sonnet" as const },
    };
    const agent: AgentConfig = {
      name: "fin-research",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
    };

    const resolved = resolveAgentConfig(agent, fleetDreamDefaults);
    expect(resolved.dream).toBeDefined();
    expect(resolved.dream?.enabled).toBe(true);
    expect(resolved.dream?.idleMinutes).toBe(45);
    expect(resolved.dream?.model).toBe("sonnet");
  });
});

describe("resolveAgentConfig - mcpServers", () => {
  const defaults: DefaultsConfig = {
    model: "sonnet",
    effort: "low" as const,
    // Phase 96 D-09 — fleet-wide outputDir template; matches DEFAULT_OUTPUT_DIR.
    outputDir: "outputs/{date}/",
    // Phase 86 MODEL-01 — test fixture mirrors the defaultsSchema default.
    allowedModels: ["haiku", "sonnet", "opus"] as ("haiku" | "sonnet" | "opus")[],
    // Phase 89 GREET-07/10 — zod defaults these to true / 300_000 in defaultsSchema.
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    // Phase 90 MEM-01 — zod defaults this to true in defaultsSchema.
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
    // Phase 94 TOOL-10 — fleet-wide directives (D-09 file-sharing + D-07 cross-agent-routing).
    systemPromptDirectives: { ...DEFAULT_SYSTEM_PROMPT_DIRECTIVES },
    clawhubBaseUrl: "https://clawhub.ai",
    clawhubCacheTtlMs: 600_000,
    skills: [],
    basePath: "~/.clawcode/agents",
    skillsPath: "~/.clawcode/skills",
    memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 }, tiers: { hotAccessThreshold: 3, hotAccessWindowDays: 7, hotDemotionDays: 7, coldRelevanceThreshold: 0.05, hotBudget: 20, centralityPromoteThreshold: 5 }, episodes: { archivalAgeDays: 90 } },
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: {
        warningThreshold: 0.6,
        criticalThreshold: 0.75,
        zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 },
      },
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
  };

  const sharedMcpServers = {
    // Phase 85 TOOL-01 — `optional: false` added to match the extended
    // mcpServerSchema (default field; mandatory servers).
    finnhub: { name: "finnhub", command: "npx", args: ["-y", "finnhub-mcp"], env: { API_KEY: "xxx" }, optional: false },
    google: { name: "google", command: "npx", args: ["-y", "google-mcp"], env: {}, optional: false },
  };

  const baseAgent: AgentConfig = {
    name: "test",
    channels: [],
    skills: [],
    effort: "low",
    heartbeat: true,
    schedules: [],
    admin: false,
    slashCommands: [],
    reactions: true,
    mcpServers: [],
  };

  it("resolves string references from shared definitions", () => {
    const agent = { ...baseAgent, mcpServers: ["finnhub"] as Array<string | { name: string; command: string; args: string[]; env: Record<string, string>; optional: boolean }> };
    const resolved = resolveAgentConfig(agent, defaults, sharedMcpServers);
    const finnhub = resolved.mcpServers.find(s => s.name === "finnhub");
    expect(finnhub).toBeDefined();
    expect(finnhub!.command).toBe("npx");
    expect(finnhub!.args).toEqual(["-y", "finnhub-mcp"]);
    expect(finnhub!.env).toEqual({ API_KEY: "xxx" });
    // Also has auto-injected clawcode
    expect(resolved.mcpServers.find(s => s.name === "clawcode")).toBeDefined();
  });

  it("passes inline MCP server objects through unchanged", () => {
    const inline = { name: "custom", command: "my-server", args: ["--port", "3000"], env: { KEY: "val" }, optional: false };
    const agent = { ...baseAgent, mcpServers: [inline] as Array<string | { name: string; command: string; args: string[]; env: Record<string, string>; optional: boolean }> };
    const resolved = resolveAgentConfig(agent, defaults, sharedMcpServers);
    const custom = resolved.mcpServers.find(s => s.name === "custom");
    expect(custom).toBeDefined();
    expect(custom!.command).toBe("my-server");
  });

  it("merges inline and refs, inline wins on name collision", () => {
    const inline = { name: "finnhub", command: "custom-finnhub", args: [], env: {}, optional: false };
    const agent = { ...baseAgent, mcpServers: ["finnhub", inline] as Array<string | { name: string; command: string; args: string[]; env: Record<string, string>; optional: boolean }> };
    const resolved = resolveAgentConfig(agent, defaults, sharedMcpServers);
    // Later entry wins on name collision
    const finnhub = resolved.mcpServers.find(s => s.name === "finnhub");
    expect(finnhub).toBeDefined();
    expect(finnhub!.command).toBe("custom-finnhub");
  });

  it("throws when string reference not found in shared definitions", () => {
    const agent = { ...baseAgent, mcpServers: ["nonexistent"] as Array<string | { name: string; command: string; args: string[]; env: Record<string, string>; optional: boolean }> };
    expect(() => resolveAgentConfig(agent, defaults, sharedMcpServers)).toThrow(
      /MCP server.*nonexistent.*not found/i,
    );
  });

  it("auto-injects clawcode MCP server when agent has none", () => {
    const resolved = resolveAgentConfig(baseAgent, defaults, sharedMcpServers);
    const clawcode = resolved.mcpServers.find(s => s.name === "clawcode");
    expect(clawcode).toBeDefined();
    expect(clawcode!.command).toBe("clawcode");
    expect(clawcode!.args).toEqual(["mcp"]);
  });

  // Phase 70 Plan 03 — auto-inject the `browser` MCP entry so every agent
  // gets the 6 browser_* tools out of the box. Parallels the `clawcode`
  // and `1password` auto-injects. Gated by defaults.browser.enabled.
  it("auto-injects browser MCP entry when defaults.browser.enabled is true", () => {
    const resolved = resolveAgentConfig(baseAgent, defaults, sharedMcpServers);
    const browser = resolved.mcpServers.find((s) => s.name === "browser");
    expect(browser).toBeDefined();
    // 2026-07-31 baseline flip: no shimRuntime config → static Go binary.
    expect(browser!.command).toBe("/opt/clawcode/bin/clawcode-mcp-shim");
    expect(browser!.args).toEqual(["--type", "browser"]);
    expect(browser!.env).toMatchObject({ CLAWCODE_AGENT: "test" });
  });

  it("omits browser MCP when defaults.browser.enabled is false", () => {
    const disabledDefaults: DefaultsConfig = {
      ...defaults,
      browser: { ...defaults.browser, enabled: false },
    };
    const resolved = resolveAgentConfig(baseAgent, disabledDefaults, sharedMcpServers);
    expect(resolved.mcpServers.find((s) => s.name === "browser")).toBeUndefined();
  });

  it("browser injection sets CLAWCODE_AGENT env to the agent name per-agent", () => {
    const clawdy = { ...baseAgent, name: "clawdy" };
    const rubi = { ...baseAgent, name: "rubi" };
    const resolvedClawdy = resolveAgentConfig(clawdy, defaults, sharedMcpServers);
    const resolvedRubi = resolveAgentConfig(rubi, defaults, sharedMcpServers);
    expect(resolvedClawdy.mcpServers.find((s) => s.name === "browser")!.env).toMatchObject({ CLAWCODE_AGENT: "clawdy" });
    expect(resolvedRubi.mcpServers.find((s) => s.name === "browser")!.env).toMatchObject({ CLAWCODE_AGENT: "rubi" });
  });

  it("preserves user-specified 'browser' mcpServer entry (no overwrite)", () => {
    const customBrowser = { name: "browser", command: "mycustom", args: ["--flag"], env: { CUSTOM: "x" }, optional: false };
    const agent = {
      ...baseAgent,
      mcpServers: [customBrowser] as Array<string | { name: string; command: string; args: string[]; env: Record<string, string>; optional: boolean }>,
    };
    const resolved = resolveAgentConfig(agent, defaults, sharedMcpServers);
    const browser = resolved.mcpServers.find((s) => s.name === "browser");
    expect(browser).toBeDefined();
    expect(browser!.command).toBe("mycustom");
    expect(browser!.args).toEqual(["--flag"]);
    expect(browser!.env).toEqual({ CUSTOM: "x" });
  });

  // Phase 71 Plan 02 — auto-inject the `search` MCP entry so every agent
  // gets web_search + web_fetch_url. Parallels the browser auto-inject;
  // gated by defaults.search.enabled (default true).
  it("auto-injects search MCP entry when defaults.search.enabled is true", () => {
    const resolved = resolveAgentConfig(baseAgent, defaults, sharedMcpServers);
    const search = resolved.mcpServers.find((s) => s.name === "search");
    expect(search).toBeDefined();
    // 2026-07-31 baseline flip: no shimRuntime config → static Go binary.
    expect(search!.command).toBe("/opt/clawcode/bin/clawcode-mcp-shim");
    expect(search!.args).toEqual(["--type", "search"]);
    expect(search!.env).toMatchObject({ CLAWCODE_AGENT: "test" });
  });

  it("omits search MCP when defaults.search.enabled is false", () => {
    const disabledDefaults: DefaultsConfig = {
      ...defaults,
      search: { ...defaults.search, enabled: false },
    };
    const resolved = resolveAgentConfig(baseAgent, disabledDefaults, sharedMcpServers);
    expect(resolved.mcpServers.find((s) => s.name === "search")).toBeUndefined();
  });

  it("search injection sets CLAWCODE_AGENT env to the agent name per-agent", () => {
    const clawdy = { ...baseAgent, name: "clawdy" };
    const rubi = { ...baseAgent, name: "rubi" };
    const resolvedClawdy = resolveAgentConfig(clawdy, defaults, sharedMcpServers);
    const resolvedRubi = resolveAgentConfig(rubi, defaults, sharedMcpServers);
    expect(resolvedClawdy.mcpServers.find((s) => s.name === "search")!.env).toMatchObject({ CLAWCODE_AGENT: "clawdy" });
    expect(resolvedRubi.mcpServers.find((s) => s.name === "search")!.env).toMatchObject({ CLAWCODE_AGENT: "rubi" });
  });

  it("preserves user-specified 'search' mcpServer entry (no overwrite)", () => {
    const customSearch = { name: "search", command: "mycustom", args: ["--flag"], env: { CUSTOM: "x" }, optional: false };
    const agent = {
      ...baseAgent,
      mcpServers: [customSearch] as Array<string | { name: string; command: string; args: string[]; env: Record<string, string>; optional: boolean }>,
    };
    const resolved = resolveAgentConfig(agent, defaults, sharedMcpServers);
    const search = resolved.mcpServers.find((s) => s.name === "search");
    expect(search).toBeDefined();
    expect(search!.command).toBe("mycustom");
    expect(search!.args).toEqual(["--flag"]);
    expect(search!.env).toEqual({ CUSTOM: "x" });
  });

  it("resolves multiple string references", () => {
    const agent = { ...baseAgent, mcpServers: ["finnhub", "google"] as Array<string | { name: string; command: string; args: string[]; env: Record<string, string>; optional: boolean }> };
    const resolved = resolveAgentConfig(agent, defaults, sharedMcpServers);
    expect(resolved.mcpServers.find(s => s.name === "finnhub")).toBeDefined();
    expect(resolved.mcpServers.find(s => s.name === "google")).toBeDefined();
    expect(resolved.mcpServers.find(s => s.name === "clawcode")).toBeDefined();
  });

  // Phase 72 Plan 02 — auto-inject the `image` MCP entry so every agent
  // gets image_generate + image_edit + image_variations. Parallels the
  // browser + search auto-injects; gated by defaults.image.enabled
  // (default true).
  it("L1: auto-injects image MCP entry when defaults.image.enabled is true", () => {
    const resolved = resolveAgentConfig(baseAgent, defaults, sharedMcpServers);
    const image = resolved.mcpServers.find((s) => s.name === "image");
    expect(image).toBeDefined();
    // 2026-07-31 baseline flip: no shimRuntime config → static Go binary.
    expect(image!.command).toBe("/opt/clawcode/bin/clawcode-mcp-shim");
    expect(image!.args).toEqual(["--type", "image"]);
    expect(image!.env).toMatchObject({ CLAWCODE_AGENT: "test" });
  });

  it("L2: omits image MCP when defaults.image.enabled is false", () => {
    const disabledDefaults: DefaultsConfig = {
      ...defaults,
      image: { ...defaults.image, enabled: false },
    };
    const resolved = resolveAgentConfig(baseAgent, disabledDefaults, sharedMcpServers);
    expect(resolved.mcpServers.find((s) => s.name === "image")).toBeUndefined();
  });

  it("L3: image injection sets CLAWCODE_AGENT env to the agent name per-agent", () => {
    const clawdy = { ...baseAgent, name: "clawdy" };
    const rubi = { ...baseAgent, name: "rubi" };
    const resolvedClawdy = resolveAgentConfig(clawdy, defaults, sharedMcpServers);
    const resolvedRubi = resolveAgentConfig(rubi, defaults, sharedMcpServers);
    expect(resolvedClawdy.mcpServers.find((s) => s.name === "image")!.env).toMatchObject({ CLAWCODE_AGENT: "clawdy" });
    expect(resolvedRubi.mcpServers.find((s) => s.name === "image")!.env).toMatchObject({ CLAWCODE_AGENT: "rubi" });
  });

  it("L4: preserves user-specified 'image' mcpServer entry (no overwrite)", () => {
    const customImage = { name: "image", command: "mycustom", args: ["--flag"], env: { CUSTOM: "x" }, optional: false };
    const agent = {
      ...baseAgent,
      mcpServers: [customImage] as Array<string | { name: string; command: string; args: string[]; env: Record<string, string>; optional: boolean }>,
    };
    const resolved = resolveAgentConfig(agent, defaults, sharedMcpServers);
    const image = resolved.mcpServers.find((s) => s.name === "image");
    expect(image).toBeDefined();
    expect(image!.command).toBe("mycustom");
    expect(image!.args).toEqual(["--flag"]);
    expect(image!.env).toEqual({ CUSTOM: "x" });
  });

  // -------------------------------------------------------------------------
  // Phase 110 Stage 0b — runtime-conditional auto-inject for browser/search/
  // image. Each shim type's command/args branches on `defaults.shimRuntime.
  // <type>` (baseline "static" since the 2026-07-31 memory-pressure fix —
  // the Go binary was always the intended production runtime; "node" is the
  // explicit-only emergency-rollback path and warns when selected).
  //
  // Crash-fallback policy: NO try/catch around the static-runtime path. The
  // loader simply emits the command/args; spawn-time failures surface to the
  // operator (fail-loud, see CONTEXT.md).
  // -------------------------------------------------------------------------
  describe("Phase 110 Stage 0b — runtime-conditional auto-inject", () => {
    const SHIM_TYPES = ["browser", "search", "image"] as const;
    const STATIC_PATH = "/opt/clawcode/bin/clawcode-mcp-shim";
    const PYTHON_PATH = "/opt/clawcode/bin/clawcode-mcp-shim.py";

    for (const type of SHIM_TYPES) {
      it(`${type}: default (no shimRuntime) resolves to the static Go binary (2026-07-31 baseline flip)`, () => {
        const resolved = resolveAgentConfig(baseAgent, defaults, sharedMcpServers);
        const entry = resolved.mcpServers.find((s) => s.name === type);
        expect(entry).toBeDefined();
        expect(entry!.command).toBe(STATIC_PATH);
        expect(entry!.args).toEqual(["--type", type]);
        expect(entry!.env).toEqual({
          CLAWCODE_AGENT: "test",
          CLAWCODE_MANAGER_SOCK: expect.stringMatching(
            /\.clawcode\/manager\/clawcode\.sock$/,
          ),
        });
      });

      it(`${type}: explicit 'node' is identical to default`, () => {
        const d: DefaultsConfig = {
          ...defaults,
          shimRuntime: { search: "node", image: "node", browser: "node" },
        } as DefaultsConfig;
        const resolved = resolveAgentConfig(baseAgent, d, sharedMcpServers);
        const entry = resolved.mcpServers.find((s) => s.name === type);
        expect(entry!.command).toBe("clawcode");
        expect(entry!.args).toEqual([`${type}-mcp`]);
      });

      it(`${type}: 'static' rewrites to /opt/clawcode/bin/clawcode-mcp-shim --type ${type}`, () => {
        const d: DefaultsConfig = {
          ...defaults,
          shimRuntime: {
            search: type === "search" ? "static" : "node",
            image: type === "image" ? "static" : "node",
            browser: type === "browser" ? "static" : "node",
          },
        } as DefaultsConfig;
        const resolved = resolveAgentConfig(baseAgent, d, sharedMcpServers);
        const entry = resolved.mcpServers.find((s) => s.name === type);
        expect(entry).toBeDefined();
        expect(entry!.command).toBe(STATIC_PATH);
        expect(entry!.args).toEqual(["--type", type]);
        // CLAWCODE_AGENT env passthrough preserved across all runtimes —
        // the inner translator still needs the agent identity. Phase 110
        // Stage 0b adds CLAWCODE_MANAGER_SOCK as defense-in-depth so a
        // future relocation of MANAGER_DIR cannot silently break shim
        // children spawned with the old default baked in.
        expect(entry!.env).toEqual({
          CLAWCODE_AGENT: "test",
          CLAWCODE_MANAGER_SOCK: expect.stringMatching(
            /\.clawcode\/manager\/clawcode\.sock$/,
          ),
        });
      });

      it(`${type}: 'python' rewrites to python3 /opt/clawcode/bin/clawcode-mcp-shim.py --type ${type}`, () => {
        const d: DefaultsConfig = {
          ...defaults,
          shimRuntime: {
            search: type === "search" ? "python" : "node",
            image: type === "image" ? "python" : "node",
            browser: type === "browser" ? "python" : "node",
          },
        } as DefaultsConfig;
        const resolved = resolveAgentConfig(baseAgent, d, sharedMcpServers);
        const entry = resolved.mcpServers.find((s) => s.name === type);
        expect(entry).toBeDefined();
        expect(entry!.command).toBe("python3");
        expect(entry!.args).toEqual([PYTHON_PATH, "--type", type]);
        expect(entry!.env).toEqual({
          CLAWCODE_AGENT: "test",
          CLAWCODE_MANAGER_SOCK: expect.stringMatching(
            /\.clawcode\/manager\/clawcode\.sock$/,
          ),
        });
      });
    }

    it("env injection: node runtime gets CLAWCODE_AGENT only (no CLAWCODE_MANAGER_SOCK — Node imports the daemon constant directly)", () => {
      const d: DefaultsConfig = {
        ...defaults,
        shimRuntime: { search: "node", image: "node", browser: "node" },
      } as DefaultsConfig;
      const resolved = resolveAgentConfig(baseAgent, d, sharedMcpServers);
      const search = resolved.mcpServers.find((s) => s.name === "search");
      expect(search!.env).toEqual({ CLAWCODE_AGENT: "test" });
      expect(search!.env).not.toHaveProperty("CLAWCODE_MANAGER_SOCK");
    });

    // Phase 110 Stage 0b — per-agent shimRuntime override (Plan 110-05's
    // canary rollout primitive). Loader resolution order: per-agent →
    // defaults → "static". The per-agent path survives agent-restart, which
    // the inline-mcpServers workaround did not (cause of the 2026-05-06
    // admin-clawdy canary regression at 09:14:57 — agent-restart spawned
    // Node search-mcp instead of honoring the operator-added inline
    // override).
    it("per-agent override: agent.shimRuntime.search='static' beats explicit node defaults; other types fall through to defaults", () => {
      const a: AgentConfig = {
        ...baseAgent,
        shimRuntime: { search: "static" },
      };
      const d: DefaultsConfig = {
        ...defaults,
        shimRuntime: { search: "node", image: "node", browser: "node" },
      } as DefaultsConfig;
      const resolved = resolveAgentConfig(a, d, sharedMcpServers);
      const search = resolved.mcpServers.find((s) => s.name === "search");
      expect(search!.command).toBe(STATIC_PATH);
      expect(search!.args).toEqual(["--type", "search"]);
      // Other types fall through to defaults (explicit node).
      const image = resolved.mcpServers.find((s) => s.name === "image");
      expect(image!.command).toBe("clawcode");
      expect(image!.args).toEqual(["image-mcp"]);
    });

    it("per-agent override: agent.shimRuntime.search='node' beats defaults.shimRuntime.search='static' (operator force-back-to-node)", () => {
      const a: AgentConfig = {
        ...baseAgent,
        shimRuntime: { search: "node" },
      };
      const d: DefaultsConfig = {
        ...defaults,
        shimRuntime: { search: "static", image: "node", browser: "node" },
      } as DefaultsConfig;
      const resolved = resolveAgentConfig(a, d, sharedMcpServers);
      const search = resolved.mcpServers.find((s) => s.name === "search");
      // Per-agent "node" wins over defaults "static" — operator can opt
      // a single agent OUT of a fleet-wide canary.
      expect(search!.command).toBe("clawcode");
      expect(search!.args).toEqual(["search-mcp"]);
      // Env: node runtime → no CLAWCODE_MANAGER_SOCK.
      expect(search!.env).not.toHaveProperty("CLAWCODE_MANAGER_SOCK");
    });

    it("per-agent override: partial — only search overridden, image/browser fall through to defaults", () => {
      const a: AgentConfig = {
        ...baseAgent,
        shimRuntime: { search: "static" },
      };
      const d: DefaultsConfig = {
        ...defaults,
        shimRuntime: { search: "node", image: "python", browser: "node" },
      } as DefaultsConfig;
      const resolved = resolveAgentConfig(a, d, sharedMcpServers);
      const search = resolved.mcpServers.find((s) => s.name === "search");
      const image = resolved.mcpServers.find((s) => s.name === "image");
      const browser = resolved.mcpServers.find((s) => s.name === "browser");
      // Per-agent: search → static
      expect(search!.command).toBe(STATIC_PATH);
      // Defaults: image → python (per-agent didn't set image)
      expect(image!.command).toBe("python3");
      // Defaults: browser → node
      expect(browser!.command).toBe("clawcode");
    });

    // 2026-07-31 memory-pressure fix — every "node" resolution warns so
    // runtime drift (5 agents silently on ~240 MB Node shims) can never
    // be invisible again. Static/python resolutions stay silent.
    it("node resolution emits phase110-shim-resolver warn with sourcedFrom=defaults", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const d: DefaultsConfig = {
          ...defaults,
          shimRuntime: { search: "node", image: "static", browser: "static" },
        } as DefaultsConfig;
        resolveAgentConfig(baseAgent, d, sharedMcpServers);
        const shimWarns = warnSpy.mock.calls.filter(
          (c) => c[0] === "phase110-shim-resolver",
        );
        expect(shimWarns).toHaveLength(1);
        const payload = JSON.parse(shimWarns[0]![1] as string);
        expect(payload).toMatchObject({
          agent: "test",
          type: "search",
          runtime: "node",
          sourcedFrom: "defaults",
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("node resolution via per-agent override warns with sourcedFrom=agent", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const a: AgentConfig = {
          ...baseAgent,
          shimRuntime: { browser: "node" },
        };
        resolveAgentConfig(a, defaults, sharedMcpServers);
        const shimWarns = warnSpy.mock.calls.filter(
          (c) => c[0] === "phase110-shim-resolver",
        );
        expect(shimWarns).toHaveLength(1);
        const payload = JSON.parse(shimWarns[0]![1] as string);
        expect(payload).toMatchObject({
          agent: "test",
          type: "browser",
          runtime: "node",
          sourcedFrom: "agent",
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("static baseline resolution emits no phase110-shim-resolver warn", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        resolveAgentConfig(baseAgent, defaults, sharedMcpServers);
        const shimWarns = warnSpy.mock.calls.filter(
          (c) => c[0] === "phase110-shim-resolver",
        );
        expect(shimWarns).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("per-agent override: env injection respects per-agent runtime, not defaults", () => {
      const a: AgentConfig = {
        ...baseAgent,
        shimRuntime: { search: "static" },
      };
      const resolved = resolveAgentConfig(a, defaults, sharedMcpServers);
      const search = resolved.mcpServers.find((s) => s.name === "search");
      // Static runtime via per-agent → CLAWCODE_MANAGER_SOCK injected.
      expect(search!.env).toMatchObject({
        CLAWCODE_AGENT: "test",
        CLAWCODE_MANAGER_SOCK: expect.stringMatching(
          /\.clawcode\/manager\/clawcode\.sock$/,
        ),
      });
    });

    // Phase 110 Stage 0b — found via dev-instance smoke test 2026-05-06:
    // when CLAWCODE_MANAGER_DIR overrides the daemon's manager dir, the
    // loader's MANAGER_SOCKET_PATH constant MUST follow. Otherwise the
    // daemon binds to the override path but the loader injects the
    // canonical path into shim children, and Go shim ENOENT's → exit 75.
    //
    // This test runs in a child process because MANAGER_SOCKET_PATH is
    // module-load-time evaluated; we re-import in a child with the env
    // set to verify the override is honored.
    it("MANAGER_SOCKET_PATH honors CLAWCODE_MANAGER_DIR env at module load (regression: dev-instance exit-75 bug)", () => {
      // Verified end-to-end via dev daemon on claude-bot: when daemon
      // runs with CLAWCODE_MANAGER_DIR=/tmp/foo, loader injects
      // CLAWCODE_MANAGER_SOCK=/tmp/foo/clawcode.sock (not the canonical
      // ~/.clawcode/manager/clawcode.sock) so children dial the actual
      // bound socket. The loader's _managerDirForSocket helper at module
      // load uses the same process.env.CLAWCODE_MANAGER_DIR fallback as
      // daemon.ts MANAGER_DIR, keeping both in lockstep.
      //
      // Direct re-import-with-different-env testing requires vm sandboxing
      // which is overkill here; the integration coverage is the dev
      // daemon test in tests/integration/dev-instance.test.ts (manual or
      // CI-gated) plus the live-daemon smoke at runtime. This unit test
      // pins the contract via source-grep: the constant MUST consult
      // process.env.CLAWCODE_MANAGER_DIR.
      const loaderSrc = require("node:fs").readFileSync(
        require("node:path").join(__dirname, "..", "loader.ts"),
        "utf8",
      );
      expect(loaderSrc).toMatch(/CLAWCODE_MANAGER_DIR/);
      expect(loaderSrc).toMatch(
        /MANAGER_SOCKET_PATH\s*=\s*join\(_managerDirForSocket,\s*"clawcode\.sock"\)/,
      );
    });

    it("env injection: alternate-runtime CLAWCODE_MANAGER_SOCK matches daemon SOCKET_PATH suffix (must stay aligned with src/manager/daemon.ts:SOCKET_PATH and Go side default at internal/shim/ipc/client.go:SocketPath)", () => {
      const d: DefaultsConfig = {
        ...defaults,
        shimRuntime: { search: "static", image: "node", browser: "node" },
      } as DefaultsConfig;
      const resolved = resolveAgentConfig(baseAgent, d, sharedMcpServers);
      const search = resolved.mcpServers.find((s) => s.name === "search");
      expect(search!.env!.CLAWCODE_MANAGER_SOCK).toMatch(
        /\.clawcode\/manager\/clawcode\.sock$/,
      );
      // Pin: the file basename MUST be `clawcode.sock`, not `manager.sock`.
      // The 2026-05-06 admin-clawdy canary failure was caused by the Go
      // shim's default being `manager.sock` — guard against future drift.
      expect(search!.env!.CLAWCODE_MANAGER_SOCK).not.toMatch(/manager\.sock$/);
    });

    it("per-type independence: search=static, image=node, browser=python yields three different commands", () => {
      const d: DefaultsConfig = {
        ...defaults,
        shimRuntime: { search: "static", image: "node", browser: "python" },
      } as DefaultsConfig;
      const resolved = resolveAgentConfig(baseAgent, d, sharedMcpServers);
      const search = resolved.mcpServers.find((s) => s.name === "search");
      const image = resolved.mcpServers.find((s) => s.name === "image");
      const browser = resolved.mcpServers.find((s) => s.name === "browser");

      expect(search!.command).toBe(STATIC_PATH);
      expect(search!.args).toEqual(["--type", "search"]);

      expect(image!.command).toBe("clawcode");
      expect(image!.args).toEqual(["image-mcp"]);

      expect(browser!.command).toBe("python3");
      expect(browser!.args).toEqual([PYTHON_PATH, "--type", "browser"]);
    });

    it("static-runtime config does NOT pre-detect missing binary or fall back (loader is fail-loud)", () => {
      // The loader emits the static path even though the binary doesn't
      // exist on this CI host. Pre-detection + fallback would silently
      // degrade — operator-locked decision is to surface spawn errors
      // directly so the operator notices and reverts the flag.
      const d: DefaultsConfig = {
        ...defaults,
        shimRuntime: { search: "static", image: "node", browser: "node" },
      } as DefaultsConfig;
      const resolved = resolveAgentConfig(baseAgent, d, sharedMcpServers);
      const search = resolved.mcpServers.find((s) => s.name === "search");
      // Static path emitted unconditionally — no fs.existsSync check, no
      // fallback to "clawcode search-mcp".
      expect(search!.command).toBe(STATIC_PATH);
      expect(search!.args).toEqual(["--type", "search"]);
      expect(search!.command).not.toBe("clawcode");
    });
  });

  // Phase 108 — 1Password broker shim auto-inject. The pre-Phase-108 path
  // spawned `npx @takescake/1password-mcp` directly per-agent (11 children
  // for 11 agents). Plan 04 rewires the auto-inject to spawn the broker
  // shim instead; the daemon-managed broker owns ONE pooled MCP child per
  // unique service-account token.
  describe("Phase 108 — 1password broker shim auto-inject", () => {
    const PRIOR_TOKEN = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    const TEST_TOKEN = "ops_TEST_PHASE108_TOKEN_LITERAL";

    beforeEach(() => {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = TEST_TOKEN;
    });
    afterEach(() => {
      if (PRIOR_TOKEN === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
      else process.env.OP_SERVICE_ACCOUNT_TOKEN = PRIOR_TOKEN;
    });

    it("108-LOAD-1: 1password auto-inject uses broker shim command (not direct npx)", () => {
      const resolved = resolveAgentConfig(baseAgent, defaults, sharedMcpServers);
      const op = resolved.mcpServers.find((s) => s.name === "1password");
      expect(op).toBeDefined();
      // P5 (Stage 0c) — baseline is the static Go byte-pipe.
      expect(op!.command).toBe("/opt/clawcode/bin/clawcode-mcp-shim");
      expect(op!.args).toEqual(["--type", "1password"]);
      // Token literal still flows through env so the shim can hash + the
      // broker can spawn the pool child with it.
      expect(op!.env?.OP_SERVICE_ACCOUNT_TOKEN).toBe(TEST_TOKEN);
      // Pre-Phase-108 npx invocation MUST NOT appear.
      expect(op!.command).not.toBe("npx");
      expect(op!.args).not.toContain("@takescake/1password-mcp@latest");
    });

    it("108-LOAD-2: shim env carries CLAWCODE_AGENT for audit logging (decision §5)", () => {
      const clawdy = { ...baseAgent, name: "clawdy" };
      const rubi = { ...baseAgent, name: "rubi" };
      const resolvedClawdy = resolveAgentConfig(clawdy, defaults, sharedMcpServers);
      const resolvedRubi = resolveAgentConfig(rubi, defaults, sharedMcpServers);
      expect(resolvedClawdy.mcpServers.find((s) => s.name === "1password")!.env)
        .toEqual({ OP_SERVICE_ACCOUNT_TOKEN: TEST_TOKEN, CLAWCODE_AGENT: "clawdy" });
      expect(resolvedRubi.mcpServers.find((s) => s.name === "1password")!.env)
        .toEqual({ OP_SERVICE_ACCOUNT_TOKEN: TEST_TOKEN, CLAWCODE_AGENT: "rubi" });
    });

    it("108-LOAD-3: omits 1password auto-inject when OP_SERVICE_ACCOUNT_TOKEN is unset", () => {
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
      const resolved = resolveAgentConfig(baseAgent, defaults, sharedMcpServers);
      expect(resolved.mcpServers.find((s) => s.name === "1password")).toBeUndefined();
    });

    it("108-LOAD-4: preserves user-specified '1password' mcpServer entry (no overwrite)", () => {
      const custom = {
        name: "1password",
        command: "mycustom",
        args: ["--flag"],
        env: { CUSTOM: "x" },
        optional: false,
      };
      const agent = {
        ...baseAgent,
        mcpServers: [custom] as Array<string | { name: string; command: string; args: string[]; env: Record<string, string>; optional: boolean }>,
      };
      const resolved = resolveAgentConfig(agent, defaults, sharedMcpServers);
      const op = resolved.mcpServers.find((s) => s.name === "1password");
      expect(op).toBeDefined();
      expect(op!.command).toBe("mycustom");
      expect(op!.args).toEqual(["--flag"]);
      expect(op!.env).toEqual({ CUSTOM: "x" });
    });
  });
});

describe("resolveContent", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clawcode-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns value as-is when it contains newlines (inline content)", async () => {
    const inline = "# My Soul\n\nBe helpful.";
    const result = await resolveContent(inline);
    expect(result).toBe(inline);
  });

  it("reads file contents when value looks like a path and file exists", async () => {
    const filePath = join(tempDir, "soul.md");
    await writeFile(filePath, "File soul content");

    const result = await resolveContent(filePath);
    expect(result).toBe("File soul content");
  });

  it("returns value as-is when value does not look like a path", async () => {
    const value = "Just some inline text";
    const result = await resolveContent(value);
    expect(result).toBe(value);
  });

  it("returns value as-is when path-like value does not exist on disk", async () => {
    const value = "./nonexistent/soul.md";
    const result = await resolveContent(value);
    expect(result).toBe(value);
  });
});

describe("expandHome", () => {
  it("replaces leading ~ with os.homedir()", () => {
    const result = expandHome("~/some/path");
    expect(result).toBe(join(homedir(), "some/path"));
  });

  it("does not modify absolute paths", () => {
    const result = expandHome("/absolute/path");
    expect(result).toBe("/absolute/path");
  });

  it("does not modify relative paths without tilde", () => {
    const result = expandHome("relative/path");
    expect(result).toBe("relative/path");
  });
});

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clawcode-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses a valid YAML config file", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
agents:
  - name: researcher
    channels: ["1234567890123456"]
    model: opus
`,
    );

    const config = await loadConfig(configPath);
    expect(config.version).toBe(1);
    expect(config.agents[0].name).toBe("researcher");
    expect(config.agents[0].model).toBe("opus");
  });

  it("throws ConfigFileNotFoundError for missing file", async () => {
    const missingPath = join(tempDir, "nonexistent.yaml");

    await expect(loadConfig(missingPath)).rejects.toThrow(ConfigFileNotFoundError);
  });

  it("throws ConfigValidationError for invalid config content", async () => {
    const configPath = join(tempDir, "bad.yaml");
    await writeFile(configPath, `version: 1\nagents: []\n`);

    await expect(loadConfig(configPath)).rejects.toThrow(ConfigValidationError);
  });

  // Quick 260715-j1j (D7) — configSchema.superRefine: `effort: ultracode`
  // requires `nativeWorkflow: true` on the SAME agent, failing loud at load
  // with a message naming the agent.
  it("rejects effort: ultracode without nativeWorkflow: true (D7 load validation)", async () => {
    const configPath = join(tempDir, "ultracode-no-optin.yaml");
    await writeFile(
      configPath,
      `version: 1
agents:
  - name: power-agent
    channels: ["1234567890123456"]
    model: opus
    effort: ultracode
`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(ConfigValidationError);
    await expect(loadConfig(configPath)).rejects.toThrow(
      /ultracode requires nativeWorkflow: true/,
    );
  });

  it("accepts effort: ultracode WITH nativeWorkflow: true on the same agent (D7 happy path)", async () => {
    const configPath = join(tempDir, "ultracode-optin.yaml");
    await writeFile(
      configPath,
      `version: 1
agents:
  - name: power-agent
    channels: ["1234567890123456"]
    model: opus
    effort: ultracode
    nativeWorkflow: true
`,
    );

    const config = await loadConfig(configPath);
    expect(config.agents[0].effort).toBe("ultracode");
    expect(config.agents[0].nativeWorkflow).toBe(true);
  });

  it("throws ConfigValidationError with agent name context", async () => {
    const configPath = join(tempDir, "bad-agent.yaml");
    await writeFile(
      configPath,
      `version: 1
agents:
  - name: researcher
    channels: [1234]
`,
    );

    try {
      await loadConfig(configPath);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const error = err as ConfigValidationError;
      expect(error.message).toContain("researcher");
    }
  });
});

describe("loadConfig - shared MCP servers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clawcode-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads full config with all 14 shared MCP servers and resolves agent references", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  model: sonnet
  basePath: ~/.clawcode/agents

mcpServers:
  finnhub:
    name: finnhub
    command: node
    args:
      - /home/example-user/clawd/mcp-servers/finnhub/server.js
    env:
      FINNHUB_API_KEY: op://example-vault-21/Finnhub/api-key
  acme-db:
    name: acme-db
    command: mcporter
    args:
      - serve
      - mysql
    env:
      MYSQL_HOST: op://example-vault-21/MySQL DB - Unraid/host
      MYSQL_PORT: "3306"
      MYSQL_USER: op://example-vault-21/MySQL DB - Unraid/username
      MYSQL_PASSWORD: op://example-vault-21/Acme DB/password
      MYSQL_DATABASE: acme
  google-workspace:
    name: google-workspace
    command: node
    args:
      - /home/example-user/clawd/projects/google-workspace-mcp/dist/index.js
  homeassistant:
    name: homeassistant
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/homeassistant.py
    env:
      HA_URL: http://10.0.0.4:8123
      HA_TOKEN: op://example-vault-21/HA Access Token/Access Token
  strava:
    name: strava
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/strava.py
    env:
      STRAVA_CLIENT_ID: op://example-vault-21/Strava OAuth Tokens/client_id
      STRAVA_CLIENT_SECRET: op://example-vault-21/Strava OAuth Tokens/client_secret
      STRAVA_ACCESS_TOKEN: op://example-vault-21/Strava OAuth Tokens/access_token
      STRAVA_REFRESH_TOKEN: op://example-vault-21/Strava OAuth Tokens/refresh_token
  openai:
    name: openai
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/openai_server.py
    env:
      OPENAI_API_KEY: '\${OPENAI_API_KEY}'
  anthropic:
    name: anthropic
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/anthropic_server.py
    env:
      ANTHROPIC_API_KEY: '\${ANTHROPIC_API_KEY}'
  brave-search:
    name: brave-search
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/brave_search.py
    env:
      BRAVE_API_KEY: '\${BRAVE_API_KEY}'
  elevenlabs:
    name: elevenlabs
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/elevenlabs.py
    env:
      ELEVENLABS_API_KEY: '\${ELEVENLABS_API_KEY}'
  ollama:
    name: ollama
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/ollama.py
    env:
      OLLAMA_URL: http://10.0.0.2:11434
  browserless:
    name: browserless
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/browserless.py
    env:
      BROWSERLESS_URL: http://10.0.0.2:3000
  chatterbox-tts:
    name: chatterbox-tts
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/chatterbox_tts.py
    env:
      CHATTERBOX_URL: http://10.0.0.2:4123
  fal-ai:
    name: fal-ai
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/fal_ai.py
    env:
      FAL_API_KEY: op://example-vault-21/fal.ai Admin API Credentials/credential
  acme-content:
    name: acme-content
    command: python3
    args:
      - /home/example-user/.openclaw/workspace-general/mcp-servers/acme_content.py
    env:
      ACME_DB_PASSWORD: op://example-vault-21/MySQL DB - Unraid/password
      HEYGEN_API_KEY: op://example-vault-21/HeyGen/api-key
      PEXELS_API_KEY: op://example-vault-21/Pexels/api-key

agents:
  - name: plain-agent
    channels:
      - "1111111111111111"
  - name: mcp-agent
    channels:
      - "2222222222222222"
    mcpServers:
      - finnhub
      - brave-search
      - homeassistant
`,
    );

    // Load and validate
    const config = await loadConfig(configPath);

    // Verify 14 shared MCP servers loaded
    const serverKeys = Object.keys(config.mcpServers);
    expect(serverKeys).toHaveLength(14);
    expect(serverKeys).toContain("finnhub");
    expect(serverKeys).toContain("acme-db");
    expect(serverKeys).toContain("google-workspace");
    expect(serverKeys).toContain("homeassistant");
    expect(serverKeys).toContain("strava");
    expect(serverKeys).toContain("openai");
    expect(serverKeys).toContain("anthropic");
    expect(serverKeys).toContain("brave-search");
    expect(serverKeys).toContain("elevenlabs");
    expect(serverKeys).toContain("ollama");
    expect(serverKeys).toContain("browserless");
    expect(serverKeys).toContain("chatterbox-tts");
    expect(serverKeys).toContain("fal-ai");
    expect(serverKeys).toContain("acme-content");

    // Verify a specific server's details
    expect(config.mcpServers["finnhub"].command).toBe("node");
    expect(config.mcpServers["acme-db"].env.MYSQL_HOST).toBeDefined();

    // Resolve all agents
    const resolved = resolveAllAgents(config);
    expect(resolved).toHaveLength(2);

    // plain-agent gets auto-injected clawcode MCP
    const plainAgent = resolved.find((a) => a.name === "plain-agent");
    expect(plainAgent).toBeDefined();
    expect(plainAgent!.mcpServers.find(s => s.name === "clawcode")).toBeDefined();
    // No user-defined MCP servers — only the auto-injected clawcode/1password/browser/search/image entries remain.
    expect(plainAgent!.mcpServers.filter(s => s.name !== "clawcode" && s.name !== "1password" && s.name !== "browser" && s.name !== "search" && s.name !== "image")).toEqual([]);

    // mcp-agent has 3 resolved servers from string references + auto-injected ones
    const mcpAgent = resolved.find((a) => a.name === "mcp-agent");
    expect(mcpAgent).toBeDefined();
    expect(mcpAgent!.mcpServers.length).toBeGreaterThanOrEqual(4);

    const serverNames = mcpAgent!.mcpServers.map((s) => s.name);
    expect(serverNames).toContain("finnhub");
    expect(serverNames).toContain("brave-search");
    expect(serverNames).toContain("homeassistant");

    // Verify resolved server has full details (not just name)
    const resolvedFinnhub = mcpAgent!.mcpServers.find((s) => s.name === "finnhub");
    expect(resolvedFinnhub).toBeDefined();
    expect(resolvedFinnhub!.command).toBe("node");
    expect(resolvedFinnhub!.args).toEqual(["/home/example-user/clawd/mcp-servers/finnhub/server.js"]);
    expect(resolvedFinnhub!.env.FINNHUB_API_KEY).toBe("op://example-vault-21/Finnhub/api-key");
  });
});

describe("resolveEnvVars", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    savedEnv.TOKEN = process.env.TOKEN;
    savedEnv.A = process.env.A;
    savedEnv.B = process.env.B;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("resolves a single env var", () => {
    process.env.OPENAI_API_KEY = "sk-123";
    expect(resolveEnvVars("${OPENAI_API_KEY}")).toBe("sk-123");
  });

  it("returns empty string for missing env var", () => {
    delete process.env.MISSING_VAR;
    expect(resolveEnvVars("${MISSING_VAR}")).toBe("");
  });

  it("handles partial interpolation with surrounding text", () => {
    process.env.TOKEN = "abc";
    expect(resolveEnvVars("Bearer ${TOKEN}")).toBe("Bearer abc");
  });

  it("passes through strings without env var patterns", () => {
    expect(resolveEnvVars("no-vars-here")).toBe("no-vars-here");
  });

  it("resolves multiple env vars in one string", () => {
    process.env.A = "foo";
    process.env.B = "bar";
    expect(resolveEnvVars("${A}_${B}")).toBe("foo_bar");
  });
});

describe("resolveAgentConfig - MCP env var interpolation", () => {
  const defaults: DefaultsConfig = {
    model: "sonnet",
    effort: "low" as const,
    // Phase 96 D-09 — fleet-wide outputDir template; matches DEFAULT_OUTPUT_DIR.
    outputDir: "outputs/{date}/",
    // Phase 86 MODEL-01 — test fixture mirrors the defaultsSchema default.
    allowedModels: ["haiku", "sonnet", "opus"] as ("haiku" | "sonnet" | "opus")[],
    // Phase 89 GREET-07/10 — zod defaults these to true / 300_000 in defaultsSchema.
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    // Phase 90 MEM-01 — zod defaults this to true in defaultsSchema.
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
    // Phase 94 TOOL-10 — fleet-wide directives (D-09 file-sharing + D-07 cross-agent-routing).
    systemPromptDirectives: { ...DEFAULT_SYSTEM_PROMPT_DIRECTIVES },
    clawhubBaseUrl: "https://clawhub.ai",
    clawhubCacheTtlMs: 600_000,
    skills: [],
    basePath: "~/.clawcode/agents",
    skillsPath: "~/.clawcode/skills",
    memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 }, tiers: { hotAccessThreshold: 3, hotAccessWindowDays: 7, hotDemotionDays: 7, coldRelevanceThreshold: 0.05, hotBudget: 20, centralityPromoteThreshold: 5 }, episodes: { archivalAgeDays: 90 } },
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: {
        warningThreshold: 0.6,
        criticalThreshold: 0.75,
        zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 },
      },
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
  };

  afterEach(() => {
    delete process.env.TEST_API_KEY;
  });

  it("resolves ${VAR_NAME} patterns in MCP server env values", () => {
    process.env.TEST_API_KEY = "sk-test-999";
    const agent: AgentConfig = {
      name: "test-agent",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [{ name: "my-server", command: "node", args: ["server.js"], env: { API_KEY: "${TEST_API_KEY}" }, optional: false }],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.mcpServers[0].env.API_KEY).toBe("sk-test-999");
  });

  it("passes op:// refs through unchanged when no opRefResolver is provided", () => {
    // Regression guard: existing tooling / offline flows that don't
    // inject a resolver MUST see op:// literals passed through (no silent
    // blanking, no throw). The spawn layer is the only place that fails
    // when resolution is missing, and the daemon is responsible for
    // passing a real resolver to avoid that.
    const agent: AgentConfig = {
      name: "passthrough-agent",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [{
        name: "acme-db",
        command: "node",
        args: ["mysql.js"],
        env: { MYSQL_HOST: "op://example-vault-21/MySQL DB - Unraid/host" },
        optional: false,
      }],
    };

    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.mcpServers.find(s => s.name === "acme-db")!.env.MYSQL_HOST)
      .toBe("op://example-vault-21/MySQL DB - Unraid/host");
  });

  it("substitutes op:// refs via the injected resolver so MCP children receive resolved secrets", () => {
    // This is the bug fix: without a resolver, a literal `op://...` string
    // would reach the MCP child and crash it at first network call (e.g.
    // `dns.lookup("op://...")` → ENOTFOUND). With the resolver, the daemon
    // hands the child the real value.
    const calls: string[] = [];
    const fakeResolver = (ref: string): string => {
      calls.push(ref);
      // Deterministic "fake 1Password" lookup for testing.
      const map: Record<string, string> = {
        "op://example-vault-21/MySQL DB - Unraid/host": "10.0.0.1",
        "op://example-vault-21/MySQL DB - Unraid/username": "example-user",
        "op://example-vault-21/Acme DB/password": "real-password",
      };
      if (!(ref in map)) {
        throw new Error(`no fake mapping for ${ref}`);
      }
      return map[ref]!;
    };

    const agent: AgentConfig = {
      name: "acme",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [{
        name: "acme-db",
        command: "node",
        args: ["mysql.js"],
        env: {
          MYSQL_HOST: "op://example-vault-21/MySQL DB - Unraid/host",
          MYSQL_USER: "op://example-vault-21/MySQL DB - Unraid/username",
          MYSQL_PASSWORD: "op://example-vault-21/Acme DB/password",
          MYSQL_DATABASE: "acme",  // plain value — no resolution needed
          MYSQL_PORT: "3306",             // plain value — no resolution needed
        },
        optional: false,
      }],
    };

    const resolved = resolveAgentConfig(agent, defaults, {}, fakeResolver);
    const server = resolved.mcpServers.find(s => s.name === "acme-db")!;

    expect(server.env.MYSQL_HOST).toBe("10.0.0.1");
    expect(server.env.MYSQL_USER).toBe("example-user");
    expect(server.env.MYSQL_PASSWORD).toBe("real-password");
    expect(server.env.MYSQL_DATABASE).toBe("acme");
    expect(server.env.MYSQL_PORT).toBe("3306");
    // Resolver was invoked exactly once per op:// value; plain values skipped.
    expect(calls).toEqual([
      "op://example-vault-21/MySQL DB - Unraid/host",
      "op://example-vault-21/MySQL DB - Unraid/username",
      "op://example-vault-21/Acme DB/password",
    ]);
  });

  it("applies ${VAR} interpolation BEFORE op:// resolution so indirect refs work", () => {
    // Edge case: a value like `${SECRET_REF}` where SECRET_REF is itself
    // an op:// URI. Interpolation must fire first so the resulting string
    // lands in the resolver. Supports patterns where the vault/item path
    // itself comes from an environment variable.
    process.env.TEST_SECRET_REF = "op://example-vault/item/password";
    const fakeResolver = (ref: string): string => {
      if (ref === "op://example-vault/item/password") return "resolved-secret";
      throw new Error(`unexpected ref ${ref}`);
    };

    try {
      const agent: AgentConfig = {
        name: "indirect-agent",
        channels: [],
        skills: [],
        effort: "low",
        heartbeat: true,
        schedules: [],
        admin: false,
        slashCommands: [],
        reactions: true,
        mcpServers: [{
          name: "indirect-server",
          command: "node",
          args: ["server.js"],
          env: { SECRET: "${TEST_SECRET_REF}" },
          optional: false,
        }],
      };

      const resolved = resolveAgentConfig(agent, defaults, {}, fakeResolver);
      expect(resolved.mcpServers.find(s => s.name === "indirect-server")!.env.SECRET)
        .toBe("resolved-secret");
    } finally {
      delete process.env.TEST_SECRET_REF;
    }
  });

  it("wraps resolver failures with server+var context so operators know which entry is broken", () => {
    // A failing resolver (e.g. 1P CLI missing, item not found, service
    // token invalid) should produce an error that names the offending
    // server and env var. This replaces the previous silent-passthrough
    // failure mode where the operator only saw ENOTFOUND from the MCP
    // child, with no indication that the root cause was an unresolved
    // op:// ref.
    const failingResolver = (_ref: string): string => {
      throw new Error("op: session expired");
    };
    const agent: AgentConfig = {
      name: "broken-agent",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [{
        name: "db-server",
        command: "node",
        args: ["db.js"],
        env: { MYSQL_HOST: "op://example-vault/db/host" },
        optional: false,
      }],
    };

    expect(() => resolveAgentConfig(agent, defaults, {}, failingResolver)).toThrow(
      /mcpServers\.db-server\.env\.MYSQL_HOST.*op:\/\/example-vault\/db\/host.*op: session expired/,
    );
  });

  it("graceful degradation: with an onMcpResolutionError handler, a failing MCP is skipped and other MCPs keep their resolved env", () => {
    // One bad op:// ref should disable only the offending MCP, not break
    // the agent entirely. Other MCPs (including ones referencing the same
    // vault but a different item/field) continue through normal resolution.
    const selectiveResolver = (ref: string): string => {
      if (ref === "op://example-vault/missing/password") {
        throw new Error('"missing" isn\'t an item in "vault"');
      }
      return `resolved:${ref}`;
    };
    const agent: AgentConfig = {
      name: "mixed-agent",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [
        {
          name: "good-server",
          command: "node",
          args: ["good.js"],
          env: { SECRET: "op://example-vault/good/token" },
          optional: false,
        },
        {
          name: "bad-server",
          command: "node",
          args: ["bad.js"],
          env: { DB_PASS: "op://example-vault/missing/password" },
          optional: false,
        },
      ],
    };

    const errors: Array<{ agent: string; server: string; message: string }> = [];
    const resolved = resolveAgentConfig(
      agent,
      defaults,
      {},
      selectiveResolver,
      (info) => errors.push({ ...info }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].agent).toBe("mixed-agent");
    expect(errors[0].server).toBe("bad-server");
    expect(errors[0].message).toMatch(/mcpServers\.bad-server\.env\.DB_PASS/);

    const serverNames = resolved.mcpServers.map((s) => s.name);
    expect(serverNames).toContain("good-server");
    expect(serverNames).not.toContain("bad-server");
    const good = resolved.mcpServers.find((s) => s.name === "good-server")!;
    expect(good.env.SECRET).toBe("resolved:op://example-vault/good/token");
  });

  it("without an onMcpResolutionError handler, resolver failure still throws (pre-existing behavior preserved)", () => {
    // Migration tooling + `clawcode list` want loud failure on any config
    // drift — only callers that opt in via the handler get the graceful
    // skip behavior.
    const failingResolver = (_ref: string): string => {
      throw new Error("op: item not found");
    };
    const agent: AgentConfig = {
      name: "strict-agent",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [{
        name: "db",
        command: "node",
        args: ["db.js"],
        env: { PASS: "op://example-vault/item/pass" },
        optional: false,
      }],
    };

    expect(() => resolveAgentConfig(agent, defaults, {}, failingResolver)).toThrow(
      /mcpServers\.db\.env\.PASS/,
    );
  });

  it("does NOT invoke the resolver for non-op:// values (avoids unnecessary CLI spawns)", () => {
    // Performance guard: the default resolver shells out via execSync,
    // so we must only call it for actual op:// refs. Plain values, empty
    // strings, and un-expanded `${VAR}` placeholders (post-interpolation
    // results) must never hit the resolver.
    let callCount = 0;
    const countingResolver = (_ref: string): string => {
      callCount++;
      return "should-not-be-called";
    };
    const agent: AgentConfig = {
      name: "plain-agent",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [{
        name: "plain-server",
        command: "node",
        args: ["server.js"],
        env: {
          PLAIN: "hardcoded",
          EMPTY: "",
          PORT: "3306",
          PATH_LIKE: "/usr/bin/node",
        },
        optional: false,
      }],
    };

    const resolved = resolveAgentConfig(agent, defaults, {}, countingResolver);
    expect(callCount).toBe(0);
    const server = resolved.mcpServers.find(s => s.name === "plain-server")!;
    expect(server.env.PLAIN).toBe("hardcoded");
    expect(server.env.EMPTY).toBe("");
    expect(server.env.PORT).toBe("3306");
    expect(server.env.PATH_LIKE).toBe("/usr/bin/node");
  });
});

// ---------------------------------------------------------------------------
// Phase 89 GREET-07 / GREET-10 — greetOnRestart + greetCoolDownMs schema
// additions (additive-optional — v2.1 migrated fleet parses unchanged).
//
// Mirrors the Phase 83 effortSchema + Phase 86 allowedModels regression
// shape: the resolver falls back to defaults when the per-agent field is
// omitted, defaults are populated by zod, and both paths are reloadable.
// ---------------------------------------------------------------------------

describe("Phase 89 GREET-07/GREET-10 schema additions", () => {
  // Local helper to build a minimum-viable DefaultsConfig (mirrors the
  // outer test fixtures but scoped to this describe to avoid fragile
  // cross-describe coupling).
  function makeDefaults(): DefaultsConfig {
    return {
      model: "sonnet",
      effort: "low" as const,
      // Phase 96 D-09 — fleet-wide outputDir template; matches DEFAULT_OUTPUT_DIR.
      outputDir: "outputs/{date}/",
      allowedModels: ["haiku", "sonnet", "opus"] as ("haiku" | "sonnet" | "opus")[],
      // Phase 89 — zod defaults these to true / 300_000 in defaultsSchema
      greetOnRestart: true,
      greetCoolDownMs: 300_000,
      // Phase 90 MEM-01 — zod defaults this to true in defaultsSchema.
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
    // Phase 94 TOOL-10 — fleet-wide directives (D-09 file-sharing + D-07 cross-agent-routing).
    systemPromptDirectives: { ...DEFAULT_SYSTEM_PROMPT_DIRECTIVES },
      clawhubBaseUrl: "https://clawhub.ai",
      clawhubCacheTtlMs: 600_000,
      skills: [],
      basePath: "~/.clawcode/agents",
      skillsPath: "~/.clawcode/skills",
      memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 }, tiers: { hotAccessThreshold: 3, hotAccessWindowDays: 7, hotDemotionDays: 7, coldRelevanceThreshold: 0.05, hotBudget: 20, centralityPromoteThreshold: 5 }, episodes: { archivalAgeDays: 90 } },
      heartbeat: {
        enabled: true,
        intervalSeconds: 60,
        checkTimeoutSeconds: 10,
        contextFill: {
          warningThreshold: 0.6,
          criticalThreshold: 0.75,
          zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 },
        },
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
    };
  }

  function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      name: "clawdy",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
      ...overrides,
    } as AgentConfig;
  }

  it("v2.1 fleet parses unchanged: agent without greetOnRestart resolves to true (defaults-driven)", () => {
    // The whole point of additive-optional: migrated 15-agent fleet has
    // no greetOnRestart field in YAML. Loader's resolver must fall back
    // to defaults.greetOnRestart (which zod defaults to true).
    const defaults = makeDefaults();
    const agent = makeAgent();
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.greetOnRestart).toBe(true);
    expect(resolved.greetCoolDownMs).toBe(300_000);
  });

  it("per-agent override beats default: greetOnRestart=false wins over defaults.greetOnRestart=true", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({ greetOnRestart: false });
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.greetOnRestart).toBe(false);
  });

  it("custom greetCoolDownMs per agent: 60000 resolves to 60000 (not 300000)", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({ greetCoolDownMs: 60_000 });
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.greetCoolDownMs).toBe(60_000);
  });

  it("defaults override baseline: defaults.greetOnRestart=false propagates when agent omits override", () => {
    const defaults: DefaultsConfig = { ...makeDefaults(), greetOnRestart: false };
    const agent = makeAgent();
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.greetOnRestart).toBe(false);
  });

  it("invalid greetCoolDownMs rejected by zod: -5 / 0 / 1.5 all fail parse", async () => {
    // We validate directly through agentSchema.parse to assert the zod
    // constraint ships (.int().positive()). Negative, zero, and
    // non-integer values must all throw.
    const { agentSchema } = await import("../schema.js");
    expect(() =>
      agentSchema.parse({ name: "x", greetCoolDownMs: -5 }),
    ).toThrow();
    expect(() =>
      agentSchema.parse({ name: "x", greetCoolDownMs: 0 }),
    ).toThrow();
    expect(() =>
      agentSchema.parse({ name: "x", greetCoolDownMs: 1.5 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 90 Plan 01 — MEM-01 memoryAutoLoad resolver fallback.
// Mirrors the greetOnRestart / allowedModels additive-optional rollout:
// defaults.memoryAutoLoad defaults to true; per-agent memoryAutoLoad=false
// overrides; per-agent memoryAutoLoadPath is expanded via expandHome.
// ---------------------------------------------------------------------------

describe("Phase 90 MEM-01 memoryAutoLoad resolver fallback", () => {
  function makeDefaults(): DefaultsConfig {
    return {
      model: "sonnet",
      effort: "low" as const,
      // Phase 96 D-09 — fleet-wide outputDir template; matches DEFAULT_OUTPUT_DIR.
      outputDir: "outputs/{date}/",
      allowedModels: ["haiku", "sonnet", "opus"] as ("haiku" | "sonnet" | "opus")[],
      greetOnRestart: true,
      greetCoolDownMs: 300_000,
      // Phase 90 MEM-01 — zod defaults this to true in defaultsSchema.
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
    // Phase 94 TOOL-10 — fleet-wide directives (D-09 file-sharing + D-07 cross-agent-routing).
    systemPromptDirectives: { ...DEFAULT_SYSTEM_PROMPT_DIRECTIVES },
      clawhubBaseUrl: "https://clawhub.ai",
      clawhubCacheTtlMs: 600_000,
      skills: [],
      basePath: "~/.clawcode/agents",
      skillsPath: "~/.clawcode/skills",
      memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 }, tiers: { hotAccessThreshold: 3, hotAccessWindowDays: 7, hotDemotionDays: 7, coldRelevanceThreshold: 0.05, hotBudget: 20, centralityPromoteThreshold: 5 }, episodes: { archivalAgeDays: 90 } },
      heartbeat: {
        enabled: true,
        intervalSeconds: 60,
        checkTimeoutSeconds: 10,
        contextFill: {
          warningThreshold: 0.6,
          criticalThreshold: 0.75,
          zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 },
        },
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
    };
  }

  function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      name: "clawdy",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
      ...overrides,
    } as AgentConfig;
  }

  it("MEM-01-L1: v2.1 fleet (15 agents, none declaring memoryAutoLoad) resolves — every ResolvedAgentConfig has memoryAutoLoad=true", () => {
    const defaults = makeDefaults();
    for (let i = 0; i < 15; i++) {
      const agent = makeAgent({ name: `agent-${i}` });
      const resolved = resolveAgentConfig(agent, defaults);
      expect(resolved.memoryAutoLoad).toBe(true);
      // memoryAutoLoadPath stays undefined when neither agent nor defaults set it.
      expect(resolved.memoryAutoLoadPath).toBeUndefined();
    }
  });

  it("MEM-01-L2: agent-level memoryAutoLoad=false keeps the override; resolver does NOT override with default true", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({ memoryAutoLoad: false });
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.memoryAutoLoad).toBe(false);
  });

  it("MEM-01-L2b: defaults.memoryAutoLoad=false propagates when agent omits override", () => {
    const defaults: DefaultsConfig = { ...makeDefaults(), memoryAutoLoad: false };
    const agent = makeAgent();
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.memoryAutoLoad).toBe(false);
  });

  it("MEM-01-L2c: memoryAutoLoadPath is expanded via expandHome when set", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({ memoryAutoLoadPath: "~/custom/memo.md" });
    const resolved = resolveAgentConfig(agent, defaults);
    // expandHome should replace the tilde with the current HOME dir.
    expect(resolved.memoryAutoLoadPath).toBe(expandHome("~/custom/memo.md"));
    expect(resolved.memoryAutoLoadPath).not.toContain("~");
  });

  it("MEM-01-L2d: absolute memoryAutoLoadPath passes through unchanged post-expandHome", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({ memoryAutoLoadPath: "/abs/memo.md" });
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.memoryAutoLoadPath).toBe("/abs/memo.md");
  });
});

// ---------------------------------------------------------------------------
// Phase 94 Plan 06 TOOL-10 — resolveSystemPromptDirectives
//
// Per-key merge resolver tests + render-block tests. The schema-level
// invariants (back-compat, default presence, override shape) are pinned in
// src/config/__tests__/schema-system-prompt-directives.test.ts; this file
// covers loader-side resolver semantics.
// ---------------------------------------------------------------------------

describe("resolveSystemPromptDirectives (Phase 94 TOOL-10)", () => {
  const fleetDefaults: Record<string, SystemPromptDirective> = {
    "file-sharing": {
      enabled: true,
      text: "ALWAYS upload via Discord.",
    },
    "cross-agent-routing": {
      enabled: true,
      text: "Suggest the user ask another agent.",
    },
  };

  it("LR-RESOLVE-DEFAULTS-ONLY: undefined override returns both defaults sorted alphabetically", () => {
    const out = resolveSystemPromptDirectives(undefined, fleetDefaults);
    expect(out.map((d) => d.key)).toEqual([
      "cross-agent-routing",
      "file-sharing",
    ]);
  });

  it("LR-RESOLVE-OVERRIDE-DISABLES: override file-sharing.enabled=false drops file-sharing only", () => {
    const out = resolveSystemPromptDirectives(
      { "file-sharing": { enabled: false } },
      fleetDefaults,
    );
    const keys = out.map((d) => d.key);
    expect(keys).toEqual(["cross-agent-routing"]);
  });

  it("LR-RESOLVE-FROZEN: returned array and entries are immutable (CLAUDE.md immutability)", () => {
    const out = resolveSystemPromptDirectives(undefined, fleetDefaults);
    expect(Object.isFrozen(out)).toBe(true);
    if (out.length > 0) {
      expect(Object.isFrozen(out[0])).toBe(true);
    }
  });

  it("LR-RESOLVE-EMPTY-WHEN-ALL-DISABLED: override disables all defaults → returns []", () => {
    const out = resolveSystemPromptDirectives(
      {
        "file-sharing": { enabled: false },
        "cross-agent-routing": { enabled: false },
      },
      fleetDefaults,
    );
    expect(out).toEqual([]);
  });

  it("999.163 — a per-agent {enabled: true} switches on a default-off directive and keeps its default text", () => {
    const out = resolveSystemPromptDirectives(
      { "follow-up-actions": { enabled: true } },
      DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
    );
    const fu = out.find((d) => d.key === "follow-up-actions");
    expect(fu).toBeDefined();
    expect(fu!.text).toContain("<actions>");
    expect(resolveSystemPromptDirectives(undefined, DEFAULT_SYSTEM_PROMPT_DIRECTIVES).some((d) => d.key === "follow-up-actions")).toBe(false);
  });

  it("LR-RESOLVE-DEFAULT-CONST-MATCHES: against the exported DEFAULT_SYSTEM_PROMPT_DIRECTIVES constant, all default directives are enabled by default", () => {
    const out = resolveSystemPromptDirectives(
      undefined,
      DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
    );
    // Phase 99 added subagent-routing; Phase 100-fu added
    // memory-recall-before-uncertainty, propose-alternatives,
    // long-output-to-file, and verify-file-writes; Phase 999.1 added
    // freshness, derivative-work, trusted-operator, discord-format;
    // Phase 999.22 added mutate-verify; Phase 115 Plan 08 T02
    // (sub-scope 17c) adds parallel-tool-calls. Sorted alphabetically
    // by key for prompt-cache hash determinism.
    expect(out.map((d) => d.key)).toEqual([
      "background-work-status",
      "cross-agent-routing",
      "derivative-work",
      "discord-format",
      "file-sharing",
      "freshness",
      "long-output-to-file",
      "memory-recall-before-uncertainty",
      "mutate-verify",
      "no-em-dashes",
      "parallel-tool-calls",
      "propose-alternatives",
      "subagent-routing",
      "trusted-operator",
      "verify-file-writes",
    ]);
    // D-09 file-sharing verbatim text reaches the resolver output
    const fs = out.find((d) => d.key === "file-sharing");
    expect(fs?.text).toContain("ALWAYS upload via Discord");
  });
});

describe("renderSystemPromptDirectiveBlock (Phase 94 TOOL-10)", () => {
  it("returns empty string when no directives are enabled (REG-ASSEMBLER-EMPTY-WHEN-DISABLED)", () => {
    expect(renderSystemPromptDirectiveBlock([])).toBe("");
  });

  it("joins directive texts with double-newline separator (alphabetical order preserved)", () => {
    const block = renderSystemPromptDirectiveBlock([
      { key: "a", text: "First." },
      { key: "b", text: "Second." },
    ]);
    expect(block).toBe("First.\n\nSecond.");
  });
});

// ---------------------------------------------------------------------------
// Phase 100 — settingSources + gsd resolution (Plan 100-01 Task 2)
//
// Tests resolveAgentConfig's handling of two new additive-optional fields:
//   - settingSources: ALWAYS populated; defaults to ["project"] when omitted.
//   - gsd: UNDEFINED when agent.gsd.projectDir is unset; expandHome'd when set.
//
// Tests pin:
//   LR1   omit → settingSources === ["project"]
//   LR2   ['user','project'] mirror exactly
//   LR3   omit gsd → gsd === undefined
//   LR4   absolute projectDir passes through expandHome unchanged
//   LR5   ~/path projectDir is expanded via expandHome
//   LR6   gsd: {} (projectDir absent) → gsd === undefined
//   LR7   resolver does NOT mutate the input agent object (immutability)
//   LR8   multi-agent integration via resolveAllAgents
// ---------------------------------------------------------------------------

describe("Phase 100 — settingSources + gsd resolution", () => {
  function makeDefaults(): DefaultsConfig {
    return {
      model: "sonnet",
      effort: "low" as const,
      // Phase 96 D-09 — fleet-wide outputDir template; matches DEFAULT_OUTPUT_DIR.
      outputDir: "outputs/{date}/",
      allowedModels: ["haiku", "sonnet", "opus"] as ("haiku" | "sonnet" | "opus")[],
      greetOnRestart: true,
      greetCoolDownMs: 300_000,
      memoryAutoLoad: true,
      memoryRetrievalTokenBudget: 1500, // Phase 115 sub-scope 3
      memoryRetrievalExcludeTags: ["session-summary", "mid-session", "raw-fallback"], // Phase 115 sub-scope 4
      excludeDynamicSections: true, // Phase 115 sub-scope 2
    cacheBreakpointPlacement: "static-first" as const, // Phase 115 sub-scope 5
      memoryRetrievalTopK: 5,
      memoryScannerEnabled: true,
      memoryFlushIntervalMs: 900_000,
      memoryCueEmoji: "✅",
      autoIngestAttachments: false, // Phase 999.43 D-09
      ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
      autonomousSkillDrafting: false, // Phase 132 D-08
      skillDistiller: { minToolCalls: 6, minDurationMs: 180_000, outcomeFilter: ["success"] as ("success" | "partial" | "failed")[], suggestPatches: false }, // Phase 132 D-03 + Phase 999.42 D7 suggestPatches
      systemPromptDirectives: { ...DEFAULT_SYSTEM_PROMPT_DIRECTIVES },
      clawhubBaseUrl: "https://clawhub.ai",
      clawhubCacheTtlMs: 600_000,
      skills: [],
      basePath: "~/.clawcode/agents",
      skillsPath: "~/.clawcode/skills",
      memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 }, tiers: { hotAccessThreshold: 3, hotAccessWindowDays: 7, hotDemotionDays: 7, coldRelevanceThreshold: 0.05, hotBudget: 20, centralityPromoteThreshold: 5 }, episodes: { archivalAgeDays: 90 } },
      heartbeat: {
        enabled: true,
        intervalSeconds: 60,
        checkTimeoutSeconds: 10,
        contextFill: {
          warningThreshold: 0.6,
          criticalThreshold: 0.75,
          zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 },
        },
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
      dream: { enabled: false, idleMinutes: 30, model: "haiku" as const },
      fileAccess: ["/home/clawcode/.clawcode/agents/{agent}/"],
      autoStart: true, // Phase 100 follow-up
      // Phase 116-06 T08 — cutover redirect default. FALSE = dual-mode.
      dashboardCutoverRedirect: false,
      "auto-compact-at": 0.7, // Phase 124 D-06
    };
  }

  function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      name: "clawdy",
      channels: [],
      skills: [],
      effort: "low",
      heartbeat: true,
      schedules: [],
      admin: false,
      slashCommands: [],
      reactions: true,
      mcpServers: [],
      ...overrides,
    } as AgentConfig;
  }

  it("LR1: omitting settingSources resolves to default ['project']", () => {
    const defaults = makeDefaults();
    const agent = makeAgent();
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.settingSources).toEqual(["project"]);
  });

  it("LR2: agent.settingSources: ['user','project'] resolves to exactly that array (deep equal)", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({
      settingSources: ["user", "project"] as ("project" | "user" | "local")[],
      autoStart: true, // Phase 100 follow-up
    });
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.settingSources).toEqual(["user", "project"]);
  });

  it("LR3: omitting gsd resolves to gsd === undefined", () => {
    const defaults = makeDefaults();
    const agent = makeAgent();
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.gsd).toBeUndefined();
  });

  it("LR4: absolute gsd.projectDir passes through expandHome unchanged", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({
      gsd: { projectDir: "/opt/clawcode-projects/sandbox" },
    });
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.gsd).toBeDefined();
    expect(resolved.gsd?.projectDir).toBe("/opt/clawcode-projects/sandbox");
  });

  it("LR5: gsd.projectDir with ~ is expanded via expandHome", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({ gsd: { projectDir: "~/projects/foo" } });
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.gsd).toBeDefined();
    // expandHome should replace ~ with the homedir
    expect(resolved.gsd?.projectDir).toBe(expandHome("~/projects/foo"));
    expect(resolved.gsd?.projectDir).not.toContain("~");
    // It should start with the actual homedir
    expect(resolved.gsd?.projectDir?.startsWith(homedir())).toBe(true);
  });

  it("LR6: agent.gsd: {} (projectDir absent) → gsd === undefined", () => {
    const defaults = makeDefaults();
    // Cast through unknown — agentSchema accepts {} but the typed fixture
    // builder is stricter. The runtime branch we're verifying triggers when
    // agent.gsd is set but agent.gsd.projectDir is not.
    const agent = makeAgent({ gsd: {} } as Partial<AgentConfig>);
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.gsd).toBeUndefined();
  });

  it("LR7: resolveAgentConfig does NOT mutate the input agent object (immutability)", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({
      settingSources: ["project", "user"] as ("project" | "user" | "local")[],
      autoStart: true, // Phase 100 follow-up
      gsd: { projectDir: "/opt/x" },
    });
    // Snapshot before resolution
    const before = JSON.parse(JSON.stringify(agent));
    resolveAgentConfig(agent, defaults);
    // After resolution, the input agent must be byte-for-byte identical.
    expect(agent).toEqual(before);
    // Specifically: settingSources reference is preserved literally on input
    expect(agent.settingSources).toEqual(["project", "user"]);
    expect(agent.gsd).toEqual({ projectDir: "/opt/x" });
  });

  it("LR8: resolveAllAgents over a 3-agent fixture — only one agent carries gsd; the other two carry gsd === undefined", () => {
    const defaults = makeDefaults();
    const agents: AgentConfig[] = [
      makeAgent({ name: "alpha" }),
      makeAgent({
        name: "beta",
        settingSources: ["project", "user"] as ("project" | "user" | "local")[],
        autoStart: true, // Phase 100 follow-up
        gsd: { projectDir: "/opt/clawcode-projects/sandbox" },
      }),
      makeAgent({ name: "gamma" }),
    ];
    const config: Config = {
      version: 1,
      defaults,
      agents,
      mcpServers: {},
    };
    const resolved = resolveAllAgents(config);
    expect(resolved.length).toBe(3);
    // alpha + gamma omitted gsd → resolved gsd undefined; settingSources default
    expect(resolved[0]?.name).toBe("alpha");
    expect(resolved[0]?.gsd).toBeUndefined();
    expect(resolved[0]?.settingSources).toEqual(["project"]);
    expect(resolved[2]?.name).toBe("gamma");
    expect(resolved[2]?.gsd).toBeUndefined();
    expect(resolved[2]?.settingSources).toEqual(["project"]);
    // beta carries the explicit override
    expect(resolved[1]?.name).toBe("beta");
    expect(resolved[1]?.gsd).toEqual({ projectDir: "/opt/clawcode-projects/sandbox" });
    expect(resolved[1]?.settingSources).toEqual(["project", "user"]);
  });
});

/**
 * Phase 100 follow-up — per-agent MCP env override propagation through the
 * resolver. The schema accepts the field; the loader must thread it through
 * `resolveAgentConfig` into `ResolvedAgentConfig.mcpEnvOverrides` verbatim
 * (no op:// resolution at config-load time — that's deferred to agent-start
 * when the daemon owns the async opRead shell-out).
 */
describe("resolveAgentConfig - mcpEnvOverrides (Phase 100 follow-up)", () => {
  // Reuse the production zod defaults for a minimal, schema-true fixture.
  // Inline fields would need to track every defaults field add (currently
  // ~25+) and break on the next milestone — defer to the schema's source
  // of truth.
  function makeDefaults(): DefaultsConfig {
    return defaultsSchema.parse({});
  }

  function makeAgent(overrides: Record<string, unknown> = {}): AgentConfig {
    return agentSchema.parse({
      name: "fin-client",
      ...overrides,
    });
  }

  it("MCP-LOAD-1: agent with mcpEnvOverrides → ResolvedAgentConfig carries the field verbatim (no op:// resolution at load time)", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({
      mcpEnvOverrides: {
        "1password": {
          OP_SERVICE_ACCOUNT_TOKEN:
            "op://example-vault-21/Acme Service Account/credential",
        },
      },
    });
    const resolved = resolveAgentConfig(agent, defaults);
    // The op:// reference passes through verbatim — agent-start path
    // (op-env-resolver.ts) does the actual `op read` later.
    expect(resolved.mcpEnvOverrides).toEqual({
      "1password": {
        OP_SERVICE_ACCOUNT_TOKEN:
          "op://example-vault-21/Acme Service Account/credential",
      },
    });
  });

  it("MCP-LOAD-2: agent without mcpEnvOverrides → ResolvedAgentConfig.mcpEnvOverrides is undefined (back-compat)", () => {
    const defaults = makeDefaults();
    const agent = makeAgent(); // no mcpEnvOverrides
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.mcpEnvOverrides).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 999.13 — DELEG (renderer + canonical text)
//
// Wave 0 RED tests. These FAIL on current main because:
//   - `renderDelegatesBlock`, `DELEGATES_DIRECTIVE_HEADER`, and
//     `DELEGATES_DIRECTIVE_FOOTER` do not exist yet (Plan 01 adds them next
//     to `renderSystemPromptDirectiveBlock` at loader.ts:672).
//
// Imports are dynamic via `await import(...)` so this file still parses on
// main even before the symbols land — the test bodies themselves fail.
// Plan 01 replaces the dynamic-import scaffolding once the symbols ship.
// ---------------------------------------------------------------------------
describe("Phase 999.13 — DELEG renderer + canonical text", () => {
  // Verbatim from PLAN.md <canonical_text>. NEVER paraphrase — these are the
  // source of truth pinned by the static-grep regression test
  // `delegates-canonical-text` below.
  const EXPECTED_HEADER =
    "## Specialist Delegation\nFor tasks matching a specialty below, delegate via the spawn-subagent-thread skill:";
  const EXPECTED_FOOTER =
    "Verify the target is at opus/high before delegating; if mismatch, surface to operator and stop. The subthread posts its summary back to your channel when done.";

  it("delegates-canonical-text: DELEGATES_DIRECTIVE_HEADER + FOOTER constants match canonical text byte-exactly", async () => {
    const mod = await import("../loader.js");
    expect(mod.DELEGATES_DIRECTIVE_HEADER).toBe(EXPECTED_HEADER);
    expect(mod.DELEGATES_DIRECTIVE_FOOTER).toBe(EXPECTED_FOOTER);
  });

  it("renderDelegatesBlock-undefined: returns '' exactly", async () => {
    const mod = await import("../loader.js");
    const out = mod.renderDelegatesBlock(undefined);
    expect(out).toBe("");
  });

  it("renderDelegatesBlock-empty: {} returns '' exactly (no header, no whitespace)", async () => {
    const mod = await import("../loader.js");
    const out = mod.renderDelegatesBlock({});
    expect(out).toBe("");
  });

  it("renderDelegatesBlock-single: { research: 'fin-research' } produces canonical 3-line block byte-exactly", async () => {
    const mod = await import("../loader.js");
    const out = mod.renderDelegatesBlock({ research: "fin-research" });
    const expected = [
      "## Specialist Delegation",
      "For tasks matching a specialty below, delegate via the spawn-subagent-thread skill:",
      "- research → fin-research",
      "Verify the target is at opus/high before delegating; if mismatch, surface to operator and stop. The subthread posts its summary back to your channel when done.",
    ].join("\n");
    expect(out).toBe(expected);
  });

  it("renderDelegatesBlock-multi-specialty (DELEG-04): bullets sorted alphabetically", async () => {
    const mod = await import("../loader.js");
    const out = mod.renderDelegatesBlock({
      research: "r1",
      coding: "c1",
      legal: "l1",
    });
    // Alphabetical: coding, legal, research
    const expected = [
      "## Specialist Delegation",
      "For tasks matching a specialty below, delegate via the spawn-subagent-thread skill:",
      "- coding → c1",
      "- legal → l1",
      "- research → r1",
      "Verify the target is at opus/high before delegating; if mismatch, surface to operator and stop. The subthread posts its summary back to your channel when done.",
    ].join("\n");
    expect(out).toBe(expected);
  });

  it("renderDelegatesBlock-deterministic: byte-identical output regardless of insertion order (Pitfall 2)", async () => {
    const mod = await import("../loader.js");
    // Build the same logical record via two different insertion orders.
    const order1 = Object.fromEntries([
      ["b", "B"],
      ["a", "A"],
    ]);
    const order2 = Object.fromEntries([
      ["a", "A"],
      ["b", "B"],
    ]);
    const out1 = mod.renderDelegatesBlock(order1);
    const out2 = mod.renderDelegatesBlock(order2);
    expect(out1).toBe(out2);
    // Both must contain bullets in alphabetical order (a then b)
    const aIdx = out1.indexOf("- a → A");
    const bIdx = out1.indexOf("- b → B");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(bIdx);
  });
});

// ---------------------------------------------------------------------------
// Phase 110 Stage 0a — defaults.shimRuntime + defaults.brokers parse
// ---------------------------------------------------------------------------

describe("loadConfig — Phase 110 Stage 0a schema additions", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clawcode-stage0a-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses defaults.shimRuntime with explicit `node` for all three sub-fields", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  shimRuntime:
    search: node
    image: node
    browser: node
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    const config = await loadConfig(configPath);
    // Cast through unknown — the inferred Config type does not yet expose
    // the new field on the public surface; the schema parses it.
    const sr = (config.defaults as unknown as {
      shimRuntime?: { search: string; image: string; browser: string };
    }).shimRuntime;
    expect(sr).toEqual({
      search: "node",
      image: "node",
      browser: "node",
      broker: "static", // P5 — broker key fills its own static default
    });
  });

  it("rejects defaults.shimRuntime.search with an unknown enum value", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  shimRuntime:
    search: rust
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    await expect(loadConfig(configPath)).rejects.toThrow(ConfigValidationError);
  });

  it("parses defaults.brokers with a single entry and default-bearing fields", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  brokers:
    "1password":
      enabled: true
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    const config = await loadConfig(configPath);
    const brokers = (config.defaults as unknown as {
      brokers?: Record<
        string,
        {
          enabled: boolean;
          maxConcurrent: number;
          spawnArgs: string[];
          env: Record<string, string>;
          drainOnIdleMs: number;
        }
      >;
    }).brokers;
    expect(brokers).toBeDefined();
    expect(brokers!["1password"]).toEqual({
      enabled: true,
      // Defaults from brokerEntrySchema fire when omitted.
      maxConcurrent: 4,
      spawnArgs: [],
      env: {},
      drainOnIdleMs: 0,
    });
  });

  it("omitting both shimRuntime and brokers leaves the defaults block parsing unchanged (back-compat)", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    const config = await loadConfig(configPath);
    expect(
      (config.defaults as unknown as { shimRuntime?: unknown }).shimRuntime,
    ).toBeUndefined();
    expect(
      (config.defaults as unknown as { brokers?: unknown }).brokers,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 999.X — defaults.subagentReaper schema parse + defaults
// ---------------------------------------------------------------------------

describe("loadConfig — defaults.subagentReaper", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clawcode-subagent-reaper-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses an explicit subagentReaper block end-to-end", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  subagentReaper:
    mode: alert
    idleTimeoutMinutes: 60
    minAgeSeconds: 120
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    const config = await loadConfig(configPath);
    const sr = (config.defaults as unknown as {
      subagentReaper?: {
        mode: string;
        idleTimeoutMinutes: number;
        minAgeSeconds: number;
      };
    }).subagentReaper;
    expect(sr).toEqual({
      mode: "alert",
      idleTimeoutMinutes: 60,
      minAgeSeconds: 120,
    });
  });

  it("default-fills mode/idleTimeoutMinutes/minAgeSeconds when partial", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  subagentReaper: {}
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    const config = await loadConfig(configPath);
    const sr = (config.defaults as unknown as {
      subagentReaper?: {
        mode: string;
        idleTimeoutMinutes: number;
        minAgeSeconds: number;
      };
    }).subagentReaper;
    expect(sr).toEqual({
      mode: "reap",
      idleTimeoutMinutes: 1440,
      minAgeSeconds: 300,
    });
  });

  it("rejects an unknown mode value", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  subagentReaper:
    mode: nuclear
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    await expect(loadConfig(configPath)).rejects.toThrow(ConfigValidationError);
  });

  it("rejects negative idleTimeoutMinutes", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  subagentReaper:
    idleTimeoutMinutes: -1
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    await expect(loadConfig(configPath)).rejects.toThrow(ConfigValidationError);
  });

  it("omitting subagentReaper leaves the field undefined (back-compat)", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    const config = await loadConfig(configPath);
    expect(
      (config.defaults as unknown as { subagentReaper?: unknown }).subagentReaper,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 999.25 — defaults.subagentCompletion schema parse + defaults
// ---------------------------------------------------------------------------

describe("loadConfig — defaults.subagentCompletion", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clawcode-subagent-completion-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses an explicit subagentCompletion block end-to-end", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  subagentCompletion:
    enabled: false
    quiescenceMinutes: 10
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    const config = await loadConfig(configPath);
    const sc = (config.defaults as unknown as {
      subagentCompletion?: {
        enabled: boolean;
        quiescenceMinutes: number;
        relayOnQuiescence: boolean;
      };
    }).subagentCompletion;
    expect(sc).toEqual({
      enabled: false,
      quiescenceMinutes: 10,
      relayOnQuiescence: true,
    });
  });

  it("default-fills enabled=true / quiescenceMinutes=5 / relayOnQuiescence=true when partial", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  subagentCompletion: {}
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    const config = await loadConfig(configPath);
    const sc = (config.defaults as unknown as {
      subagentCompletion?: {
        enabled: boolean;
        quiescenceMinutes: number;
        relayOnQuiescence: boolean;
      };
    }).subagentCompletion;
    expect(sc).toEqual({
      enabled: true,
      quiescenceMinutes: 5,
      relayOnQuiescence: true,
    });
  });

  it("rejects negative quiescenceMinutes", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
defaults:
  subagentCompletion:
    quiescenceMinutes: -1
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    await expect(loadConfig(configPath)).rejects.toThrow(ConfigValidationError);
  });

  it("omitting subagentCompletion leaves the field undefined (back-compat)", async () => {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(
      configPath,
      `version: 1
agents:
  - name: a
    channels: ["1234567890123456"]
`,
    );
    const config = await loadConfig(configPath);
    expect(
      (config.defaults as unknown as { subagentCompletion?: unknown })
        .subagentCompletion,
    ).toBeUndefined();
  });
});
