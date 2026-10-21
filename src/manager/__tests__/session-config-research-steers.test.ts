/**
 * Phase 999.173 — routing steers for research-enabled agents.
 *
 *  - Research ON: workflows only when explicitly asked; threads only when
 *    asked; research goes to `researcher` subagents; the synthesis is plain
 *    text (delivered as a reply), never post_to_agent.
 *  - Research OFF: the prompt is BYTE-IDENTICAL to before (prompt-cache prefix
 *    stability). Proven by swapping the research variants back to the legacy
 *    sentences in the ON prompt and requiring exact equality with the OFF one:
 *    nothing else in the prompt may differ.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSessionConfig, type SessionConfigDeps } from "../session-config.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import { resetUxFeatureOverridesForTests } from "../ux-feature-state-store.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));
vi.mock("../../memory/context-summary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../memory/context-summary.js")>();
  return { ...actual, loadLatestSummary: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("../../bootstrap/prompt-builder.js", () => ({
  buildBootstrapPrompt: vi.fn().mockReturnValue("bootstrap prompt"),
}));

const LEGACY_WORKFLOW =
  "For background fan-out (running several independent tasks in parallel), use the `mcp__clawcode__start_workflow` tool — it returns immediately, posts progress + results to your channel, and a stuck step auto-aborts. Do NOT use the native in-session Workflow tool for this: it runs inside your turn and is killed when the turn ends, so its results are lost and its failure is invisible.";
const LEGACY_SELF_FIRED =
  "If you ever run a self-scheduled or background turn, deliver its result by calling `mcp__clawcode__post_to_agent` (to your own channel). Do NOT assume plain text output from a self-fired turn will appear in Discord — it will not; it buffers and is lost.";
const LEGACY_THREAD_START = "You have the **subagent-thread** skill. When you need to delegate work to a subagent ";

function makeConfig(research: boolean): ResolvedAgentConfig {
  return {
    name: "personal",
    workspace: "/tmp/test-workspace",
    memoryPath: "/tmp/test-workspace",
    channels: ["chan-1"],
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
    skills: ["subagent-thread"],
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
    threads: { idleTimeoutMinutes: 30, maxThreadSessions: 5 },
    reactions: false,
    slashCommands: [],
    mcpServers: [{ name: "clawcode", command: "clawcode", args: ["mcp"], env: {} }] as never,
    deliveryAttributedStream: true,
    uxFeatures: { liveThinking: false, statusPing: false, promptSuggestions: false, researchSubagents: research },
  } as ResolvedAgentConfig;
}

function makeDeps(): SessionConfigDeps {
  return { tierManagers: new Map(), skillsCatalog: new Map(), allAgentConfigs: [] };
}

afterEach(() => resetUxFeatureOverridesForTests());

describe("999.173 — research routing steers", () => {
  it("research ON: workflows only when asked, threads only when asked, researchers for research", async () => {
    const on = (await buildSessionConfig(makeConfig(true), makeDeps())).systemPrompt;
    expect(on).toContain("Use the `mcp__clawcode__start_workflow` tool ONLY when the user explicitly asks for a workflow.");
    expect(on).toContain("launch 2-4 `researcher` subagents in parallel with the Agent tool");
    expect(on).toContain("Use the `spawn_subagent_thread` MCP tool ONLY when the user explicitly asks for a thread");
    expect(on).toContain("never post_to_agent a research synthesis");
    expect(on).toContain("Use ONLY when the user explicitly asks for a workflow — research and deep dives go to `researcher` subagents");
    expect(on).not.toContain(LEGACY_WORKFLOW);
    expect(on).not.toContain(LEGACY_THREAD_START);
    expect(on).toContain("Do NOT use the native in-session Workflow tool");
  });

  it("research OFF: the legacy sentences, and no researcher wording at all", async () => {
    const off = (await buildSessionConfig(makeConfig(false), makeDeps())).systemPrompt;
    expect(off).toContain(LEGACY_WORKFLOW);
    expect(off).toContain(LEGACY_SELF_FIRED);
    expect(off).toContain(LEGACY_THREAD_START);
    expect(off).not.toMatch(/researcher/);
  });

  it("research OFF is byte-identical: only the research variants differ from ON", async () => {
    const off = (await buildSessionConfig(makeConfig(false), makeDeps())).systemPrompt;
    const on = (await buildSessionConfig(makeConfig(true), makeDeps())).systemPrompt;
    const offThread = off.slice(off.indexOf(LEGACY_THREAD_START), off.indexOf("(e.g., quick internal ") + "(e.g., quick internal computations, file operations that don't need a thread).\n".length);
    const offManifest = off.match(/- \*\*Background workflows \(`start_workflow`\)\*\*:[^\n]*/)![0];
    const onManifest = on.match(/- \*\*Background workflows \(`start_workflow`\)\*\*:[^\n]*/)![0];
    const onThreadStart = on.indexOf("You have the **subagent-thread** skill. Use the");
    const onThreadEnd = on.indexOf("shows their progress.\n", onThreadStart) + "shows their progress.\n".length;
    const onWorkflowStart = on.indexOf("For research, deep dives, investigations and comparisons, launch 2-4");
    const onWorkflowEnd = on.indexOf("the native in-session Workflow tool: it runs inside your turn and is killed when the turn ends, so its results are lost and its failure is invisible.", onWorkflowStart);
    expect(onThreadStart).toBeGreaterThan(-1);
    expect(onWorkflowStart).toBeGreaterThan(-1);

    let restored = on.slice(0, onThreadStart) + offThread + on.slice(onThreadEnd);
    restored = restored.replace(onManifest, offManifest);
    const selfFiredStart = restored.indexOf("If you ever run a self-scheduled or background turn that is NOT");
    const selfFiredEnd = restored.indexOf("instead of redoing the work.", selfFiredStart) + "instead of redoing the work.".length;
    restored = restored.slice(0, selfFiredStart) + LEGACY_SELF_FIRED + restored.slice(selfFiredEnd);
    const wfStart = restored.indexOf("For research, deep dives, investigations and comparisons, launch 2-4");
    const wfEnd =
      restored.indexOf("so its results are lost and its failure is invisible.", wfStart) +
      "so its results are lost and its failure is invisible.".length;
    restored = restored.slice(0, wfStart) + LEGACY_WORKFLOW + restored.slice(wfEnd);
    expect(onWorkflowEnd).toBeGreaterThan(onWorkflowStart);
    expect(restored).toBe(off);
  });
});
