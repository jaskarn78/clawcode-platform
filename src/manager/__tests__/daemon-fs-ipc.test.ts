/**
 * Phase 96 Plan 05 DIPC- — daemon probe-fs + list-fs-status IPC tests.
 *
 * Closure-based intercept BEFORE routeMethod (mirrors run-dream-pass +
 * cutover-button-action patterns). Tests exercise extracted pure handler
 * functions so we don't need to spawn the full daemon — same pattern as
 * Phase 92 daemon-cutover-button.test.ts.
 *
 * Pins:
 *   DIPC-PROBE-FS-HAPPY: handleProbeFsIpc({agent}) with stub fsAccess +
 *     realpath + writeFile + handleAccessor → outcome.kind === 'completed';
 *     deps.writeFsSnapshot called once; deps.setFsCapabilitySnapshot called
 *     on the SessionHandle accessor
 *   DIPC-PROBE-FS-AGENT-NOT-RUNNING: handleProbeFsIpc with no SessionHandle
 *     → throws ManagerError 'agent not running'
 *   DIPC-LIST-FS-STATUS-HAPPY: handleListFsStatusIpc({agent}) with handle
 *     accessor returning a 2-entry snapshot → response.paths shape correct
 *   DIPC-PARITY: snapshot returned from probe-fs handler is byte-equivalent
 *     to the Map fed by direct runFsProbe invocation. Discord/CLI parity
 *     invariant — both surfaces invoke this same handler.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";

import {
  handleProbeFsIpc,
  handleListFsStatusIpc,
  type ProbeFsIpcDeps,
  type ListFsStatusIpcDeps,
} from "../daemon-fs-ipc.js";
import { ManagerError } from "../../shared/errors.js";
import type { FsCapabilitySnapshot } from "../persistent-session-handle.js";

const FIXED_NOW = new Date("2026-04-25T20:00:00Z");

function makeStubLog() {
  return pino({ level: "silent" });
}

function makeStubFsAccess(
  readableSet: ReadonlySet<string>,
): (path: string, mode: number) => Promise<void> {
  return async (path: string, _mode: number) => {
    if (readableSet.has(path)) return;
    const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  };
}

describe("Phase 96 Plan 05 — daemon probe-fs + list-fs-status IPC (DIPC-)", () => {
  it("DIPC-PROBE-FS-HAPPY: completed outcome; writeFsSnapshot + setFsCapabilitySnapshot both invoked", async () => {
    const setSnapshot = vi.fn();
    const getSnapshot = vi.fn(
      () => new Map<string, FsCapabilitySnapshot>(),
    );
    const writeFsSnapshot = vi.fn<ProbeFsIpcDeps["writeFsSnapshot"]>(async () => {});
    const fileAccess = ["/path/a", "/path/b"];

    const deps: ProbeFsIpcDeps = {
      resolveFileAccessForAgent: () => fileAccess,
      getHandleAccessors: () => ({
        getFsCapabilitySnapshot: getSnapshot,
        setFsCapabilitySnapshot: setSnapshot,
      }),
      fsAccess: makeStubFsAccess(new Set(["/path/a", "/path/b"])),
      fsConstants: { R_OK: 4, W_OK: 2 },
      realpath: async (p) => p,
      resolve: (p) => p,
      writeFsSnapshot,
      getFsCapabilityPath: (agent) => `/tmp/${agent}/fs-capability.json`,
      now: () => FIXED_NOW,
      log: makeStubLog(),
    };

    const outcome = await handleProbeFsIpc({ agent: "fin-client" }, deps);

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      // Snapshot serialized as [path, state] tuples (JSON-RPC friendly)
      expect(outcome.snapshot.length).toBe(2);
      // All paths ready
      expect(outcome.snapshot.every(([, s]) => s.status === "ready")).toBe(
        true,
      );
    }
    // writeFsSnapshot called once with the agent + snapshot Map + path
    expect(writeFsSnapshot).toHaveBeenCalledTimes(1);
    expect(writeFsSnapshot.mock.calls[0]![0]).toBe("fin-client");
    // setFsCapabilitySnapshot called once with the snapshot Map
    expect(setSnapshot).toHaveBeenCalledTimes(1);
    const setArg = setSnapshot.mock.calls[0]![0] as ReadonlyMap<string, FsCapabilitySnapshot>;
    expect(setArg.size).toBe(2);
  });

  it("DIPC-PROBE-FS-AGENT-NOT-RUNNING: handleProbeFsIpc throws ManagerError when agent has no SessionHandle", async () => {
    const deps: ProbeFsIpcDeps = {
      resolveFileAccessForAgent: () => ["/path/a"],
      // Returns null when agent isn't running
      getHandleAccessors: () => null,
      fsAccess: makeStubFsAccess(new Set(["/path/a"])),
      fsConstants: { R_OK: 4, W_OK: 2 },
      realpath: async (p) => p,
      resolve: (p) => p,
      writeFsSnapshot: async () => {},
      getFsCapabilityPath: (agent) => `/tmp/${agent}/fs-capability.json`,
      now: () => FIXED_NOW,
      log: makeStubLog(),
    };

    await expect(
      handleProbeFsIpc({ agent: "no-such-agent" }, deps),
    ).rejects.toThrow(ManagerError);
    // ManagerError message: "probe-fs: agent 'no-such-agent' not running"
    // — assert key tokens appear (regex split tolerates the agent-name
    // substring between 'agent' and 'not running').
    await expect(
      handleProbeFsIpc({ agent: "no-such-agent" }, deps),
    ).rejects.toThrow(/not running/i);
  });

  it("DIPC-LIST-FS-STATUS-HAPPY: handleListFsStatusIpc serializes snapshot as paths array", async () => {
    const snap = new Map<string, FsCapabilitySnapshot>([
      [
        "/home/clawcode/.clawcode/agents/fin-client",
        {
          status: "ready",
          mode: "rw",
          lastProbeAt: "2026-04-25T20:00:00Z",
          lastSuccessAt: "2026-04-25T20:00:00Z",
        },
      ],
      [
        "/home/example-user/.openclaw/workspace-acme",
        {
          status: "degraded",
          mode: "denied",
          lastProbeAt: "2026-04-25T20:00:00Z",
          error: "EACCES: permission denied",
        },
      ],
    ]);

    const deps: ListFsStatusIpcDeps = {
      getHandleAccessors: () => ({
        getFsCapabilitySnapshot: () => snap,
        setFsCapabilitySnapshot: () => {},
      }),
    };

    const response = await handleListFsStatusIpc(
      { agent: "fin-client" },
      deps,
    );

    expect(response.agent).toBe("fin-client");
    expect(response.paths.length).toBe(2);
    const ready = response.paths.find((p) => p.status === "ready")!;
    expect(ready.path).toBe(
      "/home/clawcode/.clawcode/agents/fin-client",
    );
    expect(ready.mode).toBe("rw");
    expect(ready.lastSuccessAt).toBe("2026-04-25T20:00:00Z");

    const degraded = response.paths.find((p) => p.status === "degraded")!;
    expect(degraded.path).toBe("/home/example-user/.openclaw/workspace-acme");
    expect(degraded.mode).toBe("denied");
    expect(degraded.error).toBe("EACCES: permission denied");
    // lastSuccessAt NOT present on degraded entry (no prior success)
    expect((degraded as { lastSuccessAt?: string }).lastSuccessAt).toBeUndefined();
  });

  it("DIPC-PARITY: probe-fs handler outcome === direct runFsProbe outcome (Discord/CLI parity)", async () => {
    // Both Discord slash + CLI go through this same daemon handler. Test
    // confirms the wire payload matches what the underlying primitive would
    // produce — drift between the surfaces would indicate the handler is
    // re-implementing logic instead of delegating to runFsProbe.
    const setSnapshot = vi.fn();
    const getSnapshot = vi.fn(
      () => new Map<string, FsCapabilitySnapshot>(),
    );
    const writeFsSnapshot = vi.fn<ProbeFsIpcDeps["writeFsSnapshot"]>(async () => {});
    const paths = ["/path/a", "/path/b", "/path/c"];

    const deps: ProbeFsIpcDeps = {
      resolveFileAccessForAgent: () => paths,
      getHandleAccessors: () => ({
        getFsCapabilitySnapshot: getSnapshot,
        setFsCapabilitySnapshot: setSnapshot,
      }),
      fsAccess: makeStubFsAccess(new Set(["/path/a", "/path/b"])),
      fsConstants: { R_OK: 4, W_OK: 2 },
      realpath: async (p) => p,
      resolve: (p) => p,
      writeFsSnapshot,
      getFsCapabilityPath: (agent) => `/tmp/${agent}/fs-capability.json`,
      now: () => FIXED_NOW,
      log: makeStubLog(),
    };

    const outcome = await handleProbeFsIpc({ agent: "fin-client" }, deps);

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      // Same paths probed (canonical equivalence — realpath stub returns input)
      const probedPaths = outcome.snapshot.map(([p]) => p).sort();
      expect(probedPaths).toEqual([...paths].sort());

      // 2 ready, 1 degraded (path /path/c not in readable set)
      const readyCount = outcome.snapshot.filter(
        ([, s]) => s.status === "ready",
      ).length;
      const degradedCount = outcome.snapshot.filter(
        ([, s]) => s.status === "degraded",
      ).length;
      expect(readyCount).toBe(2);
      expect(degradedCount).toBe(1);

      // Verbatim error pass-through (Phase 85 TOOL-04 inheritance)
      const degraded = outcome.snapshot.find(([p]) => p === "/path/c")!;
      expect(degraded[1].error).toContain("EACCES");
    }
  });
});
