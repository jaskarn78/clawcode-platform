import { describe, it, expect } from "vitest";
import { formatMcpServersTable, type McpServersResponse } from "../mcp-servers.js";

describe("formatMcpServersTable", () => {
  it("formats servers into a table with AGENT, SERVER, COMMAND, STATUS columns", () => {
    const data: McpServersResponse = {
      servers: [
        {
          agent: "alice",
          name: "finnhub",
          command: "npx",
          args: ["-y", "finnhub-mcp"],
          healthy: true,
          latencyMs: 42,
        },
        {
          agent: "bob",
          name: "google-workspace",
          command: "node",
          args: ["gw-server.js"],
          healthy: false,
          error: "connection refused",
        },
      ],
    };

    const table = formatMcpServersTable(data);

    expect(table).toContain("AGENT");
    expect(table).toContain("SERVER");
    expect(table).toContain("COMMAND");
    expect(table).toContain("STATUS");
    expect(table).toContain("alice");
    expect(table).toContain("finnhub");
    expect(table).toContain("npx -y finnhub-mcp");
    expect(table).toContain("42ms");
    expect(table).toContain("bob");
    expect(table).toContain("google-workspace");
    expect(table).toContain("connection refused");
  });

  it("shows 'unknown' status when healthy is null", () => {
    const data: McpServersResponse = {
      servers: [
        {
          agent: "alice",
          name: "finnhub",
          command: "npx",
          args: ["-y", "finnhub-mcp"],
          healthy: null,
        },
      ],
    };

    const table = formatMcpServersTable(data);
    expect(table).toContain("unknown");
  });

  it("returns message when no servers configured", () => {
    const data: McpServersResponse = { servers: [] };
    const result = formatMcpServersTable(data);
    expect(result).toBe("No MCP servers configured");
  });
});
