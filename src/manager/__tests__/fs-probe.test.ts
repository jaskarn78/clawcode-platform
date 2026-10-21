/**
 * Phase 96 Plan 01 Task 1 — fs-probe primitive tests (RED).
 *
 * Tests pin:
 *   - FP-1   ready outcome → status "ready" + mode "ro" + lastSuccessAt set
 *   - FP-2   degraded EACCES → status "degraded" + verbatim error captured
 *   - FP-3   lastSuccessAt preserved on degraded transition
 *   - FP-4   lastSuccessAt updated on ready
 *   - FP-5   timeout enforcement (FS_PROBE_TIMEOUT_MS = 5_000)
 *   - FP-6   verbatim ENOENT pass-through
 *   - FP-7   unknown for never-probed (empty paths)
 *   - FP-PARALLEL-INDEPENDENCE — one path failure does not block siblings
 *   - FP-IMMUT — orchestrator returns NEW Map; never mutates prevSnapshot
 *   - FP-CANONICAL-RESOLVE — input with `..` → snapshot keyed by canonical
 *   - FP-CANONICAL-SYMLINK — realpath result is the snapshot key
 *   - FP-CANONICAL-ENOENT-FALLBACK — realpath ENOENT → resolve fallback key
 *   - FP-VERBATIM-EACCES — Phase 85 TOOL-04 inheritance sentinel
 *   - FP-NO-LEAK — probe layer does not re-inject fileAccess path into error
 *
 * RED: src/manager/fs-probe.ts does not exist yet — imports fail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";

import {
  runFsProbe,
  FS_PROBE_TIMEOUT_MS,
  type FsProbeOutcome,
  type FsProbeDeps,
} from "../fs-probe.js";
import type { FsCapabilitySnapshot } from "../persistent-session-handle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLog,
} as unknown as Logger;

function fixedTime(iso: string): () => Date {
  return () => new Date(iso);
}

function makeDeps(overrides: Partial<FsProbeDeps> = {}): FsProbeDeps {
  return {
    fsAccess: overrides.fsAccess ?? vi.fn().mockResolvedValue(undefined),
    fsConstants: overrides.fsConstants ?? { R_OK: 4, W_OK: 2 },
    realpath: overrides.realpath ?? vi.fn().mockImplementation(async (p: string) => p),
    resolve: overrides.resolve ?? ((p: string) => p),
    now: overrides.now ?? fixedTime("2026-04-25T12:00:00.000Z"),
    log: overrides.log ?? noopLog,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runFsProbe — Phase 96 Plan 01 D-CONTEXT primitive (RED)", () => {
  it("FP-1: ready outcome — fs.access(R_OK) succeeds → status 'ready', mode 'ro', lastSuccessAt set", async () => {
    const path = "/home/clawcode/.clawcode/agents/x/";
    const deps = makeDeps();
    const result = await runFsProbe([path], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.snapshot.size).toBe(1);
    const entry = result.snapshot.get(path);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("ready");
    expect(entry?.mode).toBe("ro");
    expect(entry?.lastProbeAt).toBe("2026-04-25T12:00:00.000Z");
    expect(entry?.lastSuccessAt).toBe("2026-04-25T12:00:00.000Z");
    expect(entry?.error).toBeUndefined();
  });

  it("FP-2: degraded EACCES — verbatim error pass-through", async () => {
    const path = "/home/example-user/.openclaw/workspace-acme/";
    const eaccErr = new Error(
      "EACCES: permission denied, access '/home/example-user/.openclaw/workspace-acme/'",
    );
    const deps = makeDeps({
      fsAccess: vi.fn().mockRejectedValue(eaccErr),
    });
    const result = await runFsProbe([path], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    const entry = result.snapshot.get(path);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("degraded");
    expect(entry?.mode).toBe("denied");
    expect(entry?.error).toContain("EACCES: permission denied");
  });

  it("FP-3: lastSuccessAt preserved on degraded transition", async () => {
    const path = "/home/x/";
    const prevSnapshot = new Map<string, FsCapabilitySnapshot>([
      [
        path,
        {
          status: "ready",
          mode: "ro",
          lastProbeAt: "2026-04-25T11:59:00.000Z",
          lastSuccessAt: "2026-04-25T11:59:00.000Z",
        },
      ],
    ]);
    const deps = makeDeps({
      fsAccess: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
    });
    const result = await runFsProbe([path], deps, prevSnapshot);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    const entry = result.snapshot.get(path);
    expect(entry?.status).toBe("degraded");
    // lastSuccessAt preserved verbatim from prevSnapshot
    expect(entry?.lastSuccessAt).toBe("2026-04-25T11:59:00.000Z");
    expect(entry?.lastProbeAt).toBe("2026-04-25T12:00:00.000Z");
  });

  it("FP-4: lastSuccessAt updated on ready", async () => {
    const path = "/home/x/";
    const deps = makeDeps();
    const result = await runFsProbe([path], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    const entry = result.snapshot.get(path);
    expect(entry?.lastSuccessAt).toBe("2026-04-25T12:00:00.000Z");
  });

  it("FP-5: timeout enforcement — fs.access never resolves → degraded with timeout error", async () => {
    vi.useFakeTimers();
    try {
      const path = "/home/hang/";
      const deps = makeDeps({
        fsAccess: vi
          .fn()
          .mockImplementation(() => new Promise<void>(() => undefined)),
      });
      const promise = runFsProbe([path], deps);
      // Advance fake clock past the 5s budget
      await vi.advanceTimersByTimeAsync(FS_PROBE_TIMEOUT_MS + 100);
      const result = await promise;

      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      const entry = result.snapshot.get(path);
      expect(entry?.status).toBe("degraded");
      expect(entry?.error).toContain("timeout after 5000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("FP-6: verbatim ENOENT pass-through", async () => {
    const path = "/missing/path/";
    const enoErr = new Error(
      "ENOENT: no such file or directory, access '/missing/path/'",
    );
    const deps = makeDeps({
      fsAccess: vi.fn().mockRejectedValue(enoErr),
    });
    const result = await runFsProbe([path], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    const entry = result.snapshot.get(path);
    expect(entry?.status).toBe("degraded");
    expect(entry?.error).toContain("ENOENT: no such file");
  });

  it("FP-7: unknown for never-probed — empty paths array → empty snapshot", async () => {
    const deps = makeDeps();
    const result = await runFsProbe([], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.snapshot.size).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("FP-PARALLEL-INDEPENDENCE: one path failure does not block siblings", async () => {
    const fsAccess = vi
      .fn()
      .mockImplementationOnce(async () => undefined) // /a → ready
      .mockImplementationOnce(async () => {
        throw new Error("EACCES: permission denied, access '/b'");
      }) // /b → degraded
      .mockImplementationOnce(async () => undefined); // /c → ready
    const deps = makeDeps({ fsAccess });
    const result = await runFsProbe(["/a", "/b", "/c"], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.snapshot.size).toBe(3);
    expect(result.snapshot.get("/a")?.status).toBe("ready");
    expect(result.snapshot.get("/b")?.status).toBe("degraded");
    expect(result.snapshot.get("/c")?.status).toBe("ready");
  });

  it("FP-IMMUT: returns NEW Map; never mutates prevSnapshot", async () => {
    const prevSnapshot = new Map<string, FsCapabilitySnapshot>([
      [
        "/a",
        {
          status: "ready",
          mode: "ro",
          lastProbeAt: "2026-04-25T11:59:00.000Z",
          lastSuccessAt: "2026-04-25T11:59:00.000Z",
        },
      ],
    ]);
    const beforeSize = prevSnapshot.size;
    const deps = makeDeps();
    const result = await runFsProbe(["/a"], deps, prevSnapshot);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(prevSnapshot.size).toBe(beforeSize);
    expect(Object.is(prevSnapshot, result.snapshot)).toBe(false);

    // Calling twice with same prev → independent results
    const second = await runFsProbe(["/a"], deps, prevSnapshot);
    expect(second.kind).toBe("completed");
    if (second.kind !== "completed") return;
    expect(Object.is(result.snapshot, second.snapshot)).toBe(false);
  });

  it("FP-CANONICAL-RESOLVE: input with `..` resolves to canonical path before probe key", async () => {
    const inputPath = "/home/clawcode/../clawcode/.clawcode/agents/x/";
    const canonical = "/home/clawcode/.clawcode/agents/x/";
    const realpath = vi.fn().mockResolvedValue(canonical);
    const deps = makeDeps({ realpath });
    const result = await runFsProbe([inputPath], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    // Snapshot keyed by canonical, NOT input
    expect(result.snapshot.get(canonical)).toBeDefined();
    expect(result.snapshot.get(inputPath)).toBeUndefined();
  });

  it("FP-CANONICAL-SYMLINK: realpath result (after symlink resolution) is the snapshot key", async () => {
    const inputPath = "/home/clawcode/.clawcode/agents/x/";
    const canonical = "/var/clawcode/agents/x/";
    const realpath = vi.fn().mockResolvedValue(canonical);
    const fsAccess = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ realpath, fsAccess });
    const result = await runFsProbe([inputPath], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.snapshot.get(canonical)).toBeDefined();
    expect(result.snapshot.get(canonical)?.status).toBe("ready");
    // fsAccess should be called against the canonical path
    expect(fsAccess).toHaveBeenCalledWith(canonical, expect.any(Number));
  });

  it("FP-CANONICAL-ENOENT-FALLBACK: realpath ENOENT → fall back to deps.resolve", async () => {
    const inputPath = "/missing/";
    const realpathErr = new Error(
      "ENOENT: no such file or directory, realpath '/missing/'",
    );
    const realpath = vi.fn().mockRejectedValue(realpathErr);
    const resolve = vi.fn().mockReturnValue("/missing/");
    const fsAccess = vi.fn().mockRejectedValue(new Error("ENOENT: no such file"));
    const deps = makeDeps({ realpath, resolve, fsAccess });
    const result = await runFsProbe([inputPath], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    // Snapshot keyed by resolve fallback
    expect(result.snapshot.get("/missing/")).toBeDefined();
    expect(result.snapshot.get("/missing/")?.status).toBe("degraded");
    expect(resolve).toHaveBeenCalled();
  });

  it("FP-VERBATIM-EACCES: Phase 85 TOOL-04 inheritance — exact error string preserved", async () => {
    const sentinel =
      "EACCES: permission denied, access '/home/example-user/.openclaw/workspace-acme/'";
    const deps = makeDeps({
      fsAccess: vi.fn().mockRejectedValue(new Error(sentinel)),
    });
    const result = await runFsProbe(["/home/example-user/.openclaw/workspace-acme/"], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    const entry = result.snapshot.get("/home/example-user/.openclaw/workspace-acme/");
    // Verbatim — the entire sentinel substring must appear
    expect(entry?.error).toContain(sentinel);
  });

  it("FP-NO-LEAK: probe layer does NOT re-inject fileAccess path into error", async () => {
    // fsAccess emits a generic error WITHOUT echoing the sentinel path.
    // The probe must NOT add the path back into snapshot.error.
    const path = "/home/clawcode/SECRET_TOKEN_42/";
    const genericErr = new Error("EACCES: permission denied");
    const deps = makeDeps({
      fsAccess: vi.fn().mockRejectedValue(genericErr),
    });
    const result = await runFsProbe([path], deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    const entry = result.snapshot.get(path);
    expect(entry?.error).not.toContain("SECRET_TOKEN_42");
    expect(entry?.error).toContain("EACCES: permission denied");
  });
});
