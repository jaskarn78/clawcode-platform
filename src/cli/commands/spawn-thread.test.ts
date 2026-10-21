import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

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

describe("formatSpawnResult", () => {
  it("formats all four fields including thread URL", async () => {
    const { formatSpawnResult } = await import("./spawn-thread.js");
    const result = formatSpawnResult({
      threadId: "123456",
      sessionName: "atlas-sub-abc123",
      parentAgent: "atlas",
      channelId: "789",
    });

    expect(result).toContain("Thread ID: 123456");
    expect(result).toContain("Session: atlas-sub-abc123");
    expect(result).toContain("Thread URL: https://discord.com/channels/@me/123456");
    expect(result).toContain("Parent Agent: atlas");
    expect(result).toContain("Channel: 789");
  });

  it("returns a string containing all fields", async () => {
    const { formatSpawnResult } = await import("./spawn-thread.js");
    const result = formatSpawnResult({
      threadId: "999",
      sessionName: "luna-sub-xyz",
      parentAgent: "luna",
      channelId: "444",
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("999");
    expect(result).toContain("luna-sub-xyz");
    expect(result).toContain("luna");
    expect(result).toContain("444");
  });
});

describe("registerSpawnThreadCommand", () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("registers spawn-thread command with required --agent and --name options", async () => {
    const { registerSpawnThreadCommand } = await import("./spawn-thread.js");
    registerSpawnThreadCommand(program);

    const cmd = program.commands.find((c) => c.name() === "spawn-thread");
    expect(cmd).toBeDefined();

    // Check options exist
    const optionNames = cmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--agent");
    expect(optionNames).toContain("--name");
    expect(optionNames).toContain("--model");
    expect(optionNames).toContain("--prompt");
  });

  it("logs spawn result on success", async () => {
    const { registerSpawnThreadCommand } = await import("./spawn-thread.js");
    registerSpawnThreadCommand(program);

    mockSendIpcRequest.mockResolvedValue({
      threadId: "123456",
      sessionName: "atlas-sub-abc123",
      parentAgent: "atlas",
      channelId: "789",
    });

    await program.parseAsync([
      "node", "test", "spawn-thread",
      "--agent", "atlas",
      "--name", "research task",
    ]);

    expect(mockSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test-socket.sock",
      "spawn-subagent-thread",
      { parentAgent: "atlas", threadName: "research task", model: undefined, systemPrompt: undefined },
    );
    expect(mockCliLog).toHaveBeenCalled();
    const loggedOutput = mockCliLog.mock.calls.map((c) => c[0]).join("\n");
    expect(loggedOutput).toContain("https://discord.com/channels/@me/123456");
  });

  it("passes --model and --prompt options through to IPC", async () => {
    const { registerSpawnThreadCommand } = await import("./spawn-thread.js");
    registerSpawnThreadCommand(program);

    mockSendIpcRequest.mockResolvedValue({
      threadId: "111",
      sessionName: "atlas-sub-def",
      parentAgent: "atlas",
      channelId: "222",
    });

    await program.parseAsync([
      "node", "test", "spawn-thread",
      "--agent", "atlas",
      "--name", "coding task",
      "--model", "opus",
      "--prompt", "You are a coder",
    ]);

    expect(mockSendIpcRequest).toHaveBeenCalledWith(
      "/tmp/test-socket.sock",
      "spawn-subagent-thread",
      { parentAgent: "atlas", threadName: "coding task", model: "opus", systemPrompt: "You are a coder" },
    );
  });

  it("shows manager-not-running message for ManagerNotRunningError", async () => {
    const { registerSpawnThreadCommand } = await import("./spawn-thread.js");
    registerSpawnThreadCommand(program);

    const { ManagerNotRunningError } = await import("../../shared/errors.js");
    mockSendIpcRequest.mockRejectedValue(new ManagerNotRunningError());

    await expect(
      program.parseAsync(["node", "test", "spawn-thread", "--agent", "atlas", "--name", "test"]),
    ).rejects.toThrow("process.exit called");

    expect(mockCliError).toHaveBeenCalledWith(
      "Manager is not running. Start it with: clawcode start-all",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("shows generic error message for IPC errors", async () => {
    const { registerSpawnThreadCommand } = await import("./spawn-thread.js");
    registerSpawnThreadCommand(program);

    mockSendIpcRequest.mockRejectedValue(new Error("requires Discord bridge"));

    await expect(
      program.parseAsync(["node", "test", "spawn-thread", "--agent", "atlas", "--name", "test"]),
    ).rejects.toThrow("process.exit called");

    expect(mockCliError).toHaveBeenCalledWith("Error: requires Discord bridge");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
