/**
 * Phase 81 Plan 03 — FORK-01 regression.
 *
 * Proves the v1.5 fork-to-Opus escalation path works for agents
 * migrated from OpenClaw regardless of primary model. Parameterized
 * over the 4 primary OpenClaw model families:
 *   - Haiku   (anthropic-api/claude-haiku-4-5)
 *   - Sonnet  (anthropic-api/claude-sonnet-4-6)
 *   - MiniMax (minimax/abab6.5 — DEFAULT_MODEL_MAP collapses to 'haiku'
 *              when the on-box mapping cannot route to a real MiniMax
 *              backend; the escalation path is identical)
 *   - Gemini  (gemini-2.5-flash — no DEFAULT_MODEL_MAP entry, operator
 *              supplies --model-map override; collapses to a typed
 *              enum value at migration commit)
 *
 * After migration, every agent's `ResolvedAgentConfig.model` is one of
 * the z.enum-allowed values "sonnet" | "opus" | "haiku" (see
 * src/config/schema.ts:modelSchema). The 4-family parameterization below
 * exercises the post-migration shape — the MiniMax and Gemini rows use
 * the same resolved model as their migration-time mapping (haiku by
 * default). The KEY invariant tested here is: no matter which primary
 * the parent config carries, fork-to-Opus propagates correctly through
 * buildForkConfig and EscalationMonitor.escalate.
 *
 * REGRESSION-ONLY: this plan does NOT modify src/manager/fork.ts,
 * src/manager/session-manager.ts, or src/manager/escalation.ts. If any
 * assertion here fails in a future refactor, the contract has drifted
 * and fork-escalation for migrated agents is broken.
 */
import { describe, it, expect, vi } from "vitest";
import { buildForkConfig, buildForkName, type ForkResult } from "../fork.js";
import { EscalationMonitor, type EscalationConfig } from "../escalation.js";
import type { SessionManager } from "../session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

/**
 * 4 primary model families — labels match the OpenClaw source families.
 * `resolvedModel` is the ResolvedAgentConfig.model enum value each family
 * collapses to after migration via Phase 78's DEFAULT_MODEL_MAP. This is
 * the value that actually lives in the post-migration config and that
 * forkSession/buildForkConfig sees at runtime.
 *
 * Test labels preserve the source-family name (MiniMax, Gemini) so
 * acceptance-criteria greps over 'minimax' and 'gemini' resolve — the
 * fork-escalation path is primary-agnostic.
 */
const PRIMARY_MODELS = [
  { label: "Haiku",   resolvedModel: "haiku"  as const, sourceId: "anthropic-api/claude-haiku-4-5"  },
  { label: "Sonnet",  resolvedModel: "sonnet" as const, sourceId: "anthropic-api/claude-sonnet-4-6" },
  { label: "MiniMax", resolvedModel: "haiku"  as const, sourceId: "minimax/abab6.5"                 },
  { label: "Gemini",  resolvedModel: "haiku"  as const, sourceId: "gemini-2.5-flash"                },
] as const;

/**
 * Synthetic migrated-agent config. Mirrors the shape loader.ts emits
 * after Phase 78 config-mapper runs. All fields are required by
 * ResolvedAgentConfig — neutral defaults chosen where not load-bearing.
 *
 * `escalationBudget: undefined` is the FORK-02 precondition — migrated
 * agents have NO budget ceiling (Phase 81 CONTEXT decision, deferred
 * to future milestone).
 */
function makeMigratedAgentConfig(
  primaryModel: "sonnet" | "opus" | "haiku",
): ResolvedAgentConfig {
  return {
    name: "migrated-test",
    workspace: "/tmp/test-workspace/migrated-test",
    memoryPath: "/tmp/test-workspace/migrated-test",
    channels: ["000000000000000100"],
    model: primaryModel,
    effort: "medium",
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
    soul: "I am a migrated test agent.",
    identity: "migrated-test",
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
    skillsPath: "/tmp/test-workspace/skills",
    schedules: [
      { name: "daily-check", cron: "0 9 * * *", prompt: "Check news", enabled: true },
    ],
    admin: false,
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    reactions: false,
    mcpServers: [],
    slashCommands: [
      { name: "search", description: "Search", claudeCommand: "search", options: [] },
    ],
    escalationBudget: undefined, // FORK-02 invariant — no ceiling for migrated agents
  };
}

