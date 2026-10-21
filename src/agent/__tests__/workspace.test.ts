import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, lstat, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, createWorkspaces } from "../workspace.js";
import {
  DEFAULT_SOUL,
  DEFAULT_IDENTITY_TEMPLATE,
  DEFAULT_MEMORY_TEMPLATE,
  HOMELAB_POINTER_LINE,
  renderIdentity,
} from "../../config/defaults.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clawcode-ws-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeAgent(overrides: Partial<ResolvedAgentConfig> & { workspace: string }): ResolvedAgentConfig {
  return {
    name: "test-agent",
    memoryPath: overrides.workspace, // Phase 75 SHARED-01 — mirror workspace for test fixtures
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
    memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 } },
    schedules: [],
    admin: false,
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    skillsPath: "~/.clawcode/skills",
    slashCommands: [],
    threads: {
      idleTimeoutMinutes: 1440,
      maxThreadSessions: 10,
    },
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: {
        warningThreshold: 0.6,
        criticalThreshold: 0.75,
      },
    },
    reactions: false,
    mcpServers: [],
    ...overrides,
  };
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

describe("createWorkspace", () => {
  it("creates workspace directory at agent.workspace path", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath });

    await createWorkspace(agent);

    const stat = await lstat(wsPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates memory/ subdirectory inside workspace", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath });

    await createWorkspace(agent);

    const stat = await lstat(join(wsPath, "memory"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates skills/ subdirectory inside workspace", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath });

    await createWorkspace(agent);

    const stat = await lstat(join(wsPath, "skills"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("writes SOUL.md with DEFAULT_SOUL content when agent.soul is undefined", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath, soul: undefined });

    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "SOUL.md"), "utf-8");
    expect(content).toBe(DEFAULT_SOUL);
  });

  // Gap 4 (memory-persistence-gaps): the DEFAULT_SOUL template must include
  // the Memory Lookup convention so agents know the default scope auto-widens
  // to conversation history. Locking this down as a regression guard so a
  // future SOUL.md rewrite cannot silently drop the section.
  it("DEFAULT_SOUL documents the implicit memory_lookup scope fallback", () => {
    expect(DEFAULT_SOUL).toContain("Memory Lookup");
    expect(DEFAULT_SOUL).toContain("memory_lookup");
    expect(DEFAULT_SOUL).toMatch(/scope/);
    expect(DEFAULT_SOUL).toMatch(/fallback|widens|automatically/i);
  });

  it("writes SOUL.md with config-provided inline content when agent.soul is set", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const customSoul = "# Custom Soul\nBe bold.";
    const agent = makeAgent({ workspace: wsPath, soul: customSoul });

    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "SOUL.md"), "utf-8");
    expect(content).toBe(customSoul);
  });

  it("writes IDENTITY.md with agent name interpolated from DEFAULT_IDENTITY_TEMPLATE when agent.identity is undefined", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath, name: "researcher", identity: undefined });

    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "IDENTITY.md"), "utf-8");
    const expected = renderIdentity(DEFAULT_IDENTITY_TEMPLATE, "researcher");
    expect(content).toBe(expected);
    expect(content).toContain("researcher");
  });

  it("writes IDENTITY.md with config-provided content when agent.identity is set", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const customIdentity = "# Custom Identity\nI am special.";
    const agent = makeAgent({ workspace: wsPath, identity: customIdentity });

    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "IDENTITY.md"), "utf-8");
    expect(content).toBe(customIdentity);
  });

  it("does NOT overwrite existing SOUL.md when agent.soul is undefined (idempotency)", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath, soul: undefined });

    // First run -- creates default SOUL.md
    await createWorkspace(agent);

    // Simulate user editing SOUL.md
    const { writeFile } = await import("node:fs/promises");
    const userContent = "# User edited SOUL\nMy custom soul.";
    await writeFile(join(wsPath, "SOUL.md"), userContent);

    // Second run -- should preserve user edit
    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "SOUL.md"), "utf-8");
    expect(content).toBe(userContent);
  });

  it("DOES overwrite SOUL.md when agent.soul is explicitly set in config (config is source of truth)", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");

    // First run with default
    const agentDefault = makeAgent({ workspace: wsPath, soul: undefined });
    await createWorkspace(agentDefault);

    // Second run with explicit soul
    const configSoul = "# Config Soul\nFrom config.";
    const agentExplicit = makeAgent({ workspace: wsPath, soul: configSoul });
    await createWorkspace(agentExplicit);

    const content = await readFile(join(wsPath, "SOUL.md"), "utf-8");
    expect(content).toBe(configSoul);
  });

  it("does NOT overwrite existing IDENTITY.md when agent.identity is undefined (idempotency)", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath, identity: undefined });

    // First run
    await createWorkspace(agent);

    // Simulate user editing
    const { writeFile } = await import("node:fs/promises");
    const userContent = "# My custom identity";
    await writeFile(join(wsPath, "IDENTITY.md"), userContent);

    // Second run -- should preserve
    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "IDENTITY.md"), "utf-8");
    expect(content).toBe(userContent);
  });

  // ── Phase 999.47 Plan 04 Task 1 — SC-5 forward path ──────────────────────
  // Every new agent created via `clawcode agent-create` must ship with the
  // verbatim homelab pointer line baked into its MEMORY.md. These tests pin
  // the contract end-to-end so a future refactor cannot silently drop the
  // pointer.

  it("writes MEMORY.md containing the verbatim homelab pointer line (Phase 999.47 SC-5)", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath });

    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "MEMORY.md"), "utf-8");
    expect(content).toContain(
      "- [Homelab inventory](/home/clawcode/homelab/INVENTORY.md) — canonical source of truth for hosts, VMs, containers, access",
    );
  });

  it("writes MEMORY.md matching DEFAULT_MEMORY_TEMPLATE on first-run (regression guard for default template content)", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath });

    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "MEMORY.md"), "utf-8");
    // Regression guard: the default template (header + pointer) must land
    // intact — pointer is ADDED to the template, not replacing it.
    expect(content).toBe(DEFAULT_MEMORY_TEMPLATE);
    expect(content).toContain("# Memory");
    expect(content).toContain(HOMELAB_POINTER_LINE);
  });

  it("MEMORY.md pointer line is a markdown list item with leading dash + space", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath });

    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "MEMORY.md"), "utf-8");
    // The exact format: "- [Homelab inventory]..." — leading dash, single
    // space, then markdown link. Pin the prefix so a future formatter doesn't
    // rewrite the bullet as `*` or `+` and silently break the seeder's
    // grep -Fxq idempotency check.
    expect(content).toMatch(/^- \[Homelab inventory\]\(/m);
  });

  it("does NOT overwrite existing MEMORY.md when pointer already present (idempotency)", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath });

    // First run — creates default MEMORY.md
    await createWorkspace(agent);

    // Simulate operator edit that PRESERVES the pointer line
    const { writeFile } = await import("node:fs/promises");
    const operatorContent = `# Memory\n\nSome operator-authored notes here.\n\n${HOMELAB_POINTER_LINE}\n\nMore notes after.\n`;
    await writeFile(join(wsPath, "MEMORY.md"), operatorContent);

    // Second run — pointer is already present, file must remain byte-identical
    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "MEMORY.md"), "utf-8");
    expect(content).toBe(operatorContent);
  });

  it("appends pointer to existing MEMORY.md that lacks it (idempotent backfill in-process)", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath });

    // Pre-seed a workspace whose MEMORY.md predates Phase 999.47 — no pointer.
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(wsPath, { recursive: true });
    const legacyContent = "# Memory\n\nLegacy notes from before Phase 999.47.\n";
    await writeFile(join(wsPath, "MEMORY.md"), legacyContent);

    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "MEMORY.md"), "utf-8");
    // Original content preserved
    expect(content).toContain("Legacy notes from before Phase 999.47.");
    // Pointer appended
    expect(content).toContain(HOMELAB_POINTER_LINE);
    // File ends with newline
    expect(content.endsWith("\n")).toBe(true);
  });

  it("re-run on legacy workspace is idempotent — does NOT duplicate the pointer line", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath });

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(wsPath, { recursive: true });
    await writeFile(join(wsPath, "MEMORY.md"), "# Memory\n\nLegacy.\n");

    // First run — appends pointer
    await createWorkspace(agent);
    // Second run — must NOT append a second copy
    await createWorkspace(agent);

    const content = await readFile(join(wsPath, "MEMORY.md"), "utf-8");
    const matches = content.match(
      /- \[Homelab inventory\]\(\/home\/clawcode\/homelab\/INVENTORY\.md\)/g,
    );
    expect(matches).toHaveLength(1);
  });

  it("returns WorkspaceResult with correct fields", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath, name: "coder" });

    const result = await createWorkspace(agent);

    expect(result.agentName).toBe("coder");
    expect(result.path).toBe(wsPath);
    expect(result.created).toBe(true);
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });

  it("no symlinks exist in any created workspace", async () => {
    const tmp = await makeTempDir();
    const wsPath = join(tmp, "my-agent");
    const agent = makeAgent({ workspace: wsPath });

    await createWorkspace(agent);

    const filesToCheck = [
      join(wsPath, "SOUL.md"),
      join(wsPath, "IDENTITY.md"),
      join(wsPath, "MEMORY.md"),
    ];

    for (const filePath of filesToCheck) {
      const stat = await lstat(filePath);
      expect(stat.isSymbolicLink()).toBe(false);
    }

    // Directories should also not be symlinks
    const dirsToCheck = [wsPath, join(wsPath, "memory"), join(wsPath, "skills")];
    for (const dirPath of dirsToCheck) {
      const stat = await lstat(dirPath);
      expect(stat.isSymbolicLink()).toBe(false);
    }
  });
});

