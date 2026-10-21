/**
 * Phase 999.43-fu — Regression test for hot-reload propagation of
 * agent-level boolean/enum fields read via `SessionManager.getAgentConfig`.
 *
 * Bug history (Phase 999.43 Plan 05 §"Incident 1" + Phase 132 Plan 04
 * §"Carry-over #3"):
 *
 *   After `clawcode reload` picked up a yaml flip of
 *   `agents.fin-client.autoIngestAttachments` from undefined → true,
 *   IPC handlers calling `manager.getAgentConfig(agent)` continued to
 *   read the BOOT-TIME ResolvedAgentConfig snapshot. The journal logged
 *   `config hot-reloaded` but the per-agent `this.configs` Map was never
 *   refreshed by `SessionManager.setAllAgentConfigs` — it only wrote
 *   `this.allAgentConfigs` (a separate array consumed by session-config.ts).
 *   Operators worked around it with `systemctl restart clawcode`.
 *
 * Fix (T03 commit `fix(999.43-fu-T03)...`):
 *
 *   `SessionManager.setAllAgentConfigs` now also refreshes `this.configs`
 *   for any agent already present (preserves the "running agents" invariant).
 *
 * This test wires a REAL SessionManager + REAL ConfigReloader (no mocks at
 * the layer the bug hid under) and verifies that a hot-reload flip of
 * `autoIngestAttachments` from false → true causes the very next
 * `getAgentConfig()` call to return true — no restart, no reconcile.
 *
 * Coverage by extension: same code path serves `ingestionPriority`,
 * `autonomousSkillDrafting`, `skillDistiller`, and the closure re-reads
 * at session-manager.ts:719/764/1689/1774/2472. We pin the canonical
 * Phase 999.43 case as the regression anchor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { pino } from "pino";
import { createMockAdapter, type MockSessionAdapter } from "../session-adapter.js";
import { SessionManager } from "../session-manager.js";
import { ConfigReloader } from "../config-reloader.js";
import type { ConfigDiff } from "../../config/types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { RoutingTable } from "../../discord/types.js";
import type { BackoffConfig } from "../types.js";

// Same warm-path mock pattern as session-manager-set-model.test.ts —
// keeps `startAgent` from doing real MCP/embedder gating in the test.
vi.mock("../warm-path-check.js", async () => {
  const actual = await vi.importActual<typeof import("../warm-path-check.js")>(
    "../warm-path-check.js",
  );
  return {
    ...actual,
    runWarmPathCheck: vi.fn(async () => ({
      ready: true,
      durations_ms: { sqlite: 1, embedder: 1, session: 1, browser: 0, mcp: 0 },
      total_ms: 3,
      errors: [],
    })),
  };
});

const TEST_BACKOFF: BackoffConfig = {
  baseMs: 100,
  maxMs: 1000,
  maxRetries: 3,
  stableAfterMs: 500,
};

function makeConfig(
  name: string,
  workspaceDir: string,
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name,
    workspace: workspaceDir,
    memoryPath: workspaceDir,
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
    autoIngestAttachments: false, // Phase 999.43 D-09 — the regression target
    ingestionPriority: "medium" as const,
    settingSources: ["project"],
    autoStart: true,
    skills: [],
    soul: undefined,
    identity: undefined,
    memory: {
      compactionThreshold: 0.75,
      searchTopK: 10,
      consolidation: { enabled: false, weeklyThreshold: 7, monthlyThreshold: 30, schedule: "0 3 * * *" },
      decay: { halfLifeDays: 30, semanticWeight: 0.5, decayWeight: 0.5 },
      deduplication: { enabled: false, similarityThreshold: 0.9 },
    },
    schedules: [],
    heartbeat: { enabled: true, intervalSeconds: 60, checkTimeoutSeconds: 10, contextFill: { warningThreshold: 0.7, criticalThreshold: 0.9 } },
    skillsPath: "",
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

describe("Phase 999.43-fu — ConfigReloader → SessionManager.getAgentConfig hot-reload propagation", () => {
  const INTEGRATION_TIMEOUT_MS = 15_000;
  let tmpDir: string;
  let registryPath: string;
  let adapter: MockSessionAdapter;
  let manager: SessionManager;
  let reloader: ConfigReloader;
  let routingTableRef: { current: RoutingTable };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `sm-hotreload-${nanoid(6)}-`));
    registryPath = join(tmpDir, "registry.json");
    adapter = createMockAdapter();
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
    });
    routingTableRef = {
      current: { channelToAgent: new Map(), agentToChannels: new Map() },
    };
    // Minimal subsystem mocks — the bug under test is in SessionManager,
    // not in scheduler/heartbeat/webhooks/skills paths.
    const mockTaskScheduler = { removeAgent: vi.fn(), addAgent: vi.fn() } as any;
    const mockHeartbeatRunner = { setAgentConfigs: vi.fn() } as any;
    const mockWebhookManager = { destroy: vi.fn() } as any;
    const mockSkillsCatalog = new Map() as any;

    reloader = new ConfigReloader({
      sessionManager: manager, // REAL — this is the layer the bug hides under
      taskScheduler: mockTaskScheduler,
      heartbeatRunner: mockHeartbeatRunner,
      webhookManager: mockWebhookManager,
      skillsCatalog: mockSkillsCatalog,
      routingTableRef,
      log,
    });
  });

  afterEach(async () => {
    try { await manager.stopAll(); } catch { /* best-effort */ }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "HOT-RELOAD-01: yaml flip of autoIngestAttachments false→true takes effect on the next getAgentConfig call without restart",
    async () => {
      const agent = `fin-${nanoid(4)}`;
      const cfgBefore = makeConfig(agent, tmpDir, { autoIngestAttachments: false });

      // Boot the agent — populates SessionManager.configs (the Map that
      // getAgentConfig reads from).
      await manager.startAgent(agent, cfgBefore);

      // Sanity check pre-reload — the IPC handler view.
      const preReload = manager.getAgentConfig(agent);
      expect(preReload).toBeDefined();
      expect(preReload!.autoIngestAttachments).toBe(false);

      // Simulate the yaml edit: produce the new ResolvedAgentConfig the
      // loader would have produced AND the diff the differ would have emitted.
      const cfgAfter = makeConfig(agent, tmpDir, { autoIngestAttachments: true });
      const diff = makeDiff([
        {
          fieldPath: `agents.${agent}.autoIngestAttachments`,
          oldValue: false,
          newValue: true,
          reloadable: true,
        },
      ]);

      // Drive the production reload path. This is what ConfigWatcher.onChange
      // does in daemon.ts after a yaml debounce-and-reload.
      await reloader.applyChanges(diff, [cfgAfter]);

      // The PROOF: the IPC handler view (getAgentConfig) sees the flip on
      // the very next call. Pre-T03, this returned false (stale boot-time
      // snapshot) — the original Incident 1 symptom.
      const postReload = manager.getAgentConfig(agent);
      expect(postReload).toBeDefined();
      expect(postReload!.autoIngestAttachments).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "HOT-RELOAD-02: same path propagates ingestionPriority changes (enum field, same shape as autoIngestAttachments)",
    async () => {
      const agent = `fin-${nanoid(4)}`;
      const cfgBefore = makeConfig(agent, tmpDir, { ingestionPriority: "low" });
      await manager.startAgent(agent, cfgBefore);

      expect(manager.getAgentConfig(agent)!.ingestionPriority).toBe("low");

      const cfgAfter = makeConfig(agent, tmpDir, { ingestionPriority: "high" });
      const diff = makeDiff([
        {
          fieldPath: `agents.${agent}.ingestionPriority`,
          oldValue: "low",
          newValue: "high",
          reloadable: true,
        },
      ]);
      await reloader.applyChanges(diff, [cfgAfter]);

      expect(manager.getAgentConfig(agent)!.ingestionPriority).toBe("high");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "HOT-RELOAD-03: invariant — agent NOT in the configs Map (never started) does not get inserted by setAllAgentConfigs",
    async () => {
      // Don't start the agent; just publish a resolved config that
      // includes it. Production behavior: this.configs continues to mean
      // "agents currently managed" — yaml additions don't auto-start.
      const ghost = `ghost-${nanoid(4)}`;
      const cfg = makeConfig(ghost, tmpDir, { autoIngestAttachments: true });
      const diff = makeDiff([
        {
          // A reloadable change OTHER than the ghost's introduction so
          // applyChanges actually runs setAllAgentConfigs.
          fieldPath: `agents.${ghost}.channels`,
          oldValue: [],
          newValue: ["ch-x"],
          reloadable: true,
        },
      ]);
      await reloader.applyChanges(diff, [cfg]);

      // Ghost should NOT appear in getAgentConfig — invariant preserved.
      expect(manager.getAgentConfig(ghost)).toBeUndefined();
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
