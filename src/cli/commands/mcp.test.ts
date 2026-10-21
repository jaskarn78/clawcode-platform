import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerMcpCommand } from "./mcp.js";

// Mock CLI output
const mockCliError = vi.fn();
vi.mock("../output.js", () => ({
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

// Mock MCP server module
const mockStartMcpServer = vi.fn();
vi.mock("../../mcp/server.js", () => ({
  startMcpServer: () => mockStartMcpServer(),
}));

describe("registerMcpCommand", () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerMcpCommand(program);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("starts MCP server successfully without errors", async () => {
    mockStartMcpServer.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "mcp"]);

    expect(mockStartMcpServer).toHaveBeenCalledOnce();
    expect(mockCliError).not.toHaveBeenCalled();
  });

  it("shows error message when MCP server fails to start", async () => {
    mockStartMcpServer.mockRejectedValue(new Error("Port already in use"));

    await expect(
      program.parseAsync(["node", "test", "mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(mockCliError).toHaveBeenCalledWith(
      "Error starting MCP server: Port already in use",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("handles non-Error rejection gracefully", async () => {
    mockStartMcpServer.mockRejectedValue("unexpected string error");

    await expect(
      program.parseAsync(["node", "test", "mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(mockCliError).toHaveBeenCalledWith(
      "Error starting MCP server: unexpected string error",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
