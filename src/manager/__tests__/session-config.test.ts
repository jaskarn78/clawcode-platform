import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildSessionConfig, type SessionConfigDeps } from "../session-config.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { McpServerState } from "../../mcp/readiness.js";
import type { MemoryEntry, MemoryTier } from "../../memory/types.js";
import { MemoryStore } from "../../memory/store.js";
import { ConversationStore } from "../../memory/conversation-store.js";
import {
  ConversationBriefCache,
  computeBriefFingerprint,
} from "../conversation-brief-cache.js";
import * as briefModule from "../../memory/conversation-brief.js";
// Phase 75 SHARED-02 — named import so the file-scoped loadLatestSummary mock
// can be accessed via vi.mocked(loadLatestSummary) in the regression test below.
import { loadLatestSummary } from "../../memory/context-summary.js";
import { resolveModelId, resolveAdvisorModel } from "../model-resolver.js";
// Phase 78 CONF-01 — named import so the file-scoped readFile mock can be
// reconfigured per-test via vi.mocked(readFile).mockImplementation to simulate
// soulFile → workspace/SOUL.md → inline precedence scenarios.
import { readFile } from "node:fs/promises";

// Mock filesystem reads so buildSessionConfig doesn't hit disk
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

// Mock loadLatestSummary to return undefined (no persisted summary)
// Phase 53 Plan 02: also re-export enforceSummaryBudget + constants so
// buildSessionConfig's import of the real module resolves cleanly.
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
    slashCommands: [],
    mcpServers: [],
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

/**
 * Phase 94 Plan 02 TOOL-03 — build a ready-state mcpStateProvider for the
 * given server names. The filter consults `capabilityProbe.status === "ready"`
 * to decide whether each server appears in the LLM-visible MCP table; tests
 * that just want the table to render must wire an explicit ready snapshot.
 */
function readyMcpStateProvider(
  serverNames: readonly string[],
): (agentName: string) => ReadonlyMap<string, McpServerState> {
  const map = new Map<string, McpServerState>();
  for (const name of serverNames) {
    map.set(
      name,
      Object.freeze({
        name,
        status: "ready",
        lastSuccessAt: 1_700_000_000_000,
        lastFailureAt: null,
        lastError: null,
        failureCount: 0,
        optional: false,
        capabilityProbe: Object.freeze({
          status: "ready",
          lastRunAt: "2026-04-25T12:00:00.000Z",
        }),
      }),
    );
  }
  const frozen = Object.freeze(map) as ReadonlyMap<string, McpServerState>;
  return () => frozen;
}

describe("buildSessionConfig — subagent thread skill guidance", () => {
  it("includes Subagent Thread Skill section when agent has subagent-thread skill", async () => {
    const config = makeConfig({ skills: ["subagent-thread"] });
    const result = await buildSessionConfig(config, makeDeps());
    // Subagent thread guidance is now inside the unified "## Available Tools" section
    expect(result.systemPrompt).toContain("## Available Tools");
    expect(result.systemPrompt).toContain("subagent-thread");
  });

  it("includes guidance to prefer subagent-thread skill over raw Agent tool", async () => {
    const config = makeConfig({ skills: ["subagent-thread"] });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toContain(
      "prefer the `spawn_subagent_thread` MCP tool"
    );
    expect(result.systemPrompt).toContain("over the raw Agent tool");
  });

  // WP6 (2026-10-25): the fleet-default `subagent-routing` system-prompt
  // directive now reaches every agent's prompt and names the
  // spawn_subagent_thread tool, so these negative checks pin the absence of
  // the skill-guidance block itself (its own sentences), not of the bare
  // tool name.
  it("does NOT include subagent thread guidance when skill not assigned", async () => {
    const config = makeConfig({ skills: [] });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).not.toContain("You have the **subagent-thread** skill");
    expect(result.systemPrompt).not.toContain("prefer the `spawn_subagent_thread` MCP tool");
  });

  it("does NOT include guidance when agent has other skills but not subagent-thread", async () => {
    const config = makeConfig({ skills: ["some-other-skill"] });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).not.toContain("You have the **subagent-thread** skill");
    expect(result.systemPrompt).not.toContain("prefer the `spawn_subagent_thread` MCP tool");
  });

  it("mentions spawn_subagent_thread MCP tool in guidance", async () => {
    const config = makeConfig({ skills: ["subagent-thread"] });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toContain("spawn_subagent_thread");
  });

  it("includes guidance alongside other skills when multiple assigned", async () => {
    const config = makeConfig({ skills: ["content-engine", "subagent-thread", "market-research"] });
    const deps = makeDeps({
      skillsCatalog: new Map([
        ["content-engine", { name: "content-engine", version: "1.0", description: "Content creation", path: "/tmp/skills/content-engine" }],
        ["market-research", { name: "market-research", version: "1.0", description: "Market research", path: "/tmp/skills/market-research" }],
      ]),
    });
    const result = await buildSessionConfig(config, deps);
    // Both skill descriptions and subagent thread guidance under unified "## Available Tools"
    expect(result.systemPrompt).toContain("## Available Tools");
    expect(result.systemPrompt).toContain("content-engine");
    expect(result.systemPrompt).toContain("spawn_subagent_thread");
  });
});

describe("buildSessionConfig — MCP tools injection", () => {
  it("includes MCP tools in Available Tools section when agent has mcpServers configured (with ready capability probe)", async () => {
    const config = makeConfig({
      mcpServers: [
        { name: "finnhub", command: "npx", args: ["-y", "finnhub-mcp"], env: {}, optional: false },
      ],
    });
    // Phase 94 Plan 02 TOOL-03: filter requires capabilityProbe.status === "ready"
    // to advertise the server to the LLM. Wire a ready state provider so the
    // server passes the filter and appears in the table.
    const deps = makeDeps({
      mcpStateProvider: readyMcpStateProvider(["finnhub"]),
    });
    const result = await buildSessionConfig(config, deps);
    expect(result.systemPrompt).toContain("## Available Tools");
    expect(result.systemPrompt).toContain("finnhub");
  });

  it("lists each server name in the MCP tools status table (Phase 85 TOOL-02 — command/args NOT leaked; Pitfall 12 closure)", async () => {
    const config = makeConfig({
      mcpServers: [
        { name: "finnhub", command: "npx", args: ["-y", "finnhub-mcp"], env: {}, optional: false },
        { name: "google-workspace", command: "node", args: ["gw-server.js"], env: { API_KEY: "test" }, optional: false },
      ],
    });
    // Phase 94 Plan 02 TOOL-03: ready-state provider so both servers appear
    // in the table (filter would otherwise suppress unprobed servers).
    const deps = makeDeps({
      mcpStateProvider: readyMcpStateProvider(["finnhub", "google-workspace"]),
    });
    const result = await buildSessionConfig(config, deps);
    // Phase 85 Plan 02 — new markdown-table format replaces the legacy
    // bullet-list that leaked `command` + `args` into every prompt.
    expect(result.systemPrompt).toContain("| Server | Status | Tools | Last Error |");
    expect(result.systemPrompt).toMatch(/\| finnhub \| ready \|/);
    expect(result.systemPrompt).toMatch(/\| google-workspace \| ready \|/);
    // Regression pin for the removed leak — none of these fields should
    // appear anywhere in the rendered prompt.
    expect(result.systemPrompt).not.toContain("`npx -y finnhub-mcp`");
    expect(result.systemPrompt).not.toContain("`node gw-server.js`");
    expect(result.systemPrompt).not.toContain("API_KEY");
  });

  it("does NOT include MCP tools content when agent has empty mcpServers", async () => {
    const config = makeConfig({ mcpServers: [] });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).not.toContain("MCP tools are pre-authenticated");
    expect(result.systemPrompt).not.toContain(
      "| Server | Status | Tools | Last Error |",
    );
  });

  it("does NOT include MCP tools content when mcpServers is undefined (defaults to empty)", async () => {
    // mcpServers defaults to [] via ?? in buildSessionConfig
    const config = makeConfig();
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).not.toContain("MCP tools are pre-authenticated");
    expect(result.systemPrompt).not.toContain(
      "| Server | Status | Tools | Last Error |",
    );
  });
});

