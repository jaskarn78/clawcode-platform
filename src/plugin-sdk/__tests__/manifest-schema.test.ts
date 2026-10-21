/**
 * Phase 130 Plan 01 T-05 — SkillManifestSchema + MCPToolManifestSchema tests.
 *
 * Covers MS-01..MS-08 from the plan body.
 */
import { describe, it, expect } from "vitest";
import {
  SkillManifestSchema,
  MCPToolManifestSchema,
} from "../manifest-schema.js";

const VALID = {
  name: "subagent-thread",
  description: "Spawn subagent in Discord thread",
  version: "1.0.0",
  owner: "*",
  capabilities: ["subagent-spawn", "discord-post"],
  requiredTools: [],
  requiredMcpServers: ["clawcode"],
} as const;

describe("SkillManifestSchema", () => {
  it("MS-01: valid skill manifest parses", () => {
    const result = SkillManifestSchema.safeParse(VALID);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("subagent-thread");
      expect(result.data.capabilities).toEqual(["subagent-spawn", "discord-post"]);
    }
  });

  it("MS-02: missing `name` rejected", () => {
    const { name: _name, ...rest } = VALID;
    const result = SkillManifestSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "name")).toBe(true);
    }
  });

  it("MS-03: non-kebab-case name rejected", () => {
    const result = SkillManifestSchema.safeParse({ ...VALID, name: "SubagentThread" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nameIssue = result.error.issues.find((i) => i.path.join(".") === "name");
      expect(nameIssue?.message).toMatch(/kebab-case/);
    }
  });

  it("MS-04: non-semver version rejected", () => {
    const result = SkillManifestSchema.safeParse({ ...VALID, version: "1.0" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const verIssue = result.error.issues.find((i) => i.path.join(".") === "version");
      expect(verIssue?.message).toMatch(/semver/);
    }
  });

  it("MS-05: unknown capability rejected", () => {
    // `sandbox-execute` is intentionally NOT in CAPABILITY_VOCABULARY.
    const result = SkillManifestSchema.safeParse({
      ...VALID,
      capabilities: ["sandbox-execute"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const capIssue = result.error.issues.find(
        (i) => i.path[0] === "capabilities",
      );
      expect(capIssue).toBeDefined();
    }
  });

  it("MS-06: owner accepts a kebab-case agent name", () => {
    const result = SkillManifestSchema.safeParse({ ...VALID, owner: "admin-clawdy" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.owner).toBe("admin-clawdy");
  });

  it("MS-07: owner accepts `*`", () => {
    const result = SkillManifestSchema.safeParse({ ...VALID, owner: "*" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.owner).toBe("*");
  });

  it("MS-11: accepts an optional originatingFingerprint field (Phase 999.42 D7a)", () => {
    const result = SkillManifestSchema.safeParse({
      ...VALID,
      originatingFingerprint: "abc123def456",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.originatingFingerprint).toBe("abc123def456");
    }
  });

  it("MS-12: tolerates an omitted originatingFingerprint (additive-optional)", () => {
    const result = SkillManifestSchema.safeParse(VALID);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.originatingFingerprint).toBeUndefined();
    }
  });

  it("MS-08: defaults to empty arrays for capabilities / requiredTools / requiredMcpServers", () => {
    const minimal = {
      name: "minimal-skill",
      description: "Bare minimum",
      version: "0.1.0",
      owner: "*",
    };
    const result = SkillManifestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([]);
      expect(result.data.requiredTools).toEqual([]);
      expect(result.data.requiredMcpServers).toEqual([]);
    }
  });
});

describe("MCPToolManifestSchema", () => {
  it("MS-09: accepts optional `mcpServer` field", () => {
    const result = MCPToolManifestSchema.safeParse({
      ...VALID,
      mcpServer: "clawcode",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mcpServer).toBe("clawcode");
  });

  it("MS-10: tolerates omitted `mcpServer` field", () => {
    const result = MCPToolManifestSchema.safeParse(VALID);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mcpServer).toBeUndefined();
  });
});
