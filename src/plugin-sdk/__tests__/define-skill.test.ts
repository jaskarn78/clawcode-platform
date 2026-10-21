/**
 * Phase 130 Plan 01 T-05 — defineSkill + defineMCPTool helper tests.
 *
 * Covers DS-01..DS-03 from the plan body.
 */
import { describe, it, expect } from "vitest";
import { defineSkill } from "../define-skill.js";
import { defineMCPTool } from "../define-mcp-tool.js";

const VALID = {
  name: "subagent-thread",
  description: "Spawn subagent in Discord thread",
  version: "1.0.0",
  owner: "*" as const,
  capabilities: ["subagent-spawn", "discord-post"] as const,
  requiredTools: [] as string[],
  requiredMcpServers: ["clawcode"] as string[],
};

describe("defineSkill", () => {
  it("DS-01: returns a valid manifest unchanged", () => {
    const result = defineSkill({
      ...VALID,
      capabilities: [...VALID.capabilities],
    });
    expect(result.name).toBe("subagent-thread");
    expect(result.version).toBe("1.0.0");
    expect(result.capabilities).toEqual(["subagent-spawn", "discord-post"]);
    expect(result.owner).toBe("*");
  });

  it("DS-02: throws with a structured error message on invalid input", () => {
    // Cast through `unknown` to exercise the runtime error path with an input
    // that the static types would normally reject.
    const bad = { ...VALID, name: "BadName", capabilities: [...VALID.capabilities] } as unknown as Parameters<typeof defineSkill>[0];
    let caught: Error | undefined;
    try {
      defineSkill(bad);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("Invalid skill manifest");
    // The structured message includes the offending field path.
    expect(caught?.message).toContain("name");
    expect(caught?.message).toMatch(/kebab-case/);
  });
});

describe("defineMCPTool", () => {
  it("DS-03: accepts a manifest with the optional `mcpServer` field", () => {
    const result = defineMCPTool({
      ...VALID,
      capabilities: [...VALID.capabilities],
      mcpServer: "clawcode",
    });
    expect(result.mcpServer).toBe("clawcode");
    expect(result.name).toBe("subagent-thread");
  });
});