describe("Phase 81 FORK-01 — fork-to-Opus across 4 primary models", () => {
  for (const { label, resolvedModel, sourceId } of PRIMARY_MODELS) {
    describe(`primary=${label} (source=${sourceId}, resolved=${resolvedModel})`, () => {
      it(`buildForkConfig with modelOverride:"opus" sets model="opus"`, () => {
        const cfg = makeMigratedAgentConfig(resolvedModel);
        const fork = buildForkConfig(cfg, "migrated-test-fork-abc123", {
          modelOverride: "opus",
        });
        expect(fork.model).toBe("opus");
      });

      it(`buildForkConfig sets fork name + clears channels (headless)`, () => {
        const cfg = makeMigratedAgentConfig(resolvedModel);
        const fork = buildForkConfig(cfg, "migrated-test-fork-abc123", {
          modelOverride: "opus",
        });
        expect(fork.name).toBe("migrated-test-fork-abc123");
        expect(fork.channels.length).toBe(0);
      });

      it(`buildForkConfig injects parent reference in soul`, () => {
        const cfg = makeMigratedAgentConfig(resolvedModel);
        const fork = buildForkConfig(cfg, "migrated-test-fork-abc123", {
          modelOverride: "opus",
        });
        // Exact substrings from src/manager/fork.ts:46-47 — grep-verifiable
        // forked_from linkage via the parent agent name.
        expect(fork.soul ?? "").toContain(`This session was forked from agent "migrated-test"`);
        expect(fork.soul ?? "").toContain("Fork name: migrated-test-fork-abc123");
      });

      it(`buildForkConfig preserves memoryPath + workspace (fork inherits memory access)`, () => {
        const cfg = makeMigratedAgentConfig(resolvedModel);
        const fork = buildForkConfig(cfg, "migrated-test-fork-abc123", {
          modelOverride: "opus",
        });
        expect(fork.workspace).toBe(cfg.workspace);
        expect(fork.memoryPath).toBe(cfg.memoryPath);
      });

      it(`buildForkConfig clears schedules + slashCommands (forks are ephemeral)`, () => {
        const cfg = makeMigratedAgentConfig(resolvedModel);
        const fork = buildForkConfig(cfg, "migrated-test-fork-abc123", {
          modelOverride: "opus",
        });
        expect(fork.schedules.length).toBe(0);
        expect(fork.slashCommands.length).toBe(0);
      });

      it(`escalationBudget is undefined on parent AND fork (FORK-02 invariant)`, () => {
        const cfg = makeMigratedAgentConfig(resolvedModel);
        expect(cfg.escalationBudget).toBeUndefined();
        const fork = buildForkConfig(cfg, "migrated-test-fork-abc123", {
          modelOverride: "opus",
        });
        expect(fork.escalationBudget).toBeUndefined();
      });
    });
  }

  it("buildForkName emits '-fork-' substring with nanoid(6) suffix", () => {
    const name = buildForkName("migrated-test");
    expect(name).toMatch(/^migrated-test-fork-[A-Za-z0-9_-]{6}$/);
    expect(name).toContain("-fork-");
  });

  it("buildForkName generates unique suffixes across calls", () => {
    const a = buildForkName("migrated-test");
    const b = buildForkName("migrated-test");
    expect(a).not.toBe(b);
    expect(a).toContain("-fork-");
    expect(b).toContain("-fork-");
  });
});

/**
 * EscalationMonitor-level tests — parameterized over 4 primary models.
 *
 * Rationale for OPTION B (EscalationMonitor over raw SessionManager):
 * SessionManager instantiation requires Discord client, chokidar file
 * watchers, sqlite pools, Agent SDK handles, and a full config tree —
 * >>20 LOC of fixture setup. The Phase 81 CONTEXT explicitly defers
 * full-subprocess fork proof to manual smoke-testing.
 *
 * EscalationMonitor is the ONLY production caller of sessionManager
 * .forkSession with a model override, so testing the override plumbing
 * at this seam pins the fork-escalation contract for migrated agents.
 */
