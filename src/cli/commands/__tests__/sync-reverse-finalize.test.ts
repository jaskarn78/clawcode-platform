/**
 * Phase 91 Plan 04 Task 2 — `clawcode sync start --reverse` / `stop` / `finalize` tests.
 *
 * Covers D-18 reverse opt-in + D-20 Day-7 cleanup prompt:
 *
 *   REV-1: start --reverse when authoritativeSide=openclaw → exit 1
 *   REV-2: start --reverse when authoritativeSide=clawcode → flag file written, exit 0
 *   REV-3: stop unlinks flag file, exit 0
 *   REV-4: stop when flag file missing → exit 0 idempotent
 *   FIN-1: finalize when authoritativeSide=openclaw → exit 1
 *   FIN-2: finalize when within 7-day window → exit 1
 *   FIN-3: finalize past 7-day window + prompt=yes → exit 0, prints ssh command
 *   FIN-4: finalize --force bypasses 7-day guard
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Logger } from "pino";
import {
  runSyncReverseStartAction,
  runSyncStopAction,
} from "../sync-reverse.js";
import { runSyncFinalizeAction } from "../sync-finalize.js";
import type { SyncStateFile } from "../../../sync/types.js";

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

describe("sync start/stop/finalize (Plan 91-04 Task 2)", () => {
  let tempDir: string;
  let statePath: string;
  let flagPath: string;
  let stdoutCapture: string[];
  let stderrCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sync-revfin-"));
    statePath = join(tempDir, "sync-state.json");
    flagPath = join(tempDir, "reverse.flag");
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
  // start --reverse / stop
  // -------------------------------------------------------------------------

  it("REV-1: start --reverse when authoritativeSide=openclaw → exit 1", async () => {
    const state = buildState({ authoritativeSide: "openclaw" });
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const code = await runSyncReverseStartAction({
      syncStatePath: statePath,
      flagPath,
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(
      /Reverse sync requires authoritativeSide=clawcode/,
    );
    await expect(access(flagPath)).rejects.toThrow();
  });

  it("REV-2: start --reverse when authoritativeSide=clawcode → flag written, exit 0", async () => {
    const state = buildState({ authoritativeSide: "clawcode" });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const fixedNow = new Date("2026-04-24T20:00:00.000Z");

    const code = await runSyncReverseStartAction({
      syncStatePath: statePath,
      flagPath,
      now: () => fixedNow,
      log: silentLog,
    });

    expect(code).toBe(0);
    await expect(access(flagPath)).resolves.toBeUndefined();
    expect(stdoutCapture.join("")).toMatch(/Reverse sync \(ClawCode → OpenClaw\) ENABLED/);
  });

  it("REV-3: stop unlinks an existing flag file → exit 0", async () => {
    await writeFile(flagPath, "2026-04-24T20:00:00.000Z", "utf8");
    const code = await runSyncStopAction({ flagPath, log: silentLog });
    expect(code).toBe(0);
    await expect(access(flagPath)).rejects.toThrow();
    expect(stdoutCapture.join("")).toMatch(/Reverse sync STOPPED/);
  });

  it("REV-4: stop when flag file missing → exit 0 idempotent no-op", async () => {
    const code = await runSyncStopAction({ flagPath, log: silentLog });
    expect(code).toBe(0);
    expect(stdoutCapture.join("")).toMatch(/was not enabled \(no-op\)/);
  });

  // -------------------------------------------------------------------------
  // finalize
  // -------------------------------------------------------------------------

  it("FIN-1: finalize when authoritativeSide=openclaw → exit 1", async () => {
    const state = buildState({ authoritativeSide: "openclaw" });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const prompt = vi.fn();

    const code = await runSyncFinalizeAction({
      syncStatePath: statePath,
      promptConfirm: prompt,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/only runs post-cutover/);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("FIN-2: finalize within 7-day window → exit 1", async () => {
    const cutoverAt = "2026-04-22T12:00:00.000Z"; // 2 days ago
    const state = buildState({
      authoritativeSide: "clawcode",
      updatedAt: cutoverAt,
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const prompt = vi.fn();
    const fixedNow = new Date("2026-04-24T12:00:00.000Z");

    const code = await runSyncFinalizeAction({
      syncStatePath: statePath,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/days remain in the 7-day rollback window/);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("FIN-3: finalize past 7-day window + prompt=yes → exit 0, prints ssh rm command", async () => {
    const cutoverAt = "2026-04-10T12:00:00.000Z"; // 14 days ago
    const state = buildState({
      authoritativeSide: "clawcode",
      updatedAt: cutoverAt,
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const prompt = vi.fn().mockResolvedValue(true);
    const fixedNow = new Date("2026-04-24T12:00:00.000Z");

    const code = await runSyncFinalizeAction({
      syncStatePath: statePath,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });
    expect(code).toBe(0);
    expect(prompt).toHaveBeenCalledOnce();
    const stdout = stdoutCapture.join("");
    expect(stdout).toMatch(
      /ssh example-user@10\.0\.0\.3 "rm -rf \/home\/example-user\/\.openclaw\/workspace-acme"/,
    );
  });

  it("FIN-4: finalize --force bypasses 7-day guard", async () => {
    const cutoverAt = "2026-04-23T12:00:00.000Z"; // 1 day ago (within window)
    const state = buildState({
      authoritativeSide: "clawcode",
      updatedAt: cutoverAt,
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const prompt = vi.fn().mockResolvedValue(true);
    const fixedNow = new Date("2026-04-24T12:00:00.000Z");

    const code = await runSyncFinalizeAction({
      syncStatePath: statePath,
      force: true,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });
    expect(code).toBe(0);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("FIN-5: finalize past window + prompt=no → exit 0, prints 'Aborted'", async () => {
    const cutoverAt = "2026-04-10T12:00:00.000Z";
    const state = buildState({
      authoritativeSide: "clawcode",
      updatedAt: cutoverAt,
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const prompt = vi.fn().mockResolvedValue(false);
    const fixedNow = new Date("2026-04-24T12:00:00.000Z");

    const code = await runSyncFinalizeAction({
      syncStatePath: statePath,
      promptConfirm: prompt,
      now: () => fixedNow,
      log: silentLog,
    });
    expect(code).toBe(0);
    expect(stdoutCapture.join("")).toMatch(/Aborted\. Re-run when ready/);
  });
});
