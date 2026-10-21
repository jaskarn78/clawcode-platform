/**
 * Phase 92 Plan 06 Task 1 (RED) — verify-pipeline tests.
 *
 * Pins the contract for `runVerifyPipeline(deps)` defined in the plan's
 * <interfaces> block. RED gate: src/cutover/verify-pipeline.ts does not yet
 * exist — import-time failure triggers vitest red.
 *
 * Behavioral pins:
 *   VP1 happy-path-zero-gaps : all phases happy → outcome.kind === "verified-ready"
 *   VP2 only-additive-gaps   : 2 missing-skill gaps + applyAdditive=true → applied,
 *                              canary runs, passRate=100 → verified-ready
 *   VP3 destructive-gaps     : 1 outdated-memory-file → canary NOT run, cutover_ready=false
 *   VP4 canary-failure       : applyAdditive ok, canary passRate=80 → verified-not-ready
 *   VP5 ingest-failed-bubbles: ingest fails → outcome.kind === "ingest-failed";
 *                              profile/probe/diff/apply/canary/report NEVER called
 *   VP6 phase-call-order     : invocationCallOrder enforces sequential gating:
 *                              ingest < profile < probe < diff < apply < canary < report
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runVerifyPipeline } from "../verify-pipeline.js";
import type { VerifyPipelineDeps } from "../verify-pipeline.js";
import type {
  AgentProfile,
  CanaryInvocationResult,
  CutoverGap,
  TargetCapability,
} from "../types.js";

let outputDir: string;
let stagingDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "cutover-vp-out-"));
  stagingDir = await mkdtemp(join(tmpdir(), "cutover-vp-staging-"));
});
afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
  await rm(stagingDir, { recursive: true, force: true });
});

const silentLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
} as unknown as import("pino").Logger;

const HAPPY_PROFILE: AgentProfile = {
  tools: ["Bash", "Read"],
  skills: ["search-first"],
  mcpServers: ["browser"],
  memoryRefs: [],
  models: ["anthropic-api/claude-sonnet-4-6"],
  uploads: [],
  topIntents: [{ intent: "summarize-pdf", count: 5 }],
};

const HAPPY_CAPABILITY: TargetCapability = {
  agent: "fin-client",
  generatedAt: "2026-04-25T12:00:00Z",
  yaml: {
    skills: ["search-first"],
    mcpServers: [{ name: "browser", envKeys: [] }],
    model: "anthropic-api/claude-sonnet-4-6",
    allowedModels: ["anthropic-api/claude-sonnet-4-6"],
    memoryAutoLoad: true,
    sessionKinds: ["direct"],
  },
  workspace: {
    memoryRoot: "/tmp/wr",
    memoryFiles: [],
    memoryMdSha256: null,
    uploads: [],
    skillsInstalled: ["search-first"],
  },
  mcpRuntime: [],
};

async function writeProfileAndCapability(): Promise<{
  profilePath: string;
  capabilityPath: string;
}> {
  const profilePath = join(stagingDir, "AGENT-PROFILE.json");
  const capabilityPath = join(stagingDir, "TARGET-CAPABILITY.json");
  await writeFile(profilePath, JSON.stringify(HAPPY_PROFILE), "utf8");
  await writeFile(capabilityPath, JSON.stringify(HAPPY_CAPABILITY), "utf8");
  return { profilePath, capabilityPath };
}

function makeCanaryResults(passed: number, total: number): CanaryInvocationResult[] {
  const out: CanaryInvocationResult[] = [];
  for (let i = 0; i < total; i++) {
    out.push({
      intent: `i-${i}`,
      prompt: `p-${i}`,
      path: i % 2 === 0 ? "discord-bot" : "api",
      status: i < passed ? "passed" : "failed-empty",
      responseChars: i < passed ? 100 : 0,
      durationMs: 50,
      error: null,
    });
  }
  return out;
}

async function makeHappyDeps(
  overrides: Partial<VerifyPipelineDeps> = {},
): Promise<VerifyPipelineDeps> {
  const { profilePath, capabilityPath } = await writeProfileAndCapability();
  return {
    agent: "fin-client",
    applyAdditive: false,
    runCanaryOnReady: true,
    outputDir,
    stagingDir,
    // vitest 4 infers `kind: string` from object literals; the deps type
    // expects the precise discriminant ("ingested" | "ingest-failed" | ...).
    // Pin each vi.fn to its corresponding deps function signature so the
    // returned Mock is assignable to the deps slot directly.
    ingestDiscordHistory: vi.fn<VerifyPipelineDeps["ingestDiscordHistory"]>(async () => ({
      kind: "ingested",
      agent: "fin-client",
      channelsProcessed: 1,
      newMessages: 100,
      totalMessages: 100,
      durationMs: 10,
      jsonlPath: join(stagingDir, "discord-history.jsonl"),
    })),
    runSourceProfiler: vi.fn<VerifyPipelineDeps["runSourceProfiler"]>(async () => ({
      kind: "profiled",
      agent: "fin-client",
      chunksProcessed: 1,
      messagesProcessed: 100,
      profilePath,
      durationMs: 10,
    })),
    probeTargetCapability: vi.fn<VerifyPipelineDeps["probeTargetCapability"]>(async () => ({
      kind: "probed",
      agent: "fin-client",
      capabilityPath,
      durationMs: 10,
    })),
    diffAgentVsTarget: vi.fn<VerifyPipelineDeps["diffAgentVsTarget"]>(() => [] as readonly CutoverGap[]),
    applyAdditiveFixes: vi.fn<VerifyPipelineDeps["applyAdditiveFixes"]>(async () => ({
      kind: "dry-run",
      agent: "fin-client",
      plannedAdditive: 0,
      destructiveDeferred: 0,
    })),
    synthesizeCanaryPrompts: vi.fn<VerifyPipelineDeps["synthesizeCanaryPrompts"]>(async () => ({
      kind: "synthesized",
      agent: "fin-client",
      prompts: [{ intent: "summarize-pdf", prompt: "Summarize the attached PDF." }],
      durationMs: 50,
    })),
    runCanary: vi.fn<VerifyPipelineDeps["runCanary"]>(async () => ({
      kind: "ran",
      agent: "fin-client",
      results: makeCanaryResults(40, 40),
      passRate: 100,
      reportPath: join(outputDir, "CANARY-REPORT.md"),
      durationMs: 100,
    })),
    writeCutoverReport: vi.fn<VerifyPipelineDeps["writeCutoverReport"]>(async () => ({
      kind: "written",
      reportPath: join(outputDir, "CUTOVER-REPORT.md"),
      cutoverReady: true,
    })),
    ingestDeps: {} as unknown as VerifyPipelineDeps["ingestDeps"],
    profileDeps: {} as unknown as VerifyPipelineDeps["profileDeps"],
    probeDeps: {} as unknown as VerifyPipelineDeps["probeDeps"],
    applierDeps: {} as unknown as VerifyPipelineDeps["applierDeps"],
    canaryDeps: {} as unknown as VerifyPipelineDeps["canaryDeps"],
    synthesizerDeps: {} as unknown as VerifyPipelineDeps["synthesizerDeps"],
    log: silentLog,
    ...overrides,
  };
}

describe("runVerifyPipeline — VP1 happy-path-zero-gaps", () => {
  it("all primitives happy → outcome.kind === verified-ready", async () => {
    const deps = await makeHappyDeps();
    const out = await runVerifyPipeline(deps);
    expect(out.kind).toBe("verified-ready");
    if (out.kind !== "verified-ready") return;
    expect(out.gapCount).toBe(0);
    expect(out.canaryPassRate).toBe(100);
  });
});

describe("runVerifyPipeline — VP2 only-additive-gaps-applied", () => {
  it("2 missing-skill + applyAdditive=true → applied, canary runs → verified-ready", async () => {
    const additiveGaps: CutoverGap[] = [
      {
        kind: "missing-skill",
        identifier: "search-first",
        severity: "additive",
        sourceRef: { skillName: "search-first" },
        targetRef: { skills: [] },
      },
      {
        kind: "missing-skill",
        identifier: "market-research",
        severity: "additive",
        sourceRef: { skillName: "market-research" },
        targetRef: { skills: [] },
      },
    ];
    const deps = await makeHappyDeps({
      applyAdditive: true,
      diffAgentVsTarget: vi.fn<VerifyPipelineDeps["diffAgentVsTarget"]>(() => additiveGaps),
      applyAdditiveFixes: vi.fn<VerifyPipelineDeps["applyAdditiveFixes"]>(async () => ({
        kind: "applied",
        agent: "fin-client",
        gapsApplied: 2,
        gapsSkipped: 0,
        destructiveDeferred: 0,
        ledgerPath: "/tmp/ledger.jsonl",
        durationMs: 5,
      })),
    });
    const out = await runVerifyPipeline(deps);
    expect(out.kind).toBe("verified-ready");
    if (out.kind !== "verified-ready") return;
    expect(out.canaryPassRate).toBe(100);
    expect(deps.applyAdditiveFixes).toHaveBeenCalled();
    expect(deps.runCanary).toHaveBeenCalled();
  });
});

describe("runVerifyPipeline — VP3 destructive-gaps-not-ready", () => {
  it("1 outdated-memory-file → canary NOT run; cutoverReady=false; verified-not-ready", async () => {
    const destructiveGaps: CutoverGap[] = [
      {
        kind: "outdated-memory-file",
        identifier: "memory/x.md",
        severity: "destructive",
        sourceRef: { path: "memory/x.md", sourceHash: "a".repeat(64) },
        targetRef: { path: "memory/x.md", targetHash: "b".repeat(64) },
      },
    ];
    const deps = await makeHappyDeps({
      diffAgentVsTarget: vi.fn<VerifyPipelineDeps["diffAgentVsTarget"]>(() => destructiveGaps),
      applyAdditiveFixes: vi.fn<VerifyPipelineDeps["applyAdditiveFixes"]>(async () => ({
        kind: "destructive-gaps-deferred",
        agent: "fin-client",
        destructiveCount: 1,
      })),
      writeCutoverReport: vi.fn<VerifyPipelineDeps["writeCutoverReport"]>(async () => ({
        kind: "written",
        reportPath: join(outputDir, "CUTOVER-REPORT.md"),
        cutoverReady: false,
      })),
    });
    const out = await runVerifyPipeline(deps);
    expect(out.kind).toBe("verified-not-ready");
    if (out.kind !== "verified-not-ready") return;
    expect(out.destructiveCount).toBe(1);
    // canary NOT run when destructive gaps remain
    expect(deps.runCanary).not.toHaveBeenCalled();
  });
});

describe("runVerifyPipeline — VP4 canary-failure", () => {
  it("applyAdditive ok, canary passRate=80 → verified-not-ready", async () => {
    const deps = await makeHappyDeps({
      runCanary: vi.fn<VerifyPipelineDeps["runCanary"]>(async () => ({
        kind: "ran",
        agent: "fin-client",
        results: makeCanaryResults(32, 40),
        passRate: 80,
        reportPath: join(outputDir, "CANARY-REPORT.md"),
        durationMs: 100,
      })),
      writeCutoverReport: vi.fn<VerifyPipelineDeps["writeCutoverReport"]>(async () => ({
        kind: "written",
        reportPath: join(outputDir, "CUTOVER-REPORT.md"),
        cutoverReady: false,
      })),
    });
    const out = await runVerifyPipeline(deps);
    expect(out.kind).toBe("verified-not-ready");
    if (out.kind !== "verified-not-ready") return;
    expect(out.canaryPassRate).toBe(80);
  });
});

describe("runVerifyPipeline — VP5 ingest-failed-bubbles", () => {
  it("ingest fails → outcome.kind=ingest-failed; profile/probe/diff/apply/canary/report NEVER called", async () => {
    const deps = await makeHappyDeps({
      ingestDiscordHistory: vi.fn<VerifyPipelineDeps["ingestDiscordHistory"]>(async () => ({
        kind: "discord-fetch-failed",
        agent: "fin-client",
        channelId: "x",
        error: "rate-limited",
        durationMs: 10,
      })),
    });
    const out = await runVerifyPipeline(deps);
    expect(out.kind).toBe("ingest-failed");
    expect(deps.runSourceProfiler).not.toHaveBeenCalled();
    expect(deps.probeTargetCapability).not.toHaveBeenCalled();
    expect(deps.diffAgentVsTarget).not.toHaveBeenCalled();
    expect(deps.applyAdditiveFixes).not.toHaveBeenCalled();
    expect(deps.runCanary).not.toHaveBeenCalled();
    expect(deps.writeCutoverReport).not.toHaveBeenCalled();
  });
});

describe("runVerifyPipeline — VP6 phase-call-order", () => {
  it("invocationCallOrder enforces ingest → profile → probe → diff → apply → canary → report", async () => {
    const deps = await makeHappyDeps();
    await runVerifyPipeline(deps);

    const ingestOrder = (deps.ingestDiscordHistory as ReturnType<typeof vi.fn>)
      .mock.invocationCallOrder[0]!;
    const profileOrder = (deps.runSourceProfiler as ReturnType<typeof vi.fn>)
      .mock.invocationCallOrder[0]!;
    const probeOrder = (deps.probeTargetCapability as ReturnType<typeof vi.fn>)
      .mock.invocationCallOrder[0]!;
    const diffOrder = (deps.diffAgentVsTarget as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    const applyOrder = (deps.applyAdditiveFixes as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    const canaryOrder = (deps.runCanary as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    const reportOrder = (deps.writeCutoverReport as ReturnType<typeof vi.fn>)
      .mock.invocationCallOrder[0]!;

    expect(ingestOrder).toBeLessThan(profileOrder);
    expect(profileOrder).toBeLessThan(probeOrder);
    expect(probeOrder).toBeLessThan(diffOrder);
    expect(diffOrder).toBeLessThan(applyOrder);
    expect(applyOrder).toBeLessThan(canaryOrder);
    expect(canaryOrder).toBeLessThan(reportOrder);
  });
});
