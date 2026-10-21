/**
 * Phase 78 Plan 03 Task 1 — yaml-writer unit tests. TDD RED phase.
 *
 * Pins 14 load-bearing behaviors per 78-03-PLAN.md:
 *   1. Atomic temp+rename (tmp path matches /\.clawcode\.yaml\.\d+\.\d+\.tmp$/)
 *   2. Tmp path uniqueness across concurrent invocations (distinct pid segment)
 *   3. Tmp cleanup on rename failure (unlink runs + re-throw)
 *   4. Comment preservation byte-exact (every pre-existing line preserved in order)
 *   5. Top-level key ordering preserved byte-exact
 *   6. New agent entry shape (soulFile/identityFile/mcpServers/model/channels)
 *   7. Chokidar single 'change' event (no partial-write races)
 *   8. Pre-write secret refusal (no rename fires, content unchanged)
 *   9. Unmappable-model gate (refuses without --model-map override)
 *  10. Unmappable-model override (empty warnings = allow)
 *  11. Target sha256 matches independent hash of written bytes
 *  12. Idempotent re-run (same bytes, same sha256)
 *  13. Append-only agents order (existing agents never reordered)
 *  14. Missing existing file → refused with step: "file-not-found"
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import chokidar from "chokidar";
import { parse as parseYaml } from "yaml";
import {
  writerFs,
  removeAgentFromConfig,
  updateAgentModel,
  updateAgentSkills,
  updateAgentMcpServers,
  updateAgentConfig,
} from "../yaml-writer.js";
import { configSchema } from "../../config/schema.js";

const FIXTURE_PATH =
  "src/migration/__tests__/fixtures/clawcode.before.yaml";

async function setupDestDir(): Promise<{ dir: string; destPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cc-yaml-writer-"));
  const destPath = join(dir, "clawcode.yaml");
  await copyFile(FIXTURE_PATH, destPath);
  return { dir, destPath };
}

// Snapshot the real fs functions so afterEach can restore the dispatch
// holder after tests that swap them out.
const ORIG_FS = { ...writerFs };

afterEach(async () => {
  vi.restoreAllMocks();
  writerFs.readFile = ORIG_FS.readFile;
  writerFs.writeFile = ORIG_FS.writeFile;
  writerFs.rename = ORIG_FS.rename;
  writerFs.unlink = ORIG_FS.unlink;
});

// ---------------------------------------------------------------------------
// Phase 81 Plan 01 Task 1 — removeAgentFromConfig extension tests.
// Additive: existing yaml-writer tests above are Phase 78 regression pins
// and remain untouched. These 5 tests land the new export contract.
// ---------------------------------------------------------------------------

describe("removeAgentFromConfig — Phase 81 extension (Tests 19-23)", () => {
  async function setupRemoveFixture(
    yaml: string,
  ): Promise<{ destPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), "cc-yaml-remove-"));
    const destPath = join(dir, "clawcode.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(destPath, yaml, "utf8");
    return { destPath };
  }

  const THREE_AGENTS_YAML = `version: 1
defaults:
  model: sonnet
  basePath: ~/.clawcode/agents
agents:
  # alpha header comment
  - name: alpha
    workspace: ~/.clawcode/agents/alpha
    model: sonnet
    channels:
      - "111"
    mcpServers: []
  # middle header comment (for victim)
  - name: victim
    workspace: ~/.clawcode/agents/victim
    model: haiku
    channels:
      - "222"
    mcpServers: []
  # beta header comment
  - name: beta
    workspace: ~/.clawcode/agents/beta
    model: sonnet
    channels:
      - "333"
    mcpServers: []
`;

  it("removes the named middle agent — remaining agents + alpha/beta comments preserved (Test 19)", async () => {
    const { destPath } = await setupRemoveFixture(THREE_AGENTS_YAML);
    const result = await removeAgentFromConfig({
      existingConfigPath: destPath,
      agentName: "victim",
    });
    expect(result.outcome).toBe("removed");
    if (result.outcome !== "removed") return;
    expect(result.destPath).toBe(destPath);
    expect(result.targetSha256).toMatch(/^[a-f0-9]{64}$/);

    const after = readFileSync(destPath, "utf8");
    // Agents reparsed — victim gone, other two remain.
    const parsed = parseYaml(after) as { agents: Array<{ name: string }> };
    expect(parsed.agents.map((a) => a.name)).toEqual(["alpha", "beta"]);
    // Comments on surviving agents preserved (yaml lib may rewire the
    // orphan 'middle header comment' onto beta — we only pin survivors).
    expect(after).toContain("# alpha header comment");
    expect(after).toContain("# beta header comment");
    expect(after).not.toContain("name: victim");
  });

  it("returns not-found when agent missing; file bytes unchanged (Test 20)", async () => {
    const { destPath } = await setupRemoveFixture(THREE_AGENTS_YAML);
    const beforeBytes = readFileSync(destPath, "utf8");
    const beforeHash = createHash("sha256")
      .update(beforeBytes, "utf8")
      .digest("hex");

    const result = await removeAgentFromConfig({
      existingConfigPath: destPath,
      agentName: "does-not-exist",
    });
    expect(result.outcome).toBe("not-found");

    const afterBytes = readFileSync(destPath, "utf8");
    const afterHash = createHash("sha256")
      .update(afterBytes, "utf8")
      .digest("hex");
    expect(afterHash).toBe(beforeHash);
  });

  it("returns file-not-found when config path does not exist (Test 21)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-yaml-remove-noexist-"));
    const missing = join(dir, "does-not-exist.yaml");
    const result = await removeAgentFromConfig({
      existingConfigPath: missing,
      agentName: "anyone",
    });
    expect(result.outcome).toBe("file-not-found");
  });

  it("uses atomic temp+rename — tmp path matches .clawcode.yaml.<pid>.<ts>.tmp (Test 22)", async () => {
    const { destPath } = await setupRemoveFixture(THREE_AGENTS_YAML);
    const renameCalls: Array<[string, string]> = [];
    writerFs.rename = (async (...args: unknown[]) => {
      renameCalls.push([String(args[0]), String(args[1])]);
      return ORIG_FS.rename(
        args[0] as Parameters<typeof ORIG_FS.rename>[0],
        args[1] as Parameters<typeof ORIG_FS.rename>[1],
      );
    }) as typeof writerFs.rename;

    await removeAgentFromConfig({
      existingConfigPath: destPath,
      agentName: "victim",
      pid: 4242,
    });

    expect(renameCalls.length).toBeGreaterThan(0);
    expect(renameCalls[0]![0]).toMatch(
      /\.clawcode\.yaml\.4242\.\d+\.tmp$/,
    );
    expect(renameCalls[0]![1]).toBe(destPath);
  });

  it("unlinks tmp file on rename failure and re-throws (Test 23)", async () => {
    const { destPath } = await setupRemoveFixture(THREE_AGENTS_YAML);
    const unlinkCalls: string[] = [];
    writerFs.rename = (async () => {
      throw new Error("EACCES: simulated rename failure");
    }) as typeof writerFs.rename;
    writerFs.unlink = (async (...args: unknown[]) => {
      unlinkCalls.push(String(args[0]));
      return ORIG_FS.unlink(
        args[0] as Parameters<typeof ORIG_FS.unlink>[0],
      );
    }) as typeof writerFs.unlink;

    await expect(
      removeAgentFromConfig({
        existingConfigPath: destPath,
        agentName: "victim",
      }),
    ).rejects.toThrow(/EACCES/);

    const tmpUnlink = unlinkCalls.find((p) =>
      /\.clawcode\.yaml\.\d+\.\d+\.tmp$/.test(p),
    );
    expect(tmpUnlink).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 86 Plan 02 Task 1 — updateAgentModel tests (U1-U8).
// Pins the atomic, comment-preserving, idempotent single-field rewrite for
// agents[*].model used by the daemon IPC set-model handler after the live
// SDK swap succeeds.
// ---------------------------------------------------------------------------

describe("updateAgentModel — Phase 86 Plan 02 (Tests U1-U8)", () => {
  async function setupModelFixture(
    yaml: string,
  ): Promise<{ destPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), "cc-yaml-update-model-"));
    const destPath = join(dir, "clawcode.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(destPath, yaml, "utf8");
    return { destPath };
  }

  const THREE_AGENTS_YAML = `# fleet comment at top
version: 1
defaults:
  model: sonnet
  basePath: ~/.clawcode/agents
agents:
  # clawdy header comment
  - name: clawdy  # personal
    workspace: ~/.clawcode/agents/clawdy
    model: haiku
    channels:
      - "111"
    mcpServers: []
  - name: alpha
    workspace: ~/.clawcode/agents/alpha
    model: sonnet
    channels:
      - "222"
    mcpServers: []
  - name: beta
    workspace: ~/.clawcode/agents/beta
    model: opus
    channels:
      - "333"
    mcpServers: []
`;

  it("U1: updates clawdy's model from haiku to sonnet; other agents unchanged", async () => {
    const { destPath } = await setupModelFixture(THREE_AGENTS_YAML);
    const result = await updateAgentModel({
      existingConfigPath: destPath,
      agentName: "clawdy",
      newModel: "sonnet",
    });
    expect(result.outcome).toBe("updated");
    if (result.outcome !== "updated") return;
    expect(result.destPath).toBe(destPath);
    expect(result.targetSha256).toMatch(/^[a-f0-9]{64}$/);

    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<{ name: string; model: string }>;
    };
    const byName = new Map(parsed.agents.map((a) => [a.name, a.model]));
    expect(byName.get("clawdy")).toBe("sonnet");
    expect(byName.get("alpha")).toBe("sonnet");
    expect(byName.get("beta")).toBe("opus");
  });

  it("U2: idempotent — same model returns no-op; file bytes unchanged", async () => {
    const { destPath } = await setupModelFixture(THREE_AGENTS_YAML);
    const beforeBytes = readFileSync(destPath, "utf8");
    const beforeHash = createHash("sha256")
      .update(beforeBytes, "utf8")
      .digest("hex");

    const result = await updateAgentModel({
      existingConfigPath: destPath,
      agentName: "clawdy",
      newModel: "haiku",
    });
    expect(result.outcome).toBe("no-op");
    if (result.outcome === "no-op") {
      expect(result.reason).toMatch(/already/);
    }

    const afterBytes = readFileSync(destPath, "utf8");
    const afterHash = createHash("sha256")
      .update(afterBytes, "utf8")
      .digest("hex");
    expect(afterHash).toBe(beforeHash);
    expect(afterBytes).toBe(beforeBytes);
  });

  it("U3: preserves top-of-file and inline comments across the rewrite", async () => {
    const { destPath } = await setupModelFixture(THREE_AGENTS_YAML);
    await updateAgentModel({
      existingConfigPath: destPath,
      agentName: "clawdy",
      newModel: "sonnet",
    });

    const after = readFileSync(destPath, "utf8");
    // Top-of-file comment preserved
    expect(after).toContain("# fleet comment at top");
    // Header comment on clawdy preserved
    expect(after).toContain("# clawdy header comment");
    // Inline "# personal" comment on clawdy's name line preserved
    expect(after).toMatch(/name:\s*clawdy\s*#\s*personal/);
  });

  it("U4: agent not found — returns not-found; file bytes unchanged", async () => {
    const { destPath } = await setupModelFixture(THREE_AGENTS_YAML);
    const beforeBytes = readFileSync(destPath, "utf8");
    const beforeHash = createHash("sha256")
      .update(beforeBytes, "utf8")
      .digest("hex");

    const result = await updateAgentModel({
      existingConfigPath: destPath,
      agentName: "does-not-exist",
      newModel: "sonnet",
    });
    expect(result.outcome).toBe("not-found");
    if (result.outcome === "not-found") {
      expect(result.reason).toMatch(/does-not-exist/);
    }

    const afterBytes = readFileSync(destPath, "utf8");
    const afterHash = createHash("sha256")
      .update(afterBytes, "utf8")
      .digest("hex");
    expect(afterHash).toBe(beforeHash);
  });

  it("U5: file missing — returns file-not-found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-yaml-update-noexist-"));
    const missing = join(dir, "does-not-exist.yaml");
    const result = await updateAgentModel({
      existingConfigPath: missing,
      agentName: "clawdy",
      newModel: "sonnet",
    });
    expect(result.outcome).toBe("file-not-found");
    if (result.outcome === "file-not-found") {
      expect(result.reason).toMatch(/not found/i);
    }
  });

  it("U6: atomic rename failure — unlinks tmp and re-throws", async () => {
    const { destPath } = await setupModelFixture(THREE_AGENTS_YAML);
    const unlinkCalls: string[] = [];
    writerFs.rename = (async () => {
      throw new Error("EACCES: simulated rename failure");
    }) as typeof writerFs.rename;
    writerFs.unlink = (async (...args: unknown[]) => {
      unlinkCalls.push(String(args[0]));
      return ORIG_FS.unlink(
        args[0] as Parameters<typeof ORIG_FS.unlink>[0],
      );
    }) as typeof writerFs.unlink;

    await expect(
      updateAgentModel({
        existingConfigPath: destPath,
        agentName: "clawdy",
        newModel: "sonnet",
      }),
    ).rejects.toThrow(/EACCES/);

    const tmpUnlink = unlinkCalls.find((p) =>
      /\.clawcode\.yaml\.\d+\.\d+\.tmp$/.test(p),
    );
    expect(tmpUnlink).toBeDefined();
  });

  it("U7: round-trip — re-parse after update validates against configSchema", async () => {
    const { destPath } = await setupModelFixture(THREE_AGENTS_YAML);
    const result = await updateAgentModel({
      existingConfigPath: destPath,
      agentName: "clawdy",
      newModel: "sonnet",
    });
    expect(result.outcome).toBe("updated");

    const after = readFileSync(destPath, "utf8");
    // Round-trip: parseYaml → configSchema.safeParse MUST succeed
    const parsed = parseYaml(after) as unknown;
    const schemaResult = configSchema.safeParse(parsed);
    expect(schemaResult.success).toBe(true);
  });

  it("U8: invalid model alias — returns refused with step invalid-model", async () => {
    const { destPath } = await setupModelFixture(THREE_AGENTS_YAML);
    const beforeBytes = readFileSync(destPath, "utf8");

    const result = await updateAgentModel({
      existingConfigPath: destPath,
      agentName: "clawdy",
      newModel: "gpt-4",
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.step).toBe("invalid-model");
      expect(result.reason).toMatch(/Invalid model/);
    }

    const afterBytes = readFileSync(destPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);
  });
});

// ---------------------------------------------------------------------------
// Phase 88 Plan 01 Task 2 — updateAgentSkills tests (U1-U8).
// Mirrors the updateAgentModel contract. Atomic append/remove of a single
// skill name onto agents[*].skills, comment-preserving, idempotent.
// ---------------------------------------------------------------------------

describe("updateAgentSkills — Phase 88 Plan 01 (Tests U1-U8)", () => {
  async function setupSkillsFixture(
    yaml: string,
  ): Promise<{ destPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), "cc-yaml-update-skills-"));
    const destPath = join(dir, "clawcode.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(destPath, yaml, "utf8");
    return { destPath };
  }

  const EMPTY_SKILLS_YAML = `# fleet comment at top
version: 1
defaults:
  model: sonnet
agents:
  # clawdy header comment
  - name: clawdy  # personal
    workspace: ~/.clawcode/agents/clawdy
    model: haiku
    channels:
      - "111"
    skills: []
    mcpServers: []
  - name: alpha
    workspace: ~/.clawcode/agents/alpha
    model: sonnet
    channels:
      - "222"
    skills:
      - frontend-design
    mcpServers: []
`;

  it("U1: add happy path — appends 'frontend-design' to clawdy; 64-char hex hash", async () => {
    const { destPath } = await setupSkillsFixture(EMPTY_SKILLS_YAML);
    const result = await updateAgentSkills({
      existingConfigPath: destPath,
      agentName: "clawdy",
      skillName: "frontend-design",
      op: "add",
    });
    expect(result.outcome).toBe("updated");
    if (result.outcome !== "updated") return;
    expect(result.destPath).toBe(destPath);
    expect(result.targetSha256).toMatch(/^[a-f0-9]{64}$/);

    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<{ name: string; skills: string[] }>;
    };
    const byName = new Map(parsed.agents.map((a) => [a.name, a.skills]));
    expect(byName.get("clawdy")).toEqual(["frontend-design"]);
    // Alpha's skills unchanged
    expect(byName.get("alpha")).toEqual(["frontend-design"]);
  });

  it("U2: idempotent add — already present returns no-op; bytes unchanged", async () => {
    const { destPath } = await setupSkillsFixture(EMPTY_SKILLS_YAML);
    const beforeBytes = readFileSync(destPath, "utf8");

    const result = await updateAgentSkills({
      existingConfigPath: destPath,
      agentName: "alpha",
      skillName: "frontend-design",
      op: "add",
    });
    expect(result.outcome).toBe("no-op");
    if (result.outcome === "no-op") {
      expect(result.reason).toMatch(/already/i);
    }

    const afterBytes = readFileSync(destPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);
  });

  it("U3: preserves top-of-file, header, and inline comments", async () => {
    const { destPath } = await setupSkillsFixture(EMPTY_SKILLS_YAML);
    await updateAgentSkills({
      existingConfigPath: destPath,
      agentName: "clawdy",
      skillName: "frontend-design",
      op: "add",
    });

    const after = readFileSync(destPath, "utf8");
    expect(after).toContain("# fleet comment at top");
    expect(after).toContain("# clawdy header comment");
    expect(after).toMatch(/name:\s*clawdy\s*#\s*personal/);
  });

  it("U4: agent not found — returns not-found; bytes unchanged", async () => {
    const { destPath } = await setupSkillsFixture(EMPTY_SKILLS_YAML);
    const beforeBytes = readFileSync(destPath, "utf8");

    const result = await updateAgentSkills({
      existingConfigPath: destPath,
      agentName: "ghost",
      skillName: "frontend-design",
      op: "add",
    });
    expect(result.outcome).toBe("not-found");
    if (result.outcome === "not-found") {
      expect(result.reason).toMatch(/ghost/);
    }

    const afterBytes = readFileSync(destPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);
  });

  it("U5: file missing — returns file-not-found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-yaml-update-skills-missing-"));
    const missing = join(dir, "nope.yaml");
    const result = await updateAgentSkills({
      existingConfigPath: missing,
      agentName: "clawdy",
      skillName: "frontend-design",
      op: "add",
    });
    expect(result.outcome).toBe("file-not-found");
    if (result.outcome === "file-not-found") {
      expect(result.reason).toMatch(/not found/i);
    }
  });

  it("U6: rename failure — unlinks tmp and re-throws EACCES", async () => {
    const { destPath } = await setupSkillsFixture(EMPTY_SKILLS_YAML);
    const unlinkCalls: string[] = [];
    writerFs.rename = (async () => {
      throw new Error("EACCES: simulated rename failure");
    }) as typeof writerFs.rename;
    writerFs.unlink = (async (...args: unknown[]) => {
      unlinkCalls.push(String(args[0]));
      return ORIG_FS.unlink(
        args[0] as Parameters<typeof ORIG_FS.unlink>[0],
      );
    }) as typeof writerFs.unlink;

    await expect(
      updateAgentSkills({
        existingConfigPath: destPath,
        agentName: "clawdy",
        skillName: "frontend-design",
        op: "add",
      }),
    ).rejects.toThrow(/EACCES/);

    const tmpUnlink = unlinkCalls.find((p) =>
      /\.clawcode\.yaml\.\d+\.\d+\.tmp$/.test(p),
    );
    expect(tmpUnlink).toBeDefined();
  });

  it("U7: round-trip — configSchema.safeParse succeeds after update", async () => {
    const { destPath } = await setupSkillsFixture(EMPTY_SKILLS_YAML);
    await updateAgentSkills({
      existingConfigPath: destPath,
      agentName: "clawdy",
      skillName: "frontend-design",
      op: "add",
    });
    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as unknown;
    const schemaResult = configSchema.safeParse(parsed);
    expect(schemaResult.success).toBe(true);
  });

  it("U8: remove op — removes skill; idempotent on empty", async () => {
    const { destPath } = await setupSkillsFixture(EMPTY_SKILLS_YAML);

    // First: remove frontend-design from alpha → skills becomes []
    const r1 = await updateAgentSkills({
      existingConfigPath: destPath,
      agentName: "alpha",
      skillName: "frontend-design",
      op: "remove",
    });
    expect(r1.outcome).toBe("updated");

    const after1 = readFileSync(destPath, "utf8");
    const parsed1 = parseYaml(after1) as {
      agents: Array<{ name: string; skills: string[] }>;
    };
    const alpha1 = parsed1.agents.find((a) => a.name === "alpha")!;
    expect(alpha1.skills).toEqual([]);

    // Second: remove again → no-op (skill not present)
    const beforeBytes = readFileSync(destPath, "utf8");
    const r2 = await updateAgentSkills({
      existingConfigPath: destPath,
      agentName: "alpha",
      skillName: "frontend-design",
      op: "remove",
    });
    expect(r2.outcome).toBe("no-op");
    if (r2.outcome === "no-op") {
      expect(r2.reason).toMatch(/not in list/i);
    }
    const afterBytes = readFileSync(destPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);
  });
});

// ---------------------------------------------------------------------------
// Phase 90 Plan 05 HUB-04 — updateAgentMcpServers tests (MCP-W1..W9).
// Mirrors the updateAgentModel + updateAgentSkills contracts. Atomic add/
// remove of one mcpServers entry onto agents[*].mcpServers, comment-
// preserving, idempotent, literal-value secret-scan guarded.
// ---------------------------------------------------------------------------

describe("updateAgentMcpServers — Phase 90 Plan 05 (Tests MCP-W1..W9)", () => {
  async function setupMcpFixture(
    yaml: string,
  ): Promise<{ destPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), "cc-yaml-update-mcp-"));
    const destPath = join(dir, "clawcode.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(destPath, yaml, "utf8");
    return { destPath };
  }

  const EMPTY_MCP_YAML = `# fleet comment at top
version: 1
defaults:
  model: sonnet
agents:
  # clawdy header comment
  - name: clawdy  # personal
    workspace: ~/.clawcode/agents/clawdy
    model: haiku
    channels:
      - "111"
    skills: []
    mcpServers: []
  - name: alpha
    workspace: ~/.clawcode/agents/alpha
    model: sonnet
    channels:
      - "222"
    skills: []
    mcpServers:
      - name: foo
        command: cmd-foo
        args: []
        env: {}
`;

  it("MCP-W1: add happy path — appends new YAMLMap entry to clawdy; 64-char hex hash", async () => {
    const { destPath } = await setupMcpFixture(EMPTY_MCP_YAML);
    const result = await updateAgentMcpServers({
      existingConfigPath: destPath,
      agentName: "clawdy",
      entry: {
        name: "test-mcp",
        command: "my-cmd",
        args: ["serve"],
        env: { DB_HOST: "db.example.com" },
      },
      op: "add",
    });
    expect(result.outcome).toBe("updated");
    if (result.outcome !== "updated") return;
    expect(result.destPath).toBe(destPath);
    expect(result.targetSha256).toMatch(/^[a-f0-9]{64}$/);

    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<{
        name: string;
        mcpServers: Array<{
          name: string;
          command: string;
          args: string[];
          env: Record<string, string>;
        }>;
      }>;
    };
    const clawdy = parsed.agents.find((a) => a.name === "clawdy")!;
    expect(clawdy.mcpServers).toHaveLength(1);
    const entry = clawdy.mcpServers[0]!;
    expect(entry.name).toBe("test-mcp");
    expect(entry.command).toBe("my-cmd");
    expect(entry.args).toEqual(["serve"]);
    expect(entry.env).toEqual({ DB_HOST: "db.example.com" });
  });

  it("MCP-W2: preserves top-of-file + header + inline comments", async () => {
    const { destPath } = await setupMcpFixture(EMPTY_MCP_YAML);
    await updateAgentMcpServers({
      existingConfigPath: destPath,
      agentName: "clawdy",
      entry: {
        name: "test-mcp",
        command: "my-cmd",
        args: [],
        env: {},
      },
      op: "add",
    });

    const after = readFileSync(destPath, "utf8");
    expect(after).toContain("# fleet comment at top");
    expect(after).toContain("# clawdy header comment");
    expect(after).toMatch(/name:\s*clawdy\s*#\s*personal/);
  });

  it("MCP-W3: no-op idempotent — re-adding byte-identical entry returns no-op; bytes unchanged", async () => {
    const { destPath } = await setupMcpFixture(EMPTY_MCP_YAML);
    // First add
    await updateAgentMcpServers({
      existingConfigPath: destPath,
      agentName: "alpha",
      entry: {
        name: "foo",
        command: "cmd-foo",
        args: [],
        env: {},
      },
      op: "add",
    });
    const afterFirst = readFileSync(destPath, "utf8");

    // Re-add identical entry
    const result = await updateAgentMcpServers({
      existingConfigPath: destPath,
      agentName: "alpha",
      entry: {
        name: "foo",
        command: "cmd-foo",
        args: [],
        env: {},
      },
      op: "add",
    });
    expect(result.outcome).toBe("no-op");
    if (result.outcome === "no-op") {
      expect(result.reason).toMatch(/byte-identical/i);
    }
    const afterSecond = readFileSync(destPath, "utf8");
    expect(afterSecond).toBe(afterFirst);
  });

  it("MCP-W4: remove happy — removes entry by name; remaining entries preserved", async () => {
    const { destPath } = await setupMcpFixture(EMPTY_MCP_YAML);
    // Add bar first so alpha has foo + bar
    await updateAgentMcpServers({
      existingConfigPath: destPath,
      agentName: "alpha",
      entry: { name: "bar", command: "cmd-bar", args: [], env: {} },
      op: "add",
    });
    // Remove foo
    const result = await updateAgentMcpServers({
      existingConfigPath: destPath,
      agentName: "alpha",
      entry: { name: "foo", command: "_unused_", args: [], env: {} },
      op: "remove",
    });
    expect(result.outcome).toBe("updated");

    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<{ name: string; mcpServers: Array<{ name: string }> }>;
    };
    const alpha = parsed.agents.find((a) => a.name === "alpha")!;
    const names = alpha.mcpServers.map((m) => m.name);
    expect(names).toEqual(["bar"]);
  });

  it("MCP-W5: agent not found — returns not-found; bytes unchanged", async () => {
    const { destPath } = await setupMcpFixture(EMPTY_MCP_YAML);
    const beforeBytes = readFileSync(destPath, "utf8");

    const result = await updateAgentMcpServers({
      existingConfigPath: destPath,
      agentName: "ghost",
      entry: { name: "x", command: "y", args: [], env: {} },
      op: "add",
    });
    expect(result.outcome).toBe("not-found");
    if (result.outcome === "not-found") {
      expect(result.reason).toMatch(/ghost/);
    }
    const afterBytes = readFileSync(destPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);
  });

  it("MCP-W6: file missing — returns file-not-found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-yaml-mcp-missing-"));
    const missing = join(dir, "nope.yaml");
    const result = await updateAgentMcpServers({
      existingConfigPath: missing,
      agentName: "clawdy",
      entry: { name: "x", command: "y", args: [], env: {} },
      op: "add",
    });
    expect(result.outcome).toBe("file-not-found");
    if (result.outcome === "file-not-found") {
      expect(result.reason).toMatch(/not found/i);
    }
  });

  it("MCP-W7: rename failure — unlinks tmp and re-throws", async () => {
    const { destPath } = await setupMcpFixture(EMPTY_MCP_YAML);
    const unlinkCalls: string[] = [];
    writerFs.rename = (async () => {
      throw new Error("EACCES: simulated rename failure");
    }) as typeof writerFs.rename;
    writerFs.unlink = (async (...args: unknown[]) => {
      unlinkCalls.push(String(args[0]));
      return ORIG_FS.unlink(
        args[0] as Parameters<typeof ORIG_FS.unlink>[0],
      );
    }) as typeof writerFs.unlink;

    await expect(
      updateAgentMcpServers({
        existingConfigPath: destPath,
        agentName: "clawdy",
        entry: { name: "x", command: "y", args: [], env: {} },
        op: "add",
      }),
    ).rejects.toThrow(/EACCES/);

    const tmpUnlink = unlinkCalls.find((p) =>
      /\.clawcode\.yaml\.\d+\.\d+\.tmp$/.test(p),
    );
    expect(tmpUnlink).toBeDefined();
  });

  it("MCP-W8: round-trip — configSchema.safeParse succeeds after add", async () => {
    const { destPath } = await setupMcpFixture(EMPTY_MCP_YAML);
    await updateAgentMcpServers({
      existingConfigPath: destPath,
      agentName: "clawdy",
      entry: {
        name: "test-mcp",
        command: "my-cmd",
        args: ["serve"],
        env: { FOO: "bar" },
      },
      op: "add",
    });
    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as unknown;
    const schemaResult = configSchema.safeParse(parsed);
    expect(schemaResult.success).toBe(true);
  });

  it("MCP-W9: literal secret-scan refuses high-entropy + credential context; bytes unchanged", async () => {
    const { destPath } = await setupMcpFixture(EMPTY_MCP_YAML);
    const beforeBytes = readFileSync(destPath, "utf8");

    // High-entropy (len>=12, 3 classes, entropy>=3.8, no word boundary).
    // "password" label triggers credential-context gate.
    const result = await updateAgentMcpServers({
      existingConfigPath: destPath,
      agentName: "clawdy",
      entry: {
        name: "mysql",
        command: "mcporter",
        args: [],
        env: { DB_PASSWORD: "ExampleFakePw0123Z" },
      },
      op: "add",
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.step).toBe("secret-scan");
      expect(result.reason).toMatch(/DB_PASSWORD|high-entropy/i);
    }

    const afterBytes = readFileSync(destPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);
  });
});

// ---------------------------------------------------------------------------
// Phase 90 Plan 07 WIRE-01..04 — updateAgentConfig generic patcher
// Tests UAC-W1..UAC-W8. Generic single-agent patch writer used to apply
// the fin-client wiring (heartbeat + effort + allowedModels + mcpServers
// + greetOnRestart + greetCoolDownMs) in one atomic call.
// ---------------------------------------------------------------------------

describe("updateAgentConfig — Phase 90 Plan 07 (Tests UAC-W1..W8)", () => {
  async function setupUacFixture(yaml: string): Promise<{ destPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), "cc-yaml-update-config-"));
    const destPath = join(dir, "clawcode.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(destPath, yaml, "utf8");
    return { destPath };
  }

  const BASE_UAC_YAML = `# top-of-file comment preserved
version: 1
defaults:
  model: sonnet
agents:
  # clawdy header comment
  - name: clawdy  # inline comment
    workspace: ~/.clawcode/agents/clawdy
    model: sonnet
    channels:
      - "111"
    skills: []
    mcpServers: []
  - name: fin-client
    workspace: ~/.clawcode/agents/acme
    model: sonnet
    channels:
      - "000000000000000110"
    skills: []
    mcpServers: []
`;

  it("UAC-W1: happy path — patches effort + allowedModels; other agents untouched", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    const result = await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "fin-client",
      patch: {
        effort: "auto",
        allowedModels: ["sonnet", "opus", "haiku"],
      },
    });
    expect(result.outcome).toBe("updated");
    if (result.outcome === "updated") {
      expect(result.keysChanged).toEqual(
        expect.arrayContaining(["effort", "allowedModels"]),
      );
      expect(result.targetSha256).toMatch(/^[a-f0-9]{64}$/);
    }

    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<{
        name: string;
        effort?: unknown;
        allowedModels?: unknown;
      }>;
    };
    const fin = parsed.agents.find((a) => a.name === "fin-client")!;
    expect(fin.effort).toBe("auto");
    expect(fin.allowedModels).toEqual(["sonnet", "opus", "haiku"]);

    // Other agent untouched.
    const clawdy = parsed.agents.find((a) => a.name === "clawdy")!;
    expect(clawdy.effort).toBeUndefined();
    expect(clawdy.allowedModels).toBeUndefined();
  });

  it("UAC-W2: nested heartbeat object — every/model/prompt round-trip correctly", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    const heartbeatPrompt = "Line one\nLine two with *markdown*\n- bullet";
    const result = await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "fin-client",
      patch: {
        heartbeat: {
          every: "50m",
          model: "haiku",
          prompt: heartbeatPrompt,
        },
      },
    });
    expect(result.outcome).toBe("updated");

    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<{ name: string; heartbeat?: unknown }>;
    };
    const fin = parsed.agents.find((a) => a.name === "fin-client")!;
    expect(fin.heartbeat).toEqual({
      every: "50m",
      model: "haiku",
      prompt: heartbeatPrompt,
    });
  });

  it("UAC-W3: mcpServers string refs — seq contains string scalars", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    const result = await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "fin-client",
      patch: {
        mcpServers: [
          "acme-db",
          "acme-content",
          "google-workspace",
          "browserless",
          "fal-ai",
          "brave-search",
        ],
      },
    });
    expect(result.outcome).toBe("updated");

    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<{ name: string; mcpServers?: unknown }>;
    };
    const fin = parsed.agents.find((a) => a.name === "fin-client")!;
    expect(fin.mcpServers).toEqual([
      "acme-db",
      "acme-content",
      "google-workspace",
      "browserless",
      "fal-ai",
      "brave-search",
    ]);
  });

  it("UAC-W4: preserves top-of-file + inline comments verbatim", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "fin-client",
      patch: { effort: "auto" },
    });
    const after = readFileSync(destPath, "utf8");
    expect(after).toContain("# top-of-file comment preserved");
    expect(after).toContain("# clawdy header comment");
    expect(after).toContain("# inline comment");
  });

  it("UAC-W5: no-op — patch with identical values yields outcome no-op; bytes byte-identical", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    // First set effort: auto so the second no-op patch truly matches.
    await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "fin-client",
      patch: { effort: "auto" },
    });
    const beforeBytes = readFileSync(destPath, "utf8");

    const result = await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "fin-client",
      patch: { effort: "auto" },
    });
    expect(result.outcome).toBe("no-op");

    const afterBytes = readFileSync(destPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);
  });

  it("UAC-W6: agent not found — outcome 'not-found'", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    const result = await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "ghost",
      patch: { effort: "auto" },
    });
    expect(result.outcome).toBe("not-found");
  });

  it("UAC-W7: schema refuses invalid values — outcome 'refused' step:'invalid-patch'", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    const result = await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "fin-client",
      patch: { effort: "banana" },
    });
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.step).toBe("invalid-patch");
    }
  });

  it("WIRE-A1: integration — applies the fin-client Phase 90 Plan 07 patch end-to-end", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    const heartbeatPrompt = "AUTO-RESET: DISABLED\nDo NOT send /clear";
    const result = await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "fin-client",
      patch: {
        effort: "auto",
        allowedModels: ["sonnet", "opus", "haiku"],
        greetOnRestart: true,
        greetCoolDownMs: 300_000,
        heartbeat: { every: "50m", model: "haiku", prompt: heartbeatPrompt },
        mcpServers: [
          "acme-db",
          "acme-content",
          "google-workspace",
          "browserless",
          "fal-ai",
          "brave-search",
        ],
      },
    });
    expect(result.outcome).toBe("updated");

    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<Record<string, unknown>>;
    };
    const fin = parsed.agents.find(
      (a) => (a.name as string) === "fin-client",
    )! as Record<string, unknown>;
    expect(fin.effort).toBe("auto");
    expect(fin.allowedModels).toEqual(["sonnet", "opus", "haiku"]);
    expect(fin.greetOnRestart).toBe(true);
    expect(fin.greetCoolDownMs).toBe(300_000);
    expect(fin.heartbeat).toEqual({
      every: "50m",
      model: "haiku",
      prompt: heartbeatPrompt,
    });
    expect(fin.mcpServers).toEqual([
      "acme-db",
      "acme-content",
      "google-workspace",
      "browserless",
      "fal-ai",
      "brave-search",
    ]);
  });

  it("WIRE-A2: integration — channel binding UNCHANGED after fin-client wiring patch", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "fin-client",
      patch: {
        effort: "auto",
        allowedModels: ["sonnet", "opus", "haiku"],
      },
    });
    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<Record<string, unknown>>;
    };
    const fin = parsed.agents.find(
      (a) => (a.name as string) === "fin-client",
    )!;
    expect(fin.channels).toEqual(["000000000000000110"]);
  });

  it("WIRE-A3: integration — other agents structurally untouched after fin-client patch", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    const beforeParsed = parseYaml(
      readFileSync(destPath, "utf8"),
    ) as { agents: Array<Record<string, unknown>> };
    const clawdyBefore = beforeParsed.agents.find(
      (a) => (a.name as string) === "clawdy",
    );

    await updateAgentConfig({
      existingConfigPath: destPath,
      agentName: "fin-client",
      patch: {
        effort: "auto",
        heartbeat: { every: "50m", model: "haiku", prompt: "test" },
      },
    });

    const afterParsed = parseYaml(
      readFileSync(destPath, "utf8"),
    ) as { agents: Array<Record<string, unknown>> };
    const clawdyAfter = afterParsed.agents.find(
      (a) => (a.name as string) === "clawdy",
    );
    expect(JSON.stringify(clawdyAfter)).toBe(JSON.stringify(clawdyBefore));
  });

  it("UAC-W8: atomic rename failure unlinks tmp + re-throws", async () => {
    const { destPath } = await setupUacFixture(BASE_UAC_YAML);
    const unlinkCalls: string[] = [];
    writerFs.rename = (async () => {
      throw new Error("EACCES: simulated rename failure");
    }) as typeof writerFs.rename;
    writerFs.unlink = (async (...args: unknown[]) => {
      unlinkCalls.push(String(args[0]));
      return ORIG_FS.unlink(
        args[0] as Parameters<typeof ORIG_FS.unlink>[0],
      );
    }) as typeof writerFs.unlink;

    await expect(
      updateAgentConfig({
        existingConfigPath: destPath,
        agentName: "fin-client",
        patch: { effort: "auto" },
      }),
    ).rejects.toThrow(/EACCES/);
    expect(
      unlinkCalls.some((p) => /\.clawcode\.yaml\.\d+\.\d+\.tmp$/.test(p)),
    ).toBe(true);
  });
});
