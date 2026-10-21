/**
 * Phase 999.187 — Tier 1 memory files come from ONE directory, and USER.md
 * is finally loaded.
 *
 *   - MEMORY.md is read from `resolveMemoryRoots(config).memoryMdPath`
 *     (the dir `clawcode_memory_edit` writes to), not `<workspace>/MEMORY.md`.
 *   - When only the legacy workspace copy exists it is loaded and a
 *     `memory-root-legacy-fallback` warn names both paths.
 *   - USER.md rides in the same block under "## About the user (USER.md)",
 *     with its own cap and the `tier1-truncation` warn (file USER.md).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionConfig } from "../session-config.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

let workspace: string;
const warnCalls: Array<{ obj: Record<string, unknown>; msg?: string }> = [];

function makeMinimalConfig(name: string): ResolvedAgentConfig {
  // Cast through unknown — a minimal stub for the buildSessionConfig path
  // we exercise. The truncation block reads only `name`, `workspace`,
  // `memoryAutoLoad`, `memoryAutoLoadPath` from this config.
  return {
    name,
    workspace,
    memoryPath: workspace,
    channels: [],
    model: "haiku",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: false,
    greetCoolDownMs: 0,
    settingSources: ["project"],
    memoryAutoLoad: true,
    memoryRetrievalTopK: 5,
    memoryScannerEnabled: false,
    memoryFlushIntervalMs: 900_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    autoStart: false,
    skills: [],
    soul: undefined,
    identity: undefined,
    memory: {
      compactionThreshold: 0.85,
      searchTopK: 5,
      consolidation: {
        enabled: false,
        weeklyThreshold: 7,
        monthlyThreshold: 4,
        schedule: "0 3 * * *",
      },
      decay: {
        halfLifeDays: 30,
        semanticWeight: 0.7,
        decayWeight: 0.3,
      },
      deduplication: {
        enabled: false,
        similarityThreshold: 0.95,
      },
    },
    heartbeat: {
      enabled: false,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: {
        warningThreshold: 0.7,
        criticalThreshold: 0.9,
      },
    },
    skillsPath: workspace,
    schedules: [],
    admin: false,
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 60, maxThreadSessions: 5 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
    // buildSandboxPlan reads `sandbox.enabled` unconditionally (post-#82).
    sandbox: { enabled: false },
  } as unknown as ResolvedAgentConfig;
}

function makeDeps(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: any;
  warns: typeof warnCalls;
} {
  warnCalls.length = 0;
  const deps = {
    tierManagers: new Map(),
    skillsCatalog: { entries: [], byName: new Map() },
    allAgentConfigs: [],
    log: {
      warn(obj: Record<string, unknown>, msg?: string): void {
        warnCalls.push({ obj, msg });
      },
    },
  };
  return { deps, warns: warnCalls };
}


beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "phase999187-roots-"));
  warnCalls.length = 0;
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("session-config — Phase 999.187 one memory root + USER.md", () => {
  it(
    "loads MEMORY.md from memoryPath (the edit tool's dir) when memoryPath = <workspace>/memory",
    async () => {
      const memoryPath = join(workspace, "memory");
      mkdirSync(memoryPath, { recursive: true });
      writeFileSync(join(workspace, "MEMORY.md"), "LEGACY-WORKSPACE-COPY", "utf8");
      writeFileSync(join(memoryPath, "MEMORY.md"), "CANONICAL-MEMORYPATH-COPY", "utf8");
      const { deps, warns } = makeDeps();
      const config = { ...makeMinimalConfig("client-a-like"), memoryPath } as ResolvedAgentConfig;

      const result = await buildSessionConfig(config, deps);

      expect(result.systemPrompt).toContain("CANONICAL-MEMORYPATH-COPY");
      expect(result.systemPrompt).not.toContain("LEGACY-WORKSPACE-COPY");
      expect(warns.filter((w) => w.obj.action === "memory-root-legacy-fallback")).toHaveLength(0);
    },
    30_000,
  );

  it(
    "falls back to the legacy <workspace>/MEMORY.md with a warn when the canonical file is absent",
    async () => {
      const memoryPath = join(workspace, "memory");
      mkdirSync(memoryPath, { recursive: true });
      writeFileSync(join(workspace, "MEMORY.md"), "LEGACY-WORKSPACE-COPY", "utf8");
      const { deps, warns } = makeDeps();
      const config = { ...makeMinimalConfig("legacy-like"), memoryPath } as ResolvedAgentConfig;

      const result = await buildSessionConfig(config, deps);

      expect(result.systemPrompt).toContain("LEGACY-WORKSPACE-COPY");
      const fb = warns.filter((w) => w.obj.action === "memory-root-legacy-fallback");
      expect(fb).toHaveLength(1);
      expect(fb[0].obj).toMatchObject({
        file: "MEMORY.md",
        loaded: join(workspace, "MEMORY.md"),
        canonical: join(memoryPath, "MEMORY.md"),
      });
    },
    30_000,
  );

  it(
    "loads USER.md beside MEMORY.md under its own heading",
    async () => {
      writeFileSync(join(workspace, "MEMORY.md"), "MEM-BODY", "utf8");
      writeFileSync(join(workspace, "USER.md"), "Operator runs 40 miles a week.", "utf8");
      const { deps } = makeDeps();

      const result = await buildSessionConfig(makeMinimalConfig("user-md"), deps);

      const p = result.systemPrompt;
      expect(p).toContain("## Long-term memory (MEMORY.md)");
      expect(p).toContain("MEM-BODY");
      expect(p).toContain("## About the user (USER.md)");
      expect(p).toContain("Operator runs 40 miles a week.");
      expect(p.indexOf("MEM-BODY")).toBeLessThan(p.indexOf("## About the user (USER.md)"));
    },
    30_000,
  );

  it(
    "loads USER.md even when MEMORY.md is absent",
    async () => {
      writeFileSync(join(workspace, "USER.md"), "ONLY-USER", "utf8");
      const { deps } = makeDeps();
      const result = await buildSessionConfig(makeMinimalConfig("user-only"), deps);
      expect(result.systemPrompt).toContain("## About the user (USER.md)");
      expect(result.systemPrompt).toContain("ONLY-USER");
    },
    30_000,
  );

  it(
    "truncates USER.md over its cap with a tier1-truncation warn naming USER.md",
    async () => {
      writeFileSync(join(workspace, "USER.md"), "u".repeat(9_000), "utf8");
      const { deps, warns } = makeDeps();
      const result = await buildSessionConfig(makeMinimalConfig("user-big"), deps);
      expect(result.systemPrompt).toMatch(/\[TRUNCATED — \d+ chars dropped; keep USER.md under 4000 chars\]/);
      const w = warns.filter((x) => x.obj.action === "tier1-truncation" && x.obj.file === "USER.md");
      expect(w).toHaveLength(1);
      expect(w[0].obj.capChars).toBe(4_000);
    },
    30_000,
  );

  it(
    "an empty USER.md adds nothing",
    async () => {
      writeFileSync(join(workspace, "USER.md"), "\n\n", "utf8");
      const { deps } = makeDeps();
      const result = await buildSessionConfig(makeMinimalConfig("user-empty"), deps);
      expect(result.systemPrompt).not.toContain("## About the user (USER.md)");
    },
    30_000,
  );
});
