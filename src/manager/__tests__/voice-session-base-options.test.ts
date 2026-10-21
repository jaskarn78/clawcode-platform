import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isVoiceEnabled,
  applyVoiceOverrides,
  computeStaticPrefixHash,
  mapSessionConfigToVoiceBaseOptions,
} from "../voice-session-base-options.js";
import { buildSessionConfig, type SessionConfigDeps } from "../session-config.js";
import { CACHE_BREAKPOINT_MARKER } from "../context-assembler.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { OpenaiVoiceConfig } from "../../config/schema.js";

/**
 * OpenAI VOICE route — full-but-lean session base-options.
 *
 * Pins the load-bearing behavior:
 *   - the opt-in gate returns null/non-null correctly (the driver's byte-
 *     identity for non-voice agents hangs on this short-circuit);
 *   - opted-in → baseOptions with non-empty mcpServers + a preset systemPrompt
 *     + the agent workspace cwd, assembled through the REAL buildSessionConfig
 *     path (identity/skills/MCP folded into the stable prefix);
 *   - the static-prefix hash splits on the cache-breakpoint marker so rotating
 *     hot memories don't churn the transient cache key (the latency lever).
 */

// Mock filesystem reads so buildSessionConfig doesn't hit disk (mirrors
// session-config-mcp.test.ts).
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

vi.mock("../../memory/context-summary.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../memory/context-summary.js")
  >();
  return { ...actual, loadLatestSummary: vi.fn().mockResolvedValue(undefined) };
});

function makeConfig(
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name: "voice-agent",
    workspace: "/tmp/voice-workspace",
    memoryPath: "/tmp/voice-workspace",
    channels: [],
    model: "sonnet",
    effort: "low",
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
    threads: { idleTimeoutMinutes: 30, maxThreadSessions: 5 },
    reactions: false,
    slashCommands: [],
    mcpServers: [
      {
        name: "clawcode",
        command: "node",
        args: ["clawcode-mcp.js"],
        env: {},
        optional: false,
      },
      {
        name: "search",
        command: "node",
        args: ["search-mcp.js"],
        env: {},
        optional: true,
      },
    ],
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionConfigDeps> = {},
): SessionConfigDeps {
  return {
    tierManagers: new Map(),
    skillsCatalog: new Map(),
    allAgentConfigs: [],
    ...overrides,
  };
}

const VOICE_ON: OpenaiVoiceConfig = {
  enabled: true,
  streamKeepaliveMs: 5000,
};

describe("isVoiceEnabled (opt-in gate)", () => {
  it("returns false when config is undefined", () => {
    expect(isVoiceEnabled(undefined)).toBe(false);
  });

  it("returns false when openaiVoice is absent", () => {
    expect(isVoiceEnabled(makeConfig())).toBe(false);
  });

  it("returns false when openaiVoice.enabled is false", () => {
    expect(
      isVoiceEnabled(
        makeConfig({ openaiVoice: { enabled: false, streamKeepaliveMs: 5000 } }),
      ),
    ).toBe(false);
  });

  it("returns true only when openaiVoice.enabled === true", () => {
    expect(isVoiceEnabled(makeConfig({ openaiVoice: VOICE_ON }))).toBe(true);
  });
});

describe("applyVoiceOverrides (cascade + allowlist)", () => {
  it("inherits non-MCP overrides but drops ALL servers when the allowlist is omitted (safe default)", () => {
    const cfg = makeConfig();
    const out = applyVoiceOverrides(cfg, VOICE_ON);
    expect(out.effort).toBe(cfg.effort);
    expect(out.memoryAutoLoad).toBe(cfg.memoryAutoLoad);
    expect(out.memoryRetrievalTopK).toBe(cfg.memoryRetrievalTopK);
    // SAFE DEFAULT (security): omitted allowlist → NO MCP servers — the operator
    // must explicitly opt tools in. (Was "all servers" pre-security-review.)
    expect(out.mcpServers).toHaveLength(0);
    // Immutable — base config not mutated.
    expect(cfg.effort).toBe("low");
  });

  it("applies the voice overrides over the base config", () => {
    const out = applyVoiceOverrides(makeConfig(), {
      enabled: true,
      streamKeepaliveMs: 5000,
      effort: "high",
      memoryAutoLoad: false,
      memoryRetrievalTopK: 2,
      memoryRetrievalTokenBudget: 500,
    });
    expect(out.effort).toBe("high");
    expect(out.memoryAutoLoad).toBe(false);
    expect(out.memoryRetrievalTopK).toBe(2);
    expect(out.memoryRetrievalTokenBudget).toBe(500);
  });

  it("trims MCP servers by the allowlist (named subset)", () => {
    const out = applyVoiceOverrides(makeConfig(), {
      ...VOICE_ON,
      mcpAllowlist: ["clawcode"],
    });
    expect(out.mcpServers.map((s) => s.name)).toEqual(["clawcode"]);
  });

  it("drops all MCP servers for an empty allowlist", () => {
    const out = applyVoiceOverrides(makeConfig(), {
      ...VOICE_ON,
      mcpAllowlist: [],
    });
    expect(out.mcpServers).toHaveLength(0);
  });
});

