/**
 * Phase 83 Plan 02 Task 2 — Fork effort quarantine regression pin (EFFORT-06).
 *
 * The dangerous scenario:
 *   - Operator pushes the parent agent to `effort: max` via /clawcode-effort
 *   - Parent's SessionHandle has currentEffort = "max"
 *   - v1.5 fork-to-Opus fires (cost-sensitive advisor path)
 *   - If the fork inherits "max", the Opus advisor blows out the escalation
 *     budget — a real cost spike documented in PITFALLS.md §Pitfall 3.
 *
 * The quarantine:
 *   buildForkConfig takes `ResolvedAgentConfig`, not the live SessionHandle.
 *   The runtime override lives on the handle; it never reaches the config.
 *   Plan 02 pinned this with an explicit `effort: parentConfig.effort` line
 *   in fork.ts — without that line or these tests, a future refactor could
 *   accidentally thread runtime state into fork config.
 *
 * What these tests verify:
 *   1. MockSessionAdapter sees the fork handle created with the parent's
 *      CONFIG effort, not the parent's RUNTIME effort.
 *   2. No persisted effort-state entry bleeds into the fork name (fresh
 *      forks start at zero persistence).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { createMockAdapter, type MockSessionAdapter } from "../session-adapter.js";
import { SessionManager } from "../session-manager.js";
import { readEffortState } from "../effort-state-store.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig } from "../types.js";

// Warm-path mock — same pattern as session-manager.test.ts.
vi.mock("../warm-path-check.js", async () => {
  const actual = await vi.importActual<typeof import("../warm-path-check.js")>(
    "../warm-path-check.js",
  );
  return {
    ...actual,
    runWarmPathCheck: vi.fn(async () => ({
      ready: true,
      durations_ms: { sqlite: 50, embedder: 80, session: 1, browser: 0 },
      total_ms: 131,
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
  effort: "low" | "medium" | "high" | "max" | "ultracode" = "low",
  workspaceDir?: string,
): ResolvedAgentConfig {
  const ws = workspaceDir ?? "/tmp/test-workspace";
  return {
    name,
    workspace: ws,
    memoryPath: ws,
    channels: [],
    model: "sonnet",
    effort,
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
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
  };
}

describe("fork effort quarantine (Phase 83 EFFORT-06)", () => {
  // Longer timeout — integration tests do real SQLite init per fork +
  // warm-path + stopAll. 15s keeps the suite green under parallel vitest.
  const INTEGRATION_TIMEOUT_MS = 15_000;
  let tmpDir: string;
  let registryPath: string;
  let effortStatePath: string;
  let adapter: MockSessionAdapter;
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `fork-quarantine-${nanoid(6)}-`));
    registryPath = join(tmpDir, "registry.json");
    effortStatePath = join(tmpDir, "effort-state.json");
    adapter = createMockAdapter();
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      effortStatePath,
    });
  });

  afterEach(async () => {
    try { await manager.stopAll(); } catch { /* best-effort */ }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "fork handle launches with parent CONFIG effort, not parent runtime override",
    async () => {
    // Unique agent name per test — memory init writes to tmpDir/memory/memories.db
    // but registry/conversation state lives in per-test tmpDir so collisions
    // stay isolated. nanoid suffix keeps the name unique across parallel runs.
    const parent = `p-q1-${nanoid(4)}`;
    // 1. Parent config default: effort=low
    const parentCfg = makeConfig(parent, "low", tmpDir);
    await manager.startAgent(parent, parentCfg);
    expect(manager.getEffortForAgent(parent)).toBe("low");

    // 2. Operator bumps parent to max at runtime.
    manager.setEffortForAgent(parent, "max");
    expect(manager.getEffortForAgent(parent)).toBe("max");

    // 3. Fork (simulates v1.5 escalation path).
    const fork = await manager.forkSession(parent);

    // 4. Quarantine invariant: fork sees the CONFIG default ("low"), not
    //    the parent's runtime override ("max"). MockSessionHandle starts
    //    at its own default ("low") because buildForkConfig preserved the
    //    parent's config.effort — no runtime state leaked in.
    const forkEffort = manager.getEffortForAgent(fork.forkName);
    expect(forkEffort).toBe("low");

    // 5. Negative assertion: the fork's handle was NEVER setEffort("max").
    //    Mock captures all sessions, so we can inspect the fork handle
    //    directly and confirm its effort field equals "low".
    const forkHandle = [...adapter.sessions.values()].find(
      (h) => h.sessionId.includes(fork.forkName),
    );
    expect(forkHandle).toBeDefined();
    expect(forkHandle!.getEffort()).toBe("low");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "fork config preserves parent config effort field (buildForkConfig branch)",
    async () => {
    // Edge case: an agent that's genuinely configured at `effort: max` as
    // its CONFIG default. buildForkConfig MUST carry that config.effort
    // through to the fork's ResolvedAgentConfig so a fork-to-Opus that
    // legitimately needs max budget gets it. The quarantine rule is about
    // RUNTIME overrides — config defaults flow through unchanged.
    //
    // We verify the `buildForkConfig` output directly (the mock handle's
    // private effort field is not wired through from config, but the
    // ResolvedAgentConfig we pass into startAgent carries the field
    // verbatim — which is all the quarantine test needs).
    const parent = `p-q2-${nanoid(4)}`;
    const parentCfg = makeConfig(parent, "max", tmpDir);
    await manager.startAgent(parent, parentCfg);

    const fork = await manager.forkSession(parent);

    // The fork's resolved config (stored in SessionManager.configs) must
    // mirror the parent's CONFIG effort, not any runtime state.
    const forkConfig = manager.getAgentConfig(fork.forkName);
    expect(forkConfig).toBeDefined();
    expect(forkConfig!.effort).toBe("max");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "quick 260715-j1j (D9): parent CONFIG effort 'ultracode' → fork gets 'xhigh' (orchestration mode never inherited)",
    async () => {
      // Forks are headless (no channel, no operator) — they must never
      // inherit the native-Workflow orchestration mode, only the equivalent
      // thinking budget. buildForkConfig clamps ultracode → xhigh.
      const parent = `p-uc-${nanoid(4)}`;
      // nativeWorkflow rides along so the config is self-consistent (D7),
      // though buildForkConfig's clamp does not depend on it.
      const parentCfg = {
        ...makeConfig(parent, "ultracode", tmpDir),
        nativeWorkflow: true,
      };
      await manager.startAgent(parent, parentCfg);

      const fork = await manager.forkSession(parent);

      const forkConfig = manager.getAgentConfig(fork.forkName);
      expect(forkConfig).toBeDefined();
      expect(forkConfig!.effort).toBe("xhigh");
      expect(forkConfig!.effort).not.toBe("ultracode");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "fork name does NOT appear in parent's effort-state.json (no persistence bleed)",
    async () => {
    // EFFORT-03 + EFFORT-06 interaction: forks are ephemeral. Even though
    // the parent's override IS persisted, the fork's name must not exist
    // in the persistence file — fresh forks have zero persistence by
    // construction (startAgent(forkName) finds nothing to re-apply).
    const parent = `p-q3-${nanoid(4)}`;
    const parentCfg = makeConfig(parent, "low", tmpDir);
    await manager.startAgent(parent, parentCfg);
    manager.setEffortForAgent(parent, "max");

    // Wait for fire-and-forget persistence.
    await new Promise((r) => setTimeout(r, 50));

    const fork = await manager.forkSession(parent);

    // Parent's persisted level is "max"; fork's persisted level is null.
    expect(await readEffortState(effortStatePath, parent)).toBe("max");
    expect(await readEffortState(effortStatePath, fork.forkName)).toBeNull();
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
