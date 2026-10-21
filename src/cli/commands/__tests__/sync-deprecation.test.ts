/**
 * Phase 96 Plan 06 Task 2 — sync deprecation CLI subcommand tests (D-11).
 *
 * Validates the new operator-facing CLI surface for Phase 91 mirror
 * deprecation:
 *
 *   DT-HAPPY                       — disable-timer flips authoritativeSide to "deprecated"
 *   DT-IDEMPOTENT                  — second disable-timer is a no-op (already deprecated)
 *   DT-SYSTEMCTL-MISSING           — systemctl failure logs warning + state still updated (graceful)
 *   DT-DEPRECATED-TO-CLAWCODE-REFUSED — set-authoritative clawcode while deprecated → exit 1
 *   RT-WITHIN-WINDOW               — re-enable-timer within 7 days → flipped, deprecatedAt cleared
 *   RT-WINDOW-EXPIRED              — re-enable-timer after 8 days → exit 1, "rollback window expired"
 *   RT-NOT-DEPRECATED-REFUSED      — re-enable-timer when authoritativeSide=openclaw → exit 1
 *   RO-EXIT-2                      — sync run-once when deprecated → exit 2 (real refusal, not skip)
 *   STAT-DEPRECATED-RENDER         — sync status renders deprecation block with rollback-window remaining
 *
 * All tests use DI: execFileAsync stub returns canned outcomes,
 * appendLedgerRow recorded as vi.fn, now() is a fixed clock for
 * date-math assertions. No real systemctl, no real filesystem beyond
 * mkdtemp'd sync-state.json.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import { runSyncDisableTimerAction } from "../sync-disable-timer.js";
import { runSyncReEnableTimerAction } from "../sync-re-enable-timer.js";
import { runSyncRunOnceAction } from "../sync-run-once.js";
import { runSyncStatusAction } from "../sync-status.js";
import { runSyncSetAuthoritativeAction } from "../sync-set-authoritative.js";
import { writeSyncState } from "../../../sync/sync-state-store.js";
import {
  DEPRECATION_ROLLBACK_WINDOW_MS,
  type SyncRunOutcome,
  type SyncStateFile,
} from "../../../sync/types.js";

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

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe("sync deprecation CLI subcommands (Phase 96 Plan 06 Task 2)", () => {
  let tempDir: string;
  let statePath: string;
  let jsonlPath: string;
  let ledgerPath: string;
  let stdoutCapture: string[];
  let stderrCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), `sync-depr-${nanoid(6)}-`));
    statePath = join(tempDir, "sync-state.json");
    jsonlPath = join(tempDir, "sync.jsonl");
    ledgerPath = join(tempDir, "deprecation-ledger.jsonl");
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
  });

  afterEach(async () => {
    writeStdoutSpy.mockRestore();
    writeStderrSpy.mockRestore();
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // DT-HAPPY — disable-timer happy path
  // ---------------------------------------------------------------------

  it("DT-HAPPY: disable-timer flips state to deprecated + invokes systemctl + writes ledger row", async () => {
    await writeFile(statePath, JSON.stringify(buildState()), "utf8");
    const fixedNow = new Date("2026-04-25T16:00:00.000Z");
    const execFileMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const ledgerWriter = vi.fn().mockResolvedValue(undefined);

    const code = await runSyncDisableTimerAction({
      syncStatePath: statePath,
      ledgerPath,
      execFileImpl: execFileMock,
      appendLedgerRow: ledgerWriter,
      now: () => fixedNow,
      log: silentLog,
    });

    expect(code).toBe(0);
    expect(execFileMock).toHaveBeenCalledWith("systemctl", [
      "--user",
      "disable",
      "clawcode-sync-acme.timer",
    ]);
    const persisted = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("deprecated");
    expect(persisted.deprecatedAt).toBe(fixedNow.toISOString());
    expect(ledgerWriter).toHaveBeenCalledOnce();
    const ledgerArgs = ledgerWriter.mock.calls[0]?.[0];
    expect(ledgerArgs).toMatchObject({
      action: "disable-timer",
      timestamp: fixedNow.toISOString(),
    });
  });

  // ---------------------------------------------------------------------
  // DT-IDEMPOTENT — already deprecated → no-op
  // ---------------------------------------------------------------------

  it("DT-IDEMPOTENT: disable-timer when already deprecated is a no-op (no writes, exit 0)", async () => {
    const initialDeprecatedAt = "2026-04-25T16:00:00.000Z";
    await writeFile(
      statePath,
      JSON.stringify(
        buildState({
          authoritativeSide: "deprecated",
          deprecatedAt: initialDeprecatedAt,
        }),
      ),
      "utf8",
    );
    const execFileMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const ledgerWriter = vi.fn();

    const code = await runSyncDisableTimerAction({
      syncStatePath: statePath,
      ledgerPath,
      execFileImpl: execFileMock,
      appendLedgerRow: ledgerWriter,
      now: () => new Date("2026-04-26T16:00:00.000Z"),
      log: silentLog,
    });

    expect(code).toBe(0);
    expect(stdoutCapture.join("")).toMatch(/already deprecated/i);
    // Idempotent: no systemctl, no ledger, no state rewrite
    expect(execFileMock).not.toHaveBeenCalled();
    expect(ledgerWriter).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as SyncStateFile;
    // deprecatedAt UNCHANGED (proves no rewrite happened)
    expect(persisted.deprecatedAt).toBe(initialDeprecatedAt);
  });

  // ---------------------------------------------------------------------
  // DT-SYSTEMCTL-MISSING — systemctl failure is non-fatal (graceful per RESEARCH.md Pitfall 6)
  // ---------------------------------------------------------------------

  it("DT-SYSTEMCTL-MISSING: systemctl failure logs warning + state still updated (graceful)", async () => {
    await writeFile(statePath, JSON.stringify(buildState()), "utf8");
    const fixedNow = new Date("2026-04-25T16:00:00.000Z");
    const execFileMock = vi
      .fn()
      .mockRejectedValue(
        new Error("Failed to disable unit clawcode-sync-acme.timer: not found"),
      );
    const ledgerWriter = vi.fn().mockResolvedValue(undefined);

    const code = await runSyncDisableTimerAction({
      syncStatePath: statePath,
      ledgerPath,
      execFileImpl: execFileMock,
      appendLedgerRow: ledgerWriter,
      now: () => fixedNow,
      log: silentLog,
    });

    // Graceful: exit code 0 even though systemctl failed
    expect(code).toBe(0);
    // State STILL updated
    const persisted = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("deprecated");
    expect(persisted.deprecatedAt).toBe(fixedNow.toISOString());
    // Ledger STILL written
    expect(ledgerWriter).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------
  // DT-DEPRECATED-TO-CLAWCODE-REFUSED — state machine guard
  // ---------------------------------------------------------------------

  it("DT-DEPRECATED-TO-CLAWCODE-REFUSED: set-authoritative clawcode while deprecated → exit 1, state unchanged", async () => {
    const initialDeprecatedAt = "2026-04-25T16:00:00.000Z";
    await writeFile(
      statePath,
      JSON.stringify(
        buildState({
          authoritativeSide: "deprecated",
          deprecatedAt: initialDeprecatedAt,
        }),
      ),
      "utf8",
    );
    const runner = vi.fn();
    const prompt = vi.fn();

    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      skipVerify: true,
      skipReason: "phase-96 regression test",
      cutoverLedgerPath: join(tempDir, "cutover-ledger.jsonl"),
      syncStatePath: statePath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(
      /cannot forward-cutover from deprecated/i,
    );
    expect(runner).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    // State UNCHANGED
    const persisted = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("deprecated");
    expect(persisted.deprecatedAt).toBe(initialDeprecatedAt);
  });

  // ---------------------------------------------------------------------
  // RT-WITHIN-WINDOW — re-enable-timer within 7 days
  // ---------------------------------------------------------------------

  it("RT-WITHIN-WINDOW: re-enable-timer within 7 days → flipped to openclaw, deprecatedAt cleared, ledger row written", async () => {
    const fixedNow = new Date("2026-04-30T16:00:00.000Z"); // 5 days after deprecatedAt
    const deprecatedAt = "2026-04-25T16:00:00.000Z";
    await writeFile(
      statePath,
      JSON.stringify(
        buildState({ authoritativeSide: "deprecated", deprecatedAt }),
      ),
      "utf8",
    );
    const execFileMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const ledgerWriter = vi.fn().mockResolvedValue(undefined);

    const code = await runSyncReEnableTimerAction({
      syncStatePath: statePath,
      ledgerPath,
      execFileImpl: execFileMock,
      appendLedgerRow: ledgerWriter,
      now: () => fixedNow,
      log: silentLog,
    });

    expect(code).toBe(0);
    expect(execFileMock).toHaveBeenCalledWith("systemctl", [
      "--user",
      "enable",
      "--now",
      "clawcode-sync-acme.timer",
    ]);
    const persisted = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("openclaw");
    expect(persisted.deprecatedAt).toBeUndefined();
    expect(ledgerWriter).toHaveBeenCalledOnce();
    expect(ledgerWriter.mock.calls[0]?.[0]).toMatchObject({
      action: "re-enable-timer",
      timestamp: fixedNow.toISOString(),
    });
  });

  // ---------------------------------------------------------------------
  // RT-WINDOW-EXPIRED — re-enable-timer after 8 days
  // ---------------------------------------------------------------------

  it("RT-WINDOW-EXPIRED: re-enable-timer 8 days after deprecation → exit 1, 'rollback window expired'", async () => {
    const deprecatedAt = "2026-04-25T16:00:00.000Z";
    const fixedNow = new Date(
      new Date(deprecatedAt).getTime() + 8 * ONE_DAY_MS,
    );
    await writeFile(
      statePath,
      JSON.stringify(
        buildState({ authoritativeSide: "deprecated", deprecatedAt }),
      ),
      "utf8",
    );
    const execFileMock = vi.fn();
    const ledgerWriter = vi.fn();

    const code = await runSyncReEnableTimerAction({
      syncStatePath: statePath,
      ledgerPath,
      execFileImpl: execFileMock,
      appendLedgerRow: ledgerWriter,
      now: () => fixedNow,
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/rollback window expired/i);
    // No state change, no systemctl, no ledger
    expect(execFileMock).not.toHaveBeenCalled();
    expect(ledgerWriter).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("deprecated");
    // Should mention "8 days" since deprecation
    expect(stderrCapture.join("")).toMatch(/8 day/);
  });

  // ---------------------------------------------------------------------
  // RT-NOT-DEPRECATED-REFUSED — re-enable from openclaw state
  // ---------------------------------------------------------------------

  it("RT-NOT-DEPRECATED-REFUSED: re-enable-timer when authoritativeSide=openclaw → exit 1, 'not in deprecated state'", async () => {
    await writeFile(statePath, JSON.stringify(buildState()), "utf8");
    const execFileMock = vi.fn();
    const ledgerWriter = vi.fn();

    const code = await runSyncReEnableTimerAction({
      syncStatePath: statePath,
      ledgerPath,
      execFileImpl: execFileMock,
      appendLedgerRow: ledgerWriter,
      now: () => new Date("2026-04-26T16:00:00.000Z"),
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/not in deprecated state/i);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(ledgerWriter).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // RO-EXIT-2 — sync run-once when deprecated returns exit 2 (real refusal)
  // ---------------------------------------------------------------------

  it("RO-EXIT-2: sync run-once when deprecated → exit 2 (real refusal per Phase 91 SuccessExitStatus convention)", async () => {
    // Phase 96 D-11 — when deprecated, syncOnce returns kind='deprecated';
    // run-once translates that to exit code 2 (NOT 1, since SuccessExitStatus=1
    // would mask deprecation as a graceful skip).
    await writeSyncState(
      statePath,
      buildState({
        authoritativeSide: "deprecated",
        deprecatedAt: "2026-04-25T16:00:00.000Z",
      }),
    );

    const deprecatedOutcome: SyncRunOutcome = {
      kind: "deprecated",
      cycleId: "test-cycle",
      reason: "phase-91-mirror-deprecated; agents read source via ACL",
    };
    const runner = vi.fn().mockResolvedValue(deprecatedOutcome);

    const code = await runSyncRunOnceAction({
      syncStatePath: statePath,
      syncJsonlPath: jsonlPath,
      runSyncOnceDep: runner,
      log: silentLog,
    });

    expect(code).toBe(2);
    const stderrText = stderrCapture.join("");
    expect(stderrText).toMatch(/Phase 91 mirror deprecated/i);
    expect(stderrText).toMatch(/re-enable-timer/);
  });

  // ---------------------------------------------------------------------
  // STAT-DEPRECATED-RENDER — sync status renders deprecation state
  // ---------------------------------------------------------------------

  it("STAT-DEPRECATED-RENDER: sync status renders deprecation block + rollback window remaining", async () => {
    const deprecatedAt = "2026-04-25T16:00:00.000Z";
    const fixedNow = new Date(
      new Date(deprecatedAt).getTime() + 3 * ONE_DAY_MS,
    ); // 3 days into window
    await writeSyncState(
      statePath,
      buildState({ authoritativeSide: "deprecated", deprecatedAt }),
    );

    const code = await runSyncStatusAction({
      syncStatePath: statePath,
      syncJsonlPath: jsonlPath,
      now: () => fixedNow,
      log: silentLog,
    });

    expect(code).toBe(0);
    const stdoutText = stdoutCapture.join("");
    expect(stdoutText).toMatch(/"authoritativeSide": ?"deprecated"/);
    expect(stdoutText).toContain(deprecatedAt);
    // Window math: 7d - 3d = 4 days remaining (Math.ceil)
    expect(stdoutText).toMatch(/rollback window.*4 days remaining/i);
  });

  // ---------------------------------------------------------------------
  // RT-IDEMPOTENT-SYSTEMCTL-FAIL — re-enable systemctl failure → exit 1 (fatal, NOT idempotent)
  // ---------------------------------------------------------------------

  it("RT-IDEMPOTENT-SYSTEMCTL-FAIL: re-enable-timer systemctl failure → exit 1, state UNCHANGED", async () => {
    // Re-enable is the OPPOSITE of disable: we MUST be able to start the timer.
    // If systemctl enable fails, that's a real problem — exit 1, don't update state.
    const deprecatedAt = "2026-04-25T16:00:00.000Z";
    const fixedNow = new Date(
      new Date(deprecatedAt).getTime() + 2 * ONE_DAY_MS,
    );
    await writeFile(
      statePath,
      JSON.stringify(
        buildState({ authoritativeSide: "deprecated", deprecatedAt }),
      ),
      "utf8",
    );
    const execFileMock = vi
      .fn()
      .mockRejectedValue(new Error("Failed to enable unit"));
    const ledgerWriter = vi.fn();

    const code = await runSyncReEnableTimerAction({
      syncStatePath: statePath,
      ledgerPath,
      execFileImpl: execFileMock,
      appendLedgerRow: ledgerWriter,
      now: () => fixedNow,
      log: silentLog,
    });

    expect(code).toBe(1);
    // State NOT flipped (rollback semantics)
    const persisted = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("deprecated");
    expect(persisted.deprecatedAt).toBe(deprecatedAt);
  });
});

describe("DEPRECATION_ROLLBACK_WINDOW_MS — re-export sanity (Phase 96 D-11)", () => {
  it("re-export matches 7 * 24 * 60 * 60 * 1000 ms (7 days)", () => {
    // Co-pinned in sync-state-types-deprecation.test.ts; ensure CLI tests
    // see the same constant for window-math computations.
    expect(DEPRECATION_ROLLBACK_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