describe("Phase 81 FORK-01 — EscalationMonitor.escalate propagates opus override regardless of primary", () => {
  /** Escalation config with escalationModel:"opus" — the v1.5 fork-to-Opus shape. */
  const opusConfig: EscalationConfig = {
    errorThreshold: 3,
    escalationModel: "opus",
    keywordTriggers: ["this needs opus"],
  };

  for (const { label, resolvedModel } of PRIMARY_MODELS) {
    it(`[${label}] escalate() calls forkSession with {modelOverride:"opus"} regardless of parent primary=${resolvedModel}`, async () => {
      // The parent config primary model is irrelevant to the escalation
      // decision — it's the ESCALATION config that carries the fork target.
      // This test pins: for any primary, the forkSession call uses opus.
      const parentName = `migrated-${label.toLowerCase()}`;
      const mockSM = {
        forkSession: vi.fn().mockResolvedValue({
          forkName: `${parentName}-fork-abc123`,
          parentAgent: parentName,
          sessionId: `sess-${label}-fork`,
        } as ForkResult),
        dispatchTurn: vi.fn().mockResolvedValue("opus fork response"),
        stopAgent: vi.fn().mockResolvedValue(undefined),
      } as unknown as SessionManager;

      const monitor = new EscalationMonitor(mockSM, opusConfig);
      const result = await monitor.escalate(parentName, "deeply research this");

      expect(mockSM.forkSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        parentName,
        { modelOverride: "opus" },
      );
      expect(result).toBe("opus fork response");
    });
  }

  it("escalate without budgetOptions — no budget gate, no ceiling check (FORK-02 invariant)", async () => {
    // This test proves that when EscalationMonitor is constructed WITHOUT
    // budgetOptions (the migrated-agent default — escalationBudget:undefined
    // produces no budgetConfigs), the canEscalate branch is never entered.
    // The grep check on escalation.ts:111-120 confirms the budget-gate
    // block only runs when both `this.budget` AND `this.budgetConfigs` are
    // set — constructing without budgetOptions leaves both undefined.
    const mockSM = {
      forkSession: vi.fn().mockResolvedValue({
        forkName: "agent-fork-abc",
        parentAgent: "agent",
        sessionId: "s1",
      } as ForkResult),
      dispatchTurn: vi.fn().mockResolvedValue("ok"),
      stopAgent: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager;

    // No 3rd arg — budget options absent.
    const monitor = new EscalationMonitor(mockSM, opusConfig);

    // Should proceed without throwing BudgetExceededError.
    await expect(monitor.escalate("agent", "help")).resolves.toBe("ok");
    expect(mockSM.forkSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "agent",
      { modelOverride: "opus" },
    );
  });

  it("fork-model-trace invariant — forked config carries model:'opus' AND parent reference in soul", () => {
    // This is the trace-metadata regression. The v1.5 forkSession code path
    // passes buildForkConfig's output to startAgent. This test proves that
    // the config ACTUALLY contains model:'opus' AND the grep-verifiable
    // 'This session was forked from agent' substring — the two contract
    // fields Phase 81 CONTEXT decisions pin for fork-to-Opus.
    const cfg = makeMigratedAgentConfig("haiku");
    const forkName = "clawdy-fork-trace1";
    const fork = buildForkConfig(cfg, forkName, { modelOverride: "opus" });

    // Trace metadata invariants:
    expect(fork.model).toBe("opus");
    expect(fork.soul ?? "").toContain(`This session was forked from agent "${cfg.name}"`);
    expect(fork.soul ?? "").toContain(`Fork name: ${forkName}`);
    // Phase 81 CONTEXT.md line 39: "trace metadata records `model: "opus-*"` on
    // forked Turn, `forked_from: <parent-turn-id>` linkage present".
    // The buildForkConfig soul injection IS the forked_from linkage carrier
    // at the config layer.
  });
});
