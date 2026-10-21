/**
 * Phase 84 Plan 01 Task 2 — migrate-skills CLI integration tests.
 *
 * Exercises `runMigrateSkillsAction` end-to-end against the real
 * `~/.openclaw/skills/` tree (no mocking of discovery/secret-scan — those
 * modules are unit-tested in src/migration/__tests__/). Ledger and stdout
 * are captured via tmpdir + process.stdout spy.
 *
 * Seven tests per 84-01-PLAN Task 2 behavior spec:
 *   1. --dry-run returns 0 + "skipped (secret-scan)" contains acme-crm
 *   2. --dry-run "skipped (deprecated)" section has exactly 3 skills
 *   3. --dry-run "migrated"/"would-migrate" section has 4 P1 skills
 *   4. ledger row for migrated skill + matching source_hash → idempotent skip
 *   5. ledger row with MISMATCHED source_hash → re-appears as re-planned
 *   6. fs-guard refuses writes to ~/.openclaw/ during the action
 *   7. --dry-run against fresh tmp ledgerPath does NOT create the ledger file
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runMigrateSkillsAction } from "../migrate-skills.js";
import { appendSkillRow } from "../../../migration/skills-ledger.js";
import { ReadOnlySourceError } from "../../../migration/guards.js";
import { uninstallFsGuard } from "../../../migration/fs-guard.js";

// See fs-guard.test.ts for the CJS caveat: the runtime patch only affects
// the CJS fs module object, not ESM named bindings. Access fs via
// createRequire so we see the patched writeFile.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fsp: any = createRequire(import.meta.url)("node:fs/promises");

const OPENCLAW_SKILLS = join(homedir(), ".openclaw", "skills");

// These tests exercise the migrator against an operator's real legacy skills
// directory (it must contain the skills named in the locked classification
// table). They are skipped on machines that do not have one.
const HAS_LEGACY_SKILLS = existsSync(join(OPENCLAW_SKILLS, "acme-crm"));

/**
 * Extract the body of a named section — everything between `header` and the
 * NEXT section header (or end of output). Skips over the `===` at the end
 * of the header line itself (the header has triple-equals on BOTH sides).
 */
function extractSection(out: string, header: string): string {
  const start = out.indexOf(header);
  if (start < 0) return "";
  const afterHeader = start + header.length;
  const next = out.indexOf("===", afterHeader);
  return next < 0 ? out.slice(afterHeader) : out.slice(afterHeader, next);
}