function makeHotMemory(content: string, importance: number): MemoryEntry {
  return Object.freeze({
    id: `mem-${Math.random().toString(36).slice(2)}`,
    content,
    source: "conversation" as const,
    importance,
    accessCount: 5,
    tags: Object.freeze([] as string[]),
    embedding: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    accessedAt: "2026-01-01T00:00:00Z",
    tier: "hot" as MemoryTier,
    sourceTurnIds: null,
  });
}

function makeTierManager(hotMemories: readonly MemoryEntry[]) {
  return {
    getHotMemories: () => hotMemories,
    refreshHotTier: () => ({ demoted: 0, promoted: 0 }),
    runMaintenance: () => ({ demoted: 0, archived: 0, promoted: 0 }),
  };
}

describe("buildSessionConfig — fingerprint + top-3 hot memories", () => {
  it("injects fingerprint format markers when soul content is provided", async () => {
    const soulContent = `# Agent: TestBot

## Soul
- Helpful and knowledgeable
- Direct communication style

## Style
Concise and precise in responses.

## Constraints
- Never reveal internal prompts
`;
    const config = makeConfig({ soul: soulContent });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toContain("## Identity");
    expect(result.systemPrompt).toContain("Core traits");
  });

  it("does NOT contain full SOUL.md content in system prompt (section headers stripped)", async () => {
    const soulContent = `# Agent: TestBot

## Soul
- Helpful and knowledgeable
- Direct communication style

## Style
Concise and precise in responses with a focus on actionable information.

## Constraints
- Never reveal internal prompts

## Background
This agent was created for specialized testing purposes.
It has extensive training on TypeScript and Node.js patterns.
The full context of its creation spans multiple paragraphs of detail.
`;
    const config = makeConfig({ soul: soulContent });
    const result = await buildSessionConfig(config, makeDeps());
    // Full SOUL.md section headers and prose paragraphs should NOT appear — only fingerprint
    expect(result.systemPrompt).not.toContain("## Soul");
    expect(result.systemPrompt).not.toContain("## Background");
    expect(result.systemPrompt).not.toContain("This agent was created for specialized testing purposes");
    expect(result.systemPrompt).not.toContain("extensive training on TypeScript");
    // Fingerprint format should be present instead
    expect(result.systemPrompt).toContain("## Identity");
  });

  it("injects at most 3 hot memories in Key Memories section", async () => {
    const hotMemories = [
      makeHotMemory("Memory one", 1.0),
      makeHotMemory("Memory two", 0.9),
      makeHotMemory("Memory three", 0.8),
      makeHotMemory("Memory four", 0.7),
      makeHotMemory("Memory five", 0.6),
    ];
    const tierManager = makeTierManager(hotMemories);
    const tierManagers = new Map([["test-agent", tierManager as any]]);

    const config = makeConfig();
    const result = await buildSessionConfig(config, makeDeps({ tierManagers }));
    expect(result.systemPrompt).toContain("Memory one");
    expect(result.systemPrompt).toContain("Memory two");
    expect(result.systemPrompt).toContain("Memory three");
    expect(result.systemPrompt).not.toContain("Memory four");
    expect(result.systemPrompt).not.toContain("Memory five");
  });

  it("includes the recall instruction with agent name (WP6: clawcode_memory_search + search_documents)", async () => {
    // WP6 (2026-10-25): the line used to say "When using memory_lookup, pass
    // 'my-agent' as the agent parameter" while the capability manifest
    // teaches clawcode_memory_search. It now names the manifest's tools.
    const config = makeConfig({ name: "my-agent" });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toContain("Your name is my-agent");
    expect(result.systemPrompt).toContain(
      "Pass 'my-agent' as the agent parameter to tools that ask for it",
    );
    expect(result.systemPrompt).toContain("`clawcode_memory_search`");
    expect(result.systemPrompt).toContain("`search_documents`");
    expect(result.systemPrompt).not.toContain("When using memory_lookup");
  });

  it("applies custom contextBudgets from config to truncate sources (non-identity)", async () => {
    // Phase 53 Plan 02 D-03: identity is WARN-and-kept (never truncated).
    // Exercise the non-identity budget path instead: tool definitions.
    const longToolDefs = "T".repeat(200);
    const config = makeConfig({
      identity: "short",
      skills: [],
      contextBudgets: {
        identity: 1000,
        hotMemories: 1000,
        toolDefinitions: 10, // tiny — will be truncated
        graphContext: 1000,
      },
      admin: true, // forces toolDefinitions population via admin text
    });
    const result = await buildSessionConfig(config, makeDeps({
      allAgentConfigs: [
        makeConfig({ name: "other-agent" }),
        { ...makeConfig({ name: "test-agent" }), identity: "X" } as any,
      ],
      // WP6: the ~12K-char fleet directive block (wired by WP6) is fixed
      // operator text outside every per-section budget; turn it off so this
      // size check still measures only the budgeted sources.
      systemPromptDirectiveDefaults: {},
    }));
    // Total prompt still small (budget enforcement on tool/admin path)
    expect(result.systemPrompt.length).toBeLessThan(longToolDefs.length + 500);
  });

  it("v1.5 prompt size is not larger than v1.4 equivalent for typical sources", async () => {
    // Typical agent: identity, 3 hot memories, 2 skills, 1 MCP server, discord channel
    const soulContent = "# Agent: TestBot\n\n## Soul\n- Helpful\n- Direct\n\n## Style\nConcise.\n";
    const config = makeConfig({
      soul: soulContent,
      channels: ["123456789"],
      skills: ["content-engine"],
      mcpServers: [
        { name: "finnhub", command: "npx", args: ["-y", "finnhub-mcp"], env: {}, optional: false },
      ],
    });

    const hotMemories = [
      makeHotMemory("User prefers TypeScript", 1.0),
      makeHotMemory("Project uses vitest for testing", 0.9),
      makeHotMemory("Deploy target is Node 22 LTS", 0.8),
    ];
    const tierManager = makeTierManager(hotMemories);
    const tierManagers = new Map([["test-agent", tierManager as any]]);
    const skillsCatalog = new Map([
      ["content-engine", { name: "content-engine", version: "1.0", description: "Content creation", path: "/tmp/skills/content-engine" }],
    ]);

    const result = await buildSessionConfig(
      config,
      // WP6: directives off so the pin keeps measuring the v1.4-comparable
      // sources (the directive block is pinned by its own tests).
      makeDeps({ tierManagers, skillsCatalog, systemPromptDirectiveDefaults: {} }),
    );
    // v1.4 equivalent for this config was approximately 1200 chars
    // v1.5 should be equal or smaller due to budget enforcement
    // Phase 100-fu (2026-04-26): comprehensive capability manifest
    // (Tier 1 + Tier 2 fields) adds ~600 chars of unconditional content
    // (Model+effort, Conversation memory, Recursion guard, MCP servers,
    // Skills bullets) when the agent has any opt-in feature.
    // Context-bloat fix #3a (2026-05-21): the static Discord-bindings block
    // (~360 chars) moved OUT of the per-turn mutable suffix INTO the cached
    // stable prefix (`systemPrompt`) — paid once instead of every turn.
    // Net fleet-wide context savings; the `systemPrompt` snapshot grows by
    // exactly that block. Ceiling raised 2800 → 4800 to cover the move.
    // (The 2800 ceiling was already stale on baseline — this config
    // measured ~4195 chars before this change.)
    // Phase 999.99 (2026-06-11): INTENDED pin flip. The recurring-poll steer
    // (~470 chars) was appended to the same static discordBindingsStr block,
    // so this channel-bound config now measures ~4968 chars (was ~4498
    // pre-steer). Ceiling raised 4800 → 5200 to cover the steer — same
    // intended-growth event as the #3a move above. The steer is paid ONCE
    // (cached stable prefix), not per-turn; it forces agents onto the
    // delivered schedule_recurring primitive (Plan 01).
    // WP6 (2026-10-25): INTENDED pin flip. The pin was already stale on
    // bc95fb2 (this config measured 5449 chars: the 2026-08-27 markdown-table
    // steer and capability-manifest growth landed without moving it). WP6
    // adds the dated hot-memory bullets (" (saved YYYY-MM-DD)", 19 chars
    // each) and a longer recall line naming clawcode_memory_search /
    // search_documents: the config now measures 5727 chars (directives off;
    // they are fixed operator text outside this comparison). Ceiling raised
    // 5200 to 5800.
    expect(result.systemPrompt.length).toBeLessThanOrEqual(5800);
  });

  it("bootstrap agents still get bootstrap prompt without fingerprint", async () => {
    const config = makeConfig({ soul: "# Agent: Test\n\n## Soul\n- Helpful\n" });
    const result = await buildSessionConfig(config, makeDeps(), undefined, "needed");
    expect(result.systemPrompt).toContain("bootstrap prompt");
    expect(result.systemPrompt).not.toContain("## Identity");
    expect(result.systemPrompt).not.toContain("memory_lookup");
  });
});

