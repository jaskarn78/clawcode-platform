/**
 * Phase 130 Plan 02 — skill-loader chokepoint tests.
 *
 * Fixture-driven tests for `loadSkillManifest` covering:
 *   SL-01: valid skill → status "loaded" + phase130-skill-load-success log
 *   SL-02: required MCP server missing → status "refused-mcp-missing" + fail log
 *   SL-03: SKILL.md missing → status "manifest-missing" + warn log
 *   SL-04: all required MCP servers present → status "loaded"
 *   SL-05: unknown capability → status "parse-error" + parse-error log
 *   SL-06: empty/no frontmatter SKILL.md → status "manifest-missing" + warn log
 *
 * Fixtures are created in a temp directory per test (no checked-in
 * fixture files — keeps the test self-contained and avoids fixture-rot
 * drift from any future SKILL.md format evolution).
 *
 * Console assertions: we spy on the structured-log emitters
 * (console.info / .warn / .error) and parse the JSON payload back to
 * pin the emitted fields, not just the call count. This matches the
 * scanner.ts + stream-stall-callback.ts test idiom.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkillManifest } from "../skill-loader.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase130-skill-loader-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Helper — create a skill directory with the given SKILL.md content.
 * Returns the absolute path to the new skill directory.
 */
function makeSkill(name: string, skillMdContent: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), skillMdContent, "utf-8");
  return dir;
}

const VALID_MANIFEST = `---
name: example-skill
description: A valid example skill manifest for testing the loader chokepoint
version: 1.0.0
owner: "*"
capabilities:
  - filesystem
  - discord-post
requiredTools: []
requiredMcpServers: []
---

# Example Skill

Body content follows the frontmatter.`;

const MCP_REQUIRING_MANIFEST = `---
name: mcp-required-skill
description: Skill that requires the clawcode-broker MCP server to operate
version: 1.0.0
owner: admin-clawdy
capabilities:
  - mcp-tool-use
requiredTools: []
requiredMcpServers:
  - clawcode-broker
---
`;

const UNKNOWN_CAPABILITY_MANIFEST = `---
name: bad-cap-skill
description: Manifest with a capability outside the closed vocabulary enum
version: 1.0.0
owner: "*"
capabilities:
  - filesystem
  - chaos-monkey
requiredTools: []
requiredMcpServers: []
---
`;

const NO_FRONTMATTER_CONTENT = `# Legacy Skill

This SKILL.md has no YAML frontmatter at all.
Loader treats it as a back-compat un-migrated skill.`;

describe("Phase 130 Plan 02 — loadSkillManifest chokepoint", () => {
  it("SL-01: valid manifest with no MCP requirements returns status loaded and emits success log", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const skillDir = makeSkill("example-skill", VALID_MANIFEST);

    const result = loadSkillManifest(skillDir, []);

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") throw new Error("unreachable");
    expect(result.manifest.name).toBe("example-skill");
    expect(result.manifest.capabilities).toEqual(["filesystem", "discord-post"]);
    expect(result.manifest.requiredMcpServers).toEqual([]);

    expect(infoSpy).toHaveBeenCalledWith(
      "phase130-skill-load-success",
      expect.any(String),
    );
    const payload = JSON.parse(infoSpy.mock.calls[0]![1] as string) as {
      skill: string;
      capabilities: string[];
      requiredMcpServers: string[];
    };
    expect(payload.skill).toBe("example-skill");
    expect(payload.capabilities).toEqual(["filesystem", "discord-post"]);
    expect(payload.requiredMcpServers).toEqual([]);
  });

  it("SL-02: required MCP server not in enabled set returns refused-mcp-missing and emits fail log", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const skillDir = makeSkill("mcp-required-skill", MCP_REQUIRING_MANIFEST);

    const result = loadSkillManifest(skillDir, ["1password", "github"]);

    expect(result.status).toBe("refused-mcp-missing");
    if (result.status !== "refused-mcp-missing")
      throw new Error("unreachable");
    expect(result.manifest).toBeNull();
    expect(result.missingMcp).toEqual(["clawcode-broker"]);
    expect(result.reason).toContain("clawcode-broker");

    expect(errorSpy).toHaveBeenCalledWith(
      "phase130-skill-load-fail",
      expect.any(String),
    );
    const payload = JSON.parse(errorSpy.mock.calls[0]![1] as string) as {
      skill: string;
      missingMcp: string[];
      enabledMcp: string[];
    };
    expect(payload.skill).toBe("mcp-required-skill");
    expect(payload.missingMcp).toEqual(["clawcode-broker"]);
    expect(payload.enabledMcp).toEqual(["1password", "github"]);
  });

  it("SL-03: SKILL.md absent returns manifest-missing and emits warn log", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Create dir but NO SKILL.md
    const dir = path.join(tmpRoot, "no-md-skill");
    fs.mkdirSync(dir);

    const result = loadSkillManifest(dir, []);

    expect(result.status).toBe("manifest-missing");
    expect(result.manifest).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "phase130-skill-manifest-missing",
      expect.any(String),
    );
    const payload = JSON.parse(warnSpy.mock.calls[0]![1] as string) as {
      skill: string;
      path: string;
    };
    expect(payload.skill).toBe("no-md-skill");
    expect(payload.path).toBe(path.join(dir, "SKILL.md"));
  });

  it("SL-04: required MCP servers all present returns status loaded", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const skillDir = makeSkill("mcp-required-skill", MCP_REQUIRING_MANIFEST);

    const result = loadSkillManifest(skillDir, [
      "clawcode-broker",
      "1password",
    ]);

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") throw new Error("unreachable");
    expect(result.manifest.requiredMcpServers).toEqual(["clawcode-broker"]);
    expect(infoSpy).toHaveBeenCalledWith(
      "phase130-skill-load-success",
      expect.any(String),
    );
  });

  it("SL-05: capability outside the closed vocabulary returns parse-error and emits parse-error log", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const skillDir = makeSkill("bad-cap-skill", UNKNOWN_CAPABILITY_MANIFEST);

    const result = loadSkillManifest(skillDir, []);

    expect(result.status).toBe("parse-error");
    if (result.status !== "parse-error") throw new Error("unreachable");
    expect(result.manifest).toBeNull();
    expect(result.reason).toBe("schema mismatch");

    expect(errorSpy).toHaveBeenCalledWith(
      "phase130-skill-manifest-parse-error",
      expect.any(String),
    );
    const payload = JSON.parse(errorSpy.mock.calls[0]![1] as string) as {
      skill: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(payload.skill).toBe("bad-cap-skill");
    expect(payload.issues.length).toBeGreaterThan(0);
    // The offending field is `capabilities.1` (the second array element).
    const offending = payload.issues.find((i) => i.path.startsWith("capabilities"));
    expect(offending).toBeDefined();
  });

  it("SL-06: SKILL.md without YAML frontmatter returns manifest-missing and emits warn log", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const skillDir = makeSkill("legacy-skill", NO_FRONTMATTER_CONTENT);

    const result = loadSkillManifest(skillDir, []);

    expect(result.status).toBe("manifest-missing");
    expect(result.manifest).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "phase130-skill-manifest-missing",
      expect.any(String),
    );
  });
});
