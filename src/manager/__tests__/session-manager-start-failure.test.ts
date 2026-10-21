/**
 * WS-2 G4 (sandbox-hardening-2026-06-19) — a FRESH-START spawn failure must be
 * an observable registry health-state, not a "starting" zombie.
 *
 * Before this fix, `startAll`'s catch only LOGGED a thrown `startAgent` (e.g. a
 * broken sandbox bind → claude dies at init → `createSession` rejects), leaving
 * the registry entry at "starting" — exactly the "agent left broken and only an
 * operator noticed" gap the incident exposed. (The RESUME path,
 * `reconcileRegistry`, already marked "crashed" + scheduled recovery; this pins
 * the equivalent observability for the start path.)
 *
 * Harness mirrors recovery-warm-path-failure.test.ts: real SessionManager + mock
 * adapter, tmpdir registry, real timers. We override the mock adapter's
 * `createSession` to throw so the failure propagates through startAgentCore →
 * withLifecycleLock → startAll's catch.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMockAdapter } from "../session-adapter.js";
import type { MockSessionAdapter } from "../session-adapter.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import { readRegistry } from "../registry.js";
import { SessionManager } from "../session-manager.js";

function makeConfig(name: string, workspace: string): ResolvedAgentConfig {
  return {
    name,
    workspace,
    memoryPath: workspace,
    channels: ["#general"],
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
  } as ResolvedAgentConfig;
}

describe("startAll — fresh-start spawn failure is an observable registry health-state (WS-2 G4)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "start-failure-test-"));
    registryPath = join(tmpDir, "registry.json");
    // Simulate the incident's spawn failure: claude dies at init → createSession
    // rejects (the SDK surfaces it as exitError after the EPIPE is swallowed).
    adapter.createSession = async () => {
      throw new Error("Claude Code process exited with code 1 (simulated init failure)");
    };
    manager = new SessionManager({ adapter, registryPath });
  });

  afterEach(async () => {
    manager._clearAllRecoveryTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("marks the agent 'failed' (with lastError) instead of leaving it 'starting'", async () => {
    await manager.startAll([makeConfig("agent-broken", tmpDir)]);

    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "agent-broken");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("failed"); // NOT "starting" — the zombie the fix kills
    expect(entry!.lastError).toContain("startAgent:");
    expect(entry!.lastError).toContain("simulated init failure");
  }, 30_000);

  it("does not leave the failed agent in the running set", async () => {
    await manager.startAll([makeConfig("agent-broken", tmpDir)]);
    expect(manager.isRunning("agent-broken")).toBe(false);
  }, 30_000);

  it("startAll resolves (does not throw) so the rest of the fleet still boots", async () => {
    // The whole point of per-agent isolation: one agent's failure is contained.
    await expect(manager.startAll([makeConfig("agent-broken", tmpDir)])).resolves.toBeUndefined();
  }, 30_000);
});
