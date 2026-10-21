/**
 * Phase 115 sub-scope 13(c) + Plan 03 sub-scope 1 — MEMORY.md auto-load
 * truncation surface.
 *
 * Plan 03 upgrade: the cap moved from the legacy 50KB byte cap to the
 * 16K char cap (`INJECTED_MEMORY_MAX_CHARS`). The action label upgraded
 * from `memory-md-truncation` → `tier1-truncation` to distinguish
 * tier-1-level events. The new agent-actionable marker
 * `[TRUNCATED — N chars dropped, dream-pass priority requested]` lands
 * between the head and tail (70/20 head-tail split).
 *
 * Verifies (post-Plan-115-03):
 *   - When MEMORY.md > 16K chars, the returned body contains the
 *     dream-pass-priority marker (NOT the legacy 50KB-cap marker).
 *   - When MEMORY.md > 16K chars, deps.log.warn fires with action
 *     `tier1-truncation` and structured fields including originalChars,
 *     capChars, droppedChars, file.
 *   - When MEMORY.md ≤ 16K chars, no truncation, no warn.
 *
 * Uses the public buildSessionConfig API with a tmp workspace + a fake
 * SessionConfigDeps. We assert on the assembled stable prefix (the
 * AgentSessionConfig.systemPrompt) for marker presence/absence and on
 * the captured warn calls for the diagnostic.
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
  workspace = mkdtempSync(join(tmpdir(), "phase115-truncwarn-"));
  warnCalls.length = 0;
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

// buildSessionConfig does heavy I/O + MCP probes — bump testTimeout for this
// suite. Each test takes 1-7s on a cold-imported module set.
describe("session-config — Phase 115 sub-scope 13(c) MEMORY.md truncation surface", () => {
  it(
    "when MEMORY.md > 16K chars, body contains the dream-pass-priority marker (Phase 115 Plan 03)",
    async () => {
      // Generate 25K chars of content (above 16K cap). Use ASCII so byte-length ~ char-length.
      const big = "a".repeat(25_000);
      writeFileSync(join(workspace, "MEMORY.md"), big, "utf8");
      const { deps } = makeDeps();
      const config = makeMinimalConfig("test-agent-trunc");

      const result = await buildSessionConfig(config, deps);

      // Legacy 50KB-cap marker is NOT present.
      expect(result.systemPrompt).not.toContain("(truncated at 50KB cap)");
      expect(result.systemPrompt).not.toContain("…(truncated");
      // New Plan-115-03 marker IS present.
      expect(result.systemPrompt).toContain(
        "dream-pass priority requested",
      );
      expect(result.systemPrompt).toMatch(
        /\[TRUNCATED — \d+ chars dropped, dream-pass priority requested\]/,
      );
    },
    30_000,
  );

  it(
    "when MEMORY.md > 16K chars, deps.log.warn fires with action tier1-truncation",
    async () => {
      const big = "a".repeat(25_000);
      writeFileSync(join(workspace, "MEMORY.md"), big, "utf8");
      const { deps, warns } = makeDeps();
      const config = makeMinimalConfig("test-agent-trunc-2");

      await buildSessionConfig(config, deps);

      const truncWarns = warns.filter(
        (w) => w.obj.action === "tier1-truncation",
      );
      expect(truncWarns).toHaveLength(1);
      expect(truncWarns[0].obj).toMatchObject({
        agent: "test-agent-trunc-2",
        action: "tier1-truncation",
        file: "MEMORY.md",
      });
      expect(typeof truncWarns[0].obj.originalChars).toBe("number");
      expect(typeof truncWarns[0].obj.capChars).toBe("number");
      expect(typeof truncWarns[0].obj.droppedChars).toBe("number");
      expect(truncWarns[0].obj.originalChars).toBeGreaterThan(16_000);
      expect(truncWarns[0].obj.capChars).toBe(16_000);
      expect(truncWarns[0].msg).toBe("[diag] tier1-truncation");
    },
    30_000,
  );

  it(
    "when MEMORY.md ≤ 16K chars, no truncation and no warn fires",
    async () => {
      const small = "a".repeat(12_000); // under 16K cap
      writeFileSync(join(workspace, "MEMORY.md"), small, "utf8");
      const { deps, warns } = makeDeps();
      const config = makeMinimalConfig("test-agent-small");

      await buildSessionConfig(config, deps);

      const truncWarns = warns.filter(
        (w) => w.obj.action === "tier1-truncation",
      );
      expect(truncWarns).toHaveLength(0);
    },
    30_000,
  );

  it(
    "fleet-audit H4 — per-agent injectedMemoryMaxChars lowers the cap (truncates a 12K body that the 16K default would pass)",
    async () => {
      // 12K is UNDER the 16K module-const default (the test above proves it
      // passes untouched there) — so any truncation here can ONLY come from the
      // per-agent override lowering the cap to 8000.
      const body = "a".repeat(12_000);
      writeFileSync(join(workspace, "MEMORY.md"), body, "utf8");
      const { deps, warns } = makeDeps();
      const config = makeMinimalConfig("test-agent-h4");
      (config as { perf?: unknown }).perf = {
        memoryAssemblyBudgets: { injectedMemoryMaxChars: 8000 },
      };

      const result = await buildSessionConfig(config, deps);

      // Truncation fired at the LOWERED cap.
      expect(result.systemPrompt).toMatch(
        /\[TRUNCATED — \d+ chars dropped, dream-pass priority requested\]/,
      );
      const truncWarns = warns.filter(
        (w) => w.obj.action === "tier1-truncation",
      );
      expect(truncWarns).toHaveLength(1);
      // The telemetry reflects the resolved per-agent cap, not the 16K const.
      expect(truncWarns[0].obj.capChars).toBe(8000);
      expect(truncWarns[0].obj.originalChars).toBe(12_000);
    },
    30_000,
  );

  it(
    "fleet-audit H4 — omitting the override keeps the 16K module-const cap (no-op for the fleet)",
    async () => {
      // Same 12K body, NO override — must NOT truncate (the const cap is 16K).
      const body = "a".repeat(12_000);
      writeFileSync(join(workspace, "MEMORY.md"), body, "utf8");
      const { deps, warns } = makeDeps();
      const config = makeMinimalConfig("test-agent-h4-default");

      await buildSessionConfig(config, deps);

      const truncWarns = warns.filter(
        (w) => w.obj.action === "tier1-truncation",
      );
      expect(truncWarns).toHaveLength(0);
    },
    30_000,
  );
});
