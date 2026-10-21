/**
 * Phase 92 GAP CLOSURE — `clawcode cutover verify` CLI <-> daemon-IPC tests.
 *
 * Pins the post-gap-closure invariants:
 *   CV1: runCutoverVerifyAction calls the IPC client with method
 *        "cutover-verify" and forwards the resolved args (agent, applyAdditive,
 *        outputDir, depthMsgs) as IPC params.
 *   CV2: On cutoverReady=true response, the action prints
 *        `Cutover ready: true` to stdout and exits 0.
 *   CV3: On cutoverReady=false response, the action prints
 *        `Cutover ready: false` and exits 1 (gaps remain → operator
 *        cannot flip authoritative).
 *
 * All tests inject a stub IPC sender via the new `sendIpc` DI hook so we
 * never touch a real Unix socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Logger } from "pino";
import { runCutoverVerifyAction } from "../cutover-verify.js";

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as Logger;

describe("Phase 92 gap-closure: cutover-verify CLI <-> daemon IPC", () => {
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

  it("CV1: forwards method=cutover-verify with the resolved IPC params", async () => {
    const sendIpc = vi.fn(async () => ({
      cutoverReady: true,
      gapCount: 0,
      canaryPassRate: 100,
      reportPath: "/tmp/CUTOVER-REPORT.md",
    }));

    await runCutoverVerifyAction({
      agent: "fin-client",
      applyAdditive: true,
      outputDir: "/tmp/out",
      depthMsgs: 500,
      log: silentLog,
      sendIpc,
    });

    expect(sendIpc).toHaveBeenCalledTimes(1);
    const call = sendIpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const [method, params] = call;
    expect(method).toBe("cutover-verify");
    expect(params).toMatchObject({
      agent: "fin-client",
      applyAdditive: true,
      outputDir: "/tmp/out",
      depthMsgs: 500,
    });
  });

  it("CV2: cutoverReady=true → prints 'Cutover ready: true' on stdout, exit 0", async () => {
    const sendIpc = vi.fn(async () => ({
      cutoverReady: true,
      gapCount: 0,
      canaryPassRate: 100,
      reportPath: "/tmp/CUTOVER-REPORT.md",
    }));

    const code = await runCutoverVerifyAction({
      agent: "fin-client",
      log: silentLog,
      sendIpc,
    });

    expect(code).toBe(0);
    const stdoutAll = stdoutCapture.join("");
    expect(stdoutAll).toContain("Cutover ready: true");
  });

  it("CV3: cutoverReady=false → prints 'Cutover ready: false', exit 1", async () => {
    const sendIpc = vi.fn(async () => ({
      cutoverReady: false,
      gapCount: 7,
      canaryPassRate: 0,
      reportPath: "/tmp/CUTOVER-REPORT.md",
    }));

    const code = await runCutoverVerifyAction({
      agent: "fin-client",
      log: silentLog,
      sendIpc,
    });

    expect(code).toBe(1);
    const stdoutAll = stdoutCapture.join("");
    expect(stdoutAll).toContain("Cutover ready: false");
  });
});