describe("computeStaticPrefixHash (cache-key stability)", () => {
  it("hashes only the bytes before the cache-breakpoint marker", () => {
    const staticPart = "IDENTITY + SKILLS + MCP block";
    const withHot =
      staticPart + CACHE_BREAKPOINT_MARKER + "rotating hot memory A";
    const withDifferentHot =
      staticPart + CACHE_BREAKPOINT_MARKER + "rotating hot memory B";
    // Rotating hot memories (after the marker) must NOT change the hash.
    expect(computeStaticPrefixHash(withHot)).toBe(
      computeStaticPrefixHash(withDifferentHot),
    );
    // 16-hex-char slice.
    expect(computeStaticPrefixHash(withHot)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic when the marker is absent", () => {
    const noMarker = "just a static prefix, no marker";
    expect(computeStaticPrefixHash(noMarker)).toBe(
      computeStaticPrefixHash(noMarker),
    );
  });
});

describe("mapSessionConfigToVoiceBaseOptions (end-to-end via buildSessionConfig)", () => {
  it("produces baseOptions with preset systemPrompt + workspace cwd + allowlisted mcpServers", async () => {
    const cfg = makeConfig();
    // Explicit allowlist — the safe default is NO servers, so a voice agent must
    // opt tools in to get a non-empty mcpServers map.
    const voiceCfg = applyVoiceOverrides(cfg, {
      ...VOICE_ON,
      mcpAllowlist: ["clawcode", "search"],
    });
    const sessionConfig = await buildSessionConfig(voiceCfg, makeDeps());

    const { baseOptions, staticPrefixHash } =
      mapSessionConfigToVoiceBaseOptions(sessionConfig);

    // Preset systemPrompt (claude_code + append), NOT a raw soul string.
    expect(baseOptions.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
    });

    // Workspace cwd — the FULL agent session runs in the agent's workspace,
    // not the stateless transient cwd.
    expect(baseOptions.cwd).toBe("/tmp/voice-workspace");

    // Non-empty mcpServers keyed by server name (tools available).
    expect(baseOptions.mcpServers).toBeDefined();
    expect(Object.keys(baseOptions.mcpServers ?? {})).toContain("clawcode");
    expect(Object.keys(baseOptions.mcpServers ?? {})).toContain("search");

    // Concrete SDK model id (alias resolved), permission + auth wiring present.
    expect(baseOptions.model).toBe("claude-sonnet-5");
    expect(baseOptions.permissionMode).toBe("bypassPermissions");
    expect(baseOptions.allowDangerouslySkipPermissions).toBe(true);
    expect(baseOptions.env).toBeDefined();
    // Clean env — never carries the Anthropic API key (OAuth subscription auth).
    expect(
      (baseOptions.env as Record<string, unknown>).ANTHROPIC_API_KEY,
    ).toBeUndefined();

    // 16-hex static-prefix hash for the transient cache key.
    expect(staticPrefixHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reflects the MCP allowlist trim in the SDK mcpServers map", async () => {
    const cfg = makeConfig();
    const voiceCfg = applyVoiceOverrides(cfg, {
      ...VOICE_ON,
      mcpAllowlist: ["clawcode"],
    });
    const sessionConfig = await buildSessionConfig(voiceCfg, makeDeps());
    const { baseOptions } = mapSessionConfigToVoiceBaseOptions(sessionConfig);

    expect(Object.keys(baseOptions.mcpServers ?? {})).toEqual(["clawcode"]);
  });

  describe("Claude binary pin", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // 999.169 — the SDK chokepoint pins every query (withPinnedClaudeBinary);
    // the voice options must not hand-roll a pin, even with the override set.
    it("never hand-rolls the pin, even with CLAWCODE_CLAUDE_BIN set", async () => {
      vi.stubEnv("CLAWCODE_CLAUDE_BIN", "/opt/clawcode/claude-pin/claude");
      const sessionConfig = await buildSessionConfig(
        applyVoiceOverrides(makeConfig(), VOICE_ON),
        makeDeps(),
      );
      const { baseOptions } = mapSessionConfigToVoiceBaseOptions(sessionConfig);
      expect(baseOptions).not.toHaveProperty("pathToClaudeCodeExecutable");
    });

    it("omits it when CLAWCODE_CLAUDE_BIN is unset", async () => {
      vi.stubEnv("CLAWCODE_CLAUDE_BIN", "");
      const sessionConfig = await buildSessionConfig(
        applyVoiceOverrides(makeConfig(), VOICE_ON),
        makeDeps(),
      );
      const { baseOptions } = mapSessionConfigToVoiceBaseOptions(sessionConfig);
      expect(baseOptions).not.toHaveProperty("pathToClaudeCodeExecutable");
    });
  });
});
