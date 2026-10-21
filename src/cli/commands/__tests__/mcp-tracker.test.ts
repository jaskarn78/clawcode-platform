/**
 * Phase 999.15 Plan 00 — Wave 0 RED tests for `clawcode mcp-tracker` CLI.
 *
 * Module under test: ../mcp-tracker.js (DOES NOT EXIST AT WAVE 0).
 * GREEN ships in Plan 03 (TRACK-05 implementation).
 *
 * Locked decisions pinned here:
 *   - Subcommand name is `mcp-tracker` NOT `mcp-status` — Phase 85 already
 *     owns mcp-status (per-server readiness, see src/cli/commands/mcp-status.ts).
 *     Orchestrator recommendation #1.
 *   - Read-only — does not mutate tracker state. Pure inspection.
 *   - Returns non-zero exit code if any agent has 0/N MCP procs alive.
 *   - Calls IPC method `mcp-tracker-snapshot` (added in Plan 03).
 *   - `-a <agent>` filter expands cmdlines verbosely.
 *
 * The CLI module ships in Plan 03; at Wave 0 every test fails on
 * Cannot-find-module errors at the dynamic import line. RED.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

// IPC + output mocks (mirror threads.test.ts pattern)
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

vi.mock("../../../manager/daemon.js", () => ({
  SOCKET_PATH: "/tmp/test-socket.sock",
}));

const exitSpy = vi
  .spyOn(process, "exit")
  .mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code ?? 0}__`);
  }) as never);

async function runCli(argv: readonly string[]): Promise<number> {
  // Wave 0 history: this dynamic import was @ts-expect-error'd because
  // ../mcp-tracker.ts didn't ship until Plan 03 (TRACK-05). Module is now
  // present — directive removed.
  const { registerMcpTrackerCommand } = await import("../mcp-tracker.js");
  const program = new Command();
  program.exitOverride();
  registerMcpTrackerCommand(program);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (err) {
    const m = String((err as Error).message).match(/^__exit_(\d+)__$/);
    if (m) return Number(m[1]);
    throw err;
  }
}

const FIXTURE_TWO_AGENTS_ALL_HEALTHY = {
  agents: [
    {
      agent: "fin-client",
      claudePid: 4_070_338,
      mcpPids: [4_070_553, 4_070_559, 4_070_570],
      aliveCount: 3,
      totalCount: 3,
      cmdlines: [
        "npx mcp-server-mysql",
        "node finnhub/server.js",
        "npm exec @takescake/1password-mcp",
      ],
      registeredAt: 1_700_000_000_000,
    },
    {
      agent: "research",
      claudePid: 4_068_660,
      mcpPids: [],
      aliveCount: 0,
      totalCount: 0,
      cmdlines: [],
      registeredAt: 1_700_000_001_000,
    },
  ],
};

const FIXTURE_PARTIAL_LIVENESS = {
  agents: [
    {
      agent: "fin-content",
      claudePid: 4_069_209,
      mcpPids: [4_069_300, 4_069_301, 4_069_302, 4_069_303,
                4_069_304, 4_069_305, 4_069_306, 4_069_307],
      aliveCount: 2,
      totalCount: 8,
      cmdlines: ["npx mcp-server-mysql", "node finnhub/server.js"],
      registeredAt: 1_700_000_002_000,
    },
  ],
};

describe("clawcode mcp-tracker CLI (Phase 999.15 Wave 0 — RED)", () => {
  beforeEach(() => {
    sendIpcRequestMock.mockReset();
    cliLogMock.mockReset();
    cliErrorMock.mockReset();
    exitSpy.mockClear();
  });

  it("CLI-1: formatTrackerTable renders a stable snapshot for the canonical fixture", async () => {
    // Wave 0 directive removed — module ships in Plan 03 (this plan).
    const mod = await import("../mcp-tracker.js");
    const { formatTrackerTable } = mod as {
      formatTrackerTable: (snapshot: unknown) => string;
    };
    expect(typeof formatTrackerTable).toBe("function");
    const out = formatTrackerTable(FIXTURE_TWO_AGENTS_ALL_HEALTHY);
    expect(typeof out).toBe("string");
    // Header columns
    expect(out).toContain("AGENT");
    expect(out).toContain("CLAUDE_PID");
    expect(out).toContain("MCP_ALIVE");
    // Body rows
    expect(out).toContain("fin-client");
    expect(out).toContain("4070338");
    expect(out).toContain("3/3");
    expect(out).toContain("research");
    expect(out).toContain("0/0");
  });

  it("CLI-2: exits 1 when any agent has partial MCP liveness (operator-actionable signal)", async () => {
    sendIpcRequestMock.mockResolvedValue(FIXTURE_PARTIAL_LIVENESS);

    const code = await runCli(["mcp-tracker"]);
    expect(code).toBe(1);
    expect(sendIpcRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      "mcp-tracker-snapshot",
      expect.any(Object),
    );
  });

  it("CLI-3: exits 2 when daemon is not running (ECONNREFUSED → friendly message)", async () => {
    sendIpcRequestMock.mockImplementation(async () => {
      const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      throw err;
    });

    const code = await runCli(["mcp-tracker"]);
    expect(code).toBe(2);
    expect(cliErrorMock).toHaveBeenCalled();
  });

  it("CLI-4: subcommand registered as 'mcp-tracker' (NOT 'mcp-status' — Phase 85 collision)", async () => {
    // Wave 0 directive removed — module ships in Plan 03 (this plan).
    const { registerMcpTrackerCommand } = await import("../mcp-tracker.js");
    const program = new Command();
    program.exitOverride();
    registerMcpTrackerCommand(program);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain("mcp-tracker");
    // The Phase 85 mcp-status command is NOT registered by mcp-tracker.ts
    // (it lives in src/cli/commands/mcp-status.ts and its own register fn).
    expect(names).not.toContain("mcp-status");
  });

  it("CLI-5: -a <agent> filter renders verbose mode with cmdlines expanded", async () => {
    sendIpcRequestMock.mockResolvedValue({
      agents: [FIXTURE_TWO_AGENTS_ALL_HEALTHY.agents[0]!],
    });

    const code = await runCli(["mcp-tracker", "-a", "fin-client"]);
    expect(code).toBe(0);

    const lastArgs = sendIpcRequestMock.mock.calls.at(-1);
    expect(lastArgs).toBeDefined();
    expect(lastArgs![1]).toBe("mcp-tracker-snapshot");
    // Filter param flows through to IPC payload
    expect(lastArgs![2]).toMatchObject({ agent: "fin-client" });

    // Verbose output should include each cmdline on its own line.
    const printed = cliLogMock.mock.calls.flat().join("\n");
    for (const cmdline of FIXTURE_TWO_AGENTS_ALL_HEALTHY.agents[0]!.cmdlines) {
      expect(printed).toContain(cmdline);
    }
  });
});
