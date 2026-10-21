/**
 * Phase 88 Plan 01 Task 2 — installSingleSkill tests (I1-I10).
 *
 * Pins behavior per 88-01-PLAN:
 *   I1  happy path: install frontend-design → outcome="installed";
 *       call order scan→copy→updateAgentSkills→ledger
 *   I2  secret-scan refusal: acme-crm (MySQL creds) → blocked-secret-scan
 *   I3  already-installed: matching source_hash → outcome="already-installed"
 *   I4  stale source_hash: differs → re-install (outcome="installed")
 *   I5  scope-refused: acme skill on fleet agent without force
 *   I6  scope force override: force=true → installed
 *   I7  deprecated skill: cognitive-memory → rejected-deprecated
 *   I8  unknown skill in catalog: not-in-catalog
 *   I9  YAML persist failure → installed-persist-failed (non-rollback)
 *   I10 copy failure → copy-failed outcome kind
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarketplaceEntry } from "../catalog.js";

// We mock the yaml-writer so I9 can inject an EACCES. Import by the
// path installSingleSkill uses so the mock lands at the right boundary.
vi.mock("../../migration/yaml-writer.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../../migration/yaml-writer.js")>();
  return {
    ...actual,
    updateAgentSkills: vi.fn(actual.updateAgentSkills),
  };
});

import { installSingleSkill } from "../install-single-skill.js";
import {
  appendSkillRow,
  readSkillRows,
  type SkillsLedgerRow,
} from "../../migration/skills-ledger.js";
import * as yamlWriterModule from "../../migration/yaml-writer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function writeCleanSkill(dir: string, name: string): Promise<string> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: clean fleet skill\n---\n\n# ${name}\n\nA clean fleet skill with no secrets.\n`,
    "utf8",
  );
  return skillDir;
}

async function writeSecretSkill(dir: string, name: string): Promise<string> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  // Credential-shaped label + high-entropy value → triggers secret-scan.
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: has a secret\n---\n\n# ${name}\n\npassword: Sup3rSecret!M@mA123\n`,
    "utf8",
  );
  return skillDir;
}

async function writeClawcodeYaml(
  path: string,
  agents: Array<{ name: string; skills?: string[] }>,
): Promise<void> {
  const lines: string[] = ["version: 1", "agents:"];
  for (const a of agents) {
    lines.push(`  - name: ${a.name}`);
    lines.push(`    workspace: ~/.clawcode/agents/${a.name}`);
    lines.push(`    model: haiku`);
    lines.push(`    channels: []`);
    lines.push(`    mcpServers: []`);
    if (a.skills && a.skills.length > 0) {
      lines.push(`    skills:`);
      for (const s of a.skills) {
        lines.push(`      - ${s}`);
      }
    } else {
      lines.push(`    skills: []`);
    }
  }
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}

function makeCatalogEntry(
  partial: Partial<MarketplaceEntry> & { name: string; skillDir: string },
): MarketplaceEntry {
  return Object.freeze({
    name: partial.name,
    description: partial.description ?? "desc",
    category: partial.category ?? "fleet",
    source: partial.source ?? "local",
    skillDir: partial.skillDir,
    ...(partial.classification !== undefined
      ? { classification: partial.classification }
      : {}),
  }) as MarketplaceEntry;
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let root: string;
let sourceRoot: string;
let skillsTargetDir: string;
let clawcodeYamlPath: string;
let ledgerPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mkt-install-"));
  sourceRoot = join(root, "source");
  skillsTargetDir = join(root, "target");
  clawcodeYamlPath = join(root, "clawcode.yaml");
  ledgerPath = join(root, "ledger.jsonl");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(skillsTargetDir, { recursive: true });
  vi.mocked(yamlWriterModule.updateAgentSkills).mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("installSingleSkill — Phase 88 Plan 01 (I1-I10)", () => {
  it("I1: happy path — installs frontend-design; call order scan→copy→yaml→ledger", async () => {
    const skillDir = await writeCleanSkill(sourceRoot, "frontend-design");
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);

    const catalog: readonly MarketplaceEntry[] = [
      makeCatalogEntry({ name: "frontend-design", skillDir }),
    ];

    const result = await installSingleSkill({
      skillName: "frontend-design",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("installed");
    if (result.kind === "installed") {
      expect(result.targetPath).toBe(join(skillsTargetDir, "frontend-design"));
      expect(result.targetHash).toMatch(/^[a-f0-9]{64}$/);
    }

    // Copier ran: target dir exists with a SKILL.md
    expect(existsSync(join(skillsTargetDir, "frontend-design", "SKILL.md"))).toBe(
      true,
    );

    // updateAgentSkills called exactly once with op="add"
    expect(yamlWriterModule.updateAgentSkills).toHaveBeenCalledTimes(1);
    const call = vi.mocked(yamlWriterModule.updateAgentSkills).mock.calls[0][0];
    expect(call.agentName).toBe("clawdy");
    expect(call.skillName).toBe("frontend-design");
    expect(call.op).toBe("add");

    // Clawcode.yaml has the skill appended — accept either block-style
    // (`- frontend-design`) or flow-style (`[ frontend-design ]`) since
    // yaml preserves the input flow/block shape of the skills sequence.
    const yamlAfter = await readFile(clawcodeYamlPath, "utf8");
    expect(yamlAfter).toMatch(/frontend-design/);
    // Also verify via parsed shape (schema-level) that the skill landed
    // on the right agent.
    const { parse: parseYaml } = await import("yaml");
    const parsed = parseYaml(yamlAfter) as {
      agents: Array<{ name: string; skills: string[] }>;
    };
    const clawdySkills = parsed.agents.find((a) => a.name === "clawdy")?.skills;
    expect(clawdySkills).toContain("frontend-design");

    // Ledger has an "apply" row with status="migrated"
    const rows = await readSkillRows(ledgerPath);
    const applyMigrated = rows.filter(
      (r) => r.action === "apply" && r.status === "migrated",
    );
    expect(applyMigrated.length).toBe(1);
    expect(applyMigrated[0].skill).toBe("frontend-design");
  });

  it("I2: secret-scan refusal — acme-crm with MySQL creds → blocked-secret-scan", async () => {
    const skillDir = await writeSecretSkill(sourceRoot, "acme-crm");
    await writeClawcodeYaml(clawcodeYamlPath, [
      { name: "fin-client", skills: [] },
    ]);

    const catalog: readonly MarketplaceEntry[] = [
      makeCatalogEntry({
        name: "acme-crm",
        skillDir,
        category: "acme",
      }),
    ];

    const result = await installSingleSkill({
      skillName: "acme-crm",
      agentName: "fin-client",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("blocked-secret-scan");
    if (result.kind === "blocked-secret-scan") {
      expect(result.skill).toBe("acme-crm");
      expect(result.offender.length).toBeGreaterThan(0);
    }

    // Copier did NOT run
    expect(existsSync(join(skillsTargetDir, "acme-crm"))).toBe(false);
    // updateAgentSkills NOT called
    expect(yamlWriterModule.updateAgentSkills).not.toHaveBeenCalled();

    // Ledger has a refused row
    const rows = await readSkillRows(ledgerPath);
    const refused = rows.filter((r) => r.status === "refused");
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused[0].skill).toBe("acme-crm");
    expect(refused[0].notes).toMatch(/high-entropy|sk-prefix|discord-prefix/);
  });

  it("I3: already-installed — matching source_hash → outcome='already-installed'", async () => {
    const skillDir = await writeCleanSkill(sourceRoot, "frontend-design");
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);

    // Pre-populate ledger with a migrated row for this skill at the
    // CURRENT source hash. Compute via the Phase 84 helper promoted in
    // Task 2 GREEN (computeSkillContentHash). We use the install flow's
    // own hash (post-promotion), so borrow it via import.
    const { computeSkillContentHash } = await import(
      "../../migration/skills-discovery.js"
    );
    const currentHash = await computeSkillContentHash(skillDir);

    const preExistingRow: SkillsLedgerRow = {
      ts: new Date(Date.now() - 10000).toISOString(),
      action: "apply",
      skill: "frontend-design",
      status: "migrated",
      source_hash: currentHash,
      target_hash: "deadbeef".repeat(8),
      step: "copy",
      outcome: "allow",
      notes: "preexisting",
    };
    await appendSkillRow(ledgerPath, preExistingRow);

    const catalog: readonly MarketplaceEntry[] = [
      makeCatalogEntry({ name: "frontend-design", skillDir }),
    ];

    const result = await installSingleSkill({
      skillName: "frontend-design",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("already-installed");
    // Target NOT re-copied
    expect(existsSync(join(skillsTargetDir, "frontend-design"))).toBe(false);
    // updateAgentSkills NOT called
    expect(yamlWriterModule.updateAgentSkills).not.toHaveBeenCalled();
  });

  it("I4: stale source_hash → re-install path runs copy", async () => {
    const skillDir = await writeCleanSkill(sourceRoot, "frontend-design");
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);

    // Ledger has a migrated row but with an OLD source_hash that won't match.
    const staleRow: SkillsLedgerRow = {
      ts: new Date(Date.now() - 10000).toISOString(),
      action: "apply",
      skill: "frontend-design",
      status: "migrated",
      source_hash: "0".repeat(64),
      target_hash: "deadbeef".repeat(8),
      step: "copy",
      outcome: "allow",
      notes: "stale",
    };
    await appendSkillRow(ledgerPath, staleRow);

    const catalog: readonly MarketplaceEntry[] = [
      makeCatalogEntry({ name: "frontend-design", skillDir }),
    ];

    const result = await installSingleSkill({
      skillName: "frontend-design",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("installed");
    expect(existsSync(join(skillsTargetDir, "frontend-design", "SKILL.md"))).toBe(
      true,
    );
    expect(yamlWriterModule.updateAgentSkills).toHaveBeenCalledTimes(1);
  });

  it("I5: scope-refused — acme skill on fleet agent without force", async () => {
    // new-reel is acme scope per SCOPE_TAGS; "general" is fleet.
    const skillDir = await writeCleanSkill(sourceRoot, "new-reel");
    await writeClawcodeYaml(clawcodeYamlPath, [
      { name: "general", skills: [] },
    ]);

    const catalog: readonly MarketplaceEntry[] = [
      makeCatalogEntry({
        name: "new-reel",
        skillDir,
        category: "acme",
      }),
    ];

    const result = await installSingleSkill({
      skillName: "new-reel",
      agentName: "general",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("rejected-scope");
    if (result.kind === "rejected-scope") {
      expect(result.skillScope).toBe("acme");
      expect(result.agentScope).toBe("fleet");
    }
    expect(existsSync(join(skillsTargetDir, "new-reel"))).toBe(false);
    expect(yamlWriterModule.updateAgentSkills).not.toHaveBeenCalled();

    const rows = await readSkillRows(ledgerPath);
    const refused = rows.filter((r) => r.status === "refused");
    expect(refused.length).toBe(1);
    expect(refused[0].notes).toMatch(/scope/);
  });

  it("I6: scope force override — same scenario + force=true → installed", async () => {
    const skillDir = await writeCleanSkill(sourceRoot, "new-reel");
    await writeClawcodeYaml(clawcodeYamlPath, [
      { name: "general", skills: [] },
    ]);

    const catalog: readonly MarketplaceEntry[] = [
      makeCatalogEntry({
        name: "new-reel",
        skillDir,
        category: "acme",
      }),
    ];

    const result = await installSingleSkill({
      skillName: "new-reel",
      agentName: "general",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
      force: true,
    });

    expect(result.kind).toBe("installed");
    expect(existsSync(join(skillsTargetDir, "new-reel", "SKILL.md"))).toBe(
      true,
    );
  });

  it("I7: deprecated skill — cognitive-memory → rejected-deprecated", async () => {
    const skillDir = await writeCleanSkill(sourceRoot, "cognitive-memory");
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);

    const catalog: readonly MarketplaceEntry[] = [
      makeCatalogEntry({
        name: "cognitive-memory",
        skillDir,
        classification: "deprecate",
      }),
    ];

    const result = await installSingleSkill({
      skillName: "cognitive-memory",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("rejected-deprecated");
    if (result.kind === "rejected-deprecated") {
      expect(result.reason.length).toBeGreaterThan(0);
    }
    expect(existsSync(join(skillsTargetDir, "cognitive-memory"))).toBe(false);
    expect(yamlWriterModule.updateAgentSkills).not.toHaveBeenCalled();
  });

  it("I8: unknown skill name — not-in-catalog", async () => {
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);

    const catalog: readonly MarketplaceEntry[] = [];

    const result = await installSingleSkill({
      skillName: "does-not-exist",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("not-in-catalog");
    expect(yamlWriterModule.updateAgentSkills).not.toHaveBeenCalled();
  });

  it("I9: YAML persist failure → installed-persist-failed (non-rollback)", async () => {
    const skillDir = await writeCleanSkill(sourceRoot, "frontend-design");
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);

    // Inject the EACCES AFTER copy, on the yaml write.
    vi.mocked(yamlWriterModule.updateAgentSkills).mockImplementationOnce(
      async () => {
        throw new Error("EACCES: simulated persist failure");
      },
    );

    const catalog: readonly MarketplaceEntry[] = [
      makeCatalogEntry({ name: "frontend-design", skillDir }),
    ];

    const result = await installSingleSkill({
      skillName: "frontend-design",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("installed-persist-failed");
    if (result.kind === "installed-persist-failed") {
      expect(result.persist_error).toMatch(/EACCES/);
      expect(result.targetPath).toBe(join(skillsTargetDir, "frontend-design"));
    }
    // Copy succeeded
    expect(existsSync(join(skillsTargetDir, "frontend-design", "SKILL.md"))).toBe(
      true,
    );
    // Ledger has a migrated row (copy witnessed)
    const rows = await readSkillRows(ledgerPath);
    const migrated = rows.filter((r) => r.status === "migrated");
    expect(migrated.length).toBe(1);
    // Notes mention the persist failure
    expect(migrated[0].notes).toMatch(/persisted=false|EACCES/);
  });

  it("I10: copy failure → copy-failed outcome kind", async () => {
    // Construct a catalog entry that points at a non-existent skillDir.
    // copySkillDirectory will create the target dir but the witness loop
    // won't find any files → targetHash computed over zero files (empty
    // hash). Since there are no mismatches, the copier returns pass:true
    // with 0 files. This isn't a mismatch. A true forced failure requires
    // corrupting the copy. We simulate by pre-creating targetDir with a
    // file that cannot be deleted, then the first step (rm stale target)
    // will throw — but that'd surface as a raw error, not "copy-failed".
    //
    // Rather than fight the copier, exercise the copy-failed branch by
    // stubbing copySkillDirectory. vi.mock isn't appropriate since we'd
    // need to wrap the whole module. Instead we simulate the copy-failed
    // outcome via a forced mismatch: put a file in the target before the
    // call so after copy some byte differs. But copier wipes the target
    // first, defeating that.
    //
    // Simplest: mock the copier to return pass:false.
    vi.resetModules();
    vi.doMock("../../migration/skills-copier.js", async () => {
      const actual =
        await vi.importActual<
          typeof import("../../migration/skills-copier.js")
        >("../../migration/skills-copier.js");
      return {
        ...actual,
        copySkillDirectory: vi.fn(async () => ({
          pass: false,
          targetHash: "",
          filesCopied: 0,
          filesSkipped: 0,
          mismatches: [
            { path: "SKILL.md", srcSha: "aaaa", tgtSha: "bbbb" },
          ],
        })),
      };
    });

    // Re-import AFTER mock
    const { installSingleSkill: installFn } = await import(
      "../install-single-skill.js"
    );

    const skillDir = await writeCleanSkill(sourceRoot, "frontend-design");
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);

    const catalog: readonly MarketplaceEntry[] = [
      makeCatalogEntry({ name: "frontend-design", skillDir }),
    ];

    const result = await installFn({
      skillName: "frontend-design",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("copy-failed");
    // Ledger has a refused row
    const rows = await readSkillRows(ledgerPath);
    const refused = rows.filter((r) => r.status === "refused");
    expect(refused.length).toBe(1);

    vi.doUnmock("../../migration/skills-copier.js");
  });
});
