import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerSendCommand } from "./send.js";

// Mock IPC client and CLI output
const mockSendIpcRequest = vi.fn();
vi.mock("../../ipc/client.js", () => ({
  sendIpcRequest: (...args: unknown[]) => mockSendIpcRequest(...args),
}));

const mockCliLog = vi.fn();
const mockCliError = vi.fn();
vi.mock("../output.js", () => ({
  cliLog: (...args: unknown[]) => mockCliLog(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

// Mock daemon socket path
vi.mock("../../manager/daemon.js", () => ({
  SOCKET_PATH: "/tmp/test-socket.sock",
}));

describe("registerSendCommand", () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerSendCommand(program);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("logs success message with agent name and message id", async () => {
    mockSendIpcRequest.mockResolvedValue({
      ok: true,
      messageId: "msg-456",
    });

    await program.parseAsync(["node", "test", "send", "atlas", "hello there"]);

    expect(mockSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test-socket.sock",
      "send-message",
      { from: "cli", to: "atlas", content: "hello there", priority: "normal" },
    );
    expect(mockCliLog).toHaveBeenCalledWith("Message sent to atlas (id: msg-456)");
  });

  it("passes --from option through to IPC params", async () => {
    mockSendIpcRequest.mockResolvedValue({ ok: true, messageId: "msg-1" });

    await program.parseAsync(["node", "test", "send", "luna", "ping", "--from", "admin"]);

    expect(mockSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test-socket.sock",
      "send-message",
      { from: "admin", to: "luna", content: "ping", priority: "normal" },
    );
  });

  it("passes --priority option through to IPC params", async () => {
    mockSendIpcRequest.mockResolvedValue({ ok: true, messageId: "msg-2" });

    await program.parseAsync(["node", "test", "send", "atlas", "urgent task", "--priority", "high"]);

    expect(mockSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test-socket.sock",
      "send-message",
      { from: "cli", to: "atlas", content: "urgent task", priority: "high" },
    );
  });

  it("shows manager-not-running message for ManagerNotRunningError", async () => {
    const { ManagerNotRunningError } = await import("../../shared/errors.js");
    mockSendIpcRequest.mockRejectedValue(new ManagerNotRunningError());

    await expect(
      program.parseAsync(["node", "test", "send", "atlas", "hello"]),
    ).rejects.toThrow("process.exit called");

    expect(mockCliError).toHaveBeenCalledWith(
      "Manager is not running. Start it with: clawcode start-all",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("shows generic error message for unknown errors", async () => {
    mockSendIpcRequest.mockRejectedValue(new Error("Network error"));

    await expect(
      program.parseAsync(["node", "test", "send", "atlas", "hello"]),
    ).rejects.toThrow("process.exit called");

    expect(mockCliError).toHaveBeenCalledWith("Error: Network error");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
