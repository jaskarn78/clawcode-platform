/**
 * Phase 91 Plan 04 Task 2 — `clawcode sync resolve <path>` tests.
 *
 * Covers D-14 semantics:
 *   - RES-1: Missing conflict for path → exit 1 with stderr error
 *   - RES-2: --side openclaw pulls remote→local, updates perFileHashes, clears conflict
 *   - RES-3: --side clawcode pushes local→remote, updates perFileHashes, clears conflict
 *   - RES-4: rsync non-zero exit → exit 1, state unchanged (atomic rollback)
 *   - RES-5: Resolved + unresolved conflicts for same path → only unresolved one is touched
 *   - RES-6: readFile failure post-rsync → exit 1 with clear error
 *
 * All I/O hermetic: rsync + readFile injected as mocks; state via temp file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import type { Logger } from "pino";
import { runSyncResolveAction } from "../sync-resolve.js";
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

describe("sync resolve (Plan 91-04 Task 2)", () => {
  let tempDir: string;
  let statePath: string;
  let stdoutCapture: string[];
  let stderrCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sync-resolve-"));
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

  it("RES-1: missing conflict for path → exits 1 with stderr error, state unchanged", async () => {
    const state = buildState({ conflicts: [] });
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const rsyncStub = vi.fn();
    const readFileStub = vi.fn();

    const code = await runSyncResolveAction({
      path: "MEMORY.md",
      side: "openclaw",
      syncStatePath: statePath,
      runRsync: rsyncStub,
      readFileImpl: readFileStub as unknown as typeof readFile,
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/No unresolved conflict for path 'MEMORY\.md'/);
    expect(rsyncStub).not.toHaveBeenCalled();
    expect(readFileStub).not.toHaveBeenCalled();

    // State unchanged on disk.
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    expect(persisted.conflicts).toEqual([]);
  });

  it("RES-2: --side openclaw pulls remote→local, updates perFileHashes, clears conflict", async () => {
    const state = buildState({
      perFileHashes: { "MEMORY.md": "old".padEnd(64, "0") },
      conflicts: [
        {
          path: "MEMORY.md",
          sourceHash: "a".repeat(64),
          destHash: "b".repeat(64),
          detectedAt: "2026-04-24T18:55:00.000Z",
          resolvedAt: null,
        },
      ],
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const rsyncStub = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const readFileStub = vi
      .fn()
      .mockResolvedValue(Buffer.from("new merged content", "utf8"));

    const code = await runSyncResolveAction({
      path: "MEMORY.md",
      side: "openclaw",
      syncStatePath: statePath,
      runRsync: rsyncStub,
      readFileImpl: readFileStub as unknown as typeof readFile,
      log: silentLog,
    });

    expect(code).toBe(0);
    expect(rsyncStub).toHaveBeenCalledOnce();
    const rsyncArgs = rsyncStub.mock.calls[0][0] as string[];
    // Expected src: example-user@...:workspace-acme/MEMORY.md
    expect(rsyncArgs[rsyncArgs.length - 2]).toBe(
      "example-user@10.0.0.3:/home/example-user/.openclaw/workspace-acme/MEMORY.md",
    );
    // Expected dst: /home/clawcode/.clawcode/agents/acme/MEMORY.md
    expect(rsyncArgs[rsyncArgs.length - 1]).toBe(
      "/home/clawcode/.clawcode/agents/acme/MEMORY.md",
    );

    // State updated: conflict resolved, perFileHashes[MEMORY.md] = new sha256
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.conflicts[0].resolvedAt).not.toBeNull();
    expect(persisted.perFileHashes["MEMORY.md"]).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted.perFileHashes["MEMORY.md"]).not.toBe("old".padEnd(64, "0"));

    // Stdout mentions the resolution.
    expect(stdoutCapture.join("")).toMatch(/Resolved 'MEMORY\.md' using openclaw side/);
  });

  it("RES-3: --side clawcode pushes local→remote, updates perFileHashes, clears conflict", async () => {
    const state = buildState({
      conflicts: [
        {
          path: "vault/notes.md",
          sourceHash: "a".repeat(64),
          destHash: "b".repeat(64),
          detectedAt: "2026-04-24T18:55:00.000Z",
          resolvedAt: null,
        },
      ],
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const rsyncStub = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const readFileStub = vi.fn().mockResolvedValue(Buffer.from("local wins"));

    const code = await runSyncResolveAction({
      path: "vault/notes.md",
      side: "clawcode",
      syncStatePath: statePath,
      runRsync: rsyncStub,
      readFileImpl: readFileStub as unknown as typeof readFile,
      log: silentLog,
    });

    expect(code).toBe(0);
    const rsyncArgs = rsyncStub.mock.calls[0][0] as string[];
    // src = local, dst = remote (reverse of RES-2)
    expect(rsyncArgs[rsyncArgs.length - 2]).toBe(
      "/home/clawcode/.clawcode/agents/acme/vault/notes.md",
    );
    expect(rsyncArgs[rsyncArgs.length - 1]).toBe(
      "example-user@10.0.0.3:/home/example-user/.openclaw/workspace-acme/vault/notes.md",
    );

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.conflicts[0].resolvedAt).not.toBeNull();
    expect(persisted.perFileHashes["vault/notes.md"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("RES-4: rsync non-zero exit → exits 1 with stderr, state unchanged", async () => {
    const state = buildState({
      conflicts: [
        {
          path: "MEMORY.md",
          sourceHash: "a".repeat(64),
          destHash: "b".repeat(64),
          detectedAt: "2026-04-24T18:55:00.000Z",
          resolvedAt: null,
        },
      ],
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const rsyncStub = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "rsync: connection refused",
      exitCode: 255,
    });
    const readFileStub = vi.fn();

    const code = await runSyncResolveAction({
      path: "MEMORY.md",
      side: "openclaw",
      syncStatePath: statePath,
      runRsync: rsyncStub,
      readFileImpl: readFileStub as unknown as typeof readFile,
      log: silentLog,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/rsync failed \(exit 255\)/);
    expect(readFileStub).not.toHaveBeenCalled();

    // State unchanged: conflict still unresolved, no perFileHashes entry.
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.conflicts[0].resolvedAt).toBeNull();
    expect(persisted.perFileHashes["MEMORY.md"]).toBeUndefined();
  });

  it("RES-5: same path has resolved + unresolved conflicts → only unresolved one is touched", async () => {
    const state = buildState({
      conflicts: [
        {
          path: "MEMORY.md",
          sourceHash: "old-source".padEnd(64, "0"),
          destHash: "old-dest".padEnd(64, "0"),
          detectedAt: "2026-04-24T10:00:00.000Z",
          resolvedAt: "2026-04-24T10:30:00.000Z", // already resolved
        },
        {
          path: "MEMORY.md",
          sourceHash: "a".repeat(64),
          destHash: "b".repeat(64),
          detectedAt: "2026-04-24T18:55:00.000Z",
          resolvedAt: null, // new unresolved
        },
      ],
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const rsyncStub = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const readFileStub = vi.fn().mockResolvedValue(Buffer.from("fresh"));

    const code = await runSyncResolveAction({
      path: "MEMORY.md",
      side: "openclaw",
      syncStatePath: statePath,
      runRsync: rsyncStub,
      readFileImpl: readFileStub as unknown as typeof readFile,
      log: silentLog,
    });

    expect(code).toBe(0);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as SyncStateFile;
    expect(persisted.conflicts).toHaveLength(2);

    // Resolved entry untouched — still has the original resolvedAt timestamp.
    expect(persisted.conflicts[0].resolvedAt).toBe("2026-04-24T10:30:00.000Z");
    expect(persisted.conflicts[0].sourceHash).toBe("old-source".padEnd(64, "0"));
    // Unresolved entry now has a fresh resolvedAt.
    expect(persisted.conflicts[1].resolvedAt).not.toBeNull();
    expect(persisted.conflicts[1].resolvedAt).not.toBe("2026-04-24T10:30:00.000Z");
  });

  it("RES-6: readFile (re-hash step) fails after rsync → exits 1 with clear error", async () => {
    const state = buildState({
      conflicts: [
        {
          path: "MEMORY.md",
          sourceHash: "a".repeat(64),
          destHash: "b".repeat(64),
          detectedAt: "2026-04-24T18:55:00.000Z",
          resolvedAt: null,
        },
      ],
    });
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const rsyncStub = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const readFileStub = vi.fn().mockRejectedValue(new Error("EACCES: permission denied"));

    const code = await runSyncResolveAction({
      path: "MEMORY.md",
      side: "openclaw",
      syncStatePath: statePath,
      runRsync: rsyncStub,
      readFileImpl: readFileStub as unknown as typeof readFile,
      log: silentLog,
    });
    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(
      /Failed to re-hash .* after rsync: EACCES: permission denied/,
    );
  });
});
