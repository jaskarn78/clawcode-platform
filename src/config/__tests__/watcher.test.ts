import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as yamlStringify } from "yaml";
import pino from "pino";
import { ConfigWatcher } from "../watcher.js";
import type { ConfigDiff } from "../types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

const log = pino({ level: "silent" });

function makeYaml(overrides: Record<string, unknown> = {}): string {
  return yamlStringify({
    version: 1,
    defaults: {
      model: "sonnet",
      skills: [],
      basePath: "~/.clawcode/agents",
      skillsPath: "~/.clawcode/skills",
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
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    },
    agents: [
      {
        name: "researcher",
        channels: ["123"],
        skills: [],
        heartbeat: true,
        schedules: [],
        admin: false,
        slashCommands: [],
        reactions: true,
      },
    ],
    ...overrides,
  });
}

/**
 * Helper: wait for a condition to become true with timeout.
 */
async function waitFor(
  fn: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("ConfigWatcher", () => {
  let tmpDir: string;
  let configPath: string;
  let auditPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "watcher-test-"));
    configPath = join(tmpDir, "clawcode.yaml");
    auditPath = join(tmpDir, "audit.jsonl");
    await writeFile(configPath, makeYaml());
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("calls onChange with correct diff when config changes", async () => {
    let receivedDiff: ConfigDiff | undefined;
    let receivedAgents: ResolvedAgentConfig[] | undefined;

    const watcher = new ConfigWatcher({
      configPath,
      auditTrailPath: auditPath,
      onChange: async (diff, agents) => {
        receivedDiff = diff;
        receivedAgents = agents;
      },
      log,
      debounceMs: 100,
    });

    await watcher.start();

    // Change channels (reloadable)
    const newYaml = makeYaml({
      agents: [
        {
          name: "researcher",
          channels: ["123", "456"],
          skills: [],
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
        },
      ],
    });
    await writeFile(configPath, newYaml);

    await waitFor(() => receivedDiff !== undefined, 5000);

    expect(receivedDiff).toBeDefined();
    expect(receivedDiff!.hasReloadableChanges).toBe(true);
    expect(receivedAgents).toBeDefined();
    expect(receivedAgents!.length).toBe(1);

    await watcher.stop();
  });

  it("debounces multiple rapid changes into one reload", async () => {
    let callCount = 0;

    const watcher = new ConfigWatcher({
      configPath,
      auditTrailPath: auditPath,
      onChange: async () => {
        callCount++;
      },
      log,
      debounceMs: 200,
    });

    await watcher.start();

    // Write multiple times rapidly
    for (let i = 0; i < 5; i++) {
      const yaml = makeYaml({
        agents: [
          {
            name: "researcher",
            channels: [`chan-${i}`],
            skills: [],
            heartbeat: true,
            schedules: [],
            admin: false,
            slashCommands: [],
            reactions: true,
          },
        ],
      });
      await writeFile(configPath, yaml);
      await new Promise((r) => setTimeout(r, 30));
    }

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 500));

    // Should have been called exactly once (or at most a few if filesystem events aren't perfectly merged)
    expect(callCount).toBeLessThanOrEqual(2);
    expect(callCount).toBeGreaterThanOrEqual(1);

    await watcher.stop();
  });

  it("does not crash on invalid YAML and preserves old config", async () => {
    const watcher = new ConfigWatcher({
      configPath,
      auditTrailPath: auditPath,
      onChange: async () => {},
      log,
      debounceMs: 100,
    });

    await watcher.start();
    const configBefore = watcher.getCurrentConfig();

    // Write invalid YAML
    await writeFile(configPath, "{{{{invalid yaml!!!!}}}}");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 400));

    // Config should be unchanged
    expect(watcher.getCurrentConfig()).toEqual(configBefore);

    await watcher.stop();
  });

  it("getCurrentConfig returns the initial config after start", async () => {
    const watcher = new ConfigWatcher({
      configPath,
      auditTrailPath: auditPath,
      onChange: async () => {},
      log,
      debounceMs: 100,
    });

    await watcher.start();
    const config = watcher.getCurrentConfig();

    expect(config.version).toBe(1);
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].name).toBe("researcher");

    await watcher.stop();
  });

  it("logs warning for non-reloadable field changes", async () => {
    const warnings: string[] = [];
    const warnLog = pino({
      level: "warn",
      transport: undefined,
    });
    // Use a custom log that captures warn calls
    const customLog = {
      ...log,
      warn: (obj: unknown, msg?: string) => {
        warnings.push(msg ?? String(obj));
      },
      error: log.error.bind(log),
      info: log.info.bind(log),
      debug: log.debug.bind(log),
      child: () => customLog,
    } as unknown as pino.Logger;

    const watcher = new ConfigWatcher({
      configPath,
      auditTrailPath: auditPath,
      onChange: async () => {},
      log: customLog,
      debounceMs: 100,
    });

    await watcher.start();

    // Change model (non-reloadable)
    const newYaml = makeYaml({
      agents: [
        {
          name: "researcher",
          channels: ["123"],
          model: "opus",
          skills: [],
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
        },
      ],
    });
    await writeFile(configPath, newYaml);

    await waitFor(() => warnings.length > 0, 5000);

    const restartWarning = warnings.find((w) =>
      w.includes("requires daemon restart"),
    );
    expect(restartWarning).toBeDefined();

    await watcher.stop();
  });

  // Phase 999.X — newConfig is passed to onChange so the daemon can
  // reassign its `let config` ref. Closures inside onTickAfter
  // (orphan-claude-reaper, subagent-session-reaper) read
  // `config.defaults.<dial>` lazily and pick up yaml hot-reloads
  // without restart.
  it("passes newConfig to onChange for daemon `let config` reassignment", async () => {
    let receivedNewConfig: import("../schema.js").Config | undefined;

    const watcher = new ConfigWatcher({
      configPath,
      auditTrailPath: auditPath,
      onChange: async (_diff, _agents, newConfig) => {
        receivedNewConfig = newConfig;
      },
      log,
      debounceMs: 100,
    });

    await watcher.start();

    const newYaml = makeYaml({
      agents: [
        {
          name: "researcher",
          channels: ["999"],
          skills: [],
          heartbeat: true,
          schedules: [],
          admin: false,
          slashCommands: [],
          reactions: true,
        },
      ],
    });
    await writeFile(configPath, newYaml);

    await waitFor(() => receivedNewConfig !== undefined, 5000);

    expect(receivedNewConfig).toBeDefined();
    expect(receivedNewConfig!.agents).toHaveLength(1);
    expect(receivedNewConfig!.agents[0]!.channels).toEqual(["999"]);

    await watcher.stop();
  });
});
