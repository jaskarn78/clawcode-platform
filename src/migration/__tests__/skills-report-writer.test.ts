/**
 * Phase 84 Plan 03 Task 1 — skills-report-writer unit tests.
 *
 * Exercises `writeSkillsMigrationReport` against synthetic fixtures:
 * - Pre-seeded skills ledger (tmpdir JSONL) with known source_hash values
 * - Synthetic DiscoveredSkill[] covering all classification verdicts
 * - Synthetic LinkVerification[] covering linked / scope-refused /
 *   missing-from-catalog
 *
 * Seven tests per 84-03-PLAN Task 1 behavior spec:
 *   1. Happy path — all 12 skills emit under ## Per-Skill Outcomes
 *   2. Determinism — two calls with same inputs + same clock = byte-identical
 *   3. Atomic write — .tmp+rename means reader never sees partial file
 *   4. Frontmatter parses as valid YAML with expected keys
 *   5. source_integrity_sha is sha256(sorted(ledger_source_hashes).join("\n"))
 *   6. Verification table renders with em-dash for empty reason
 *   7. sourceTreeReadonly variants render correct invariant checkbox state
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  writeSkillsMigrationReport,
  type WriteReportOpts,
} from "../skills-report-writer.js";
import {
  appendSkillRow,
  type SkillsLedgerRow,
} from "../skills-ledger.js";
import type { DiscoveredSkill } from "../skills-discovery.js";
import type { LinkVerification } from "../skills-linker-verifier.js";

const FIXED_TS = "2026-04-21T19:00:00.000Z";

/**
 * Build the full 12-skill fixture in classification order per
 * SKILL_CLASSIFICATIONS in skills-discovery.ts. Stable sourceHash
 * values so test 5 can hand-verify source_integrity_sha.
 */
function buildDiscoveredFixture(): readonly DiscoveredSkill[] {
  return [
    { name: "cognitive-memory", path: "/s/cognitive-memory", classification: "deprecate", sourceHash: "hash-cognitive-memory" },
    { name: "acme-content-creator.retired", path: "/s/acme-content-creator.retired", classification: "deprecate", sourceHash: "hash-acme-content-creator-retired" },
    { name: "acme-crm", path: "/s/acme-crm", classification: "p1", sourceHash: "hash-acme-crm" },
    { name: "frontend-design", path: "/s/frontend-design", classification: "p1", sourceHash: "hash-frontend-design" },
    { name: "new-reel", path: "/s/new-reel", classification: "p1", sourceHash: "hash-new-reel" },
    { name: "openclaw-config", path: "/s/openclaw-config", classification: "deprecate", sourceHash: "hash-openclaw-config" },
    { name: "power-apps-builder", path: "/s/power-apps-builder", classification: "p2", sourceHash: "hash-power-apps-builder" },
    { name: "remotion", path: "/s/remotion", classification: "p2", sourceHash: "hash-remotion" },
    { name: "self-improving-agent", path: "/s/self-improving-agent", classification: "p1", sourceHash: "hash-self-improving-agent" },
    { name: "test", path: "/s/test", classification: "p2", sourceHash: "hash-test" },
    { name: "tuya-ac", path: "/s/tuya-ac", classification: "p1", sourceHash: "hash-tuya-ac" },
    { name: "workspace-janitor", path: "/s/workspace-janitor", classification: "p2", sourceHash: "hash-workspace-janitor" },
  ];
}

/**
 * Seed a tmp ledger with per-skill outcomes matching the happy-path
 * canonical state: 4 migrated (frontend-design / new-reel /
 * self-improving-agent / tuya-ac), 1 refused (acme-crm),
 * 3 deprecated (classify/skip rows), 4 p2 (classify/skip rows).
 */
async function seedLedger(
  ledgerPath: string,
  discovered: readonly DiscoveredSkill[],
): Promise<void> {
  for (const skill of discovered) {
    if (skill.classification === "deprecate") {
      await appendSkillRow(ledgerPath, {
        ts: FIXED_TS,
        action: "plan",
        skill: skill.name,
        status: "skipped",
        source_hash: skill.sourceHash,
        step: "classify",
        outcome: "allow",
        notes: "deprecated per v2.2 verdict list",
      });
      continue;
    }
    if (skill.classification === "p2") {
      await appendSkillRow(ledgerPath, {
        ts: FIXED_TS,
        action: "plan",
        skill: skill.name,
        status: "skipped",
        source_hash: skill.sourceHash,
        step: "classify",
        outcome: "allow",
        notes: "P2 — out of v2.2 scope",
      });
      continue;
    }
    // P1 — acme-crm refuses; others migrate.
    if (skill.name === "acme-crm") {
      await appendSkillRow(ledgerPath, {
        ts: FIXED_TS,
        action: "apply",
        skill: skill.name,
        status: "refused",
        source_hash: skill.sourceHash,
        step: "classify",
        outcome: "refuse",
        notes: "SKILL.md:20 (high-entropy)",
      });
      continue;
    }
    await appendSkillRow(ledgerPath, {
      ts: FIXED_TS,
      action: "apply",
      skill: skill.name,
      status: "migrated",
      source_hash: skill.sourceHash,
      target_hash: `target-${skill.name}`,
      step: "copy",
      outcome: "allow",
      notes: "copied",
    });
  }
}

