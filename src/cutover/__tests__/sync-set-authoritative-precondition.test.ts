/**
 * Phase 92 Plan 06 Task 1 (RED) — sync-set-authoritative precondition tests.
 *
 * Pins the contract for the cutover-ready precondition gate added to Phase
 * 91's executeForwardCutover BEFORE driveDrain. RED gate: the helper
 * checkCutoverReportPrecondition + new args (skipVerify/skipReason/
 * cutoverReportPath) do not yet exist on src/cli/commands/sync-set-authoritative.ts.
 *
 * Behavioral pins (D-09 + CUT-10):
 *   PRECON1 missing-report : no report → exit 1, stderr mentions missing CUTOVER-REPORT.md
 *   PRECON2 stale-report   : 25 hours old → exit 1, stale message
 *   PRECON3 not-ready      : cutover_ready=false → exit 1
 *   PRECON4 fresh-and-ready: cutover_ready=true + 1h old → proceeds to drain → flip
 *   PRECON5 skip-verify    : --skip-verify --reason → proceeds + audit row
 *                            with action=skip-verify, reason="client_a waiting on demo"
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
} from "node:fs/promises";
import type { Logger } from "pino";

import { runSyncSetAuthoritativeAction } from "../../cli/commands/sync-set-authoritative.js";
import { readCutoverRows } from "../ledger.js";
import type {
  SyncRunOutcome,
  SyncStateFile,
} from "../../sync/types.js";

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as Logger;

function buildState(overrides: Partial<SyncStateFile> = {}): SyncStateFile {
  return {
    version: 1,
    updatedAt: "2026-04-24T18:00:00.000Z",
    authoritativeSide: "openclaw",
    lastSyncedAt: "2026-04-24T18:00:00.000Z",
    openClawHost: "example-user@10.0.0.3",
    openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
    clawcodeWorkspace: "/home/clawcode/.clawcode/agents/acme",
    perFileHashes: {},
    conflicts: [],
    openClawSessionCursor: null,
    ...overrides,
  };
}

const syncedOutcome: SyncRunOutcome = {
  kind: "synced",
  cycleId: "drain",
  filesAdded: 0,
  filesUpdated: 0,
  filesRemoved: 0,
  filesSkippedConflict: 0,
  bytesTransferred: 0,
  durationMs: 100,
};

function buildReportContent(args: {
  agent: string;
  cutoverReady: boolean;
  generatedAt: string;
}): string {
  return [
    "---",
    `agent: ${args.agent}`,
    `cutover_ready: ${args.cutoverReady}`,
    `report_generated_at: ${args.generatedAt}`,
    `gap_count: 0`,
    `additive_gap_count: 0`,
    `destructive_gap_count: 0`,
    `canary_pass_rate: 100`,
    `canary_total_invocations: 40`,
    "---",
    "",
    `# Report`,
    "",
    `Cutover ready: ${args.cutoverReady}`,
    "",
  ].join("\n");
}

describe("sync set-authoritative cutover-ready precondition (Plan 92-06)", () => {
  let tempDir: string;
  let statePath: string;
  let reportPath: string;
  let ledgerPath: string;
  let stderrCapture: string[];
  let stdoutCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cutover-precon-"));
    statePath = join(tempDir, "sync-state.json");
    reportPath = join(tempDir, "CUTOVER-REPORT.md");
    ledgerPath = join(tempDir, "cutover-ledger.jsonl");

    stdoutCapture = [];
    stderrCapture = [];
    writeStdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stdoutCapture.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }) as typeof process.stdout.write);
    writeStderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stderrCapture.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }) as typeof process.stderr.write);

    await writeFile(statePath, JSON.stringify(buildState()), "utf8");
  });

  afterEach(async () => {
    writeStdoutSpy.mockRestore();
    writeStderrSpy.mockRestore();
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("PRECON1 missing-report → exit 1, stderr mentions CUTOVER-REPORT.md", async () => {
    const runner = vi.fn();
    const prompt = vi.fn();
    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      syncStatePath: statePath,
      cutoverReportPath: reportPath, // points at non-existent path
      cutoverLedgerPath: ledgerPath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/CUTOVER-REPORT\.md|cutover/i);
    // Drain must NOT have run — precondition gate is BEFORE drain
    expect(runner).not.toHaveBeenCalled();
  });

  it("PRECON2 stale-report (>24h) → exit 1, stale message", async () => {
    const fixedNow = new Date("2026-04-25T12:00:00.000Z");
    const generatedAt = new Date(
      fixedNow.getTime() - 25 * 60 * 60 * 1000,
    ).toISOString();
    await writeFile(
      reportPath,
      buildReportContent({
        agent: "fin-client",
        cutoverReady: true,
        generatedAt,
      }),
      "utf8",
    );
    const runner = vi.fn();
    const prompt = vi.fn();
    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      syncStatePath: statePath,
      cutoverReportPath: reportPath,
      cutoverLedgerPath: ledgerPath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/stale|24/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it("PRECON3 not-ready report → exit 1, refuses", async () => {
    const fixedNow = new Date("2026-04-25T12:00:00.000Z");
    const generatedAt = new Date(
      fixedNow.getTime() - 1 * 60 * 60 * 1000,
    ).toISOString();
    await writeFile(
      reportPath,
      buildReportContent({
        agent: "fin-client",
        cutoverReady: false,
        generatedAt,
      }),
      "utf8",
    );
    const runner = vi.fn();
    const prompt = vi.fn();
    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      syncStatePath: statePath,
      cutoverReportPath: reportPath,
      cutoverLedgerPath: ledgerPath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/not.ready|cutover/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it("PRECON4 fresh-and-ready → drain proceeds, flip succeeds", async () => {
    const fixedNow = new Date("2026-04-25T12:00:00.000Z");
    const generatedAt = new Date(
      fixedNow.getTime() - 1 * 60 * 60 * 1000,
    ).toISOString();
    await writeFile(
      reportPath,
      buildReportContent({
        agent: "fin-client",
        cutoverReady: true,
        generatedAt,
      }),
      "utf8",
    );
    const runner = vi.fn().mockResolvedValue(syncedOutcome);
    const prompt = vi.fn().mockResolvedValue(true);
    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      syncStatePath: statePath,
      cutoverReportPath: reportPath,
      cutoverLedgerPath: ledgerPath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });
    expect(code).toBe(0);
    expect(runner).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledOnce();
    const persisted = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("clawcode");
  });

  it("PRECON5 skip-verify --reason → bypasses + appends ledger audit row with action=skip-verify", async () => {
    const fixedNow = new Date("2026-04-25T12:00:00.000Z");
    const runner = vi.fn().mockResolvedValue(syncedOutcome);
    const prompt = vi.fn().mockResolvedValue(true);
    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      skipVerify: true,
      skipReason: "client_a waiting on demo",
      syncStatePath: statePath,
      cutoverReportPath: reportPath, // does NOT exist — but skip-verify bypasses
      cutoverLedgerPath: ledgerPath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });
    expect(code).toBe(0);
    expect(runner).toHaveBeenCalledOnce();

    // Audit row must exist with action=skip-verify and the operator-provided reason.
    const rows = await readCutoverRows(ledgerPath);
    const skipRow = rows.find((r) => r.action === "skip-verify");
    expect(skipRow).toBeDefined();
    expect(skipRow!.reason).toBe("client_a waiting on demo");
    expect(skipRow!.timestamp).toBe(fixedNow.toISOString());
    expect(skipRow!.agent).toBe("fin-client");
  });
});
