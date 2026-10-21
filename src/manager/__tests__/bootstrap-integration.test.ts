import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildSessionConfig } from "../session-config.js";
import type { SessionConfigDeps } from "../session-config.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BootstrapStatus } from "../../bootstrap/types.js";

/**
 * Minimal mock deps for buildSessionConfig.
 * No tier managers, skills, or other agent configs needed for bootstrap tests.
 */
function makeDeps(): SessionConfigDeps {
  return {
    tierManagers: new Map(),
    skillsCatalog: new Map(),
    allAgentConfigs: [],
  };
}

/**
 * Create a minimal ResolvedAgentConfig for testing.
 * Uses provided workspace and optional overrides.
 */
function makeConfig(
  workspace: string,
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name: "test-agent",
    workspace,
    channels: ["general"],
    model: "sonnet",
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
    skillsPath: "",
    admin: false,
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 30, maxThreadSessions: 10 },
    reactions: false,
    slashCommands: [],
    ...overrides,
  } as ResolvedAgentConfig;
}

describe("Bootstrap integration with buildSessionConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bootstrap-int-"));
    // Ensure memory dir exists (loadLatestSummary reads from it)
    await mkdir(join(tmpDir, "memory"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("buildSessionConfig with bootstrapStatus needed returns bootstrap prompt", async () => {
    // No SOUL.md in workspace
    const config = makeConfig(tmpDir);
    const deps = makeDeps();
    const status: BootstrapStatus = "needed";

    const result = await buildSessionConfig(config, deps, undefined, status);

    // Should contain bootstrap walkthrough text, not SOUL.md default
    expect(result.systemPrompt).toContain("First-Run Bootstrap Session");
    expect(result.systemPrompt).toContain("setting up your identity");
    expect(result.systemPrompt).not.toContain("Who You Are");
  });

  it("buildSessionConfig with bootstrapStatus complete returns normal prompt", async () => {
    // Create a custom SOUL.md in workspace
    await writeFile(
      join(tmpDir, "SOUL.md"),
      "# My Soul\n\nI am a researcher agent with deep curiosity.",
    );
    const config = makeConfig(tmpDir);
    const deps = makeDeps();
    const status: BootstrapStatus = "complete";

    const result = await buildSessionConfig(config, deps, undefined, status);

    // Should contain fingerprint extracted from SOUL.md (name from heading)
    expect(result.systemPrompt).toContain("My Soul");
    expect(result.systemPrompt).toContain("## Identity");
    expect(result.systemPrompt).not.toContain("First-Run Bootstrap Session");
  });

  it("buildSessionConfig with bootstrapStatus undefined returns normal prompt (backward compat)", async () => {
    // Create a SOUL.md with recognizable content
    await writeFile(
      join(tmpDir, "SOUL.md"),
      "# SOUL.md - Who You Are\n\nYou are a helpful assistant.",
    );
    const config = makeConfig(tmpDir);
    const deps = makeDeps();

    // No bootstrapStatus parameter (backward compatibility)
    const result = await buildSessionConfig(config, deps);

    // Fingerprint extracts name from heading — "SOUL.md - Who You Are"
    expect(result.systemPrompt).toContain("## Identity");
    expect(result.systemPrompt).toContain("Who You Are");
    expect(result.systemPrompt).not.toContain("First-Run Bootstrap Session");
  });

  it("bootstrap prompt includes Discord Channel Bindings", async () => {
    const config = makeConfig(tmpDir, {
      channels: ["general", "dev"],
    });
    const deps = makeDeps();
    const status: BootstrapStatus = "needed";

    const result = await buildSessionConfig(config, deps, undefined, status);

    expect(result.systemPrompt).toContain("Discord Communication");
    expect(result.systemPrompt).toContain("general");
    expect(result.systemPrompt).toContain("dev");
  });
});
