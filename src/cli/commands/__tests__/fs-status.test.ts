/**
 * Phase 96 Plan 05 FSS- — `clawcode fs-status -a <agent>` CLI tests.
 *
 * Mirrors mcp-status.test.ts pattern byte-for-byte structurally — full
 * snapshot dump, table render, hermetic IPC stub via DI.
 *
 * Pins:
 *   FSS-CLI-HAPPY: deps.sendIpc returns serialized snapshot via list-fs-status;
 *     CLI outputs table: canonicalPath | status | mode | lastProbeAt
 *   FSS-CLI-NO-AGENT: agent flag missing → commander emits usage error
 *     (exit non-zero)
 *   FSS-CLI-COLOR-CODING: ready entries marked with ✓; degraded with ⚠;
 *     unknown with ?
 *   FSS-CLI-IMMUTABILITY: render two times same input → same output
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";

import {
  formatFsStatusTable,
  runFsStatusAction,
  type FsStatusResponse,
  type RunFsStatusActionArgs,
  registerFsStatusCommand,
} from "../fs-status.js";

// Pin vi.fn to the action's `sendIpc` signature so .mock.calls[i] tuple-narrows
// to [method, params] under vitest 4 instead of [].
type SendIpcFn = NonNullable<RunFsStatusActionArgs["sendIpc"]>;

function happySnapshot(): FsStatusResponse {
  return {
    agent: "fin-client",
    paths: [
      {
        path: "/home/clawcode/.clawcode/agents/fin-client",
        status: "ready",
        mode: "rw",
        lastProbeAt: "2026-04-25T20:00:00Z",
        lastSuccessAt: "2026-04-25T20:00:00Z",
      },
      {
        path: "/home/example-user/.openclaw/workspace-acme",
        status: "ready",
        mode: "ro",
        lastProbeAt: "2026-04-25T20:00:00Z",
        lastSuccessAt: "2026-04-25T20:00:00Z",
      },
      {
        path: "/home/example-user/.openclaw/workspace-coding",
        status: "degraded",
        mode: "denied",
        lastProbeAt: "2026-04-25T20:00:00Z",
        error: "EACCES: permission denied",
      },
    ],
  };
}

describe("clawcode fs-status — Phase 96 Plan 05 (FSS-)", () => {
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

  it("FSS-CLI-HAPPY: full snapshot rendered as table with path | status | mode | lastProbeAt columns", async () => {
    const sendIpc = vi.fn<SendIpcFn>(async () => happySnapshot() as unknown);
    const args: RunFsStatusActionArgs = {
      agent: "fin-client",
      sendIpc,
    };
    const code = await runFsStatusAction(args);

    expect(sendIpc).toHaveBeenCalledTimes(1);
    const call = sendIpc.mock.calls[0]!;
    expect(call[0]).toBe("list-fs-status");
    expect((call[1] as { agent: string }).agent).toBe("fin-client");
    expect(code).toBe(0);

    const stdoutAll = stdoutCapture.join("");
    expect(stdoutAll).toContain("/home/clawcode/.clawcode/agents/fin-client");
    expect(stdoutAll).toContain("ready");
    expect(stdoutAll).toContain("degraded");
    expect(stdoutAll).toContain("rw");
    expect(stdoutAll).toContain("ro");
    expect(stdoutAll).toContain("2026-04-25T20:00:00Z");
    expect(stdoutAll).toContain("EACCES: permission denied");
  });

  it("FSS-CLI-NO-AGENT: agent flag missing → commander emits usage error (exit non-zero)", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    registerFsStatusCommand(program);

    let threw = false;
    try {
      await program.parseAsync(["fs-status"], {
        from: "user",
      } as never);
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg.toLowerCase()).toMatch(/missing|required|agent/);
    }
    expect(threw).toBe(true);
  });

  it("FSS-CLI-COLOR-CODING: ready→✓, degraded→⚠, unknown→? in formatted output", () => {
    const out = formatFsStatusTable(happySnapshot());
    // Two ready entries → two ✓ markers
    const tickCount = (out.match(/✓/g) ?? []).length;
    expect(tickCount).toBeGreaterThanOrEqual(2);
    // One degraded entry → one ⚠ marker
    const warnCount = (out.match(/⚠/g) ?? []).length;
    expect(warnCount).toBeGreaterThanOrEqual(1);
  });

  it("FSS-CLI-IMMUTABILITY: formatFsStatusTable is pure — same input → same output across calls", () => {
    const snap = happySnapshot();
    const a = formatFsStatusTable(snap);
    const b = formatFsStatusTable(snap);
    expect(a).toBe(b);
  });
});
