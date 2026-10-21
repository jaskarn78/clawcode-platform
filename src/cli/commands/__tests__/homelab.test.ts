// src/cli/commands/__tests__/homelab.test.ts
//
// Phase 999.47 Plan 02 Task 3 — `clawcode homelab` CLI tests.
//
// Tests the pure runner functions (runHomelabReindex / runHomelabRefresh)
// rather than the commander action wrappers, because the action wrappers
// call process.exit() and are hard to test in-process. The pure runners
// carry every meaningful behavior — exit-code mapping happens in a
// separate function under test by inspection of the runner result.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runHomelabReindex,
  runHomelabRefresh,
  __setIpcSenderForTests,
  __setRegistryReaderForTests,
  __setRefreshRunnerForTests,
  __setWorkspaceResolverForTests,
} from "../homelab.js";
import { logger } from "../../../shared/logger.js";

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

// Minimal RegistryEntry-compatible shape for tests; cast through unknown
// because tests only need `name` plus enough scaffolding for the runner
// to iterate. Other RegistryEntry fields are not consumed by the runner.
function makeRegistry(names: readonly string[]): {
  readonly entries: readonly { readonly name: string }[];
} {
  return {
    entries: names.map((n) => ({ name: n })),
  };
}

beforeEach(() => {
  infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger as never);
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
  // Deterministic default: no workspaces resolved → legacy direct-path
  // ingest. Individual tests override with a populated map to exercise
  // the T-101-08 workspace-staging path.
  __setWorkspaceResolverForTests(async () => new Map());
});

