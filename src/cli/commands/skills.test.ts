import { describe, it, expect } from "vitest";
import { formatSkillsTable } from "./skills.js";

describe("formatSkillsTable", () => {
  it("returns 'No skills registered' for empty catalog", () => {
    const result = formatSkillsTable({ catalog: [], assignments: {} });
    expect(result).toBe("No skills registered");
  });

  it("shows columns SKILL, VERSION, DESCRIPTION, AGENTS", () => {
    const result = formatSkillsTable({
      catalog: [
        {
          name: "content-engine",
          description: "Write social posts and threads",
          version: "1.0.0",
          path: "/skills/content-engine",
        },
      ],
      assignments: {},
    });
    expect(result).toContain("SKILL");
    expect(result).toContain("VERSION");
    expect(result).toContain("DESCRIPTION");
    expect(result).toContain("AGENTS");
  });

  it("shows skill name, version, and description in row", () => {
    const result = formatSkillsTable({
      catalog: [
        {
          name: "market-research",
          description: "Market sizing and competitor analysis",
          version: "2.1.0",
          path: "/skills/market-research",
        },
      ],
      assignments: {},
    });
    expect(result).toContain("market-research");
    expect(result).toContain("2.1.0");
    expect(result).toContain("Market sizing and competitor analysis");
  });

  it("shows '-' when version is null", () => {
    const result = formatSkillsTable({
      catalog: [
        {
          name: "no-version-skill",
          description: "A skill without a version",
          version: null,
          path: "/skills/no-version-skill",
        },
      ],
      assignments: {},
    });
    // The row should contain "-" for version
    const lines = result.split("\n");
    const dataRow = lines[2]; // header, separator, first data row
    expect(dataRow).toContain("no-version-skill");
    expect(dataRow).toContain("-");
  });

  it("truncates description longer than 50 chars with '...'", () => {
    const longDesc =
      "This is a very long description that exceeds fifty characters by quite a bit";
    const result = formatSkillsTable({
      catalog: [
        {
          name: "verbose-skill",
          description: longDesc,
          version: "1.0.0",
          path: "/skills/verbose-skill",
        },
      ],
      assignments: {},
    });
    expect(result).toContain(longDesc.slice(0, 50) + "...");
    expect(result).not.toContain(longDesc);
  });

  it("shows '-' in AGENTS column when no agents assigned", () => {
    const result = formatSkillsTable({
      catalog: [
        {
          name: "unassigned",
          description: "No one uses this",
          version: "1.0.0",
          path: "/skills/unassigned",
        },
      ],
      assignments: {},
    });
    const lines = result.split("\n");
    const dataRow = lines[2];
    expect(dataRow).toContain("unassigned");
    // The AGENTS column header is present, and data row ends with the agents value
    // Since no agents assigned, the row should contain "-" after the description
    expect(dataRow.trimEnd()).toMatch(/-\s*$/);
  });

  it("shows comma-separated agent names when agents assigned", () => {
    const result = formatSkillsTable({
      catalog: [
        {
          name: "content-engine",
          description: "Write posts",
          version: "1.0.0",
          path: "/skills/content-engine",
        },
      ],
      assignments: {
        atlas: ["content-engine", "market-research"],
        luna: ["content-engine"],
      },
    });
    expect(result).toContain("atlas, luna");
  });

  it("handles multiple skills with mixed assignments", () => {
    const result = formatSkillsTable({
      catalog: [
        {
          name: "skill-a",
          description: "First skill",
          version: "1.0.0",
          path: "/skills/skill-a",
        },
        {
          name: "skill-b",
          description: "Second skill",
          version: null,
          path: "/skills/skill-b",
        },
        {
          name: "skill-c",
          description: "Third skill",
          version: "3.0.0",
          path: "/skills/skill-c",
        },
      ],
      assignments: {
        agent1: ["skill-a", "skill-c"],
        agent2: ["skill-b"],
        agent3: ["skill-a", "skill-b", "skill-c"],
      },
    });
    expect(result).toContain("skill-a");
    expect(result).toContain("skill-b");
    expect(result).toContain("skill-c");
    // skill-a assigned to agent1, agent3
    expect(result).toContain("agent1, agent3");
    // skill-b assigned to agent2, agent3
    expect(result).toContain("agent2, agent3");
    // skill-c assigned to agent1, agent3
    // (same as skill-a in this case)
  });

  it("has header separator line", () => {
    const result = formatSkillsTable({
      catalog: [
        {
          name: "test",
          description: "Test skill",
          version: "1.0.0",
          path: "/skills/test",
        },
      ],
      assignments: {},
    });
    const lines = result.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // Second line should be all dashes
    expect(lines[1]).toMatch(/^-+$/);
  });
});
