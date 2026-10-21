/**
 * Phase 84 Plan 01 Task 1 — skills-ledger.
 *
 * Mirrors the shape of ledger.test.ts (v2.1 Phase 76). The v2.2 skills
 * ledger is a separate file at `.planning/migration/v2.2-skills-ledger.jsonl`
 * so the v2.1 agent migration ledger remains byte-stable as a regression
 * pin; we do NOT append skill rows to the v2.1 ledger.
 *
 * Canaries covered (≥6 per 84-01-PLAN Task 1 behavior spec):
 *   a. validation rejects missing skill field
 *   b. validation rejects non-ISO ts
 *   c. appendSkillRow creates parent dir on first write
 *   d. readSkillRows returns [] on missing file
 *   e. latestStatusBySkill keeps last insert-order row per skill
 *   f. refused + refuse round-trips cleanly
 *   + constant exposure (DEFAULT_SKILLS_LEDGER_PATH / SKILLS_LEDGER_*)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSkillRow,
  readSkillRows,
  latestStatusBySkill,
  skillsLedgerRowSchema,
  DEFAULT_SKILLS_LEDGER_PATH,
  SKILLS_LEDGER_ACTIONS,
  SKILLS_LEDGER_STATUSES,
  SKILLS_LEDGER_OUTCOMES,
  type SkillsLedgerRow,
} from "../skills-ledger.js";

const goodRow = (overrides: Partial<SkillsLedgerRow> = {}): SkillsLedgerRow => ({
  ts: "2026-04-21T12:00:00.000Z",
  action: "plan",
  skill: "frontend-design",
  status: "pending",
  source_hash: "abc123",
  ...overrides,
});

describe("skills-ledger", () => {
  let tmpDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "skills-ledger-test-"));
    // Nested under missing subdirs — exercises mkdir recursive path.
    ledgerPath = join(tmpDir, "planning", "migration", "v2.2-skills-ledger.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exposes DEFAULT_SKILLS_LEDGER_PATH locked to v2.2 path", () => {
    expect(DEFAULT_SKILLS_LEDGER_PATH).toBe(
      ".planning/migration/v2.2-skills-ledger.jsonl",
    );
  });

  it("exposes SKILLS_LEDGER_ACTIONS / STATUSES / OUTCOMES", () => {
    expect(SKILLS_LEDGER_ACTIONS).toEqual(["plan", "apply", "verify"]);
    expect(SKILLS_LEDGER_STATUSES).toEqual([
      "pending",
      "migrated",
      "skipped",
      "refused",
      "re-planned",
    ]);
    expect(SKILLS_LEDGER_OUTCOMES).toEqual(["allow", "refuse"]);
  });

  it("rejects missing skill field at schema level", () => {
    const { skill: _skill, ...bad } = goodRow();
    void _skill;
    const result = skillsLedgerRowSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects non-ISO ts at schema level", () => {
    const bad = { ...goodRow(), ts: "2026-04-21" };
    const result = skillsLedgerRowSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("appendSkillRow creates parent dir on first write and produces one JSONL row", async () => {
    expect(existsSync(ledgerPath)).toBe(false);
    await appendSkillRow(ledgerPath, goodRow());
    expect(existsSync(ledgerPath)).toBe(true);
    const rows = await readSkillRows(ledgerPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skill).toBe("frontend-design");
  });

  it("appendSkillRow validates BEFORE mkdir — bad row cannot create the file", async () => {
    const bad = { ...goodRow(), status: "not-a-status" } as unknown as SkillsLedgerRow;
    let caught: Error | undefined;
    try {
      await appendSkillRow(ledgerPath, bad);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it("readSkillRows returns [] when the ledger file is missing", async () => {
    const missing = join(tmpDir, "never-existed", "skills.jsonl");
    const rows = await readSkillRows(missing);
    expect(rows).toEqual([]);
  });

  it("latestStatusBySkill returns only the last status per skill (last-write-wins, insert-order)", async () => {
    await appendSkillRow(
      ledgerPath,
      goodRow({
        skill: "frontend-design",
        status: "pending",
        ts: "2026-04-21T10:00:00.000Z",
      }),
    );
    await appendSkillRow(
      ledgerPath,
      goodRow({
        skill: "new-reel",
        status: "pending",
        ts: "2026-04-21T10:01:00.000Z",
      }),
    );
    await appendSkillRow(
      ledgerPath,
      goodRow({
        skill: "frontend-design",
        status: "migrated",
        action: "apply",
        ts: "2026-04-21T10:02:00.000Z",
      }),
    );
    await appendSkillRow(
      ledgerPath,
      goodRow({
        skill: "acme-crm",
        status: "refused",
        action: "apply",
        outcome: "refuse",
        ts: "2026-04-21T10:03:00.000Z",
      }),
    );
    const map = await latestStatusBySkill(ledgerPath);
    expect(map.get("frontend-design")).toBe("migrated");
    expect(map.get("new-reel")).toBe("pending");
    expect(map.get("acme-crm")).toBe("refused");
    expect(map.size).toBe(3);
  });

  it("refused status with refuse outcome round-trips cleanly", async () => {
    const row: SkillsLedgerRow = {
      ts: "2026-04-21T12:30:00.000Z",
      action: "apply",
      skill: "acme-crm",
      status: "refused",
      source_hash: "crm-hash-abc",
      step: "secret-scan",
      outcome: "refuse",
      notes: "high-entropy offender in SKILL.md:20",
    };
    await appendSkillRow(ledgerPath, row);
    const rows = await readSkillRows(ledgerPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("refused");
    expect(rows[0]?.outcome).toBe("refuse");
    expect(rows[0]?.step).toBe("secret-scan");
    expect(rows[0]?.notes).toContain("high-entropy");
  });
});
