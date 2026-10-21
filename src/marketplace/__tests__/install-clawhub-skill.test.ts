/**
 * Phase 90 Plan 04 Task 2 — installSingleSkill ClawHub branch tests.
 *
 * HUB-INS-1..6 per 90-04-PLAN:
 *   HUB-INS-1  happy path: ClawHub catalog entry → outcome="installed"
 *              (staging → download → scan → normalize → scope → copy →
 *              updateAgentSkills → ledger → staging cleanup).
 *   HUB-INS-2  ClawhubRateLimitedError during download → outcome="rate-limited".
 *   HUB-INS-3  ClawhubAuthRequiredError → outcome="auth-required".
 *   HUB-INS-4  Manifest invalid (no SKILL.md in tarball) → outcome="manifest-invalid".
 *   HUB-INS-5  Secret-scan fail → outcome="blocked-secret-scan".
 *   HUB-INS-6  Happy path → final state includes updateAgentSkills add, target
 *              dir populated, staging dir cleaned up.
 *   HUB-OUT-1  Type-level exhaustive-switch compile enforcement for all 11
 *              SkillInstallOutcome variants (assertion at compile time only).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MarketplaceEntry } from "../catalog.js";

const execFileP = promisify(execFile);

// Mock both clawhub-client (for download mocking) and yaml-writer (spy add).
vi.mock("../clawhub-client.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../clawhub-client.js")>();
  return {
    ...actual,
    downloadClawhubSkill: vi.fn(),
  };
});
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
  ClawhubAuthRequiredError,
  ClawhubRateLimitedError,
} from "../clawhub-client.js";
import * as clawhubClient from "../clawhub-client.js";
import * as yamlWriterModule from "../../migration/yaml-writer.js";
import { readSkillRows } from "../../migration/skills-ledger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Prepare a "extractedDir" on disk representing a ClawHub-staged skill —
 * this is what downloadClawhubSkill would produce. Contents mirror the
 * Phase 88 writeCleanSkill fixture so the downstream secret-scan + scope
 * gate behave identically.
 */
async function prepareStagedSkill(
  stagingRoot: string,
  skillName: string,
  body: string,
): Promise<{ extractedDir: string; files: string[] }> {
  const extractedDir = join(stagingRoot, "extracted");
  await mkdir(extractedDir, { recursive: true });
  await writeFile(
    join(extractedDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: clean clawhub skill\n---\n\n${body}\n`,
    "utf8",
  );
  return { extractedDir, files: [join(extractedDir, "SKILL.md")] };
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

function makeClawhubCatalogEntry(
  name: string,
  opts?: { description?: string; category?: "acme" | "personal" | "fleet" },
): MarketplaceEntry {
  return Object.freeze({
    name,
    description: opts?.description ?? "clawhub skill description",
    category: opts?.category ?? "fleet",
    source: Object.freeze({
      kind: "clawhub" as const,
      baseUrl: "https://clawhub.ai",
      downloadUrl: `https://clawhub.ai/skills/${name}.tar.gz`,
      version: "1.0.0",
    }),
    skillDir: "",
  }) as MarketplaceEntry;
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let root: string;
let stagingRoot: string;
let skillsTargetDir: string;
let clawcodeYamlPath: string;
let ledgerPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mkt-clawhub-install-"));
  stagingRoot = join(root, "staging");
  skillsTargetDir = join(root, "target");
  clawcodeYamlPath = join(root, "clawcode.yaml");
  ledgerPath = join(root, "ledger.jsonl");
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(skillsTargetDir, { recursive: true });
  vi.mocked(yamlWriterModule.updateAgentSkills).mockClear();
  vi.mocked(clawhubClient.downloadClawhubSkill).mockReset();
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

