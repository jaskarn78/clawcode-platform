/**
 * Phase 96 Plan 01 Task 1 — fs-capability boundary check tests (RED).
 *
 * D-06 single-source-of-truth boundary: cache-hit fast path → on-miss live
 * fs.access fallback. Snapshot keyed by canonical absPath; NO path-prefix
 * startsWith.
 *
 * Tests pin:
 *   - CFC-1   cache-hit ready → allowed:true
 *   - CFC-2   cache-hit degraded → falls through to live check
 *   - CFC-3   on-miss live success → allowed:true
 *   - CFC-4   on-miss live EACCES → allowed:false
 *   - CFC-5   D-06 NO startsWith — subpath does NOT inherit root entry's status
 *   - CFC-6   canonical absPath via realpath/resolve fallback
 *   - CFC-7   ENOENT canonical fallback (path doesn't exist yet)
 *   - CFC-8   immutability — snapshot input never mutated
 *
 * RED: src/manager/fs-capability.ts does not exist yet — imports fail.
 */

import { describe, it, expect, vi } from "vitest";

import {
  checkFsCapability,
  type CheckFsCapabilityDeps,
} from "../fs-capability.js";
import type { FsCapabilitySnapshot } from "../persistent-session-handle.js";

function makeDeps(overrides: Partial<CheckFsCapabilityDeps> = {}): CheckFsCapabilityDeps {
  return {
    fsAccess: overrides.fsAccess ?? vi.fn().mockResolvedValue(undefined),
    fsConstants: overrides.fsConstants ?? { R_OK: 4 },
    canonicalize:
      overrides.canonicalize ?? vi.fn().mockImplementation(async (p: string) => p),
  };
}

describe("checkFsCapability — Phase 96 Plan 01 D-06 boundary (RED)", () => {
  it("CFC-1: cache-hit ready → allowed:true with canonical path + mode", async () => {
    const path = "/home/clawcode/x/";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [
        path,
        {
          status: "ready",
          mode: "ro",
          lastProbeAt: "2026-04-25T12:00:00.000Z",
          lastSuccessAt: "2026-04-25T12:00:00.000Z",
        },
      ],
    ]);
    const fsAccess = vi.fn();
    const deps = makeDeps({
      fsAccess,
      canonicalize: vi.fn().mockResolvedValue(path),
    });

    const result = await checkFsCapability(path, snapshot, deps);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.canonicalPath).toBe(path);
    expect(result.mode).toBe("ro");
    // fast-path: live fs.access NOT called when cached entry is ready
    expect(fsAccess).not.toHaveBeenCalled();
  });

  it("CFC-2: cache-hit degraded → falls through to live fs.access", async () => {
    const path = "/home/x/";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [
        path,
        {
          status: "degraded",
          mode: "denied",
          lastProbeAt: "2026-04-25T12:00:00.000Z",
          error: "EACCES: stale",
        },
      ],
    ]);
    const fsAccess = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      fsAccess,
      canonicalize: vi.fn().mockResolvedValue(path),
    });

    const result = await checkFsCapability(path, snapshot, deps);
    expect(result.allowed).toBe(true);
    expect(fsAccess).toHaveBeenCalledOnce();
  });

  it("CFC-3: on-miss live success — empty snapshot, fs.access resolves → allowed:true", async () => {
    const path = "/home/clawcode/file.txt";
    const snapshot = new Map<string, FsCapabilitySnapshot>();
    const fsAccess = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      fsAccess,
      canonicalize: vi.fn().mockResolvedValue(path),
    });

    const result = await checkFsCapability(path, snapshot, deps);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.canonicalPath).toBe(path);
    expect(result.mode).toBe("ro");
    expect(fsAccess).toHaveBeenCalledOnce();
  });

  it("CFC-4: on-miss live EACCES → allowed:false with verbatim reason", async () => {
    const path = "/forbidden/";
    const snapshot = new Map<string, FsCapabilitySnapshot>();
    const fsAccess = vi
      .fn()
      .mockRejectedValue(new Error("EACCES: permission denied, access '/forbidden/'"));
    const deps = makeDeps({
      fsAccess,
      canonicalize: vi.fn().mockResolvedValue(path),
    });

    const result = await checkFsCapability(path, snapshot, deps);
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toContain("EACCES");
  });

  it("CFC-5: D-06 NO startsWith — subpath does NOT inherit root-entry's status", async () => {
    // snapshot has the root path, but query is for a subpath that the
    // operator may have ACL-restricted.
    const root = "/home/clawcode/";
    const subpath = "/home/clawcode/secret/file";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [
        root,
        {
          status: "ready",
          mode: "ro",
          lastProbeAt: "2026-04-25T12:00:00.000Z",
          lastSuccessAt: "2026-04-25T12:00:00.000Z",
        },
      ],
    ]);
    // Live fs.access denies the subpath (e.g., per-file ACL restriction)
    const fsAccess = vi
      .fn()
      .mockRejectedValue(new Error("EACCES: permission denied"));
    const deps = makeDeps({
      fsAccess,
      canonicalize: vi.fn().mockResolvedValue(subpath),
    });

    const result = await checkFsCapability(subpath, snapshot, deps);
    // Subpath must NOT inherit root entry's ready status — D-06 NO startsWith
    expect(result.allowed).toBe(false);
    // Live fs.access SHOULD have been called (cache miss because exact-match)
    expect(fsAccess).toHaveBeenCalledOnce();
  });

  it("CFC-6: canonical absPath via realpath fallback resolves `..`", async () => {
    const inputPath = "/home/x/../y/file";
    const canonical = "/home/y/file";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [
        canonical,
        {
          status: "ready",
          mode: "ro",
          lastProbeAt: "2026-04-25T12:00:00.000Z",
          lastSuccessAt: "2026-04-25T12:00:00.000Z",
        },
      ],
    ]);
    const canonicalize = vi.fn().mockResolvedValue(canonical);
    const fsAccess = vi.fn();
    const deps = makeDeps({ fsAccess, canonicalize });

    const result = await checkFsCapability(inputPath, snapshot, deps);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    // Canonicalized path is what was looked up
    expect(result.canonicalPath).toBe(canonical);
    expect(canonicalize).toHaveBeenCalledWith(inputPath);
  });

  it("CFC-7: ENOENT canonical fallback — canonicalize throws → allowed:false", async () => {
    const inputPath = "/missing/file";
    const enoErr = new Error("ENOENT: no such file or directory");
    const canonicalize = vi.fn().mockRejectedValue(enoErr);
    const fsAccess = vi.fn();
    const snapshot = new Map<string, FsCapabilitySnapshot>();
    const deps = makeDeps({ fsAccess, canonicalize });

    const result = await checkFsCapability(inputPath, snapshot, deps);
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toContain("ENOENT");
  });

  it("CFC-8: immutability — snapshot input never mutated", async () => {
    const path = "/home/clawcode/x/";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [
        path,
        {
          status: "ready",
          mode: "ro",
          lastProbeAt: "2026-04-25T12:00:00.000Z",
          lastSuccessAt: "2026-04-25T12:00:00.000Z",
        },
      ],
    ]);
    const before = snapshot.size;
    const fsAccess = vi.fn();
    const deps = makeDeps({
      fsAccess,
      canonicalize: vi.fn().mockResolvedValue(path),
    });

    await checkFsCapability(path, snapshot, deps);
    await checkFsCapability(path, snapshot, deps);
    expect(snapshot.size).toBe(before);
    // Map identity preserved — no replacement
    expect(snapshot.get(path)?.status).toBe("ready");
  });
});
