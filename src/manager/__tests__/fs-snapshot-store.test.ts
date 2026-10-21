/**
 * Phase 96 Plan 01 Task 1 — fs-snapshot-store atomic temp+rename tests (RED).
 *
 * Mirrors src/sync/sync-state-store.ts:75-160 verbatim. Atomic temp+rename
 * for ~/.clawcode/agents/<agent>/fs-capability.json. Schema-validated read
 * with graceful null fallback on missing/corrupt/invalid.
 *
 * Tests pin:
 *   - FSS-1   atomic temp+rename order — mkdir < writeFile(tmp) < rename(tmp, final)
 *   - FSS-2   mkdir recursive parent dir creation
 *   - FSS-3   schema-validated read returns parsed Map
 *   - FSS-4   graceful null on missing file (ENOENT)
 *   - FSS-5   graceful null on corrupt JSON + log warn
 *   - FSS-6   idempotent writes — distinct tmp filenames per call
 *
 * RED: src/manager/fs-snapshot-store.ts does not exist yet — imports fail.
 */

import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";

import {
  writeFsSnapshot,
  readFsSnapshot,
  type FsSnapshotStoreDeps,
} from "../fs-snapshot-store.js";
import type { FsCapabilitySnapshot } from "../persistent-session-handle.js";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLog,
} as unknown as Logger;

function makeDeps(overrides: Partial<FsSnapshotStoreDeps> = {}): FsSnapshotStoreDeps {
  return {
    writeFile: overrides.writeFile ?? vi.fn().mockResolvedValue(undefined),
    rename: overrides.rename ?? vi.fn().mockResolvedValue(undefined),
    mkdir: overrides.mkdir ?? vi.fn().mockResolvedValue(undefined),
    readFile: overrides.readFile ?? vi.fn().mockResolvedValue("{}"),
    log: overrides.log ?? noopLog,
  };
}

describe("fs-snapshot-store — Phase 96 Plan 01 atomic persistence (RED)", () => {
  it("FSS-1: atomic temp+rename — mkdir < writeFile(tmp) < rename(tmp, final)", async () => {
    const filePath = "/home/clawcode/.clawcode/agents/x/fs-capability.json";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [
        "/home/clawcode/.clawcode/agents/x/",
        {
          status: "ready",
          mode: "ro",
          lastProbeAt: "2026-04-25T12:00:00.000Z",
          lastSuccessAt: "2026-04-25T12:00:00.000Z",
        },
      ],
    ]);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const rename = vi.fn().mockResolvedValue(undefined);
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ writeFile, rename, mkdir });
    const now = (): Date => new Date("2026-04-25T12:00:00.000Z");

    await writeFsSnapshot("x", snapshot, filePath, deps, now);

    expect(mkdir).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenCalledOnce();
    // Order: mkdir < writeFile < rename
    const mkdirOrder = mkdir.mock.invocationCallOrder[0];
    const writeOrder = writeFile.mock.invocationCallOrder[0];
    const renameOrder = rename.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeOrder);
    expect(writeOrder).toBeLessThan(renameOrder);
    // tmp path includes ".tmp"
    const writePath = writeFile.mock.calls[0][0] as string;
    expect(writePath).toContain(".tmp");
    expect(writePath).toContain(filePath);
    // rename: from tmp to final
    expect(rename.mock.calls[0][0]).toBe(writePath);
    expect(rename.mock.calls[0][1]).toBe(filePath);
  });

  it("FSS-2: mkdir recursive parent dir creation", async () => {
    const filePath = "/home/clawcode/.clawcode/agents/x/fs-capability.json";
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ mkdir });
    await writeFsSnapshot("x", new Map(), filePath, deps);

    expect(mkdir).toHaveBeenCalledWith(
      "/home/clawcode/.clawcode/agents/x",
      { recursive: true },
    );
  });

  it("FSS-3: schema-validated read returns parsed Map for valid payload", async () => {
    const filePath = "/path/fs-capability.json";
    const payload = {
      agent: "x",
      lastProbeAt: "2026-04-25T12:00:00.000Z",
      paths: {
        "/home/clawcode/x/": {
          status: "ready",
          mode: "ro",
          lastProbeAt: "2026-04-25T12:00:00.000Z",
          lastSuccessAt: "2026-04-25T12:00:00.000Z",
        },
        "/home/example-user/acme/": {
          status: "degraded",
          mode: "denied",
          lastProbeAt: "2026-04-25T12:00:00.000Z",
          error: "EACCES",
        },
      },
    };
    const readFile = vi.fn().mockResolvedValue(JSON.stringify(payload));
    const deps = makeDeps({ readFile });

    const result = await readFsSnapshot(filePath, deps);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.size).toBe(2);
    expect(result.get("/home/clawcode/x/")?.status).toBe("ready");
    expect(result.get("/home/example-user/acme/")?.status).toBe("degraded");
    expect(result.get("/home/example-user/acme/")?.error).toBe("EACCES");
  });

  it("FSS-4: graceful null on missing file — ENOENT does NOT throw", async () => {
    const filePath = "/path/missing.json";
    const enoErr = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const readFile = vi.fn().mockRejectedValue(enoErr);
    const deps = makeDeps({ readFile });

    const result = await readFsSnapshot(filePath, deps);
    expect(result).toBeNull();
  });

  it("FSS-5: graceful null on corrupt JSON + log warn", async () => {
    const filePath = "/path/corrupt.json";
    const log: Logger = { ...noopLog, warn: vi.fn() } as unknown as Logger;
    const readFile = vi.fn().mockResolvedValue("not-json{{{");
    const deps = makeDeps({ readFile, log });

    const result = await readFsSnapshot(filePath, deps);
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("FSS-6: idempotent writes — distinct tmp filenames across calls", async () => {
    const filePath = "/path/fs-capability.json";
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ writeFile });

    await writeFsSnapshot("x", new Map(), filePath, deps);
    await writeFsSnapshot("x", new Map(), filePath, deps);

    expect(writeFile).toHaveBeenCalledTimes(2);
    const firstTmp = writeFile.mock.calls[0][0] as string;
    const secondTmp = writeFile.mock.calls[1][0] as string;
    // Both contain .tmp
    expect(firstTmp).toContain(".tmp");
    expect(secondTmp).toContain(".tmp");
    // Distinct (random suffix prevents collision)
    expect(firstTmp).not.toBe(secondTmp);
  });
});
