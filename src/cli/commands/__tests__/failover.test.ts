/**
 * Phase 138 Plan 05 T-06 — `clawcode failover` CLI tests.
 *
 * Registers the command on a fresh commander `Command`, injects a stub
 * IPC sender, and parses argv — asserting each subcommand sends the
 * correct IPC method + params shape and renders the response.
 *
 * See:
 *   - `src/cli/commands/failover.ts`
 *   - `src/cli/commands/__tests__/homelab.test.ts` — the test template
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import {
  registerFailoverCommand,
  __setIpcSenderForTests,
} from "../failover.js";

/** Parse argv against a fresh Command with the failover command wired. */
async function run(argv: readonly string[]): Promise<void> {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on commander errors
  registerFailoverCommand(program);
  await program.parseAsync(["node", "clawcode", ...argv]);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // cliLog / cliError write through process.stdout/stderr — capture so
  // the assertions can inspect rendered output without polluting test
  // stdout. `as never` widens the mock's return shape to `write`'s.
  logSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((() => true) as never);
  errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as never);
});

afterEach(() => {
  __setIpcSenderForTests(null);
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("clawcode failover status", () => {
  it("sends failover-status with no agent param when none given", async () => {
    const sender = vi.fn().mockResolvedValue({ rows: [] });
    __setIpcSenderForTests(sender);
    await run(["failover", "status"]);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][1]).toBe("failover-status");
    expect(sender.mock.calls[0][2]).toEqual({});
  });

  it("scopes failover-status to one agent when <agent> given", async () => {
    const sender = vi.fn().mockResolvedValue({ rows: [] });
    __setIpcSenderForTests(sender);
    await run(["failover", "status", "clawdy"]);
    expect(sender.mock.calls[0][2]).toEqual({ agent: "clawdy" });
  });

  it("renders the active override rows in the table output", async () => {
    const sender = vi.fn().mockResolvedValue({
      rows: [
        {
          agent: "clawdy",
          active_backend: "codex-cli",
          reason: "threshold-95",
          triggered_at: Date.UTC(2026, 4, 20, 12, 0, 0),
          expires_at: Date.UTC(2026, 4, 21, 0, 0, 0),
        },
      ],
    });
    __setIpcSenderForTests(sender);
    await run(["failover", "status"]);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toContain("clawdy");
    expect(printed).toContain("codex-cli");
    expect(printed).toContain("threshold-95");
  });

  it("--json emits the raw response", async () => {
    const sender = vi.fn().mockResolvedValue({ rows: [] });
    __setIpcSenderForTests(sender);
    await run(["failover", "status", "--json"]);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toContain('"rows"');
  });
});

describe("clawcode failover reset", () => {
  it("sends failover-reset with the agent name", async () => {
    const sender = vi
      .fn()
      .mockResolvedValue({ ok: true, agent: "clawdy", action: "reset" });
    __setIpcSenderForTests(sender);
    await run(["failover", "reset", "clawdy"]);
    expect(sender.mock.calls[0][1]).toBe("failover-reset");
    expect(sender.mock.calls[0][2]).toEqual({ agent: "clawdy" });
  });
});

describe("clawcode failover set", () => {
  it("sends failover-set with agent + backend for a valid backend", async () => {
    const sender = vi.fn().mockResolvedValue({
      ok: true,
      agent: "clawdy",
      action: "set",
      backend: "codex-cli",
    });
    __setIpcSenderForTests(sender);
    await run(["failover", "set", "clawdy", "codex-cli"]);
    expect(sender.mock.calls[0][1]).toBe("failover-set");
    expect(sender.mock.calls[0][2]).toEqual({
      agent: "clawdy",
      backend: "codex-cli",
    });
  });

  it("REJECTS portable-fork at CLI parse time — no IPC sent", async () => {
    const sender = vi.fn();
    __setIpcSenderForTests(sender);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
    await expect(
      run(["failover", "set", "clawdy", "portable-fork"]),
    ).rejects.toThrow("process.exit called");
    expect(sender).not.toHaveBeenCalled();
    const printed = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toContain("Invalid backend 'portable-fork'");
    exitSpy.mockRestore();
  });

  it("REJECTS an arbitrary bogus backend at CLI parse time", async () => {
    const sender = vi.fn();
    __setIpcSenderForTests(sender);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
    await expect(
      run(["failover", "set", "clawdy", "openrouter"]),
    ).rejects.toThrow("process.exit called");
    expect(sender).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
