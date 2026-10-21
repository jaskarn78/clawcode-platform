import { describe, it, expect, vi } from "vitest";
import { formatSecurityOutput } from "./security.js";
import type { SecurityStatusResponse } from "./security.js";

describe("formatSecurityOutput", () => {
  it("formats agent with allowlist patterns, allow-always, and ACLs", () => {
    const data: SecurityStatusResponse = {
      agents: {
        "test-agent": {
          allowlistPatterns: ["read *", "write /tmp/*"],
          allowAlwaysPatterns: ["deploy production"],
          channelAcls: [
            {
              channelId: "ch-123",
              allowedUserIds: ["user1", "user2"],
              allowedRoles: ["admin"],
            },
          ],
        },
      },
    };

    const output = formatSecurityOutput(data);

    expect(output).toContain("Security Status");
    expect(output).toContain("Agent: test-agent");
    expect(output).toContain("read *");
    expect(output).toContain("write /tmp/*");
    expect(output).toContain("deploy production");
    expect(output).toContain("ch-123");
    expect(output).toContain("user1");
    expect(output).toContain("admin");
  });

  it("returns message when no agents have security config", () => {
    const data: SecurityStatusResponse = {
      agents: {},
    };

    const output = formatSecurityOutput(data);

    expect(output).toContain("No security configuration found");
  });

  it("shows (none) when agent has no allowlist patterns", () => {
    const data: SecurityStatusResponse = {
      agents: {
        "bare-agent": {
          allowlistPatterns: [],
          allowAlwaysPatterns: [],
          channelAcls: [],
        },
      },
    };

    const output = formatSecurityOutput(data);

    expect(output).toContain("Agent: bare-agent");
    expect(output).toContain("(none)");
  });

  it("handles multiple agents", () => {
    const data: SecurityStatusResponse = {
      agents: {
        "agent-a": {
          allowlistPatterns: ["cmd-a"],
          allowAlwaysPatterns: [],
          channelAcls: [],
        },
        "agent-b": {
          allowlistPatterns: ["cmd-b"],
          allowAlwaysPatterns: ["always-b"],
          channelAcls: [],
        },
      },
    };

    const output = formatSecurityOutput(data);

    expect(output).toContain("Agent: agent-a");
    expect(output).toContain("Agent: agent-b");
    expect(output).toContain("cmd-a");
    expect(output).toContain("cmd-b");
    expect(output).toContain("always-b");
  });
});