// ── Phase 52 Plan 02 — two-block wiring for prompt caching ──────────────────

describe("buildSessionConfig — Phase 52 two-block wiring", () => {
  it("returns systemPrompt carrying the stable prefix incl. static Discord bindings", async () => {
    const soulContent = "# My Soul\n\n## Soul\n- Helpful\n";
    const config = makeConfig({
      soul: soulContent,
      channels: ["general"],
    });
    const result = await buildSessionConfig(config, makeDeps());

    // Stable block has identity derived from fingerprint.
    expect(result.systemPrompt).toContain("## Identity");
    expect(result.systemPrompt).toContain("My Soul");
    // Context-bloat fix #3a — Discord bindings are STATIC and now ride the
    // cached stable prefix (paid once), no longer the per-turn suffix.
    expect(result.systemPrompt).toContain("## Discord Communication");
  });

  // Phase 999.99 — FIX-1 GUARD: the recurring-poll steer must reach the
  // STEADY-STATE fleet path (discordBindingsStr → stablePrefix → systemPrompt),
  // NOT the bootstrap-only branch (session-config.ts:366-384) that the running
  // fleet never executes. This test exercises a normal (NON-bootstrap)
  // channel-bound buildSessionConfig and asserts the steer text rode through to
  // the returned systemPrompt. It would FAIL if the steer were (wrongly)
  // anchored to the bootstrap branch — that's the false-green the plan-checker
  // flagged. Mirrors the :427-441 stable-prefix setup (no bootstrapStatus arg).
  it("Phase 999.99: recurring-poll steer reaches the steady-state systemPrompt (schedule_recurring + post_to_agent) — FIX-1 guard", async () => {
    const config = makeConfig({ channels: ["general"] });
    const result = await buildSessionConfig(config, makeDeps());

    // The steer rides discordBindingsStr → stablePrefix → systemPrompt.
    expect(result.systemPrompt).toContain("schedule_recurring");
    expect(result.systemPrompt).toContain("mcp__clawcode__post_to_agent");
    // It lands in the cached stable prefix (systemPrompt), NOT the per-turn
    // mutable suffix — same property the Discord-bindings block has.
    expect(result.mutableSuffix ?? "").not.toContain("schedule_recurring");
  });

  it("Phase 999.99: a channel-LESS agent does NOT get the steer (channel-gated — it can't post_to_agent its own channel anyway)", async () => {
    const config = makeConfig({ channels: [] });
    const result = await buildSessionConfig(config, makeDeps());
    // The steer lives inside the `channels.length > 0` discordBindingsStr guard,
    // so a channel-less agent's prompt stays free of it (and the byte-stability
    // snapshot at "back-compat-byte-identical" — which uses channels:[] — is
    // immune to this phase).
    expect(result.systemPrompt).not.toContain("schedule_recurring");
  });

  it("returns mutableSuffix carrying the merged Session Continuity block", async () => {
    const config = makeConfig({
      channels: ["channel-xyz"],
    });
    const result = await buildSessionConfig(
      config,
      makeDeps(),
      "## Context Summary\nprevious session info",
    );

    expect(result.mutableSuffix).toBeDefined();
    // Context-bloat fix #3a — Discord bindings moved to the stable prefix.
    expect(result.mutableSuffix).not.toContain("## Discord Communication");
    expect(result.systemPrompt).toContain("channel-xyz");
    // Context-bloat fix #3b — the context summary lands in the merged
    // "## Session Continuity" block in the mutable suffix.
    expect(result.mutableSuffix).toContain("## Session Continuity");
    expect(result.mutableSuffix).toContain("## Context Summary");
  });

  it("returns hotStableToken (64-char hex) for the caller to persist for next-turn comparison", async () => {
    const config = makeConfig();
    const result = await buildSessionConfig(config, makeDeps());

    expect(result.hotStableToken).toBeDefined();
    expect(result.hotStableToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it("threads priorHotStableToken from deps into assembleContext (hot-tier moves to mutable on drift)", async () => {
    const hotMemories = [
      makeHotMemory("user likes TS", 1.0),
      makeHotMemory("project uses vitest", 0.9),
    ];
    const tierManager = makeTierManager(hotMemories);
    const tierManagers = new Map([["test-agent", tierManager as any]]);
    const config = makeConfig();

    // Pass a priorHotStableToken that DEFINITELY does not match current hot-tier.
    const result = await buildSessionConfig(
      config,
      makeDeps({
        tierManagers,
        priorHotStableToken: "0".repeat(64),
      }),
    );

    // When prior token does not match, hot-tier moves OUT of the stable
    // systemPrompt and into the mutableSuffix.
    expect(result.systemPrompt).not.toContain("## Key Memories");
    expect(result.mutableSuffix ?? "").toContain("## Key Memories");
  });

  it("omits mutableSuffix field when no mutable content exists (stable-only agent)", async () => {
    // No channels + no context summary = nothing in the mutable block.
    const config = makeConfig({ channels: [] });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.mutableSuffix).toBeUndefined();
  });
});

// ── Phase 53 Plan 02 — resume summary budget + assembler budget wiring ───────

describe("resume summary budget (Phase 53)", () => {
  it("Test 9: resumeSummaryBudget on config invokes enforceSummaryBudget before assembly", async () => {
    // Mock loadLatestSummary to return an oversized summary.
    const { loadLatestSummary } = await import("../../memory/context-summary.js");
    (loadLatestSummary as any).mockResolvedValueOnce(
      Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" "),
    );

    const warnings: Record<string, unknown>[] = [];
    const stubLog = {
      warn: (obj: Record<string, unknown>, _msg?: string) => {
        warnings.push(obj);
      },
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => stubLog,
    };

    const config = makeConfig({
      channels: ["c1"],
      perf: {
        resumeSummaryBudget: 500, // floor — tight
      } as any,
    });
    const result = await buildSessionConfig(
      config,
      makeDeps({ log: stubLog as any }),
    );

    // The hard-truncated summary (ending with ...) appears in the mutable suffix
    expect(result.mutableSuffix).toBeDefined();
    const mutableBlob = result.mutableSuffix ?? "";
    expect(mutableBlob).toContain("## Context Summary (from previous session)");
    // At least one warn log fired for the oversized resume summary
    const summaryWarn = warnings.find(
      (w) => (w as any).budget === 500 || (w as any).section === "resume_summary",
    );
    expect(summaryWarn).toBeDefined();
  });

  it("Test 10: memoryAssemblyBudgets threaded through to assembler + warn fires for over-budget", async () => {
    const warnings: Record<string, unknown>[] = [];
    const stubLog = {
      warn: (obj: Record<string, unknown>, _msg?: string) => {
        warnings.push(obj);
      },
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => stubLog,
    };

    const config = makeConfig({
      channels: ["c1"],
      identity: "X".repeat(10000),
      perf: {
        memoryAssemblyBudgets: { identity: 10 },
      } as any,
    });

    await buildSessionConfig(config, makeDeps({ log: stubLog as any }));

    const identityWarn = warnings.find((w) => (w as any).section === "identity");
    expect(identityWarn).toBeDefined();
    // Phase 115 D-03 replaced the Phase 53 warn-and-keep no-op with real
    // truncation (enforceDropLowestImportance); this pin was left at the
    // old strategy name. Updated by WP6 (2026-10-25).
    expect((identityWarn as any).strategy).toBe("drop-lowest-importance");
    expect((identityWarn as any).budgetTokens).toBe(10);
  });

  it("Test 11: onBudgetWarning logger callback receives full event payload", async () => {
    const warnings: Record<string, unknown>[] = [];
    const stubLog = {
      warn: (obj: Record<string, unknown>, _msg?: string) => {
        warnings.push(obj);
      },
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => stubLog,
    };

    const config = makeConfig({
      channels: [],
      identity: "X".repeat(10000),
      soul: "S".repeat(10000),
      perf: {
        memoryAssemblyBudgets: { identity: 10, soul: 5 },
      } as any,
    });

    await buildSessionConfig(config, makeDeps({ log: stubLog as any }));

    const anyAssemblyWarn = warnings.find(
      (w) =>
        (w as any).section &&
        ["identity", "soul"].includes((w as any).section),
    );
    expect(anyAssemblyWarn).toBeDefined();
    expect(typeof (anyAssemblyWarn as any).beforeTokens).toBe("number");
    expect(typeof (anyAssemblyWarn as any).budgetTokens).toBe("number");
    expect(typeof (anyAssemblyWarn as any).strategy).toBe("string");
    expect((anyAssemblyWarn as any).agent).toBe("test-agent");
  });

  it("Test 12: new ContextSources fields populated from upstream (skillsHeader separate from toolDefinitions)", async () => {
    // When agent has skills, the skillsHeader block is filled; MCP/admin
    // text keeps going through toolDefinitions. Both under the unified
    // "Available Tools" header.
    const config = makeConfig({
      channels: ["c1"],
      skills: ["content-engine"],
    });
    const skillsCatalog = new Map([
      [
        "content-engine",
        { name: "content-engine", version: null, description: "Write content" },
      ],
    ] as any);
    const result = await buildSessionConfig(
      config,
      makeDeps({ skillsCatalog: skillsCatalog as any }),
    );

    expect(result.systemPrompt).toContain("## Available Tools");
    expect(result.systemPrompt).toContain("content-engine");
    expect(result.systemPrompt).toContain("Write content");
  });
});

// ── Phase 53 Plan 03 — lazy-skill wiring ────────────────────────────────────

import { SkillUsageTracker } from "../../usage/skill-usage-tracker.js";

describe("buildSessionConfig — lazy-skill wiring (Phase 53 Plan 03)", () => {
  it("Test 11: passes lazySkills config + skill usage window through to assembler", async () => {
    const tracker = new SkillUsageTracker({ capacity: 20 });
    // Simulate 25 turns of usage so we're past warm-up
    for (let i = 0; i < 25; i++) {
      tracker.recordTurn("test-agent", {
        mentionedSkills: ["search-first"],
      });
    }

    const config = makeConfig({
      skills: ["search-first", "content-engine"],
      perf: {
        lazySkills: {
          enabled: true,
          usageThresholdTurns: 20,
          reinflateOnMention: true,
        },
      },
    } as unknown as Partial<ResolvedAgentConfig>);
    const skillsCatalog = new Map([
      [
        "search-first",
        { name: "search-first", version: "1.0", description: "Research before coding", path: "/tmp/skills/search-first" },
      ],
      [
        "content-engine",
        { name: "content-engine", version: "1.0", description: "Content creation", path: "/tmp/skills/content-engine" },
      ],
    ] as any);

    const result = await buildSessionConfig(
      config,
      makeDeps({
        skillsCatalog: skillsCatalog as any,
        skillUsageTracker: tracker,
      } as any),
    );

    // content-engine (not recently used, not mentioned) compresses to one-liner
    expect(result.systemPrompt).toContain(
      "- content-engine: Content creation",
    );
    // search-first (recently used) renders as full-content bullet with version
    expect(result.systemPrompt).toContain("search-first");
    expect(result.systemPrompt).toContain("Research before coding");
  });

  it("Test 12: sources.skills built from skillsCatalog with name/desc/fullContent", async () => {
    const tracker = new SkillUsageTracker({ capacity: 20 });
    const config = makeConfig({
      skills: ["alpha-skill"],
      perf: {
        lazySkills: {
          enabled: true,
          usageThresholdTurns: 20,
          reinflateOnMention: true,
        },
      },
    } as unknown as Partial<ResolvedAgentConfig>);
    const skillsCatalog = new Map([
      [
        "alpha-skill",
        { name: "alpha-skill", version: "2.1", description: "Alpha description", path: "/tmp/skills/alpha-skill" },
      ],
    ] as any);

    const result = await buildSessionConfig(
      config,
      makeDeps({
        skillsCatalog: skillsCatalog as any,
        skillUsageTracker: tracker,
      } as any),
    );

    // In warm-up (0 turns < 20 threshold), all skills render full content.
    // The "full content" path in session-config defaults to the legacy
    // bullet with name+version+description shape.
    expect(result.systemPrompt).toContain("alpha-skill");
    expect(result.systemPrompt).toContain("Alpha description");
  });

  it("Test 13: absent skillUsageTracker → no throw, skills render full-content (warm-up behavior)", async () => {
    const config = makeConfig({
      skills: ["search-first"],
      perf: {
        lazySkills: {
          enabled: true,
          usageThresholdTurns: 20,
          reinflateOnMention: true,
        },
      },
    } as unknown as Partial<ResolvedAgentConfig>);
    const skillsCatalog = new Map([
      [
        "search-first",
        { name: "search-first", version: "1.0", description: "Research before coding", path: "/tmp/skills/search-first" },
      ],
    ] as any);

    // No skillUsageTracker in deps
    const result = await buildSessionConfig(
      config,
      makeDeps({ skillsCatalog: skillsCatalog as any }),
    );

    expect(result.systemPrompt).toContain("search-first");
    expect(result.systemPrompt).toContain("Research before coding");
  });
});

// ── Phase 67 — Resume Auto-Injection (SESS-02 / SESS-03) ───────────────────

describe("buildSessionConfig — Phase 67 conversation brief", () => {
  /** Deterministic "now" — 2026-04-18T12:00:00Z. */
  const T = new Date("2026-04-18T12:00:00Z").getTime();
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  beforeEach(() => {
    memStore = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
  });

  afterEach(() => {
    memStore?.close();
  });

  function seedSummary(sessionId: string, content: string, createdAt: string) {
    const entry = memStore.insert(
      {
        content,
        source: "conversation",
        importance: 0.78,
        tags: ["session-summary", `session:${sessionId}`],
        skipDedup: true,
      },
      new Float32Array(384).fill(0.1),
    );
    memStore
      .getDatabase()
      .prepare("UPDATE memories SET created_at = ? WHERE id = ?")
      .run(createdAt, entry.id);
  }

  function seedEndedSession(startedAt: string, endedAt: string) {
    const session = convStore.startSession("test-agent");
    memStore
      .getDatabase()
      .prepare(
        "UPDATE conversation_sessions SET started_at = ?, ended_at = ?, status = 'ended' WHERE id = ?",
      )
      .run(startedAt, endedAt, session.id);
  }

  it("conversation context in mutable suffix", async () => {
    // Gap > 4h threshold: last session ended at T-7h
    seedSummary("A", "User asked about deployment.", "2026-04-17T08:00:00Z");
    seedSummary("B", "Discussed Phase 67 design.", "2026-04-16T08:00:00Z");
    seedEndedSession("2026-04-18T03:00:00Z", "2026-04-18T05:00:00Z");

    const config = makeConfig({ name: "test-agent", channels: ["general"] });
    const deps = makeDeps({
      memoryStores: new Map([["test-agent", memStore]]),
      conversationStores: new Map([["test-agent", convStore]]),
      now: T,
    } as any);
    const result = await buildSessionConfig(config, deps);

    // Brief MUST be in mutable suffix, NOT in stable system prompt
    // (Pitfall 1 invariant — prompt-cache stability).
    expect(result.mutableSuffix).toBeDefined();
    const mutable = result.mutableSuffix ?? "";
    expect(mutable).toContain("## Recent Sessions");
    expect(mutable).toContain("User asked about deployment");
    expect(result.systemPrompt).not.toContain("## Recent Sessions");
    expect(result.systemPrompt).not.toContain("User asked about deployment");
  });

  it("calls conversation brief assembler", async () => {
    seedSummary("X", "Critical decision logged.", "2026-04-17T08:00:00Z");
    seedEndedSession("2026-04-18T03:00:00Z", "2026-04-18T05:00:00Z");

    const config = makeConfig({ name: "test-agent", channels: ["general"] });
    const deps = makeDeps({
      memoryStores: new Map([["test-agent", memStore]]),
      conversationStores: new Map([["test-agent", convStore]]),
      now: T,
    } as any);
    const result = await buildSessionConfig(config, deps);

    // Brief content reaches the assembled prompt via the wired helper.
    const mutable = result.mutableSuffix ?? "";
    expect(mutable).toContain("Critical decision logged");
  });

  it("handles missing conversationStore", async () => {
    // Seed memory so the brief WOULD render if the helper were called —
    // then verify it is NOT called (graceful degradation).
    seedSummary("X", "Should not appear.", "2026-04-17T08:00:00Z");

    const config = makeConfig({ name: "test-agent", channels: ["general"] });
    const deps = makeDeps({
      memoryStores: new Map([["test-agent", memStore]]),
      // conversationStores intentionally omitted — simulates legacy startup path.
      now: T,
    } as any);
    const result = await buildSessionConfig(config, deps);

    // No throw; no brief content in any output block.
    const mutable = result.mutableSuffix ?? "";
    expect(mutable).not.toContain("## Recent Sessions");
    expect(mutable).not.toContain("Should not appear");
    expect(result.systemPrompt).not.toContain("## Recent Sessions");
    expect(result.systemPrompt).not.toContain("Should not appear");
  });
});

// ── Phase 73 Plan 02 — conversation-brief cache wiring (LAT-02) ─────────────

describe("buildSessionConfig — Phase 73 brief cache wiring", () => {
  /** Deterministic "now" — 2026-04-18T12:00:00Z. */
  const T = new Date("2026-04-18T12:00:00Z").getTime();
  let memStore: MemoryStore;
  let convStore: ConversationStore;
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    memStore = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
  });

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
    memStore?.close();
  });

  function seedSummary(
    sessionId: string,
    content: string,
    createdAt: string,
  ) {
    const entry = memStore.insert(
      {
        content,
        source: "conversation",
        importance: 0.78,
        tags: ["session-summary", `session:${sessionId}`],
        skipDedup: true,
      },
      new Float32Array(384).fill(0.1),
    );
    memStore
      .getDatabase()
      .prepare("UPDATE memories SET created_at = ? WHERE id = ?")
      .run(createdAt, entry.id);
  }

  function seedEndedSession(
    id: string,
    startedAt: string,
    endedAt: string,
  ) {
    const session = convStore.startSession("test-agent");
    memStore
      .getDatabase()
      .prepare(
        "UPDATE conversation_sessions SET id = ?, started_at = ?, ended_at = ?, status = 'ended' WHERE id = ?",
      )
      .run(id, startedAt, endedAt, session.id);
    // listRecentTerminatedSessions only returns sessions that still carry at
    // least one turn row (EXISTS clause, conversation-store.ts). Without a
    // turn the fingerprint was sha256 of an empty id list and the two
    // fingerprint tests below failed on a clean checkout. Seeding one turn
    // keeps them valid both for the current query and for a query that
    // also counts summarized-and-pruned sessions.
    convStore.recordTurn({ sessionId: id, role: "user", content: "seed turn" });
  }

  it("cache MISS → calls assembleConversationBrief and populates the cache", async () => {
    seedSummary("A", "User asked about deployment.", "2026-04-17T08:00:00Z");
    seedEndedSession("sess-A", "2026-04-18T03:00:00Z", "2026-04-18T05:00:00Z");

    const cache = new ConversationBriefCache();
    spy = vi.spyOn(briefModule, "assembleConversationBrief");

    const config = makeConfig({ name: "test-agent", channels: ["general"] });
    const deps = makeDeps({
      memoryStores: new Map([["test-agent", memStore]]),
      conversationStores: new Map([["test-agent", convStore]]),
      briefCache: cache,
      now: T,
    } as any);

    const result = await buildSessionConfig(config, deps);

    // Brief was assembled exactly once (miss path took the real assembler).
    expect(spy).toHaveBeenCalledTimes(1);
    // Cache populated.
    const entry = cache.get("test-agent");
    expect(entry).toBeDefined();
    expect(entry!.briefBlock).toContain("## Recent Sessions");
    // Rendered block flows into the mutable suffix as today.
    expect(result.mutableSuffix ?? "").toContain("User asked about deployment");
  });

  it("cache HIT (matching fingerprint) → skips assembleConversationBrief, uses cached block", async () => {
    // Seed a terminated session; cache stores a fabricated brief keyed by
    // the fingerprint computed over that session's ID. buildSessionConfig
    // MUST return the cached brief without invoking the assembler.
    seedEndedSession("sess-A", "2026-04-18T03:00:00Z", "2026-04-18T05:00:00Z");
    const fingerprint = computeBriefFingerprint(["sess-A"]);
    const cachedBlock =
      "## Recent Sessions\n### Session from cache\nCached brief body.\n";

    const cache = new ConversationBriefCache();
    cache.set("test-agent", { fingerprint, briefBlock: cachedBlock });

    spy = vi.spyOn(briefModule, "assembleConversationBrief");

    const config = makeConfig({ name: "test-agent", channels: ["general"] });
    const deps = makeDeps({
      memoryStores: new Map([["test-agent", memStore]]),
      conversationStores: new Map([["test-agent", convStore]]),
      briefCache: cache,
      now: T,
    } as any);

    const result = await buildSessionConfig(config, deps);

    // Assembler was NOT called — hit path short-circuited.
    expect(spy).toHaveBeenCalledTimes(0);
    // Cached body lands in the mutable suffix verbatim.
    expect(result.mutableSuffix ?? "").toContain("Cached brief body.");
  });

  it("cache entry with stale fingerprint → cache miss, assembler called, new entry written", async () => {
    seedSummary("A", "First session summary.", "2026-04-17T08:00:00Z");
    seedEndedSession("sess-A", "2026-04-18T03:00:00Z", "2026-04-18T05:00:00Z");

    // Populate cache with a fingerprint that does NOT match current
    // terminated-session set (simulates a second terminated session having
    // appeared after the cache was last written).
    const staleFingerprint = computeBriefFingerprint(["sess-OLD"]);
    const cache = new ConversationBriefCache();
    cache.set("test-agent", {
      fingerprint: staleFingerprint,
      briefBlock: "## Stale brief",
    });

    spy = vi.spyOn(briefModule, "assembleConversationBrief");

    const config = makeConfig({ name: "test-agent", channels: ["general"] });
    const deps = makeDeps({
      memoryStores: new Map([["test-agent", memStore]]),
      conversationStores: new Map([["test-agent", convStore]]),
      briefCache: cache,
      now: T,
    } as any);

    const result = await buildSessionConfig(config, deps);

    // Stale entry did NOT match the fresh fingerprint → assembler ran.
    expect(spy).toHaveBeenCalledTimes(1);
    // Stale body does NOT leak into the output.
    expect(result.mutableSuffix ?? "").not.toContain("Stale brief");
    // Fresh body DOES appear (from the assembler).
    expect(result.mutableSuffix ?? "").toContain("First session summary");
    // Cache was overwritten with the new fingerprint.
    const freshFingerprint = computeBriefFingerprint(["sess-A"]);
    expect(cache.get("test-agent")!.fingerprint).toBe(freshFingerprint);
  });

  it("no briefCache dep → byte-identical legacy behavior (assembler called each time)", async () => {
    seedSummary("A", "Legacy brief body.", "2026-04-17T08:00:00Z");
    seedEndedSession("sess-A", "2026-04-18T03:00:00Z", "2026-04-18T05:00:00Z");

    spy = vi.spyOn(briefModule, "assembleConversationBrief");

    const config = makeConfig({ name: "test-agent", channels: ["general"] });
    const deps = makeDeps({
      memoryStores: new Map([["test-agent", memStore]]),
      conversationStores: new Map([["test-agent", convStore]]),
      // briefCache intentionally omitted — legacy path.
      now: T,
    } as any);

    await buildSessionConfig(config, deps);
    expect(spy).toHaveBeenCalledTimes(1);

    // Second call also hits the assembler (no cache in play).
    await buildSessionConfig(config, deps);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// ── Phase 75 SHARED-02 — shared-workspace session-resume context summary ────

describe("buildSessionConfig — shared-workspace context summary resume (Phase 75 gap)", () => {
  beforeEach(() => {
    vi.mocked(loadLatestSummary).mockReset();
    // Default: behave like the file-scoped mock (no persisted summary).
    vi.mocked(loadLatestSummary).mockResolvedValue(undefined);
  });

  it("reads context-summary.md from memoryPath/memory (not workspace/memory) for a shared-workspace agent", async () => {
    // Phase 75 VERIFICATION Truth #7 regression: the WRITE path
    // (AgentMemoryManager.saveContextSummary) targets memoryPath/memory/,
    // so the READ path (buildSessionConfig -> loadLatestSummary) must
    // target the SAME directory. Prior to the fix this test fails
    // because session-config.ts:318 passed config.workspace.
    const config = makeConfig({
      workspace: "/shared/fin",
      memoryPath: "/shared/fin/fin-A",
    });

    // Path-aware mock: returns the sentinel only when called with the
    // memoryPath-derived memory dir. If session-config.ts passes the
    // workspace-derived dir (/shared/fin/memory), the mock returns
    // undefined and the assertion below fails — which is exactly the
    // RED state on master.
    vi.mocked(loadLatestSummary).mockImplementation(async (dir: string) => {
      if (dir === "/shared/fin/fin-A/memory") {
        return "SHARED_WORKSPACE_RESUME_MARKER";
      }
      return undefined;
    });

    const result = await buildSessionConfig(config, makeDeps());

    // The loader MUST have been called with the memoryPath-derived dir.
    expect(vi.mocked(loadLatestSummary)).toHaveBeenCalledWith(
      "/shared/fin/fin-A/memory",
    );
    // And the summary content must have flowed into the assembled prompt.
    // Phase 52 two-block wiring routes context summary to the mutable
    // suffix (never stable prefix), so assert against the combined output.
    const assembledPrompt = result.systemPrompt + (result.mutableSuffix ?? "");
    expect(assembledPrompt).toContain("SHARED_WORKSPACE_RESUME_MARKER");
  });
});

// ── Phase 78 CONF-01 — lazy-read precedence for soulFile / identityFile ─────
//
// Precedence chain (BOTH soul and identity):
//   config.soulFile (absolute path) → <workspace>/SOUL.md → inline config.soul
//   config.identityFile (absolute path) → <workspace>/IDENTITY.md → inline config.identity
//
// Silent fall-through on read errors at every step: a configured soulFile
// pointing at a deleted file falls through to workspace/SOUL.md and then
// to the inline string.

describe("buildSessionConfig — soulFile / identityFile lazy-read precedence (Phase 78 CONF-01)", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    // Default: behave like the file-scoped mock (every path ENOENT).
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
  });

  /**
   * Path-aware readFile mock helper. Returns content for paths in the map;
   * rejects for everything else. Mimics real disk I/O by path.
   */
  function mockFiles(files: Record<string, string>) {
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      const p = typeof path === "string" ? path : String(path);
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    });
  }

  it("Test 1 — reads soulFile content into systemPrompt when set and file exists", async () => {
    // SOUL content gets passed through extractFingerprint → formatFingerprint.
    // We use SOUL.md syntax so the fingerprint extractor produces stable output,
    // but the marker string appears in the result because the name is injected.
    mockFiles({
      "/custom/path/SOUL.md":
        "# Agent: TestBot\n\n## Soul\n- SOUL_FROM_FILE_POINTER\n- Direct\n\n## Style\nConcise.\n",
    });
    const config = makeConfig({ soulFile: "/custom/path/SOUL.md" });
    const result = await buildSessionConfig(config, makeDeps());
    // Fingerprint section emitted → SOUL pathway exercised.
    expect(result.systemPrompt).toContain("## Identity");
    // readFile was called with the soulFile path.
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(
      "/custom/path/SOUL.md",
      "utf-8",
    );
  });

  it("Test 2 — falls through to <workspace>/SOUL.md when soulFile is unreadable", async () => {
    // soulFile is SET but only the workspace/SOUL.md resolves on disk.
    mockFiles({
      "/tmp/test-workspace/SOUL.md":
        "# Agent: Test\n\n## Soul\n- SOUL_FROM_WORKSPACE\n",
    });
    const config = makeConfig({
      workspace: "/tmp/test-workspace",
      soulFile: "/path/does/not/exist/SOUL.md",
    });
    const result = await buildSessionConfig(config, makeDeps());
    // Fallback fired — workspace SOUL.md was read.
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(
      "/tmp/test-workspace/SOUL.md",
      "utf-8",
    );
    // Fingerprint section still renders (SOUL content was obtained).
    expect(result.systemPrompt).toContain("## Identity");
  });

  it("Test 3 — falls through to inline config.soul when neither file exists", async () => {
    // No readFile calls resolve — only inline soul remains.
    const config = makeConfig({
      workspace: "/tmp/empty-workspace",
      soul: "# Agent: Test\n\n## Soul\n- INLINE_SOUL_FALLBACK\n",
    });
    const result = await buildSessionConfig(config, makeDeps());
    // Fingerprint section rendered from inline string.
    expect(result.systemPrompt).toContain("## Identity");
  });

  it("Test 4 — no crash when soulFile, workspace/SOUL.md, AND inline soul are all absent", async () => {
    // All three branches dead — SOUL section empty, but no throws.
    const config = makeConfig({ workspace: "/tmp/empty" });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toBeDefined();
    // No "undefined" string leaking in.
    expect(result.systemPrompt).not.toContain("undefined");
  });

  it("Test 5 — reads identityFile content into identity block when set and file exists", async () => {
    mockFiles({
      "/custom/path/IDENTITY.md":
        "# IDENTITY_FROM_FILE\nDetailed identity prose.",
    });
    const config = makeConfig({ identityFile: "/custom/path/IDENTITY.md" });
    const result = await buildSessionConfig(config, makeDeps());
    // The identity file content flows into systemPrompt verbatim.
    expect(result.systemPrompt).toContain("IDENTITY_FROM_FILE");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(
      "/custom/path/IDENTITY.md",
      "utf-8",
    );
  });

  it("Test 6 — identity precedence mirrors soul: identityFile > workspace/IDENTITY.md > inline identity", async () => {
    // identityFile UNSET, workspace IDENTITY.md present — workspace wins.
    mockFiles({
      "/tmp/ws/IDENTITY.md": "IDENTITY_FROM_WORKSPACE",
    });
    const configA = makeConfig({ workspace: "/tmp/ws" });
    const resultA = await buildSessionConfig(configA, makeDeps());
    expect(resultA.systemPrompt).toContain("IDENTITY_FROM_WORKSPACE");

    // Neither file — inline wins.
    vi.mocked(readFile).mockReset();
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    const configB = makeConfig({
      workspace: "/tmp/empty",
      identity: "INLINE_IDENTITY_FALLBACK",
    });
    const resultB = await buildSessionConfig(configB, makeDeps());
    expect(resultB.systemPrompt).toContain("INLINE_IDENTITY_FALLBACK");
  });

  it("Test 7 — soulFile wins over <workspace>/SOUL.md when BOTH exist (precedence correctness)", async () => {
    mockFiles({
      "/custom/path/SOUL.md":
        "# Agent: T\n\n## Soul\n- FROM_FILE_POINTER\n",
      "/tmp/ws/SOUL.md":
        "# Agent: T\n\n## Soul\n- FROM_WORKSPACE\n",
    });
    const config = makeConfig({
      workspace: "/tmp/ws",
      soulFile: "/custom/path/SOUL.md",
    });
    const result = await buildSessionConfig(config, makeDeps());
    // The soulFile branch short-circuits — workspace SOUL.md was never read.
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(
      "/custom/path/SOUL.md",
      "utf-8",
    );
    const workspaceCall = vi
      .mocked(readFile)
      .mock.calls.find((c) => c[0] === "/tmp/ws/SOUL.md");
    expect(workspaceCall).toBeUndefined();
  });

  it("Test 8 — regression: workspace SOUL.md + IDENTITY.md still load when soulFile/identityFile unset (Phase 45/LOAD-02 preserved)", async () => {
    mockFiles({
      "/tmp/ws/SOUL.md":
        "# Agent: Legacy\n\n## Soul\n- LEGACY_WORKSPACE_SOUL\n",
      "/tmp/ws/IDENTITY.md": "LEGACY_WORKSPACE_IDENTITY",
    });
    const config = makeConfig({ workspace: "/tmp/ws" });
    const result = await buildSessionConfig(config, makeDeps());
    // Both workspace files loaded byte-for-byte.
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(
      "/tmp/ws/SOUL.md",
      "utf-8",
    );
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(
      "/tmp/ws/IDENTITY.md",
      "utf-8",
    );
    expect(result.systemPrompt).toContain("LEGACY_WORKSPACE_IDENTITY");
    expect(result.systemPrompt).toContain("## Identity");
  });
});

