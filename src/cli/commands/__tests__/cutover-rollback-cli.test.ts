/**
 * Phase 92 GAP CLOSURE — `clawcode cutover rollback` CLI <-> daemon-IPC tests.
 *
 * Pins the post-gap-closure invariants:
 *   CR1: runCutoverRollbackAction forwards method="cutover-rollback" with
 *        resolved IPC params (agent, ledgerTo, ledgerPath, dryRun).
 *   CR2: On a successful rewind response (errors empty), prints the
 *        rewound row count and exits 0.
 *   CR3: When the daemon returns errors[], the action exits 1 even if some
 *        rows were rewound (any failure means cutover state isn't fully
 *        reversed → operator must investigate before re-attempting).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Logger } from "pino";
import { runCutoverRollbackAction } from "../cutover-rollback.js";

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as Logger;

describe("Phase 92 gap-closure: cutover-rollback CLI <-> daemon IPC", () => {
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

  afterEach(() => {
    writeStdoutSpy.mockRestore();
    writeStderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("CR1: forwards method=cutover-rollback with resolved IPC params", async () => {
    const sendIpc = vi.fn(async () => ({
      rewoundCount: 3,
      errors: [],
    }));

    await runCutoverRollbackAction({
      agent: "fin-client",
      ledgerTo: "2026-04-24T00:00:00Z",
      ledgerPath: "/tmp/cutover-ledger.jsonl",
      dryRun: true,
      log: silentLog,
      sendIpc,
    });

    expect(sendIpc).toHaveBeenCalledTimes(1);
    const call = sendIpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const [method, params] = call;
    expect(method).toBe("cutover-rollback");
    expect(params).toMatchObject({
      agent: "fin-client",
      ledgerTo: "2026-04-24T00:00:00Z",
      ledgerPath: "/tmp/cutover-ledger.jsonl",
      dryRun: true,
    });
  });

  it("CR2: successful rewind (errors=[]) → prints rewound count, exit 0", async () => {
    const sendIpc = vi.fn(async () => ({
      rewoundCount: 5,
      errors: [],
    }));

    const code = await runCutoverRollbackAction({
      agent: "fin-client",
      ledgerTo: "2026-04-24T00:00:00Z",
      log: silentLog,
      sendIpc,
    });

    expect(code).toBe(0);
    const stdoutAll = stdoutCapture.join("");
    // CR2 invariant: rewoundCount surfaces in stdout for the operator.
    expect(stdoutAll).toMatch(/rewoundCount/i);
    expect(stdoutAll).toContain("5");
  });

  it("CR3: errors present → exit 1 even when some rows rewound", async () => {
    const sendIpc = vi.fn(async () => ({
      rewoundCount: 2,
      errors: [
        { row: 4, error: "rsync exit 23: target not writable" },
      ],
    }));

    const code = await runCutoverRollbackAction({
      agent: "fin-client",
      ledgerTo: "2026-04-24T00:00:00Z",
      log: silentLog,
      sendIpc,
    });

    expect(code).toBe(1);
  });
});
