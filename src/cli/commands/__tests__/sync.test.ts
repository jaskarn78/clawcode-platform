/**
 * Phase 91 Plan 04 Task 1 — `clawcode sync` command group tests.
 *
 * Covers:
 *   - ST-REG: registerSyncCommand attaches all 8 subcommands to parent
 *   - ST-STATUS-1..3: sync status happy paths + missing state/jsonl
 *   - ST-RUN-1..3: sync run-once outcome JSON + exit-code branching
 *   - ST-XL-1..3: sync translate-sessions happy path + agent-not-found + errors
 *
 * All tests are hermetic via DI — no rsync, no SSH, no real SQLite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import type { Logger } from "pino";
import { registerSyncCommand } from "../sync.js";
import { runSyncStatusAction } from "../sync-status.js";
import { runSyncRunOnceAction } from "../sync-run-once.js";
import { runSyncTranslateSessionsAction } from "../sync-translate-sessions.js";
import type { SyncRunOutcome, SyncStateFile } from "../../../sync/types.js";
import type { TranslatorRunOutcome } from "../../../sync/conversation-turn-translator.js";

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as Logger;

describe("sync command group (Plan 91-04 Task 1)", () => {
  let tempDir: string;
  let stdoutCapture: string[];
  let stderrCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sync-task1-"));
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
  // Registration wiring
  // -------------------------------------------------------------------------

  it("ST-REG: registerSyncCommand wires 10 subcommands to parent (Phase 91 + Phase 96 D-11)", () => {
    const parent = new Command();
    registerSyncCommand(parent);
    const syncCmd = parent.commands.find((c) => c.name() === "sync");
    expect(syncCmd).toBeDefined();
    const subcommandNames = syncCmd!.commands.map((c) => c.name()).sort();
    // Phase 91: status, run-once, translate-sessions, resolve, set-authoritative, start, stop, finalize
    // Phase 96 D-11: disable-timer, re-enable-timer (Plan 96-06)
    expect(subcommandNames).toEqual(
      [
        "disable-timer",
        "finalize",
        "re-enable-timer",
        "resolve",
        "run-once",
        "set-authoritative",
        "start",
        "status",
        "stop",
        "translate-sessions",
      ].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // sync status
  // -------------------------------------------------------------------------

  it("ST-STATUS-1: returns 0 and emits default state JSON when files are missing", async () => {
    const statePath = join(tempDir, "missing-state.json");
    const jsonlPath = join(tempDir, "missing.jsonl");

    const code = await runSyncStatusAction({
      syncStatePath: statePath,
      syncJsonlPath: jsonlPath,
      log: silentLog,
    });

    expect(code).toBe(0);
    const combined = stdoutCapture.join("");
    const parsed = JSON.parse(combined);
    expect(parsed.authoritativeSide).toBe("openclaw"); // DEFAULT_SYNC_STATE
    expect(parsed.conflictCount).toBe(0);
    expect(parsed.lastCycle).toBeNull();
  });

  it("ST-STATUS-2: emits state summary + last JSONL cycle when present", async () => {
    const statePath = join(tempDir, "state.json");
    const jsonlPath = join(tempDir, "sync.jsonl");

    const state: SyncStateFile = {
      version: 1,
      updatedAt: "2026-04-24T19:00:00.000Z",
      authoritativeSide: "openclaw",
      lastSyncedAt: "2026-04-24T19:00:00.000Z",
      openClawHost: "example-user@10.0.0.3",
      openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
      clawcodeWorkspace: "/home/clawcode/.clawcode/agents/acme",
      perFileHashes: { "MEMORY.md": "a".repeat(64) },
      conflicts: [
        {
          path: "vault/procedures/archive/foo.md",
          sourceHash: "b".repeat(64),
          destHash: "c".repeat(64),
          detectedAt: "2026-04-24T18:55:00.000Z",
          resolvedAt: null,
        },
      ],
      openClawSessionCursor: null,
    };
    await writeFile(statePath, JSON.stringify(state), "utf8");
    await writeFile(
      jsonlPath,
      JSON.stringify({
        timestamp: "2026-04-24T19:00:00.000Z",
        cycleId: "test-cycle-abc",
        direction: "openclaw-to-clawcode",
        status: "synced",
        filesAdded: 1,
        filesUpdated: 0,
        filesRemoved: 0,
        filesSkippedConflict: 0,
        bytesTransferred: 512,
        durationMs: 1234,
      }) + "\n",
      "utf8",
    );

    const code = await runSyncStatusAction({
      syncStatePath: statePath,
      syncJsonlPath: jsonlPath,
      log: silentLog,
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCapture.join(""));
    expect(parsed.authoritativeSide).toBe("openclaw");
    expect(parsed.conflictCount).toBe(1);
    expect(parsed.conflicts[0].path).toBe(
      "vault/procedures/archive/foo.md",
    );
    expect(parsed.perFileHashCount).toBe(1);
    expect(parsed.lastCycle.cycleId).toBe("test-cycle-abc");
    expect(parsed.lastCycle.status).toBe("synced");
  });

  it("ST-STATUS-3: ignores resolved conflicts in conflictCount + conflicts[]", async () => {
    const statePath = join(tempDir, "state.json");
    const state: SyncStateFile = {
      version: 1,
      updatedAt: "2026-04-24T19:00:00.000Z",
      authoritativeSide: "openclaw",
      lastSyncedAt: null,
      openClawHost: "example-user@10.0.0.3",
      openClawWorkspace: "/src",
      clawcodeWorkspace: "/dst",
      perFileHashes: {},
      conflicts: [
        {
          path: "resolved.md",
          sourceHash: "a".repeat(64),
          destHash: "b".repeat(64),
          detectedAt: "2026-04-24T18:00:00.000Z",
          resolvedAt: "2026-04-24T18:30:00.000Z",
        },
        {
          path: "unresolved.md",
          sourceHash: "c".repeat(64),
          destHash: "d".repeat(64),
          detectedAt: "2026-04-24T18:55:00.000Z",
          resolvedAt: null,
        },
      ],
      openClawSessionCursor: null,
    };
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const code = await runSyncStatusAction({
      syncStatePath: statePath,
      syncJsonlPath: join(tempDir, "nope.jsonl"),
      log: silentLog,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCapture.join(""));
    expect(parsed.conflictCount).toBe(1);
    expect(parsed.conflicts).toHaveLength(1);
    expect(parsed.conflicts[0].path).toBe("unresolved.md");
  });

  // -------------------------------------------------------------------------
  // sync run-once
  // -------------------------------------------------------------------------

  it("ST-RUN-1: exits 0 on 'synced' outcome, emits flat JSON", async () => {
    const cannedOutcome: SyncRunOutcome = {
      kind: "synced",
      cycleId: "test-cycle-1",
      filesAdded: 3,
      filesUpdated: 5,
      filesRemoved: 1,
      filesSkippedConflict: 0,
      bytesTransferred: 65536,
      durationMs: 1200,
    };
    const runner = vi.fn().mockResolvedValue(cannedOutcome);

    const code = await runSyncRunOnceAction({
      syncStatePath: join(tempDir, "state.json"),
      syncJsonlPath: join(tempDir, "sync.jsonl"),
      filterFile: join(tempDir, "filter.txt"),
      runSyncOnceDep: runner,
      log: silentLog,
    });

    expect(code).toBe(0);
    expect(runner).toHaveBeenCalledOnce();
    const parsed = JSON.parse(stdoutCapture.join(""));
    expect(parsed.kind).toBe("synced");
    expect(parsed.filesAdded).toBe(3);
  });

  it("ST-RUN-2: exits 1 on 'failed-ssh' outcome", async () => {
    const runner = vi.fn().mockResolvedValue({
      kind: "failed-ssh",
      cycleId: "test-cycle-2",
      error: "ssh: connect to host 10.0.0.3 port 22: No route to host",
      durationMs: 100,
    } satisfies SyncRunOutcome);

    const code = await runSyncRunOnceAction({
      syncStatePath: join(tempDir, "state.json"),
      runSyncOnceDep: runner,
      log: silentLog,
    });

    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutCapture.join(""));
    expect(parsed.kind).toBe("failed-ssh");
  });

  it("ST-RUN-3: exits 1 on thrown exception (wraps with cliError)", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("boom"));
    const code = await runSyncRunOnceAction({
      syncStatePath: join(tempDir, "state.json"),
      runSyncOnceDep: runner,
      log: silentLog,
    });
    expect(code).toBe(1);
    const errOutput = stderrCapture.join("");
    expect(errOutput).toMatch(/sync run-once failed: boom/);
  });

  it("ST-RUN-4: exits 0 on 'skipped-no-changes' (not a hard failure)", async () => {
    const runner = vi.fn().mockResolvedValue({
      kind: "skipped-no-changes",
      cycleId: "test-cycle-4",
      durationMs: 50,
    } satisfies SyncRunOutcome);
    const code = await runSyncRunOnceAction({
      runSyncOnceDep: runner,
      log: silentLog,
    });
    expect(code).toBe(0);
  });

  it("ST-RUN-5: exits 0 on 'paused' (authoritativeSide=clawcode, normal flow)", async () => {
    const runner = vi.fn().mockResolvedValue({
      kind: "paused",
      cycleId: "test-cycle-5",
      reason: "authoritative-is-clawcode-no-reverse-opt-in",
    } satisfies SyncRunOutcome);
    const code = await runSyncRunOnceAction({
      runSyncOnceDep: runner,
      log: silentLog,
    });
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // sync translate-sessions
  // -------------------------------------------------------------------------

  it("ST-XL-1: happy path — invokes translator, emits outcome JSON, exits 0", async () => {
    const loadConfigStub = vi.fn().mockResolvedValue({
      agents: [
        {
          name: "fin-client",
          workspace: join(tempDir, "ws"),
          memoryPath: join(tempDir, "ws"),
        },
      ],
    });
    await mkdir(join(tempDir, "ws"), { recursive: true });

    const cannedOutcome: TranslatorRunOutcome = {
      sessionsScanned: 3,
      sessionsSkippedMidWrite: 1,
      sessionsSkippedParseError: 0,
      turnsInserted: 42,
      turnsSkippedDuplicate: 8,
      turnsSkippedNonText: 15,
      durationMs: 500,
    };
    const translatorStub = vi.fn().mockResolvedValue(cannedOutcome);
    const makeStoreStub = vi.fn().mockReturnValue({
      store: {} as never,
      close: () => {},
    });

    const code = await runSyncTranslateSessionsAction({
      agentName: "fin-client",
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: loadConfigStub,
      runTranslatorDep: translatorStub,
      makeConversationStore: makeStoreStub,
      log: silentLog,
    });

    expect(code).toBe(0);
    expect(translatorStub).toHaveBeenCalledOnce();
    const parsed = JSON.parse(stdoutCapture.join(""));
    expect(parsed.turnsInserted).toBe(42);
    expect(parsed.sessionsScanned).toBe(3);
  });

  it("ST-XL-2: agent not in config — exits 1 with stderr error", async () => {
    const loadConfigStub = vi.fn().mockResolvedValue({
      agents: [{ name: "other-agent", workspace: "/tmp" }],
    });
    const code = await runSyncTranslateSessionsAction({
      agentName: "missing",
      loadConfigDep: loadConfigStub,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(
      /Agent 'missing' not in clawcode\.yaml/,
    );
  });

  it("ST-XL-3: agent has no workspace — exits 1 with stderr error", async () => {
    const loadConfigStub = vi.fn().mockResolvedValue({
      agents: [{ name: "fin-client" }], // no workspace field
    });
    const code = await runSyncTranslateSessionsAction({
      agentName: "fin-client",
      loadConfigDep: loadConfigStub,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(
      /has no workspace configured/,
    );
  });

  it("ST-XL-4: translator throws — exits 1, close() still called", async () => {
    const loadConfigStub = vi.fn().mockResolvedValue({
      agents: [
        {
          name: "fin-client",
          workspace: join(tempDir, "ws"),
        },
      ],
    });
    const closeSpy = vi.fn();
    const makeStoreStub = vi.fn().mockReturnValue({
      store: {} as never,
      close: closeSpy,
    });
    const translatorStub = vi.fn().mockRejectedValue(new Error("translator bug"));

    const code = await runSyncTranslateSessionsAction({
      agentName: "fin-client",
      loadConfigDep: loadConfigStub,
      runTranslatorDep: translatorStub,
      makeConversationStore: makeStoreStub,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(
      /translate-sessions failed for 'fin-client': translator bug/,
    );
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("ST-XL-5: loadConfig fails — exits 1 with stderr error", async () => {
    const loadConfigStub = vi
      .fn()
      .mockRejectedValue(new Error("ENOENT: no such file"));
    const code = await runSyncTranslateSessionsAction({
      agentName: "fin-client",
      configPath: "/nonexistent.yaml",
      loadConfigDep: loadConfigStub,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/Failed to load .*\.yaml/);
  });
});