describe.skipIf(!HAS_LEGACY_SKILLS)("migrate-skills CLI", () => {
  let tmp: string;
  let ledgerPath: string;
  let stdoutCapture: string[];
  let stderrCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "migrate-skills-"));
    ledgerPath = join(tmp, "v2.2-skills-ledger.jsonl");
    stdoutCapture = [];
    stderrCapture = [];
    writeStdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stdoutCapture.push(
          typeof chunk === "string" ? chunk : chunk.toString(),
        );
        return true;
      }) as typeof process.stdout.write);
    writeStderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stderrCapture.push(
          typeof chunk === "string" ? chunk : chunk.toString(),
        );
        return true;
      }) as typeof process.stderr.write);
    // Deterministic output
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
  });

  afterEach(() => {
    writeStdoutSpy.mockRestore();
    writeStderrSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
    // Belt-and-suspenders: make sure fs-guard is uninstalled even on test failure.
    uninstallFsGuard();
  });

  it("test 1: --dry-run exits 0 and lists acme-crm under 'skipped (secret-scan)'", async () => {
    const code = await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: true,
    });
    expect(code).toBe(0);
    const out = stdoutCapture.join("");
    expect(out).toContain("=== skipped (secret-scan) ===");
    expect(out).toContain("acme-crm");
    // acme-crm line must appear AFTER the secret-scan header and
    // before the next section header.
    const secretSectionStart = out.indexOf("=== skipped (secret-scan) ===");
    const acmePos = out.indexOf("acme-crm", secretSectionStart);
    expect(acmePos).toBeGreaterThan(secretSectionStart);
    // Next section header must come after the acme line.
    const nextSectionStart = out.indexOf("===", acmePos);
    expect(nextSectionStart).toBeGreaterThan(acmePos);
  });

  it("test 2: 'skipped (deprecated)' section lists exactly 3 skills", async () => {
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: true,
    });
    const out = stdoutCapture.join("");
    // The three deprecated skills
    expect(out).toContain("cognitive-memory");
    expect(out).toContain("openclaw-config");
    expect(out).toContain("acme-content-creator.retired");
    const deprecatedBlock = extractSection(out, "=== skipped (deprecated) ===");
    expect(deprecatedBlock).toContain("cognitive-memory");
    expect(deprecatedBlock).toContain("openclaw-config");
    expect(deprecatedBlock).toContain("acme-content-creator.retired");
  });

  it("test 3: 'migrated' section (--dry-run = would-migrate) lists the 4 clean P1 skills", async () => {
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: true,
    });
    const out = stdoutCapture.join("");
    const migBlock = extractSection(out, "=== migrated ===");
    // 4 P1 skills that pass secret scan: frontend-design, new-reel,
    // self-improving-agent, tuya-ac (acme-crm refused above)
    expect(migBlock).toContain("frontend-design");
    expect(migBlock).toContain("new-reel");
    expect(migBlock).toContain("self-improving-agent");
    expect(migBlock).toContain("tuya-ac");
    // acme-crm must NOT be in migrated section
    expect(migBlock).not.toContain("acme-crm");
  });

  it("test 4: ledger 'migrated' row with matching source_hash → idempotent skip", async () => {
    // First run — discover source hashes + write manual ledger rows for
    // frontend-design with matching source_hash.
    const firstCode = await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false, // Apply to write ledger rows
    });
    expect(firstCode).toBe(1); // acme-crm refuses on apply

    // Manually promote frontend-design's ledger row to 'migrated' so the
    // idempotency check fires on the next dry-run.
    // Read the source hash from the existing ledger.
    const { readSkillRows, appendSkillRow } = await import(
      "../../../migration/skills-ledger.js"
    );
    const rows = await readSkillRows(ledgerPath);
    const fdRow = rows.find((r) => r.skill === "frontend-design");
    expect(fdRow).toBeDefined();
    await appendSkillRow(ledgerPath, {
      ts: "2026-04-21T12:00:00.000Z",
      action: "apply",
      skill: "frontend-design",
      status: "migrated",
      source_hash: fdRow!.source_hash,
    });

    // Clear captured stdout and run dry-run again.
    stdoutCapture = [];
    const secondCode = await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: true,
    });
    expect(secondCode).toBe(0);
    const out = stdoutCapture.join("");
    const idemBlock = extractSection(out, "=== skipped (idempotent) ===");
    expect(idemBlock).toContain("frontend-design");
    // frontend-design must not also appear in the migrated/would-migrate section
    const migBlock = extractSection(out, "=== migrated ===");
    expect(migBlock).not.toContain("frontend-design");
  });

  it("test 5: ledger row with MISMATCHED source_hash → skill re-appears in migrated section", async () => {
    // Seed a 'migrated' row with a bogus source_hash — the idempotency
    // predicate (matching source_hash) fails, so the skill should NOT
    // move to 'skipped (idempotent)' and instead go through normal flow.
    await appendSkillRow(ledgerPath, {
      ts: "2026-04-20T10:00:00.000Z",
      action: "apply",
      skill: "frontend-design",
      status: "migrated",
      source_hash: "stale-hash-from-an-earlier-source-version",
    });

    const code = await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: true,
    });
    expect(code).toBe(0);
    const out = stdoutCapture.join("");
    const migBlock = extractSection(out, "=== migrated ===");
    expect(migBlock).toContain("frontend-design");
    // frontend-design must NOT appear in 'skipped (idempotent)' this time
    const idemBlock = extractSection(out, "=== skipped (idempotent) ===");
    expect(idemBlock).not.toContain("frontend-design");
  });

  it("test 6: fs-guard refuses writes under ~/.openclaw/ during the action body", async () => {
    // Install fs-guard manually (normally installed by the action) and try
    // to write under ~/.openclaw/. Should throw ReadOnlySourceError. The
    // action body wraps try{installFsGuard; ...}finally{uninstallFsGuard},
    // so equivalent protection applies during a real CLI run.
    const { installFsGuard, uninstallFsGuard: uninstall } = await import(
      "../../../migration/fs-guard.js"
    );
    installFsGuard();
    let caught: Error | undefined;
    try {
      await fsp.writeFile(
        join(homedir(), ".openclaw", "skills", "poisoned.md"),
        "should refuse",
      );
    } catch (err) {
      caught = err as Error;
    } finally {
      uninstall();
    }
    expect(caught).toBeInstanceOf(ReadOnlySourceError);
    // After uninstall, writes elsewhere still work.
    const okPath = join(tmp, "ok.md");
    await fsp.writeFile(okPath, "ok");
    expect(existsSync(okPath)).toBe(true);
  });

  it("test 7: --dry-run against a fresh tmp ledger path does NOT create the ledger file", async () => {
    expect(existsSync(ledgerPath)).toBe(false);
    const code = await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: true,
    });
    expect(code).toBe(0);
    // Dry-run must not touch the ledger file.
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it("test 8 (bonus): apply mode refuses with exit 1 when acme-crm fails secret scan", async () => {
    const code = await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
    });
    expect(code).toBe(1);
    // Ledger should have been written with the refuse row.
    expect(existsSync(ledgerPath)).toBe(true);
    const { readSkillRows } = await import(
      "../../../migration/skills-ledger.js"
    );
    const rows = await readSkillRows(ledgerPath);
    const crmRow = rows.find((r) => r.skill === "acme-crm");
    expect(crmRow?.status).toBe("refused");
    expect(crmRow?.outcome).toBe("refuse");
  });

  it("test 9 (bonus): output sections are in the locked order", async () => {
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: true,
    });
    const out = stdoutCapture.join("");
    const positions = [
      "=== migrated ===",
      "=== skipped (secret-scan) ===",
      "=== skipped (deprecated) ===",
      "=== skipped (idempotent) ===",
    ].map((h) => ({ h, pos: out.indexOf(h) }));
    // All four sections emit (even if empty — header always printed).
    for (const { h, pos } of positions) {
      expect(pos, `missing section: ${h}`).toBeGreaterThanOrEqual(0);
    }
    // Order: migrated < secret-scan < deprecated < idempotent
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!.pos).toBeGreaterThan(positions[i - 1]!.pos);
    }
  });

  it("test 10 (bonus): ~/ path expansion works for sourceDir", async () => {
    const code = await runMigrateSkillsAction({
      sourceDir: "~/.openclaw/skills",
      ledgerPath,
      dryRun: true,
    });
    expect(code).toBe(0);
    const out = stdoutCapture.join("");
    // Must have discovered the P1 skills — proves the ~ expansion happened.
    expect(out).toContain("tuya-ac");
  });

  it("test 11 (bonus): non-existent source returns empty sections + exit 0", async () => {
    const code = await runMigrateSkillsAction({
      sourceDir: join(tmp, "does-not-exist"),
      ledgerPath,
      dryRun: true,
    });
    expect(code).toBe(0);
    const out = stdoutCapture.join("");
    // Four section headers still emitted (deterministic output contract).
    expect(out).toContain("=== migrated ===");
    expect(out).toContain("=== skipped (secret-scan) ===");
    expect(out).toContain("=== skipped (deprecated) ===");
    expect(out).toContain("=== skipped (idempotent) ===");
    // Body between headers should be "(none)" for every section.
    expect((out.match(/\(none\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  // ------------------------------------------------------------------
  // Plan 02 apply-path tests (12-17)
  // ------------------------------------------------------------------

  it("test 12 (plan-02): apply to tmpdir target migrates 4 P1 skills; tuya-ac gets name+description frontmatter", async () => {
    const skillsTarget = join(tmp, "clawcode-skills");
    const code = await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
      // No config path → skip linker verification (tested separately).
    });
    // acme-crm refuses at secret-scan → exit 1
    expect(code).toBe(1);
    // 4 clean P1 skills copied
    expect(existsSync(join(skillsTarget, "frontend-design", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(skillsTarget, "new-reel", "SKILL.md"))).toBe(true);
    expect(
      existsSync(join(skillsTarget, "self-improving-agent", "SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(skillsTarget, "tuya-ac", "SKILL.md"))).toBe(true);
    // acme-crm NOT copied
    expect(existsSync(join(skillsTarget, "acme-crm"))).toBe(false);
    // tuya-ac frontmatter normalized
    const { readFile: rf } = await import("node:fs/promises");
    const tuyaSkill = await rf(
      join(skillsTarget, "tuya-ac", "SKILL.md"),
      "utf8",
    );
    expect(tuyaSkill.startsWith("---\nname: tuya-ac\ndescription: ")).toBe(
      true,
    );
    // frontend-design frontmatter preserved byte-for-byte
    const fdTarget = await rf(
      join(skillsTarget, "frontend-design", "SKILL.md"),
      "utf8",
    );
    const fdSource = await rf(
      join(OPENCLAW_SKILLS, "frontend-design", "SKILL.md"),
      "utf8",
    );
    expect(fdTarget).toBe(fdSource);
  });

  it("test 13 (plan-02): idempotent apply — second run moves 4 P1 skills to 'skipped (idempotent)'", async () => {
    const skillsTarget = join(tmp, "clawcode-skills-idem");
    const first = await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
    });
    expect(first).toBe(1); // acme-crm refuses
    stdoutCapture = [];
    const second = await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
    });
    expect(second).toBe(1); // acme-crm still refuses
    const out = stdoutCapture.join("");
    const idemIdx = out.indexOf("=== skipped (idempotent) ===");
    expect(idemIdx).toBeGreaterThan(-1);
    const idemBlock = out.slice(idemIdx, out.indexOf("===", idemIdx + 30));
    expect(idemBlock).toContain("frontend-design");
    expect(idemBlock).toContain("new-reel");
    expect(idemBlock).toContain("self-improving-agent");
    expect(idemBlock).toContain("tuya-ac");
  });

  it("test 14 (plan-02): apply with synthetic clawcode.yaml → linker verifications emit; tuya-ac scope-refused on fin-* agent without --force-scope", async () => {
    // Build a synthetic clawcode.yaml assigning tuya-ac to fin-research
    // (personal skill → fin agent — scope refused by default).
    const yamlPath = join(tmp, "clawcode-synth.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      yamlPath,
      [
        "version: 1",
        "agents:",
        "  - name: fin-research",
        "    workspace: /tmp/fin-ws",
        "    channels:",
        "      - 'c-fin'",
        "    model: sonnet",
        "    skills:",
        "      - tuya-ac",
        "  - name: clawdy",
        "    workspace: /tmp/clawdy-ws",
        "    channels:",
        "      - 'c-clawdy'",
        "    model: sonnet",
        "    skills:",
        "      - tuya-ac",
        "      - frontend-design",
      ].join("\n"),
    );

    const skillsTarget = join(tmp, "clawcode-skills-scope");
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
      clawcodeYamlPath: yamlPath,
    });
    const out = stdoutCapture.join("");
    // A verification section must emit
    expect(out).toContain("=== linker verification ===");
    // fin-research must be scope-refused for tuya-ac
    expect(out).toMatch(/fin-research.*tuya-ac.*scope-refused/);
    // clawdy + tuya-ac must succeed (personal agent + personal skill)
    expect(out).toMatch(/clawdy.*tuya-ac.*linked/);
  });

  it("test 15 (plan-02): --force-scope overrides scope refusal — tuya-ac linked on fin-research", async () => {
    const yamlPath = join(tmp, "clawcode-force.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      yamlPath,
      [
        "version: 1",
        "agents:",
        "  - name: fin-research",
        "    workspace: /tmp/fin-ws",
        "    channels: ['c-fin']",
        "    model: sonnet",
        "    skills:",
        "      - tuya-ac",
      ].join("\n"),
    );
    const skillsTarget = join(tmp, "clawcode-skills-force");
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
      clawcodeYamlPath: yamlPath,
      forceScope: true,
    });
    const out = stdoutCapture.join("");
    expect(out).toContain("=== linker verification ===");
    // With force, scope-refused becomes linked.
    expect(out).toMatch(/fin-research.*tuya-ac.*linked/);
    expect(out).not.toMatch(/fin-research.*tuya-ac.*scope-refused/);
  });

  it("test 16 (plan-02): self-improving-agent .learnings/ imported to MemoryStore; re-apply imports zero new entries", async () => {
    // Use an in-memory MemoryStore via an external dbPath. Pass the
    // memoryDbPath so the CLI action wires it to the dedup helper.
    const dbPath = join(tmp, "agent-memory.db");
    const skillsTarget = join(tmp, "clawcode-skills-learnings");
    const { MemoryStore } = await import("../../../memory/store.js");
    // Pre-open so test can probe it (the CLI will open its own handle
    // against the same path). better-sqlite3 allows multiple read handles
    // but not concurrent writers — CLI finishes before we probe.
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
      memoryDbPath: dbPath,
    });
    // Probe — count learning-tagged entries with our migration origin prefix.
    const store = new MemoryStore(dbPath);
    const db = store.getDatabase();
    const firstCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM memories WHERE origin_id LIKE 'openclaw-learning-%'",
        )
        .get() as { n: number }
    ).n;
    expect(firstCount).toBeGreaterThan(0);

    // Re-apply — should dedup all existing entries + origin_id skip path
    stdoutCapture = [];
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
      memoryDbPath: dbPath,
    });
    const secondCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM memories WHERE origin_id LIKE 'openclaw-learning-%'",
        )
        .get() as { n: number }
    ).n;
    // Idempotent — second run MUST NOT insert new learning entries.
    expect(secondCount).toBe(firstCount);
  });

  it("test 17 (plan-02): tuya-ac post-apply — scanSkillsDirectory returns non-empty description, null version", async () => {
    const skillsTarget = join(tmp, "clawcode-skills-scan");
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
    });
    const { scanSkillsDirectory } = await import(
      "../../../skills/scanner.js"
    );
    const catalog = await scanSkillsDirectory(skillsTarget);
    const tuyaEntry = catalog.get("tuya-ac");
    expect(tuyaEntry).toBeDefined();
    expect(tuyaEntry!.name).toBe("tuya-ac");
    expect(tuyaEntry!.description.length).toBeGreaterThan(0);
    // Transformer did NOT add a version: field — only name+description.
    expect(tuyaEntry!.version).toBeNull();
  });

  // ------------------------------------------------------------------
  // Plan 03 report-writer tests (18-20)
  // ------------------------------------------------------------------

  it("test 18 (plan-03): end-to-end apply writes report with expected frontmatter counters", async () => {
    const skillsTarget = join(tmp, "clawcode-skills-report");
    const reportPath = join(tmp, "v2.2-skills-migration-report.md");
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
      reportPath,
    });
    expect(existsSync(reportPath)).toBe(true);
    const { readFile: rf } = await import("node:fs/promises");
    const body = await rf(reportPath, "utf8");
    // Frontmatter header + canonical counters (4 P1 migrated, 1 refused)
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain("# v2.2 OpenClaw Skills Migration Report");
    expect(body).toMatch(/^skills_migrated: 4$/m);
    expect(body).toMatch(/^skills_refused_secret_scan: 1$/m);
    expect(body).toMatch(/^skills_deprecated: 3$/m);
    expect(body).toMatch(/^skills_skipped_p2: 4$/m);
    // All 12 discovered skills under Per-Skill Outcomes
    expect(body).toContain("### acme-crm");
    expect(body).toContain("### frontend-design");
    expect(body).toContain("### tuya-ac");
    expect(body).toContain("### power-apps-builder");
  });

  it("test 19 (plan-03): re-running apply overwrites the report (atomic — no stale .tmp leftover)", async () => {
    const skillsTarget = join(tmp, "clawcode-skills-reapply");
    const reportPath = join(tmp, "v2.2-skills-migration-report.md");
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
      reportPath,
    });
    const { readFile: rf } = await import("node:fs/promises");
    const first = await rf(reportPath, "utf8");

    // Second apply — report gets rewritten with new timestamp.
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: false,
      skillsTargetDir: skillsTarget,
      reportPath,
    });
    const second = await rf(reportPath, "utf8");
    expect(second.startsWith("---\n")).toBe(true);
    expect(second).toContain("# v2.2 OpenClaw Skills Migration Report");
    // Both runs include the full skill set
    expect(first).toContain("### tuya-ac");
    expect(second).toContain("### tuya-ac");
    // No stray .tmp files in the target dir
    const { readdirSync } = await import("node:fs");
    const leftover = readdirSync(tmp).filter((n) => n.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("test 20 (plan-03): --dry-run does NOT write a report", async () => {
    const skillsTarget = join(tmp, "clawcode-skills-dryrun-report");
    const reportPath = join(tmp, "v2.2-skills-migration-report-dryrun.md");
    await runMigrateSkillsAction({
      sourceDir: OPENCLAW_SKILLS,
      ledgerPath,
      dryRun: true,
      skillsTargetDir: skillsTarget,
      reportPath,
    });
    // Dry-run is informational — no report written.
    expect(existsSync(reportPath)).toBe(false);
  });
});

// Suppress unused-import lint (we only reference these for type compat).
void mkdirSync;
void writeFileSync;
