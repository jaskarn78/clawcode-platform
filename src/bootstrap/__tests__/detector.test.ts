import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBootstrapNeeded } from "../detector.js";
import { DEFAULT_SOUL } from "../../config/defaults.js";
import { BOOTSTRAP_FLAG_FILE } from "../types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

function makeConfig(overrides: Partial<ResolvedAgentConfig> & { workspace: string }): ResolvedAgentConfig {
  return {
    name: "test-agent",
    memoryPath: overrides.workspace, // Phase 75 SHARED-01 — mirror workspace for test fixtures
    channels: ["#general"],
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
      compactionThreshold: 80,
      searchTopK: 5,
      consolidation: { enabled: false, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" },
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: false, similarityThreshold: 0.9 },
    },
    heartbeat: {
      enabled: false,
      intervalSeconds: 30,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 70, criticalThreshold: 90 },
    },
    skillsPath: "",
    schedules: [],
    admin: false,
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 30, maxThreadSessions: 10 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
    ...overrides,
  };
}

describe("detectBootstrapNeeded", () => {
  const tempDirs: string[] = [];

  async function makeTempWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "bootstrap-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("returns 'needed' when no flag file and no SOUL.md", async () => {
    const workspace = await makeTempWorkspace();
    const config = makeConfig({ workspace });

    const status = await detectBootstrapNeeded(config);

    expect(status).toBe("needed");
  });

  it("returns 'needed' when no flag file and SOUL.md matches DEFAULT_SOUL", async () => {
    const workspace = await makeTempWorkspace();
    await writeFile(join(workspace, "SOUL.md"), DEFAULT_SOUL, "utf-8");
    const config = makeConfig({ workspace });

    const status = await detectBootstrapNeeded(config);

    expect(status).toBe("needed");
  });

  it("returns 'complete' when .bootstrap-complete flag file exists", async () => {
    const workspace = await makeTempWorkspace();
    await writeFile(join(workspace, BOOTSTRAP_FLAG_FILE), "done", "utf-8");
    const config = makeConfig({ workspace });

    const status = await detectBootstrapNeeded(config);

    expect(status).toBe("complete");
  });

  it("returns 'complete' when SOUL.md exists and differs from DEFAULT_SOUL", async () => {
    const workspace = await makeTempWorkspace();
    await writeFile(join(workspace, "SOUL.md"), "# Custom Soul\nI am unique.", "utf-8");
    const config = makeConfig({ workspace });

    const status = await detectBootstrapNeeded(config);

    expect(status).toBe("complete");
  });

  it("returns 'skipped' when config.soul is defined", async () => {
    const workspace = await makeTempWorkspace();
    const config = makeConfig({ workspace, soul: "custom-soul-content" });

    const status = await detectBootstrapNeeded(config);

    expect(status).toBe("skipped");
  });

  it("returns 'needed' when SOUL.md matches DEFAULT_SOUL with whitespace differences", async () => {
    const workspace = await makeTempWorkspace();
    await writeFile(join(workspace, "SOUL.md"), `  ${DEFAULT_SOUL}  \n`, "utf-8");
    const config = makeConfig({ workspace });

    const status = await detectBootstrapNeeded(config);

    expect(status).toBe("needed");
  });
});