describe("installSingleSkill — ClawHub branch (Phase 90 Plan 04 HUB-INS-1..6)", () => {
  it("HUB-INS-1: happy path — ClawHub entry → download→scan→copy→yaml→ledger → outcome='installed'; staging cleaned up", async () => {
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);

    // Track the staging dir the installer chose — we assert cleanup.
    const stagedByInstaller: string[] = [];
    vi.mocked(clawhubClient.downloadClawhubSkill).mockImplementationOnce(
      async (args) => {
        stagedByInstaller.push(args.stagingDir);
        return prepareStagedSkill(args.stagingDir, "clawhub-skill", "A clean clawhub skill with no secrets.");
      },
    );

    const catalog: readonly MarketplaceEntry[] = [
      makeClawhubCatalogEntry("clawhub-skill"),
    ];

    const result = await installSingleSkill({
      skillName: "clawhub-skill",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("installed");
    if (result.kind === "installed") {
      expect(result.targetPath).toBe(join(skillsTargetDir, "clawhub-skill"));
      expect(result.targetHash).toMatch(/^[a-f0-9]{64}$/);
    }
    // Target skill dir present
    expect(existsSync(join(skillsTargetDir, "clawhub-skill", "SKILL.md"))).toBe(true);
    // updateAgentSkills called with op="add"
    expect(yamlWriterModule.updateAgentSkills).toHaveBeenCalledTimes(1);
    const call = vi.mocked(yamlWriterModule.updateAgentSkills).mock.calls[0][0];
    expect(call.agentName).toBe("clawdy");
    expect(call.skillName).toBe("clawhub-skill");
    expect(call.op).toBe("add");
    // Staging dir cleaned up
    for (const s of stagedByInstaller) {
      expect(existsSync(s)).toBe(false);
    }
    // Ledger has a migrated row
    const rows = await readSkillRows(ledgerPath);
    const migrated = rows.filter(
      (r) => r.action === "apply" && r.status === "migrated",
    );
    expect(migrated).toHaveLength(1);
    expect(migrated[0].skill).toBe("clawhub-skill");
  });

  it("HUB-INS-2: ClawhubRateLimitedError during download → outcome='rate-limited'; staging cleaned", async () => {
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);
    const stagedByInstaller: string[] = [];
    vi.mocked(clawhubClient.downloadClawhubSkill).mockImplementationOnce(
      async (args) => {
        stagedByInstaller.push(args.stagingDir);
        // Simulate: staging dir was created by downloadClawhubSkill
        // before the 429 fired; installer's finally must still clean it.
        await mkdir(args.stagingDir, { recursive: true });
        throw new ClawhubRateLimitedError(60_000, "rate-limited");
      },
    );

    const catalog: readonly MarketplaceEntry[] = [
      makeClawhubCatalogEntry("rate-limited-skill"),
    ];

    const result = await installSingleSkill({
      skillName: "rate-limited-skill",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("rate-limited");
    if (result.kind === "rate-limited") {
      expect(result.retryAfterMs).toBe(60_000);
    }
    expect(yamlWriterModule.updateAgentSkills).not.toHaveBeenCalled();
    // Staging cleaned
    for (const s of stagedByInstaller) {
      expect(existsSync(s)).toBe(false);
    }
  });

  it("HUB-INS-3: ClawhubAuthRequiredError → outcome='auth-required'; staging cleaned", async () => {
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);
    const stagedByInstaller: string[] = [];
    vi.mocked(clawhubClient.downloadClawhubSkill).mockImplementationOnce(
      async (args) => {
        stagedByInstaller.push(args.stagingDir);
        await mkdir(args.stagingDir, { recursive: true });
        throw new ClawhubAuthRequiredError("auth required (403)");
      },
    );

    const catalog: readonly MarketplaceEntry[] = [
      makeClawhubCatalogEntry("auth-required-skill"),
    ];

    const result = await installSingleSkill({
      skillName: "auth-required-skill",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("auth-required");
    if (result.kind === "auth-required") {
      expect(result.reason).toMatch(/auth required/);
    }
    expect(yamlWriterModule.updateAgentSkills).not.toHaveBeenCalled();
    for (const s of stagedByInstaller) {
      expect(existsSync(s)).toBe(false);
    }
  });

  it("HUB-INS-4: manifest-invalid — tarball missing SKILL.md → outcome='manifest-invalid'; staging cleaned", async () => {
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);
    const stagedByInstaller: string[] = [];
    vi.mocked(clawhubClient.downloadClawhubSkill).mockImplementationOnce(
      async (args) => {
        stagedByInstaller.push(args.stagingDir);
        // Create an extracted dir but no SKILL.md inside.
        const extracted = join(args.stagingDir, "extracted");
        await mkdir(extracted, { recursive: true });
        await writeFile(join(extracted, "random.txt"), "no skill here", "utf8");
        return { extractedDir: extracted, files: [join(extracted, "random.txt")] };
      },
    );

    const catalog: readonly MarketplaceEntry[] = [
      makeClawhubCatalogEntry("bad-manifest-skill"),
    ];

    const result = await installSingleSkill({
      skillName: "bad-manifest-skill",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("manifest-invalid");
    if (result.kind === "manifest-invalid") {
      expect(result.reason).toMatch(/SKILL\.md/i);
    }
    expect(yamlWriterModule.updateAgentSkills).not.toHaveBeenCalled();
    for (const s of stagedByInstaller) {
      expect(existsSync(s)).toBe(false);
    }
  });

  it("HUB-INS-5: secret-scan fail on ClawHub-downloaded SKILL.md → outcome='blocked-secret-scan'; no target written", async () => {
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);
    const stagedByInstaller: string[] = [];
    vi.mocked(clawhubClient.downloadClawhubSkill).mockImplementationOnce(
      async (args) => {
        stagedByInstaller.push(args.stagingDir);
        const extracted = join(args.stagingDir, "extracted");
        await mkdir(extracted, { recursive: true });
        // High-entropy + credential context → secret-scan refuses
        await writeFile(
          join(extracted, "SKILL.md"),
          `---\nname: secret-skill\ndescription: has a secret\n---\n\npassword: Sup3rSecret!M@mA123\n`,
          "utf8",
        );
        return { extractedDir: extracted, files: [join(extracted, "SKILL.md")] };
      },
    );

    const catalog: readonly MarketplaceEntry[] = [
      makeClawhubCatalogEntry("secret-skill"),
    ];

    const result = await installSingleSkill({
      skillName: "secret-skill",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("blocked-secret-scan");
    expect(existsSync(join(skillsTargetDir, "secret-skill"))).toBe(false);
    expect(yamlWriterModule.updateAgentSkills).not.toHaveBeenCalled();
    for (const s of stagedByInstaller) {
      expect(existsSync(s)).toBe(false);
    }
  });

  it("HUB-INS-6: happy path final state — updateAgentSkills add once, target populated, staging cleaned, YAML persists", async () => {
    await writeClawcodeYaml(clawcodeYamlPath, [{ name: "clawdy", skills: [] }]);
    const stagedByInstaller: string[] = [];
    vi.mocked(clawhubClient.downloadClawhubSkill).mockImplementationOnce(
      async (args) => {
        stagedByInstaller.push(args.stagingDir);
        return prepareStagedSkill(args.stagingDir, "my-skill", "Happy path skill body.");
      },
    );

    const catalog: readonly MarketplaceEntry[] = [
      makeClawhubCatalogEntry("my-skill"),
    ];

    const result = await installSingleSkill({
      skillName: "my-skill",
      agentName: "clawdy",
      catalog,
      skillsTargetDir,
      clawcodeYamlPath,
      ledgerPath,
    });

    expect(result.kind).toBe("installed");
    // updateAgentSkills add called once
    expect(yamlWriterModule.updateAgentSkills).toHaveBeenCalledTimes(1);
    // YAML persisted
    const yamlAfter = await readFile(clawcodeYamlPath, "utf8");
    expect(yamlAfter).toMatch(/my-skill/);
    // Target populated
    expect(existsSync(join(skillsTargetDir, "my-skill", "SKILL.md"))).toBe(true);
    // Staging cleaned
    for (const s of stagedByInstaller) {
      expect(existsSync(s)).toBe(false);
    }
  });
});

/**
 * HUB-OUT-1 — compile-time exhaustiveness of SkillInstallOutcome (11 variants).
 * This test exists only to trip a `tsc --noEmit` regression if a new variant is
 * added without updating every renderer. The `_exhaustive: never` pattern is
 * the canonical Phase 88 enforcement idiom.
 */
describe("SkillInstallOutcome — Phase 90 Plan 04 HUB-OUT-1 exhaustive switch", () => {
  it("HUB-OUT-1: all 11 variants handled by a sample renderer (compile-time check)", async () => {
    // Import type only so runtime is zero-cost.
    type Outcome = import("../install-single-skill.js").SkillInstallOutcome;
    function sampleRender(o: Outcome): string {
      switch (o.kind) {
        case "installed":
          return `installed: ${o.skill}`;
        case "installed-persist-failed":
          return `installed-persist-failed: ${o.skill}`;
        case "already-installed":
          return `already-installed: ${o.skill}`;
        case "blocked-secret-scan":
          return `blocked-secret-scan: ${o.skill}`;
        case "rejected-scope":
          return `rejected-scope: ${o.skill}`;
        case "rejected-deprecated":
          return `rejected-deprecated: ${o.skill}`;
        case "not-in-catalog":
          return `not-in-catalog: ${o.skill}`;
        case "copy-failed":
          return `copy-failed: ${o.skill}`;
        case "auth-required":
          return `auth-required: ${o.skill}`;
        case "rate-limited":
          return `rate-limited: ${o.skill}`;
        case "manifest-invalid":
          return `manifest-invalid: ${o.skill}`;
        default: {
          const _exhaustive: never = o;
          return _exhaustive;
        }
      }
    }
    // Just prove sampleRender compiles + runs on a live outcome.
    const sample: Outcome = {
      kind: "rate-limited",
      skill: "x",
      retryAfterMs: 1,
    };
    expect(sampleRender(sample)).toBe("rate-limited: x");
  });
});

// Silence unused lint — used only in the sample above to prove the exec
// scaffold compiles when tests need it.
void execFileP;