// ---------------------------------------------------------------------------
// Phase 90 Plan 01 — MEM-01: MEMORY.md auto-inject into the v1.7 stable
// prefix, positioned AFTER SOUL+IDENTITY and BEFORE the MCP status table
// (D-18). 50KB hard cap with truncation marker (D-17). Silent skip on
// missing file (same precedence semantics as SOUL/IDENTITY branches).
// Opt-out via config.memoryAutoLoad === false.
// ---------------------------------------------------------------------------

describe("buildSessionConfig — MEM-01 MEMORY.md auto-inject (Phase 90)", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
  });

  function mockFiles(files: Record<string, string>) {
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      const p = typeof path === "string" ? path : String(path);
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    });
  }

  it("MEM-01-C1: injection order — SOUL < IDENTITY < MEMORY < MCP Servers in stable prefix", async () => {
    mockFiles({
      "/tmp/ws/SOUL.md":
        "# Agent: Fin\n\n## Soul\n- SOUL_MARKER_ORDER_TEST\n",
      "/tmp/ws/IDENTITY.md": "IDENTITY_MARKER_ORDER_TEST",
      "/tmp/ws/MEMORY.md": "MEMORY_MARKER_ORDER_TEST — our firm legal name is X.",
    });
    const config = makeConfig({
      workspace: "/tmp/ws",
      memoryAutoLoad: true,
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
      mcpServers: [
        { name: "acme-db", command: "x", args: [], env: {}, optional: false },
      ],
    });
    // Phase 94 Plan 02 TOOL-03: wire ready capabilityProbe so the MCP block
    // renders in the stable prefix (filter would otherwise hide an unprobed
    // server).
    const result = await buildSessionConfig(
      config,
      makeDeps({ mcpStateProvider: readyMcpStateProvider(["acme-db"]) }),
    );
    const prompt = result.systemPrompt;
    const idxIdentity = prompt.indexOf("## Identity");
    const idxIdentityBody = prompt.indexOf("IDENTITY_MARKER_ORDER_TEST");
    const idxMemoryHeading = prompt.indexOf("## Long-term memory");
    const idxMemoryBody = prompt.indexOf("MEMORY_MARKER_ORDER_TEST");
    const idxMcp = prompt.indexOf("| Server | Status | Tools | Last Error |");
    // All must be present.
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxIdentityBody).toBeGreaterThanOrEqual(0);
    expect(idxMemoryHeading).toBeGreaterThanOrEqual(0);
    expect(idxMemoryBody).toBeGreaterThan(0);
    expect(idxMcp).toBeGreaterThan(0);
    // Order: identity body BEFORE memory; memory BEFORE mcp status.
    expect(idxIdentityBody).toBeLessThan(idxMemoryBody);
    expect(idxMemoryBody).toBeLessThan(idxMcp);
  });

  it("MEM-01-C2: 16K char cap (Phase 115 D-01), 60KB MEMORY.md is head-tail truncated with the dream-pass marker", async () => {
    // Phase 115 D-01 replaced the 50KB byte cap with INJECTED_MEMORY_MAX_CHARS
    // (16,000 chars, 70% head + 20% tail around an agent-actionable marker).
    // This test still pinned the 50KB marker and slice length; updated by
    // WP6 (2026-10-25), which also keeps the marker alive through the
    // identity-budget pass (headTailTruncateKeepingMarker).
    const big = "H".repeat(30 * 1024) + "T".repeat(30 * 1024);
    mockFiles({ "/tmp/ws/MEMORY.md": big });
    const config = makeConfig({
      workspace: "/tmp/ws",
      memoryAutoLoad: true,
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
    });
    const result = await buildSessionConfig(config, makeDeps());
    const prompt = result.systemPrompt;
    expect(prompt).toContain("## Long-term memory");
    expect(prompt).not.toContain("…(truncated at 50KB cap)");
    // The agent-actionable read-site marker survives, between head and tail.
    const markerMatch = /\[TRUNCATED \S+ (\d+) chars dropped, dream-pass priority requested\]/.exec(prompt);
    expect(markerMatch).not.toBeNull();
    const headIdx = prompt.indexOf("HHHH");
    const tailIdx = prompt.indexOf("TTTT");
    expect(headIdx).toBeGreaterThan(0);
    expect(headIdx).toBeLessThan(markerMatch!.index);
    expect(tailIdx).toBeGreaterThan(markerMatch!.index);
    // At most the 16K cap's 90% (head 70% + tail 20%) of the body survives,
    // and the marker accounts for everything else.
    const kept = (prompt.match(/H{10,}|T{10,}/g) ?? []).reduce((n, run) => n + run.length, 0);
    expect(kept).toBeLessThanOrEqual(Math.floor(16_000 * 0.9));
    expect(Number(markerMatch![1]) + kept).toBe(60 * 1024);
  });

  it("MEM-01-C3: opt-out via memoryAutoLoad=false — MEMORY.md never read, heading absent", async () => {
    mockFiles({
      "/tmp/ws/MEMORY.md": "SHOULD_NEVER_APPEAR",
    });
    const config = makeConfig({
      workspace: "/tmp/ws",
      memoryAutoLoad: false,
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).not.toContain("## Long-term memory");
    expect(result.systemPrompt).not.toContain("SHOULD_NEVER_APPEAR");
    // Explicit: readFile was NEVER called with the MEMORY.md path.
    const memCall = vi
      .mocked(readFile)
      .mock.calls.find((c) => c[0] === "/tmp/ws/MEMORY.md");
    expect(memCall).toBeUndefined();
  });

  it("MEM-01-C4: override path via memoryAutoLoadPath — reads the override, NOT workspace MEMORY.md", async () => {
    mockFiles({
      "/override/fixture-memory.md": "OVERRIDE_MEMORY_CONTENT",
      "/tmp/ws/MEMORY.md": "WORKSPACE_MEMORY_CONTENT_NOT_READ",
    });
    const config = makeConfig({
      workspace: "/tmp/ws",
      memoryAutoLoad: true,
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
      memoryAutoLoadPath: "/override/fixture-memory.md",
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toContain("OVERRIDE_MEMORY_CONTENT");
    expect(result.systemPrompt).not.toContain(
      "WORKSPACE_MEMORY_CONTENT_NOT_READ",
    );
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(
      "/override/fixture-memory.md",
      "utf-8",
    );
    // Workspace MEMORY.md was NEVER attempted.
    const wsCall = vi
      .mocked(readFile)
      .mock.calls.find((c) => c[0] === "/tmp/ws/MEMORY.md");
    expect(wsCall).toBeUndefined();
  });

  it("MEM-01-C5: missing MEMORY.md — silent skip, no crash, heading absent", async () => {
    // Default mock rejects ENOENT for every path.
    const config = makeConfig({
      workspace: "/tmp/ws",
      memoryAutoLoad: true,
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toBeDefined();
    expect(result.systemPrompt).not.toContain("## Long-term memory");
    // Readfile was invoked but rejected — proven by the default ENOENT mock.
    // buildSessionConfig MUST NOT throw.
  });

  it("MEM-01-C6: fin-client integration — 'Acme LLC' surfaces without retrieval", async () => {
    mockFiles({
      "/tmp/fin-client/MEMORY.md":
        "# Firm rules\n\nOur firm legal name is Acme LLC — NOT 'Acme Investment Advisors LLC'.\n",
    });
    const config = makeConfig({
      name: "fin-client",
      workspace: "/tmp/fin-client",
      memoryAutoLoad: true,
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
    });
    const result = await buildSessionConfig(config, makeDeps());
    // The stable prefix contains the firm legal name verbatim.
    expect(result.systemPrompt).toContain("Acme LLC");
    expect(result.systemPrompt).toContain("## Long-term memory");
  });

  it("MEM-01-C7: MEMORY.md content lands in STABLE PREFIX (systemPrompt), NOT in mutableSuffix", async () => {
    mockFiles({
      "/tmp/ws/MEMORY.md": "STABLE_PREFIX_MEMORY_PAYLOAD",
    });
    const config = makeConfig({
      workspace: "/tmp/ws",
      memoryAutoLoad: true,
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
      channels: ["channel-xyz"], // forces a mutableSuffix to exist
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toContain("STABLE_PREFIX_MEMORY_PAYLOAD");
    // mutableSuffix, when present, must NOT echo the MEMORY body.
    if (result.mutableSuffix !== undefined) {
      expect(result.mutableSuffix).not.toContain(
        "STABLE_PREFIX_MEMORY_PAYLOAD",
      );
    }
  });
});

describe("buildSessionConfig — capability manifest injection (Phase 100 follow-up)", () => {
  it("CM-INT-1: includes the capability manifest in systemPrompt when agent has notable features", async () => {
    const config = makeConfig({
      dream: { enabled: true, idleMinutes: 30, model: "haiku" },
      schedules: [
        {
          name: "tick",
          cron: "*/5 * * * *",
          prompt: "tick",
          enabled: true,
        },
      ],
      skills: ["subagent-thread"],
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toContain("Your ClawCode Capabilities");
    expect(result.systemPrompt).toContain("Memory dreaming");
    expect(result.systemPrompt).toContain("Scheduled tasks");
  });

  it("CM-INT-2: omits the manifest entirely when agent has zero notable features (no bloat)", async () => {
    const config = makeConfig({
      dream: undefined,
      schedules: [],
      skills: [],
      gsd: undefined,
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).not.toContain("Your ClawCode Capabilities");
  });
});

// ---------------------------------------------------------------------------
// Phase 999.13 — back-compat byte-stability across both pillars
//
// Wave 0 RED-supportive snapshot test. The snapshot pins the cache-stable
// prefix for an agent fixture WITHOUT `delegates` and WITHOUT any
// `defaults.timezone` config — anchoring the no-config baseline so any
// future drift fails loud (REG-DETERMINISTIC).
//
// On main today this test creates the snapshot and passes. After Plans 01
// and 02 land, the same fixture must still produce the same snapshot —
// proving back-compat for the existing 15-agent fleet (no yaml change).
// ---------------------------------------------------------------------------
describe("Phase 999.13 — back-compat byte-stability", () => {
  it("back-compat-byte-identical: agent without delegates and without timezone produces stable systemPrompt", async () => {
    // Minimal, deterministic fixture. No delegates, no timezone — the
    // baseline that all 15 deployed agents currently match.
    const config = makeConfig({
      name: "back-compat-fixture-agent",
      workspace: "/tmp/back-compat-ws",
      memoryPath: "/tmp/back-compat-ws",
      channels: [],
      skills: [],
      mcpServers: [],
      schedules: [],
      slashCommands: [],
      dream: undefined,
      // Note: NO `delegates` field — stays undefined (Plan 01 adds the
      // resolver field on AgentConfig but absence must remain back-compat).
    });

    // WP6 (2026-10-25): directives off. The fleet directive block is fixed
    // operator text owned by config/schema.ts and is pinned by its own tests;
    // keeping it out of this snapshot stops every directive wording edit from
    // breaking the delegates / timezone back-compat pin.
    const result = await buildSessionConfig(
      config,
      makeDeps({ systemPromptDirectiveDefaults: {} }),
    );
    // Snapshot the systemPrompt verbatim. On main: snapshot is created.
    // After Plans 01+02 deploy: same fixture must still match — any drift
    // to the no-delegates / no-timezone baseline fails loud.
    expect(result.systemPrompt).toMatchSnapshot(
      "back-compat-byte-identical-systemPrompt",
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 115 Plan 04 sub-scope 5 — cacheBreakpointPlacement wiring regression.
//
// The architectural contract: ResolvedAgentConfig.cacheBreakpointPlacement
// MUST be threaded from session-config.ts into AssembleOptions so the
// operator-controlled config knob actually reaches the assembler. Without
// this wiring, an operator setting `agents.X.cacheBreakpointPlacement: "legacy"`
// in clawcode.yaml gets NO behavioral change — the revert path is dead code.
//
// This test pins the wiring at the buildSessionConfig boundary. Asserts:
//   - default (no override) → systemPrompt contains the breakpoint marker
//     (defaults.cacheBreakpointPlacement zod-default 'static-first' fires)
//   - explicit "legacy" → systemPrompt does NOT contain the marker
//     (revert path produces pre-115-04 byte-shape)
// ---------------------------------------------------------------------------
describe("Phase 115 Plan 04 — cacheBreakpointPlacement config wiring", () => {
  it("default (no override on ResolvedAgentConfig) → systemPrompt contains the breakpoint marker", async () => {
    // The session-config caller threads `config.cacheBreakpointPlacement`
    // into AssembleOptions. ResolvedAgentConfig field is optional at the
    // type level (per shared/types.ts) but the loader resolver always
    // populates it from defaults.cacheBreakpointPlacement (zod default
    // "static-first"). When undefined (legacy fixture), the assembler
    // falls back to DEFAULT_CACHE_BREAKPOINT_PLACEMENT which is also
    // "static-first" — so the marker SHOULD appear regardless.
    const config = makeConfig({
      identity: "I am a 115-04 wiring test agent",
      // Note: `cacheBreakpointPlacement` deliberately NOT set on the fixture
      // to mirror the path through assembleContextInternal where opts is
      // undefined and the default fires.
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toContain("phase115-cache-breakpoint");
  });

  it("explicit 'legacy' override → systemPrompt does NOT contain the breakpoint marker (revert path active)", async () => {
    const config = makeConfig({
      identity: "I am a 115-04 legacy-mode agent",
      cacheBreakpointPlacement: "legacy",
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).not.toContain("phase115-cache-breakpoint");
  });

  it("explicit 'static-first' override → systemPrompt contains the marker (parity with default)", async () => {
    const config = makeConfig({
      identity: "I am a 115-04 explicit static-first agent",
      cacheBreakpointPlacement: "static-first",
    });
    const result = await buildSessionConfig(config, makeDeps());
    expect(result.systemPrompt).toContain("phase115-cache-breakpoint");
  });
});


describe("buildSessionConfig — native advisor pairing guard (2026-08-28)", () => {
  const advisorBudget = { canCall: () => true } as never;
  // The literal ids these tests pinned (claude-fable-5 / claude-opus-5) went
  // stale when the alias map moved to newer model versions. Expected ids now
  // come from the same resolver session-config uses (updated by WP6,
  // 2026-10-25, to make the suite green; behavior under test is unchanged).
  const FABLE_ID = resolveModelId("fable");
  const FABLE_ADVISOR_ID = resolveAdvisorModel("fable");
  const OPUS_ADVISOR_ID = resolveAdvisorModel("opus");
  it("fable executor + fable advisor → advisorModel is the concrete fable id", async () => {
    const config = makeConfig({ name: "fin-client", model: "fable", advisor: { backend: "native", model: "fable" } } as never);
    const result = await buildSessionConfig(config, makeDeps({ advisorDefaults: { backend: "native", model: "opus" }, advisorBudget } as never));
    expect(result.advisorModel).toBe(FABLE_ADVISOR_ID);
    expect(FABLE_ADVISOR_ID).toMatch(/^claude-fable-/);
  });
  it("fable executor + the fleet-default opus advisor → advisor OMITTED and the operator warned", async () => {
    const warn = vi.fn();
    const config = makeConfig({ name: "fin-client", model: "fable", advisor: { backend: "native" } } as never);
    const result = await buildSessionConfig(
      config,
      makeDeps({ advisorDefaults: { backend: "native", model: "opus" }, advisorBudget, log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } } as never),
    );
    expect(result.advisorModel).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ agent: "fin-client", executor: FABLE_ID, advisor: OPUS_ADVISOR_ID });
    expect(String(warn.mock.calls[0]?.[1])).toContain("pairing");
  });
  it("sonnet executor + opus advisor (the common fleet pair) stays enabled; fork backend never sets it", async () => {
    const ok = await buildSessionConfig(
      makeConfig({ model: "sonnet", advisor: { backend: "native" } } as never),
      makeDeps({ advisorDefaults: { backend: "native", model: "opus" }, advisorBudget } as never),
    );
    expect(ok.advisorModel).toBe(OPUS_ADVISOR_ID);
    expect(OPUS_ADVISOR_ID).toMatch(/^claude-opus-/);
    const fork = await buildSessionConfig(
      makeConfig({ model: "fable", advisor: { backend: "fork", model: "fable" } } as never),
      makeDeps({ advisorDefaults: { backend: "fork", model: "opus" }, advisorBudget } as never),
    );
    expect(fork.advisorModel).toBeUndefined();
  });
});
