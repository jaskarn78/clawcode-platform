/**
 * Phase 999.14 Plan 00 — MCP-10 RED tests for the three new
 * `clawcode threads` subcommands: archive / prune --stale-after /
 * prune --agent.
 *
 * Wave 0 status: 10 tests RED on purpose. The new subcommands are NOT
 * yet registered on `registerThreadsCommand`. Wave 1 Task 3 adds them
 * (and the new daemon IPC methods threads-prune-stale and
 * threads-prune-agent) and turns the tests GREEN.
 *
 * Operator-pain regression coverage (load-bearing):
 *   - Test 3: archive against a Discord 50001/10003 thread MUST exit 0
 *     ("Discord thread already gone; registry pruned"), NOT throw an
 *     error. This is the escape hatch operators didn't have today.
 *   - Test 4: archive against a transient 5xx MUST exit 0 with a
 *     retry-later message, NOT a hard failure.
 *
 * Avoids name collision with src/cli/commands/threads.test.ts (the
 * existing formatter unit tests). This file is the SUBCOMMAND tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

// Mock IPC + output + prompt before the threads.ts import so the
// `registerThreadsCommand` hookup uses the mocks.
const { sendIpcRequestMock } = vi.hoisted(() => ({
  sendIpcRequestMock: vi.fn(),
}));
vi.mock("../../../ipc/client.js", () => ({
  sendIpcRequest: sendIpcRequestMock,
}));

const { cliLogMock, cliErrorMock } = vi.hoisted(() => ({
  cliLogMock: vi.fn(),
  cliErrorMock: vi.fn(),
}));
vi.mock("../../output.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../output.js")>("../../output.js");
  return {
    ...actual,
    cliLog: cliLogMock,
    cliError: cliErrorMock,
  };
});

const { confirmPromptMock } = vi.hoisted(() => ({
  confirmPromptMock: vi.fn(),
}));
vi.mock("../../prompts.js", () => ({
  confirmPrompt: confirmPromptMock,
}));

import { ManagerNotRunningError } from "../../../shared/errors.js";
import { registerThreadsCommand } from "../threads.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // Throw on .exit instead of process.exit
  registerThreadsCommand(program);
  return program;
}

const exitSpy = vi
  .spyOn(process, "exit")
  // Throw to abort the action so we observe the exit code in tests.
  .mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code ?? 0}__`);
  }) as never);

async function runCli(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    // `from: 'user'` means argv is the raw subcommand list (no node/script
    // prefix). Commander parses these as the subcommand chain.
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (err) {
    const m = String((err as Error).message).match(/^__exit_(\d+)__$/);
    if (m) return Number(m[1]);
    throw err;
  }
}

beforeEach(() => {
  sendIpcRequestMock.mockReset();
  cliLogMock.mockReset();
  cliErrorMock.mockReset();
  confirmPromptMock.mockReset();
  exitSpy.mockClear();
});

describe("clawcode threads archive (MCP-10)", () => {
  it("Test 1: archive <id> success path — registry pruned, exit 0", async () => {
    sendIpcRequestMock.mockResolvedValue({
      ok: true,
      archived: true,
      bindingPruned: true,
      classification: "success",
    });

    const code = await runCli(["threads", "archive", "thread-abc"]);

    expect(code).toBe(0);
    expect(sendIpcRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      "archive-discord-thread",
      expect.objectContaining({ threadId: "thread-abc" }),
    );
    const out = cliLogMock.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/Archived thread-abc/);
    expect(out).toMatch(/registry pruned/);
  });

  it("Test 2: archive <id> --lock — IPC params include lock:true", async () => {
    sendIpcRequestMock.mockResolvedValue({
      ok: true,
      archived: true,
      bindingPruned: true,
      classification: "success",
    });

    await runCli(["threads", "archive", "thread-abc", "--lock"]);

    expect(sendIpcRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      "archive-discord-thread",
      expect.objectContaining({ threadId: "thread-abc", lock: true }),
    );
  });

  it("Test 3 (operator-pain regression): archive on Discord 50001 — exit 0 with friendly message", async () => {
    // Daemon now returns success-with-classification on 50001/10003 paths
    // (Wave 1 swaps in cleanupThreadWithClassifier under the IPC handler).
    sendIpcRequestMock.mockResolvedValue({
      ok: true,
      archived: false,
      bindingPruned: true,
      classification: "prune",
    });

    const code = await runCli(["threads", "archive", "thread-abc"]);

    expect(code).toBe(0);
    const out = cliLogMock.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/Discord thread already gone/i);
    expect(out).toMatch(/registry pruned/i);
  });

  it("Test 4: archive on transient 5xx — exit 0 with retry-later message", async () => {
    sendIpcRequestMock.mockResolvedValue({
      ok: true,
      archived: false,
      bindingPruned: false,
      classification: "retain",
    });

    const code = await runCli(["threads", "archive", "thread-abc"]);

    expect(code).toBe(0);
    const out = cliLogMock.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/Transient Discord error/i);
    expect(out).toMatch(/retained|sweep/i);
  });
});

describe("clawcode threads prune --stale-after (MCP-10)", () => {
  it("Test 5: --stale-after 24h — IPC threads-prune-stale, summary printed", async () => {
    sendIpcRequestMock.mockResolvedValue({
      staleCount: 5,
      prunedCount: 5,
      agents: { "fin-client": 3, "fin-test": 2 },
    });

    const code = await runCli(["threads", "prune", "--stale-after", "24h"]);

    expect(code).toBe(0);
    expect(sendIpcRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      "threads-prune-stale",
      expect.objectContaining({ staleAfter: "24h" }),
    );
    const out = cliLogMock.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/5 stale binding/i);
    expect(out).toMatch(/fin-client/);
    expect(out).toMatch(/fin-test/);
  });

  it("Test 6: --stale-after 6h — IPC carries staleAfter:'6h'", async () => {
    sendIpcRequestMock.mockResolvedValue({
      staleCount: 1,
      prunedCount: 1,
      agents: { "fin-client": 1 },
    });

    await runCli(["threads", "prune", "--stale-after", "6h"]);

    expect(sendIpcRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      "threads-prune-stale",
      expect.objectContaining({ staleAfter: "6h" }),
    );
  });
});

describe("clawcode threads prune --agent (MCP-10)", () => {
  it("Test 7: prune --agent without --yes, user types 'n' — aborts, no IPC", async () => {
    confirmPromptMock.mockResolvedValue(false);

    const code = await runCli(["threads", "prune", "--agent", "fin-client"]);

    expect(code).toBe(0);
    expect(confirmPromptMock).toHaveBeenCalled();
    expect(sendIpcRequestMock).not.toHaveBeenCalled();
    const out = cliLogMock.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/Aborted/i);
  });

  it("Test 8: prune --agent --yes — prompt skipped, IPC sent, summary printed", async () => {
    sendIpcRequestMock.mockResolvedValue({ prunedCount: 3 });

    const code = await runCli([
      "threads",
      "prune",
      "--agent",
      "fin-client",
      "--yes",
    ]);

    expect(code).toBe(0);
    expect(confirmPromptMock).not.toHaveBeenCalled();
    expect(sendIpcRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      "threads-prune-agent",
      expect.objectContaining({ agent: "fin-client" }),
    );
    const out = cliLogMock.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/Pruned 3 binding/i);
    expect(out).toMatch(/fin-client/);
  });

  it("Test 9: prune --agent (no --yes), user types 'y' — IPC sent", async () => {
    confirmPromptMock.mockResolvedValue(true);
    sendIpcRequestMock.mockResolvedValue({ prunedCount: 2 });

    const code = await runCli(["threads", "prune", "--agent", "fin-client"]);

    expect(code).toBe(0);
    expect(confirmPromptMock).toHaveBeenCalled();
    expect(sendIpcRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      "threads-prune-agent",
      expect.objectContaining({ agent: "fin-client" }),
    );
  });
});

describe("clawcode threads prune error handling (MCP-10)", () => {
  it("Test 10: ManagerNotRunningError — exits 1 with message", async () => {
    // ManagerNotRunningError ctor takes no args (message is hard-coded);
    // pass nothing — the prior fixture passed an unused string.
    sendIpcRequestMock.mockRejectedValue(new ManagerNotRunningError());

    const code = await runCli([
      "threads",
      "prune",
      "--agent",
      "fin-client",
      "--yes",
    ]);

    expect(code).toBe(1);
    const err = cliErrorMock.mock.calls.map((c) => String(c[0])).join("\n");
    expect(err).toMatch(/Manager is not running/i);
  });
});