describe("createWorkspaces", () => {
  it("processes multiple agents and returns WorkspaceResult[] for each", async () => {
    const tmp = await makeTempDir();
    const agents: ResolvedAgentConfig[] = [
      makeAgent({ workspace: join(tmp, "agent-a"), name: "agent-a" }),
      makeAgent({ workspace: join(tmp, "agent-b"), name: "agent-b" }),
    ];

    const results = await createWorkspaces(agents);

    expect(results).toHaveLength(2);
    expect(results[0].agentName).toBe("agent-a");
    expect(results[1].agentName).toBe("agent-b");

    // Both workspaces should exist
    await expect(access(join(tmp, "agent-a"))).resolves.toBeUndefined();
    await expect(access(join(tmp, "agent-b"))).resolves.toBeUndefined();
  });

  it("two agent workspaces share no files (different absolute paths)", async () => {
    const tmp = await makeTempDir();
    const agents: ResolvedAgentConfig[] = [
      makeAgent({ workspace: join(tmp, "agent-x"), name: "agent-x" }),
      makeAgent({ workspace: join(tmp, "agent-y"), name: "agent-y" }),
    ];

    const results = await createWorkspaces(agents);

    // Collect all file paths from both workspaces
    const allPathsA = new Set([
      results[0].path,
      join(results[0].path, "SOUL.md"),
      join(results[0].path, "IDENTITY.md"),
      join(results[0].path, "memory"),
      join(results[0].path, "skills"),
    ]);

    const allPathsB = new Set([
      results[1].path,
      join(results[1].path, "SOUL.md"),
      join(results[1].path, "IDENTITY.md"),
      join(results[1].path, "memory"),
      join(results[1].path, "skills"),
    ]);

    // No overlap
    for (const pathA of allPathsA) {
      expect(allPathsB.has(pathA)).toBe(false);
    }
  });
});
