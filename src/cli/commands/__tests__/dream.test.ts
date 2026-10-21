/**
 * Phase 95 Plan 03 Task 1 (RED) — `clawcode dream <agent>` CLI tests.
 *
 * Mirrors the Phase 92 cutover-verify-cli.test.ts pattern: hermetic IPC stub
 * via DI hook, stdout/stderr capture via spy, exit-code returned from action.
 *
 * Pins:
 *   CLI1: no flags → IPC params {agent, force:false, idleBypass:false,
 *         modelOverride:undefined}; stdout = JSON.stringify(response, null, 2);
 *         exit code 0 on outcome.kind='completed'
 *   CLI2: --idle-bypass → idleBypass:true in IPC params
 *   CLI3: --force --model sonnet → force:true, modelOverride:'sonnet'
 *   CLI4: --model gpt4 → REJECTED at commander parse layer; exit != 0
 *   CLI5: outcome.kind='failed' → exit 1; stderr contains error
 *   CLI6: outcome.kind='skipped' → exit 2; stderr contains skip reason
 *   CLI7: missing agent argument → commander emits usage error; exit != 0
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";

import {
  registerDreamCommand,
  runDreamAction,
  type RunDreamActionArgs,
  type RunDreamPassIpcResponse,
} from "../dream.js";

// vitest 4 narrows `.mock.calls` to the inferred parameter tuple. Pin the
// mock to the exact `sendIpc` signature so `calls[i]` reads as `[method,
// params]` instead of `[]`. NonNullable peels off the optional wrapper on
// RunDreamActionArgs.sendIpc.
type SendIpcFn = NonNullable<RunDreamActionArgs["sendIpc"]>;

function completedResponse(): RunDreamPassIpcResponse {
  return {
    agent: "fin-client",
    startedAt: "2026-04-25T12:00:00Z",
    outcome: {
      kind: "completed",
      result: {
        newWikilinks: [],
        promotionCandidates: [],
        themedReflection: "stub",
        suggestedConsolidations: [],
      },
      durationMs: 1234,
      tokensIn: 100,
      tokensOut: 50,
      model: "haiku",
    },
    applied: {
      kind: "applied",
      appliedWikilinkCount: 0,
      surfacedPromotionCount: 0,
      surfacedConsolidationCount: 0,
      logPath: "/tmp/dreams/2026-04-25.md",
    },
  };
}

describe("clawcode dream — Phase 95 Plan 03 (CLI1-CLI7)", () => {
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

  it("CLI1: no flags → IPC params have idleBypass:false, force:false, modelOverride:undefined; exits 0 on completed", async () => {
    const sendIpc = vi.fn<SendIpcFn>(async () => completedResponse());

    const args: RunDreamActionArgs = {
      agent: "fin-client",
      sendIpc,
    };
    const code = await runDreamAction(args);

    expect(sendIpc).toHaveBeenCalledTimes(1);
    const call = sendIpc.mock.calls[0]!;
    expect(call[0]).toBe("run-dream-pass");
    expect(call[1]).toMatchObject({
      agent: "fin-client",
      force: false,
      idleBypass: false,
    });
    expect(call[1].modelOverride).toBeUndefined();
    expect(code).toBe(0);
    const stdoutAll = stdoutCapture.join("");
    expect(stdoutAll).toContain('"kind": "completed"');
  });

  it("CLI2: --idle-bypass → idleBypass:true in IPC params", async () => {
    const sendIpc = vi.fn<SendIpcFn>(async () => completedResponse());

    await runDreamAction({
      agent: "fin-client",
      idleBypass: true,
      sendIpc,
    });

    const call = sendIpc.mock.calls[0]!;
    expect(call[1].idleBypass).toBe(true);
  });

  it("CLI3: --force --model sonnet → force:true, modelOverride:'sonnet'", async () => {
    const sendIpc = vi.fn<SendIpcFn>(async () => completedResponse());

    await runDreamAction({
      agent: "fin-client",
      force: true,
      model: "sonnet",
      sendIpc,
    });

    const call = sendIpc.mock.calls[0]!;
    expect(call[1].force).toBe(true);
    expect(call[1].modelOverride).toBe("sonnet");
  });

  it("CLI4: --model gpt4 → REJECTED at commander parse layer", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    registerDreamCommand(program);

    let threw = false;
    try {
      await program.parseAsync(
        ["dream", "fin-client", "--model", "gpt4"],
        { from: "user" } as never,
      );
    } catch (err) {
      threw = true;
      // commander throws CommanderError on validation failure
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg.toLowerCase()).toMatch(/haiku|sonnet|opus|model|invalid/);
    }
    expect(threw).toBe(true);
  });

  it("CLI5: outcome.kind='failed' → exit 1, stderr contains error", async () => {
    const sendIpc = vi.fn<SendIpcFn>(async () => ({
      agent: "fin-client",
      startedAt: "2026-04-25T12:00:00Z",
      outcome: { kind: "failed" as const, error: "dispatch boom" },
      applied: {
        kind: "skipped" as const,
        reason: "no-completed-result" as const,
      },
    }));

    const code = await runDreamAction({
      agent: "fin-client",
      sendIpc,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toContain("dispatch boom");
  });

  it("CLI6: outcome.kind='skipped' → exit 2, stderr contains skip reason", async () => {
    const sendIpc = vi.fn<SendIpcFn>(async () => ({
      agent: "fin-client",
      startedAt: "2026-04-25T12:00:00Z",
      outcome: { kind: "skipped" as const, reason: "disabled" as const },
      applied: {
        kind: "skipped" as const,
        reason: "no-completed-result" as const,
      },
    }));

    const code = await runDreamAction({
      agent: "fin-client",
      sendIpc,
    });

    expect(code).toBe(2);
    expect(stderrCapture.join("")).toContain("disabled");
  });

  it("CLI7: missing agent argument → commander emits usage error", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    registerDreamCommand(program);

    let threw = false;
    try {
      await program.parseAsync(["dream"], {
        from: "user",
      } as never);
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg.toLowerCase()).toMatch(/missing|argument|agent/);
    }
    expect(threw).toBe(true);
  });
});