describe("skills-report-writer — writeSkillsMigrationReport", () => {
  let tmp: string;
  let ledgerPath: string;
  let reportPath: string;
  let discovered: readonly DiscoveredSkill[];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "skills-report-"));
    ledgerPath = join(tmp, "v2.2-skills-ledger.jsonl");
    reportPath = join(tmp, "out", "v2.2-skills-migration-report.md");
    discovered = buildDiscoveredFixture();
    await seedLedger(ledgerPath, discovered);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("test 1 (happy path): all 12 skills emit under ## Per-Skill Outcomes", async () => {
    const verifications: readonly LinkVerification[] = [
      { agent: "fin-client", skill: "acme-crm", status: "linked" },
      { agent: "clawdy", skill: "tuya-ac", status: "linked" },
    ];
    const written = await writeSkillsMigrationReport({
      reportPath,
      ledgerPath,
      discovered,
      verifications,
      sourceTreeReadonly: "verified",
      generatedAt: FIXED_TS,
    });
    expect(written).toBe(reportPath);
    expect(existsSync(reportPath)).toBe(true);

    const body = readFileSync(reportPath, "utf8");
    expect(body).toContain("# v2.2 OpenClaw Skills Migration Report");
    expect(body).toContain("## Per-Skill Outcomes");
    // All 12 skill names must appear as ### headings.
    for (const s of discovered) {
      expect(body).toMatch(new RegExp(`^### ${s.name.replace(/\./g, "\\.")}$`, "m"));
    }
    // Aggregates correct: 4 migrated, 1 refused, 3 deprecated, 4 p2.
    expect(body).toMatch(/^skills_migrated: 4$/m);
    expect(body).toMatch(/^skills_refused_secret_scan: 1$/m);
    expect(body).toMatch(/^skills_deprecated: 3$/m);
    expect(body).toMatch(/^skills_skipped_p2: 4$/m);
  });

  it("test 2 (determinism): identical inputs + same clock = byte-identical output", async () => {
    const verifications: readonly LinkVerification[] = [
      { agent: "fin-client", skill: "acme-crm", status: "linked" },
    ];
    const opts: WriteReportOpts = {
      reportPath,
      ledgerPath,
      discovered,
      verifications,
      sourceTreeReadonly: "verified",
      generatedAt: FIXED_TS,
    };
    await writeSkillsMigrationReport(opts);
    const first = readFileSync(reportPath, "utf8");
    await writeSkillsMigrationReport(opts);
    const second = readFileSync(reportPath, "utf8");
    expect(first).toBe(second);
    // Hard guarantee via sha256.
    const sha1 = createHash("sha256").update(first, "utf8").digest("hex");
    const sha2 = createHash("sha256").update(second, "utf8").digest("hex");
    expect(sha1).toBe(sha2);
  });

  it("test 3 (atomic write): interrupted write never leaves partial content visible", async () => {
    // Write an initial full report.
    await writeSkillsMigrationReport({
      reportPath,
      ledgerPath,
      discovered,
      verifications: [],
      sourceTreeReadonly: "verified",
      generatedAt: FIXED_TS,
    });
    const first = readFileSync(reportPath, "utf8");
    expect(first).toContain("# v2.2 OpenClaw Skills Migration Report");

    // Simulate a second write (atomic temp+rename) — at no point should
    // the destination file be partial. Validate by reading the file during
    // the write: we can't reliably race in Node, but we CAN assert the
    // writer does NOT leave a .tmp file behind and DID overwrite to the
    // new complete content.
    await writeSkillsMigrationReport({
      reportPath,
      ledgerPath,
      discovered,
      verifications: [
        { agent: "x", skill: "frontend-design", status: "linked" },
      ],
      sourceTreeReadonly: "verified",
      generatedAt: "2026-04-21T20:00:00.000Z",
    });
    const second = readFileSync(reportPath, "utf8");
    expect(second).toContain("# v2.2 OpenClaw Skills Migration Report");
    // Second content is different (new timestamp + new verification row)
    expect(second).not.toBe(first);
    // No lingering .tmp files.
    const { readdirSync } = await import("node:fs");
    const dir = join(tmp, "out");
    const leftover = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("test 4 (frontmatter valid YAML): 9 expected keys in fixed order", async () => {
    await writeSkillsMigrationReport({
      reportPath,
      ledgerPath,
      discovered,
      verifications: [],
      sourceTreeReadonly: "verified",
      generatedAt: FIXED_TS,
    });
    const body = readFileSync(reportPath, "utf8");
    // Extract frontmatter block.
    const match = body.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).not.toBeNull();
    const fm = match![1]!;
    // Split into "key: value" pairs in ORDER — must match canonical order.
    const keys = fm
      .split("\n")
      .map((l) => l.split(":")[0]!.trim())
      .filter((k) => k.length > 0);
    expect(keys).toEqual([
      "milestone",
      "date",
      "skills_migrated",
      "skills_refused_secret_scan",
      "skills_deprecated",
      "skills_skipped_p2",
      "skills_skipped_idempotent",
      "source_integrity_sha",
      "source_tree_readonly",
    ]);
    // Fixed values
    expect(fm).toContain("milestone: v2.2");
    expect(fm).toContain(`date: ${FIXED_TS}`);
    expect(fm).toContain("source_tree_readonly: verified");
  });

  it("test 5 (source_integrity_sha is sha256 of sorted ledger source_hashes)", async () => {
    await writeSkillsMigrationReport({
      reportPath,
      ledgerPath,
      discovered,
      verifications: [],
      sourceTreeReadonly: "verified",
      generatedAt: FIXED_TS,
    });
    const body = readFileSync(reportPath, "utf8");
    const match = body.match(/^source_integrity_sha: ([a-f0-9]{64})$/m);
    expect(match).not.toBeNull();
    const reportedSha = match![1]!;

    // Hand-compute expected: sha256(sorted unique source_hash values joined by \n)
    // The seed writes one row per skill — so sourceHash values are exactly
    // the discovered fixtures' sourceHash array.
    const hashes = discovered.map((s) => s.sourceHash).sort();
    const expected = createHash("sha256")
      .update(hashes.join("\n"), "utf8")
      .digest("hex");
    expect(reportedSha).toBe(expected);
  });

  it("test 6 (verification table): em-dash renders for empty reason; pipe-escaping preserved", async () => {
    const verifications: readonly LinkVerification[] = [
      { agent: "fin-client", skill: "acme-crm", status: "linked" },
      {
        agent: "clawdy",
        skill: "acme-crm",
        status: "scope-refused",
        reason: "skill scope=acme vs agent scope=personal",
      },
      {
        agent: "(none)",
        skill: "new-reel",
        status: "missing-from-catalog",
        reason: "skill not in target ~/.clawcode/skills/ after migration — copy likely failed",
      },
    ];
    await writeSkillsMigrationReport({
      reportPath,
      ledgerPath,
      discovered,
      verifications,
      sourceTreeReadonly: "verified",
      generatedAt: FIXED_TS,
    });
    const body = readFileSync(reportPath, "utf8");
    expect(body).toContain("## Per-Agent Linker Verification");
    // Table header
    expect(body).toContain("| Agent | Skill | Status | Reason |");
    // Linked row uses em-dash U+2014 for empty reason
    expect(body).toContain("| fin-client | acme-crm | linked | \u2014 |");
    // Scope-refused row has the reason text
    expect(body).toContain(
      "| clawdy | acme-crm | scope-refused | skill scope=acme vs agent scope=personal |",
    );
    // Missing row with em-dash-containing reason text preserved as-is
    expect(body).toContain(
      "| (none) | new-reel | missing-from-catalog | skill not in target ~/.clawcode/skills/ after migration \u2014 copy likely failed |",
    );
  });

  it("test 7 (sourceTreeReadonly variants): 'verified' / 'mtime-changed' / 'unchecked' render correct checkbox", async () => {
    // verified → [x] checkbox
    await writeSkillsMigrationReport({
      reportPath,
      ledgerPath,
      discovered,
      verifications: [],
      sourceTreeReadonly: "verified",
      generatedAt: FIXED_TS,
    });
    let body = readFileSync(reportPath, "utf8");
    expect(body).toMatch(/- \[x\] `~\/\.openclaw\/skills\/` mtime unchanged/);

    // mtime-changed → [ ]
    await writeSkillsMigrationReport({
      reportPath,
      ledgerPath,
      discovered,
      verifications: [],
      sourceTreeReadonly: "mtime-changed",
      generatedAt: FIXED_TS,
    });
    body = readFileSync(reportPath, "utf8");
    expect(body).toMatch(/- \[ \] `~\/\.openclaw\/skills\/` mtime unchanged/);
    // Frontmatter reflects the failed state
    expect(body).toContain("source_tree_readonly: mtime-changed");

    // unchecked → [ ] with unchecked-annotated text
    await writeSkillsMigrationReport({
      reportPath,
      ledgerPath,
      discovered,
      verifications: [],
      sourceTreeReadonly: "unchecked",
      generatedAt: FIXED_TS,
    });
    body = readFileSync(reportPath, "utf8");
    expect(body).toMatch(/- \[ \] `~\/\.openclaw\/skills\/` mtime unchanged/);
    expect(body).toContain("source_tree_readonly: unchecked");
  });
});

// Suppress unused-import lint.
void writeFileSync;
