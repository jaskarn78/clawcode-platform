/**
 * Phase 91 Plan 04 Task 2 — `clawcode sync set-authoritative <side>` tests.
 *
 * Covers D-17 forward cutover + D-19 reverse + D-20 7-day window + D-21
 * atomic mid-drain verification:
 *
 *   SA-1:  clawcode WITHOUT --confirm-cutover → exit 1
 *   SA-2:  clawcode + --confirm-cutover + drain=failed-ssh → exit 1, state unchanged
 *   SA-3:  clawcode + --confirm-cutover + drain=synced + prompt=yes → state flipped
 *   SA-4:  clawcode + --confirm-cutover + drain=synced + prompt=no → state unchanged
 *   SA-5:  clawcode + --confirm-cutover + drain=partial-conflicts → exit 1, "resolve first"
 *   SA-6:  openclaw WITHOUT any revert flag → exit 1
 *   SA-7:  openclaw + --revert-cutover within 7 days → flipped
 *   SA-8:  openclaw + --revert-cutover AFTER 7 days → exit 1
 *   SA-9:  openclaw + --force-rollback AFTER 7 days → flipped
 *   SA-10: clawcode when already=clawcode → exit 1 (no-op guard)
 *   SA-11: openclaw when already=openclaw → exit 1 (no-op guard)
 *   SA-12: drain throws → exit 1, state unchanged (defensive exception handling)
 *
 * All tests use DI: runSyncOnceDep as vi.fn returning canned outcomes,
 * promptConfirm as vi.fn returning deterministic booleans, now() as a
 * fixed clock for date-math assertions. No real rsync, no real prompt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import type { Logger } from "pino";
import {
  ROLLBACK_WINDOW_MS,
  runSyncSetAuthoritativeAction,
} from "../sync-set-authoritative.js";
import type {
  SyncRunOutcome,
  SyncStateFile,
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

const syncedOutcome: SyncRunOutcome = {
  kind: "synced",
  cycleId: "drain-cycle",
  filesAdded: 2,
  filesUpdated: 5,
  filesRemoved: 0,
  filesSkippedConflict: 0,
  bytesTransferred: 65536,
  durationMs: 1200,
};

describe("sync set-authoritative (Plan 91-04 Task 2)", () => {
  let tempDir: string;
  let statePath: string;
  let stdoutCapture: string[];
  let stderrCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sync-setauth-"));
    statePath = join(tempDir, "sync-state.json");
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

  // -------------------------------------------------------------------------
  // Forward cutover (→ clawcode)
  // -------------------------------------------------------------------------

  it("SA-1: clawcode WITHOUT --confirm-cutover → exit 1, state unchanged", async () => {
    const state = buildState();
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const runner = vi.fn();
    const prompt = vi.fn();

    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      syncStatePath: statePath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/--confirm-cutover/);
    expect(runner).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("openclaw");
  });

  it("SA-2: clawcode + --confirm-cutover + drain=failed-ssh → exit 1, state unchanged", async () => {
    const state = buildState();
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const runner = vi.fn().mockResolvedValue({
      kind: "failed-ssh",
      cycleId: "drain",
      error: "connection timeout",
      durationMs: 100,
    } satisfies SyncRunOutcome);
    const prompt = vi.fn();

    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      // Phase 92 Plan 06: bypass cutover-ready precondition for Phase 91 drain regressions
      skipVerify: true,
      skipReason: "phase-91 regression test",
      cutoverLedgerPath: join(tempDir, "cutover-ledger.jsonl"),
      syncStatePath: statePath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/Drain failed \(failed-ssh\)/);
    expect(prompt).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("openclaw");
  });

  it("SA-3: clawcode + --confirm-cutover + drain=synced + prompt=yes → state flipped", async () => {
    const state = buildState();
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const runner = vi.fn().mockResolvedValue(syncedOutcome);
    const prompt = vi.fn().mockResolvedValue(true);
    const fixedNow = new Date("2026-04-24T20:00:00.000Z");

    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      skipVerify: true,
      skipReason: "phase-91 regression test",
      cutoverLedgerPath: join(tempDir, "cutover-ledger.jsonl"),
      syncStatePath: statePath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });

    expect(code).toBe(0);
    expect(runner).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledOnce();
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("clawcode");
    expect(persisted.updatedAt).toBe(fixedNow.toISOString());
    expect(stdoutCapture.join("")).toMatch(/Flipped authoritativeSide → clawcode/);
  });

  it("SA-4: clawcode + --confirm-cutover + drain=synced + prompt=no → state unchanged, exit 0", async () => {
    const state = buildState();
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const runner = vi.fn().mockResolvedValue(syncedOutcome);
    const prompt = vi.fn().mockResolvedValue(false);

    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      skipVerify: true,
      skipReason: "phase-91 regression test",
      cutoverLedgerPath: join(tempDir, "cutover-ledger.jsonl"),
      syncStatePath: statePath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      log: silentLog,
    });

    expect(code).toBe(0); // user aborted, not a failure
    expect(stdoutCapture.join("")).toMatch(/Aborted/);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("openclaw");
  });

  it("SA-5: clawcode + --confirm-cutover + drain=partial-conflicts → exit 1 with 'resolve first'", async () => {
    const state = buildState();
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const runner = vi.fn().mockResolvedValue({
      kind: "partial-conflicts",
      cycleId: "drain",
      filesAdded: 1,
      filesUpdated: 0,
      filesRemoved: 0,
      filesSkippedConflict: 1,
      bytesTransferred: 1024,
      durationMs: 500,
      conflicts: [
        {
          path: "MEMORY.md",
          sourceHash: "a".repeat(64),
          destHash: "b".repeat(64),
          detectedAt: "2026-04-24T18:55:00.000Z",
          resolvedAt: null,
        },
      ],
    } satisfies SyncRunOutcome);
    const prompt = vi.fn();

    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      skipVerify: true,
      skipReason: "phase-91 regression test",
      cutoverLedgerPath: join(tempDir, "cutover-ledger.jsonl"),
      syncStatePath: statePath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/Drain completed with unresolved conflicts/);
    expect(prompt).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("openclaw");
  });

  it("SA-10: already authoritative=clawcode → exit 1 no-op guard", async () => {
    const state = buildState({ authoritativeSide: "clawcode" });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const runner = vi.fn();
    const prompt = vi.fn();

    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      syncStatePath: statePath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/Already authoritative: clawcode/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("SA-12: drain throws → exit 1, state unchanged", async () => {
    const state = buildState();
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const runner = vi.fn().mockRejectedValue(new Error("drain bug"));
    const prompt = vi.fn();

    const code = await runSyncSetAuthoritativeAction({
      side: "clawcode",
      confirmCutover: true,
      skipVerify: true,
      skipReason: "phase-91 regression test",
      cutoverLedgerPath: join(tempDir, "cutover-ledger.jsonl"),
      syncStatePath: statePath,
      runSyncOnceDep: runner,
      promptConfirm: prompt,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(
      /Drain sync failed with exception: drain bug/,
    );
    expect(prompt).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("openclaw");
  });

  // -------------------------------------------------------------------------
  // Reverse (→ openclaw, with 7-day window)
  // -------------------------------------------------------------------------

  it("SA-6: openclaw WITHOUT --revert-cutover nor --force-rollback → exit 1", async () => {
    const state = buildState({ authoritativeSide: "clawcode" });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const prompt = vi.fn();

    const code = await runSyncSetAuthoritativeAction({
      side: "openclaw",
      syncStatePath: statePath,
      promptConfirm: prompt,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(
      /requires either --revert-cutover .* or --force-rollback/,
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it("SA-7: openclaw + --revert-cutover within 7 days + prompt=yes → flipped", async () => {
    const cutoverAt = "2026-04-24T12:00:00.000Z";
    const state = buildState({
      authoritativeSide: "clawcode",
      updatedAt: cutoverAt,
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const prompt = vi.fn().mockResolvedValue(true);
    // 3 days later — well within the 7-day window.
    const fixedNow = new Date("2026-04-27T12:00:00.000Z");

    const code = await runSyncSetAuthoritativeAction({
      side: "openclaw",
      revertCutover: true,
      syncStatePath: statePath,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });

    expect(code).toBe(0);
    expect(prompt).toHaveBeenCalledOnce();
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("openclaw");
    expect(persisted.updatedAt).toBe(fixedNow.toISOString());
    expect(stdoutCapture.join("")).toMatch(/Flipped authoritativeSide → openclaw/);
  });

  it("SA-8: openclaw + --revert-cutover AFTER 7 days → exit 1 (no --force-rollback)", async () => {
    const cutoverAt = "2026-04-01T12:00:00.000Z";
    const state = buildState({
      authoritativeSide: "clawcode",
      updatedAt: cutoverAt,
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const prompt = vi.fn();
    // 20 days later — well past 7-day window.
    const fixedNow = new Date("2026-04-21T12:00:00.000Z");

    const code = await runSyncSetAuthoritativeAction({
      side: "openclaw",
      revertCutover: true,
      syncStatePath: statePath,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(
      /Rollback window expired \(20 days/,
    );
    expect(prompt).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("clawcode");
  });

  it("SA-9: openclaw + --force-rollback AFTER 7 days + prompt=yes → flipped with warning", async () => {
    const cutoverAt = "2026-04-01T12:00:00.000Z";
    const state = buildState({
      authoritativeSide: "clawcode",
      updatedAt: cutoverAt,
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const prompt = vi.fn().mockResolvedValue(true);
    const fixedNow = new Date("2026-04-21T12:00:00.000Z");

    const code = await runSyncSetAuthoritativeAction({
      side: "openclaw",
      forceRollback: true,
      syncStatePath: statePath,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });

    expect(code).toBe(0);
    // Warning line on stdout.
    expect(stdoutCapture.join("")).toMatch(/WARNING: Post-window rollback/);
    expect(stdoutCapture.join("")).toMatch(/Flipped authoritativeSide → openclaw/);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.authoritativeSide).toBe("openclaw");
  });

  it("SA-11: already authoritative=openclaw → exit 1 no-op guard", async () => {
    const state = buildState({ authoritativeSide: "openclaw" });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const prompt = vi.fn();

    const code = await runSyncSetAuthoritativeAction({
      side: "openclaw",
      revertCutover: true,
      syncStatePath: statePath,
      promptConfirm: prompt,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/Already authoritative: openclaw/);
    expect(prompt).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Constant sanity
  // -------------------------------------------------------------------------

  it("SA-CONST: ROLLBACK_WINDOW_MS is exactly 7 days in ms", () => {
    expect(ROLLBACK_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