afterEach(() => {
  __setIpcSenderForTests(null);
  __setRegistryReaderForTests(null);
  __setRefreshRunnerForTests(null);
  __setWorkspaceResolverForTests(null);
  infoSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("clawcode homelab reindex", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "homelab-cli-"));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("Test 1: happy path — 3 agents × 3 files = 9 IPC calls, exit code 0 mapping", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true });
    __setIpcSenderForTests(sender);
    __setRegistryReaderForTests(async () =>
      makeRegistry(["agent-a", "agent-b", "agent-c"]),
    );

    const result = await runHomelabReindex({ repoPath });
    expect(sender).toHaveBeenCalledTimes(9);
    expect(result.totalAgents).toBe(3);
    expect(result.totalFiles).toBe(9);
    expect(result.succeeded).toBe(9);
    expect(result.failed).toBe(0);

    // Verify the IPC method + params shape on the first call.
    const firstCall = sender.mock.calls[0];
    expect(firstCall[1]).toBe("ingest-document");
    const params = firstCall[2] as Record<string, unknown>;
    expect(typeof params.agent).toBe("string");
    expect(typeof params.file_path).toBe("string");
    expect(typeof params.source).toBe("string");

    // phase999.47-homelab-reindex log line fires exactly once with totals.
    const reindexLogs = infoSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-reindex",
    );
    expect(reindexLogs).toHaveLength(1);
    const payload = reindexLogs[0][0] as Record<string, unknown>;
    expect(payload.totalAgents).toBe(3);
    expect(payload.succeeded).toBe(9);
    expect(payload.failed).toBe(0);
  });

  it("Test 2: one agent's IPC fails — other agents continue, succeeded > 0, failed > 0", async () => {
    const sender = vi.fn().mockImplementation(
      async (_socket: string, _method: string, params: Record<string, unknown>) => {
        if ((params.agent as string) === "agent-b") {
          throw new Error("IPC timeout");
        }
        return { ok: true };
      },
    );
    __setIpcSenderForTests(sender);
    __setRegistryReaderForTests(async () =>
      makeRegistry(["agent-a", "agent-b", "agent-c"]),
    );

    const result = await runHomelabReindex({ repoPath });
    expect(result.totalAgents).toBe(3);
    expect(result.failed).toBe(3); // agent-b × 3 files
    expect(result.succeeded).toBe(6); // 2 agents × 3 files
    const failedAgent = result.perAgent.find((a) => a.agent === "agent-b");
    expect(failedAgent?.failed).toBe(3);
    expect(failedAgent?.errors[0].error).toMatch(/IPC timeout/);
  });

  it("Test 3: all agents fail — result captures total failures", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("daemon down"));
    __setIpcSenderForTests(sender);
    __setRegistryReaderForTests(async () =>
      makeRegistry(["agent-a", "agent-b"]),
    );

    const result = await runHomelabReindex({ repoPath });
    expect(result.totalAgents).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(6);

    const reindexLogs = infoSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-reindex",
    );
    expect(reindexLogs).toHaveLength(1);
    const payload = reindexLogs[0][0] as Record<string, unknown>;
    expect(payload.succeeded).toBe(0);
    expect(payload.failed).toBe(6);
  });

  it("Test 4: missing repo path — throws ENOENT", async () => {
    await expect(
      runHomelabReindex({ repoPath: "/nonexistent/path/xxx" }),
    ).rejects.toMatchObject({
      code: "ENOENT",
      message: expect.stringContaining("homelab repo not found"),
    });
  });

  it("Test 5: empty fleet — exits with totalAgents=0 + warn log, no IPC calls", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true });
    __setIpcSenderForTests(sender);
    __setRegistryReaderForTests(async () => makeRegistry([]));

    const result = await runHomelabReindex({ repoPath });
    expect(result.totalAgents).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(sender).not.toHaveBeenCalled();

    const warns = warnSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-reindex",
    );
    expect(warns).toHaveLength(1);
  });

  it("Test 6: T-101-08 staging — copies canonical files into <workspace>/homelab/ and ingests the local copy", async () => {
    const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
    for (const f of ["INVENTORY.md", "NETWORK.md", "ACCESS.md"]) {
      writeFileSync(join(repoPath, f), `# ${f} content\n`);
    }
    const workspace = mkdtempSync(join(tmpdir(), "homelab-ws-"));
    try {
      const sender = vi.fn().mockResolvedValue({ ok: true });
      __setIpcSenderForTests(sender);
      __setRegistryReaderForTests(async () => makeRegistry(["agent-a"]));
      __setWorkspaceResolverForTests(
        async () => new Map([["agent-a", workspace]]),
      );

      const result = await runHomelabReindex({ repoPath });
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);

      // Every IPC call carries the WORKSPACE-LOCAL path, never the shared
      // repo path (which the daemon's T-101-08 guard would refuse).
      for (const call of sender.mock.calls) {
        const params = call[2] as Record<string, unknown>;
        expect(params.file_path as string).toContain(join(workspace, "homelab"));
        expect(params.file_path as string).not.toContain(repoPath);
      }
      // The staged copy really exists on disk with the source content.
      expect(existsSync(join(workspace, "homelab", "INVENTORY.md"))).toBe(true);
      expect(readFileSync(join(workspace, "homelab", "INVENTORY.md"), "utf-8")).toBe(
        "# INVENTORY.md content\n",
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("Test 7: staging copy failure — counted as failed with error captured, IPC not fired for that file", async () => {
    // Canonical files intentionally NOT created in repoPath → copyFile
    // throws ENOENT for every file of the workspace-staged agent.
    const workspace = mkdtempSync(join(tmpdir(), "homelab-ws-"));
    try {
      const sender = vi.fn().mockResolvedValue({ ok: true });
      __setIpcSenderForTests(sender);
      __setRegistryReaderForTests(async () => makeRegistry(["agent-a"]));
      __setWorkspaceResolverForTests(
        async () => new Map([["agent-a", workspace]]),
      );

      const result = await runHomelabReindex({ repoPath });
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(3);
      expect(sender).not.toHaveBeenCalled();
      const agentRow = result.perAgent.find((a) => a.agent === "agent-a");
      expect(agentRow?.errors[0].error).toMatch(/ENOENT/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("uses ingest-document IPC (NOT a new method) — wire-shape contract pin", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true });
    __setIpcSenderForTests(sender);
    __setRegistryReaderForTests(async () => makeRegistry(["agent-a"]));

    await runHomelabReindex({ repoPath });
    for (const call of sender.mock.calls) {
      expect(call[1]).toBe("ingest-document");
    }
  });

  it("uses INVENTORY.md / NETWORK.md / ACCESS.md sources", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true });
    __setIpcSenderForTests(sender);
    __setRegistryReaderForTests(async () => makeRegistry(["agent-a"]));

    await runHomelabReindex({ repoPath });
    const sources = sender.mock.calls.map(
      (call) => (call[2] as Record<string, string>).source,
    );
    expect(sources).toEqual(
      expect.arrayContaining(["INVENTORY.md", "NETWORK.md", "ACCESS.md"]),
    );
  });
});

describe("clawcode homelab refresh (operator escape hatch)", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "homelab-cli-refresh-"));
    mkdirSync(join(repoPath, "scripts"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("Test 7: runs the refresh runner once and surfaces stdout/stderr/exitCode", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: "refresh output",
      stderr: "",
      exitCode: 0,
    });
    __setRefreshRunnerForTests(runner);

    const result = await runHomelabRefresh({ repoPath });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(repoPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("refresh output");
  });

  it("Test 4b: missing repo path on refresh — throws ENOENT", async () => {
    await expect(
      runHomelabRefresh({ repoPath: "/nonexistent/path/xxx" }),
    ).rejects.toMatchObject({
      code: "ENOENT",
      message: expect.stringContaining("homelab repo not found"),
    });
  });

  it("surfaces non-zero exit code from the refresh script", async () => {
    __setRefreshRunnerForTests(
      vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "tailscale CLI not found",
        exitCode: 1,
      }),
    );
    const result = await runHomelabRefresh({ repoPath });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/tailscale/);
  });
});
