/**
 * Quick 260715-j1j (D11) — conditional native-Workflow steer pins.
 *
 * The 260714-mkq anti-Workflow steer (v2 Discord-bindings block + v3 Model
 * A/B channel-protocol prompts) becomes CONDITIONAL on the per-agent
 * `nativeWorkflow` opt-in:
 *
 *   - Non-opted agents (the fleet) keep the original steer sentence
 *     VERBATIM — it is load-bearing for prompt-cache prefix hashes, so this
 *     suite pins the exact byte string.
 *   - Opted-in agents get the inverted steer: native Workflow PERMITTED for
 *     in-turn parallel lanes, bounded fan-out (concurrent lanes ≤4), still
 *     preferring `mcp__clawcode__start_workflow` for long-running background
 *     work that must survive the turn.
 *
 * The hard disallowedTools block is pinned separately in
 * loader-disallowed-tools.test.ts (subtraction of exactly "Workflow").
 */
import { describe, it, expect, vi } from "vitest";
import { buildSessionConfig, type SessionConfigDeps } from "../session-config.js";
import { buildChannelProtocolPrompt } from "../../llm-runtime/backends/claude-code-interactive.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

// Mock filesystem reads so buildSessionConfig doesn't hit disk (same harness
// as session-config-mcp.test.ts).
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

vi.mock("../../memory/context-summary.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../memory/context-summary.js")
  >();
  return {
    ...actual,
    loadLatestSummary: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../bootstrap/prompt-builder.js", () => ({
  buildBootstrapPrompt: vi.fn().mockReturnValue("bootstrap prompt"),
}));

/**
 * The 260714-mkq v2 steer sentence, byte-identical to session-config.ts.
 * Changing this string churns every non-opted agent's stablePrefix hash —
 * a fleet-wide cache bust. Update ONLY with that cost in mind.
 */
const V2_ANTI_WORKFLOW_STEER =
  "For background fan-out (running several independent tasks in parallel), use the `mcp__clawcode__start_workflow` tool — it returns immediately, posts progress + results to your channel, and a stuck step auto-aborts. Do NOT use the native in-session Workflow tool for this: it runs inside your turn and is killed when the turn ends, so its results are lost and its failure is invisible.";

/** The 260714-mkq v3 steer (Model A/B), joined form, byte-identical pin. */
const V3_ANTI_WORKFLOW_STEER =
  "For background fan-out (several independent tasks in parallel), use the `mcp__clawcode__start_workflow` tool — it returns immediately and posts progress + results to your channel; do NOT use the native in-session Workflow tool, whose lanes are killed when your turn ends.";

function makeConfig(
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name: "steer-agent",
    workspace: "/tmp/test-workspace",
    memoryPath: "/tmp/test-workspace",
    channels: ["chan-1"],
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
    mcpServers: [],
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

describe("v2 Discord-bindings workflow steer — conditional on nativeWorkflow (D11)", () => {
  it("non-opted agent keeps the anti-Workflow steer sentence VERBATIM (cache-prefix pin)", async () => {
    const cfg = await buildSessionConfig(makeConfig(), makeDeps());
    expect(cfg.systemPrompt).toContain(V2_ANTI_WORKFLOW_STEER);
  });

  it("opted-in agent LACKS the anti-Workflow sentence and gets the bounded permitted variant", async () => {
    const cfg = await buildSessionConfig(
      makeConfig({ nativeWorkflow: true }),
      makeDeps(),
    );
    expect(cfg.systemPrompt).not.toContain(
      "Do NOT use the native in-session Workflow tool",
    );
    // Inverted steer: permitted + bounded fan-out.
    expect(cfg.systemPrompt).toContain("PERMITTED");
    expect(cfg.systemPrompt).toContain("keep concurrent lanes ≤4");
    // Long-running background work still steers to the daemon path.
    expect(cfg.systemPrompt).toContain("mcp__clawcode__start_workflow");
  });

  it("non-opted agent's prompt does NOT contain the permitted variant", async () => {
    const cfg = await buildSessionConfig(makeConfig(), makeDeps());
    expect(cfg.systemPrompt).not.toContain("keep concurrent lanes ≤4");
  });
});

describe("v3 channel-protocol workflow steer — conditional on nativeWorkflow (D11)", () => {
  it("Model A non-opted keeps the anti-Workflow steer VERBATIM", () => {
    const prompt = buildChannelProtocolPrompt(true, false);
    expect(prompt).toContain(V3_ANTI_WORKFLOW_STEER);
  });

  it("Model A opted-in lacks the anti-Workflow steer and contains the bounded permitted variant", () => {
    const prompt = buildChannelProtocolPrompt(true, true);
    expect(prompt).not.toContain("do NOT use the native in-session Workflow tool");
    expect(prompt).toContain("PERMITTED");
    expect(prompt).toContain("keep concurrent lanes ≤4");
    expect(prompt).toContain("mcp__clawcode__start_workflow");
  });

  it("Model B non-opted keeps the anti-Workflow steer VERBATIM", () => {
    const prompt = buildChannelProtocolPrompt(false, false);
    expect(prompt).toContain(V3_ANTI_WORKFLOW_STEER);
  });

  it("Model B opted-in lacks the anti-Workflow steer and contains the bounded permitted variant", () => {
    const prompt = buildChannelProtocolPrompt(false, true);
    expect(prompt).not.toContain("do NOT use the native in-session Workflow tool");
    expect(prompt).toContain("PERMITTED");
    expect(prompt).toContain("keep concurrent lanes ≤4");
    expect(prompt).toContain("mcp__clawcode__start_workflow");
  });
});
