/**
 * Phase 59 Plan 03 Task 3 -- CLI `clawcode tasks` tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

vi.mock("../../../ipc/client.js", () => ({
  sendIpcRequest: vi.fn(),
}));

// Must import AFTER mock setup
import { sendIpcRequest } from "../../../ipc/client.js";
import { registerTasksCommand } from "../tasks.js";
import { ManagerNotRunningError } from "../../../shared/errors.js";

const mockSendIpc = sendIpcRequest as ReturnType<typeof vi.fn>;

describe("clawcode tasks CLI", () => {
  let program: Command;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerTasksCommand(program);
    mockSendIpc.mockReset();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe("retry", () => {
    it("invokes task-retry IPC with the task_id", async () => {
      mockSendIpc.mockResolvedValue({ task_id: "task:new123" });
      await program.parseAsync(["node", "cli", "tasks", "retry", "task:old456"]);
      expect(mockSendIpc).toHaveBeenCalledWith(
        expect.any(String),
        "task-retry",
        { task_id: "task:old456" },
      );
    });

    it("prints the new task_id on success", async () => {
      mockSendIpc.mockResolvedValue({ task_id: "task:new789" });
      await program.parseAsync(["node", "cli", "tasks", "retry", "task:old123"]);
      const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(output).toContain("task:new789");
      expect(output).toContain("digest preserved");
    });
  });

  describe("status", () => {
    it("invokes task-status IPC with the task_id", async () => {
      mockSendIpc.mockResolvedValue({
        task_id: "task:abc",
        status: "running",
      });
      await program.parseAsync(["node", "cli", "tasks", "status", "task:abc"]);
      expect(mockSendIpc).toHaveBeenCalledWith(
        expect.any(String),
        "task-status",
        { task_id: "task:abc" },
      );
    });

    it("prints the status on success", async () => {
      mockSendIpc.mockResolvedValue({
        task_id: "task:abc",
        status: "complete",
        result: { summary: "done" },
      });
      await program.parseAsync(["node", "cli", "tasks", "status", "task:abc"]);
      const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(output).toContain("complete");
    });
  });

  describe("error handling", () => {
    it("handles ManagerNotRunningError gracefully", async () => {
      mockSendIpc.mockRejectedValue(new ManagerNotRunningError());
      try {
        await program.parseAsync(["node", "cli", "tasks", "status", "task:x"]);
      } catch {
        // Expected: process.exit mock throws
      }
      const errOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(errOutput).toContain("Manager is not running");
    });
  });
});
