/**
 * Phase 96 Plan 05 PRO- — `clawcode probe-fs <agent>` CLI tests.
 *
 * Mirrors the Phase 95 dream.test.ts + Phase 92 cutover-verify-cli pattern:
 * hermetic IPC stub via DI hook, stdout/stderr capture via spy, exit-code
 * returned from action.
 *
 * Pins:
 *   PRO-HAPPY: deps.sendIpc returns FsProbeOutcome{kind:'completed',
 *     snapshot: 3 entries with mixed statuses, durationMs:120}; CLI outputs
 *     table with 3 rows; status emoji visible per row
 *   PRO-DIFF: --diff flag → outcome.changes populates "Changes since last
 *     probe" rendering ("path: ready → degraded" or similar)
 *   PRO-CONNECTION-FAILURE: deps.sendIpc rejects with ManagerNotRunningError
 *     → CLI prints "daemon" hint and exits non-zero
 *   PRO-AGENT-NOT-RUNNING: deps.sendIpc rejects with `Error("agent not
 *     running")` → CLI prints error + exits non-zero
 *   PRO-IMMUTABILITY: render two times same input → same output (the table
 *     formatter is a pure function of its input)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  formatProbeFsTable,
  runProbeFsAction,
  type FsProbeOutcomeWire,
  type RunProbeFsActionArgs,
} from "../probe-fs.js";

// vitest 4 narrows .mock.calls when the mock's parameters can't be inferred.
// Pin to the action's sendIpc signature.
type SendIpcFn = NonNullable<RunProbeFsActionArgs["sendIpc"]>;
import { ManagerNotRunningError } from "../../../shared/errors.js";

function completedOutcome(): FsProbeOutcomeWire {
  return {
    kind: "completed",
    snapshot: [
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
          status: "ready",
          mode: "ro",
          lastProbeAt: "2026-04-25T20:00:00Z",
          lastSuccessAt: "2026-04-25T20:00:00Z",
        },
      ],
      [
        "/home/example-user/.openclaw/workspace-coding",
        {
          status: "degraded",
          mode: "denied",
          lastProbeAt: "2026-04-25T20:00:00Z",
          error: "EACCES: permission denied",
        },
      ],
    ],
    durationMs: 120,
  };
}

function outcomeWithChanges(): FsProbeOutcomeWire {
  return {
    kind: "completed",
    snapshot: [
      [
        "/home/clawcode/.clawcode/agents/fin-client",
        {
          status: "ready",
          mode: "rw",
          lastProbeAt: "2026-04-25T20:00:00Z",
          lastSuccessAt: "2026-04-25T20:00:00Z",
        },
      ],
    ],
    durationMs: 80,
    changes: [
      {
        path: "/home/example-user/.openclaw/workspace-acme",
        from: "ready",
        to: "degraded",
      },
    ],
  };
}

describe("clawcode probe-fs — Phase 96 Plan 05 (PRO-)", () => {
  let stdoutCapture: string[];
  let stderrCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutCapture = [];
    stderrCapture = [];
    writeStdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stdoutCapture.push(
          typeof chunk === "string" ? chunk : chunk.toString(),
        );
        return true;
      }) as typeof process.stdout.write);
    writeStderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stderrCapture.push(
          typeof chunk === "string" ? chunk : chunk.toString(),
        );
        return true;
      }) as typeof process.stderr.write);
  });

  afterEach(() => {
    writeStdoutSpy.mockRestore();
    writeStderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("PRO-HAPPY: deps.sendIpc returns completed outcome → stdout has 3-row table with status emojis; exit 0", async () => {
    const sendIpc = vi.fn<SendIpcFn>(async () => completedOutcome() as unknown);
    const args: RunProbeFsActionArgs = {
      agent: "fin-client",
      sendIpc,
    };
    const code = await runProbeFsAction(args);

    expect(sendIpc).toHaveBeenCalledTimes(1);
    const call = sendIpc.mock.calls[0]!;
    expect(call[0]).toBe("probe-fs");
    expect((call[1] as { agent: string }).agent).toBe("fin-client");
    expect(code).toBe(0);

    const stdoutAll = stdoutCapture.join("");
    // Each path appears in the output
    expect(stdoutAll).toContain("/home/clawcode/.clawcode/agents/fin-client");
    expect(stdoutAll).toContain("/home/example-user/.openclaw/workspace-acme");
    expect(stdoutAll).toContain("/home/example-user/.openclaw/workspace-coding");
    // Status emojis: ✓ for ready (2 ready), ⚠ for degraded (1)
    expect(stdoutAll).toMatch(/✓|✅/);
    expect(stdoutAll).toMatch(/⚠/);
    expect(stdoutAll).toContain("EACCES: permission denied");
  });

  it("PRO-DIFF: --diff flag → outcome.changes rendered as 'Changes since last probe'", async () => {
    const sendIpc = vi.fn<SendIpcFn>(async () => outcomeWithChanges() as unknown);
    const args: RunProbeFsActionArgs = {
      agent: "fin-client",
      diff: true,
      sendIpc,
    };
    const code = await runProbeFsAction(args);
    expect(code).toBe(0);

    const stdoutAll = stdoutCapture.join("");
    expect(stdoutAll.toLowerCase()).toContain("changes");
    expect(stdoutAll).toContain("workspace-acme");
    expect(stdoutAll.toLowerCase()).toContain("degraded");
  });

  it("PRO-CONNECTION-FAILURE: ManagerNotRunningError → stderr 'daemon'; exit non-zero (ECONNREFUSED equivalent)", async () => {
    const sendIpc = vi.fn<SendIpcFn>(async () => {
      throw new ManagerNotRunningError();
    });
    const args: RunProbeFsActionArgs = {
      agent: "fin-client",
      sendIpc,
    };
    const code = await runProbeFsAction(args);
    expect(code).not.toBe(0);

    const stderrAll = stderrCapture.join("");
    expect(stderrAll.toLowerCase()).toContain("daemon");
  });

  it("PRO-AGENT-NOT-RUNNING: IPC reject with 'agent not running' → stderr error; exit non-zero", async () => {
    const sendIpc = vi.fn<SendIpcFn>(async () => {
      throw new Error("agent not running");
    });
    const args: RunProbeFsActionArgs = {
      agent: "no-such-agent",
      sendIpc,
    };
    const code = await runProbeFsAction(args);
    expect(code).not.toBe(0);

    const stderrAll = stderrCapture.join("");
    expect(stderrAll).toContain("agent not running");
  });

  it("PRO-IMMUTABILITY: formatProbeFsTable is pure — same input → same output across calls", () => {
    const outcome = completedOutcome();
    const a = formatProbeFsTable("fin-client", outcome);
    const b = formatProbeFsTable("fin-client", outcome);
    expect(a).toBe(b);
  });
});
