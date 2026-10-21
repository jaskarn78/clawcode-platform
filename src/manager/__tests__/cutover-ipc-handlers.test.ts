/**
 * Phase 92 GAP CLOSURE — daemon-side cutover-verify + cutover-rollback IPC
 * handler tests.
 *
 * Pins:
 *   HV1: handleCutoverVerifyIpc projects VerifyOutcome.verified-ready →
 *        {cutoverReady:true, gapCount, canaryPassRate, reportPath}
 *   HV2: handleCutoverVerifyIpc rejects missing/invalid agent param via
 *        ManagerError (so IPC returns JSON-RPC error not silent success)
 *   HR1: handleCutoverRollbackIpc projects RollbackEngineResult →
 *        {rewoundCount, errors[]} (drops debug counters)
 *   HR2: handleCutoverRollbackIpc rejects missing ledgerTo
 *   IPC: IPC_METHODS array contains both new method strings (regression)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  handleCutoverVerifyIpc,
  handleCutoverRollbackIpc,
} from "../cutover-ipc-handlers.js";
import { IPC_METHODS } from "../../ipc/protocol.js";
import { ManagerError } from "../../shared/errors.js";

const silentLog = pino({ level: "silent" });

describe("Phase 92 gap-closure daemon IPC handlers", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cutover-ipc-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // cutover-verify
  // ---------------------------------------------------------------------

  it("HV1: projects verified-ready outcome to operator response", async () => {
    // Write real profile.json + capability.json to tempDir so the verify-pipeline's
    // readFile() in phase 4 (JSON load) sees valid input. ESM can't be spied.
    const profilePath = join(tempDir, "profile.json");
    const capabilityPath = join(tempDir, "capability.json");
    await writeFile(
      profilePath,
      JSON.stringify({
        tools: [],
        skills: [],
        mcpServers: [],
        memoryRefs: [],
        models: [],
        uploads: [],
        topIntents: [{ intent: "x", count: 1 }],
      }),
    );
    await writeFile(
      capabilityPath,
      JSON.stringify({
        agent: "fin-client",
        tools: [],
        skills: [],
        mcpServers: [],
        memoryRefs: [],
        models: [],
        uploads: [],
        sessionKinds: [],
      }),
    );

    const buildPipelineDeps = vi.fn(async () => ({
      // Stub pipeline deps — the inner runVerifyPipeline gets called with
      // these. We replace the pipeline functions with vi.fn() stubs that
      // walk the pipeline to a verified-ready outcome.
      agent: "fin-client",
      applyAdditive: false,
      runCanaryOnReady: true,
      outputDir: "/tmp/out",
      stagingDir: "/tmp/staging",
      ingestDiscordHistory: vi.fn(async () => ({
        kind: "no-changes" as const,
        agent: "fin-client",
        durationMs: 1,
        jsonlPath: "/tmp/discord.jsonl",
        sleepCount: 0,
      })),
      runSourceProfiler: vi.fn(async () => ({
        kind: "profiled" as const,
        agent: "fin-client",
        profilePath,
        durationMs: 1,
        chunks: 1,
      })),
      probeTargetCapability: vi.fn(async () => ({
        kind: "probed" as const,
        agent: "fin-client",
        capabilityPath,
        durationMs: 1,
      })),
      diffAgentVsTarget: vi.fn(() => []),
      applyAdditiveFixes: vi.fn(async () => ({
        kind: "dry-run" as const,
        agent: "fin-client",
        plannedAdditive: 0,
        destructiveDeferred: 0,
      })),
      synthesizeCanaryPrompts: vi.fn(async () => ({
        kind: "synthesized" as const,
        prompts: [{ intent: "x", prompt: "y" }],
        durationMs: 1,
      })),
      runCanary: vi.fn(async () => ({
        kind: "ran" as const,
        agent: "fin-client",
        results: [
          {
            intent: "x",
            prompt: "y",
            path: "discord-bot" as const,
            status: "passed" as const,
            durationMs: 1,
          },
          {
            intent: "x",
            prompt: "y",
            path: "openai-api" as const,
            status: "passed" as const,
            durationMs: 1,
          },
        ],
        passRate: 100,
        totalInvocations: 2,
        durationMs: 2,
      })),
      writeCutoverReport: vi.fn(async () => ({
        kind: "written" as const,
        reportPath: "/tmp/CUTOVER-REPORT.md",
        cutoverReady: true,
      })),
      ingestDeps: {
        channels: ["1"],
        stagingDir: "/tmp/staging",
        fetchMessages: vi.fn(),
        log: silentLog,
      } as never,
      profileDeps: {
        historyJsonlPaths: ["/tmp/discord.jsonl"],
        outputDir: "/tmp",
        dispatcher: { dispatch: vi.fn() },
        log: silentLog,
      } as never,
      probeDeps: {
        outputDir: "/tmp",
        loadConfig: vi.fn(),
        listMcpStatus: vi.fn(),
        readWorkspaceInventory: vi.fn(),
        log: silentLog,
      } as never,
      applierDeps: {} as never,
      canaryDeps: {} as never,
      synthesizerDeps: {} as never,
      log: silentLog,
    }));

    const response = await handleCutoverVerifyIpc(
      {
        agent: "fin-client",
        applyAdditive: false,
        outputDir: "/tmp/out",
      },
      // Cast through `unknown` because vi.fn()'s inferred return type loses
      // the runCanaryOnReady literal; the production caller (daemon.ts) has
      // the same problem and uses the same cast pattern.
      {
        buildPipelineDeps: buildPipelineDeps as unknown as Parameters<
          typeof handleCutoverVerifyIpc
        >[1]["buildPipelineDeps"],
        log: silentLog,
      },
    );

    expect(buildPipelineDeps).toHaveBeenCalledTimes(1);
    expect(response.cutoverReady).toBe(true);
    expect(response.reportPath).toBe("/tmp/CUTOVER-REPORT.md");
    expect(response.gapCount).toBe(0);
    expect(response.canaryPassRate).toBe(100);
  });

  it("HV2: rejects missing agent param via ManagerError", async () => {
    await expect(
      handleCutoverVerifyIpc(
        { applyAdditive: true },
        {
          buildPipelineDeps: vi.fn(),
          log: silentLog,
        },
      ),
    ).rejects.toBeInstanceOf(ManagerError);
  });

  // ---------------------------------------------------------------------
  // cutover-rollback
  // ---------------------------------------------------------------------

  it("HR1: projects RollbackEngineResult to operator response", async () => {
    const buildEngineDeps = vi.fn(async () => ({
      agent: "fin-client",
      ledgerTo: "2026-04-01T00:00:00Z",
      ledgerPath: "/tmp/ledger.jsonl",
      clawcodeYamlPath: "/tmp/clawcode.yaml",
      memoryRoot: "/tmp/memory",
      uploadsTargetDir: "/tmp/uploads",
      skillsTargetDir: "/tmp/skills",
      dryRun: false,
      removeAgentSkill: vi.fn(),
      removeAgentAllowedModel: vi.fn(),
      log: silentLog,
    }));

    const response = await handleCutoverRollbackIpc(
      {
        agent: "fin-client",
        ledgerTo: "2026-04-01T00:00:00Z",
        dryRun: true,
      },
      { buildEngineDeps, log: silentLog },
    );

    // Ledger doesn't exist → rewoundCount = 0, no errors. The response
    // shape is what we're asserting (debug counters NOT bubbled).
    expect(response).toHaveProperty("rewoundCount");
    expect(response).toHaveProperty("errors");
    expect(response).not.toHaveProperty("skippedAlreadyRewound");
    expect(response).not.toHaveProperty("skippedIrreversible");
    expect(response.rewoundCount).toBe(0);
    expect(response.errors).toEqual([]);
  });

  it("HR2: rejects missing ledgerTo via ManagerError", async () => {
    await expect(
      handleCutoverRollbackIpc(
        { agent: "fin-client" },
        {
          buildEngineDeps: vi.fn(),
          log: silentLog,
        },
      ),
    ).rejects.toBeInstanceOf(ManagerError);
  });

  // ---------------------------------------------------------------------
  // IPC method registration
  // ---------------------------------------------------------------------

  it("IPC: IPC_METHODS includes cutover-verify and cutover-rollback", () => {
    expect(IPC_METHODS).toContain("cutover-verify");
    expect(IPC_METHODS).toContain("cutover-rollback");
  });
});
