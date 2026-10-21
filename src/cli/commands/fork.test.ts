import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerForkCommand } from "./fork.js";

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

describe("registerForkCommand", () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerForkCommand(program);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("logs fork result on success", async () => {
    mockSendIpcRequest.mockResolvedValue({
      ok: true,
      forkName: "atlas-fork-1",
      parentAgent: "atlas",
      sessionId: "session-123",
    });

    await program.parseAsync(["node", "test", "fork", "atlas"]);

    expect(mockSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test-socket.sock",
      "fork-session",
      { name: "atlas" },
    );
    expect(mockCliLog).toHaveBeenCalledWith("Forked atlas -> atlas-fork-1");
    expect(mockCliLog).toHaveBeenCalledWith("Session ID: session-123");
  });

  it("passes --model option through to IPC params", async () => {
    mockSendIpcRequest.mockResolvedValue({
      ok: true,
      forkName: "atlas-fork-1",
      parentAgent: "atlas",
      sessionId: "session-123",
    });

    await program.parseAsync(["node", "test", "fork", "atlas", "--model", "opus"]);

    expect(mockSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test-socket.sock",
      "fork-session",
      { name: "atlas", model: "opus" },
    );
  });

  it("passes --prompt option through to IPC params", async () => {
    mockSendIpcRequest.mockResolvedValue({
      ok: true,
      forkName: "atlas-fork-1",
      parentAgent: "atlas",
      sessionId: "session-123",
    });

    await program.parseAsync(["node", "test", "fork", "atlas", "--prompt", "You are a research agent"]);

    expect(mockSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test-socket.sock",
      "fork-session",
      { name: "atlas", systemPrompt: "You are a research agent" },
    );
  });

  it("shows manager-not-running message for ManagerNotRunningError", async () => {
    const { ManagerNotRunningError } = await import("../../shared/errors.js");
    mockSendIpcRequest.mockRejectedValue(new ManagerNotRunningError());

    await expect(
      program.parseAsync(["node", "test", "fork", "atlas"]),
    ).rejects.toThrow("process.exit called");

    expect(mockCliError).toHaveBeenCalledWith(
      "Manager is not running. Start it with: clawcode start-all",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("shows generic error message for unknown errors", async () => {
    mockSendIpcRequest.mockRejectedValue(new Error("Connection refused"));

    await expect(
      program.parseAsync(["node", "test", "fork", "atlas"]),
    ).rejects.toThrow("process.exit called");

    expect(mockCliError).toHaveBeenCalledWith("Error: Connection refused");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
