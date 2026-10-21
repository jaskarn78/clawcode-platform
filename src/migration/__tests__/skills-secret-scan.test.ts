/**
 * Phase 84 Plan 01 Task 1 — skills-secret-scan.
 *
 * Eight canaries per 84-01-PLAN Task 1 behavior spec:
 *   (1) acme-crm  → REFUSED with reason "high-entropy" in SKILL.md lines 15-25
 *   (2) tuya-ac        → ALLOWED (plain markdown, uses op:// for creds)
 *   (3) frontend-design → ALLOWED (content-only)
 *   (4) synthetic dir with sk-... password → REFUSED with reason "sk-prefix"
 *   (5) dir with op://example-vault/item/password → ALLOWED (op:// whitelist)
 *   (6) dir with only numeric ids + model-ids → ALLOWED
 *   (7) dir containing a .png binary file → binary skipped, no false positive
 *   (8) empty dir (no SKILL.md) → ALLOWED (nothing to scan)
 *
 * IMPORTANT: this test MUST NOT contain the literal acme-crm password
 * — the scanner is exercised against the real on-disk skill dir; spelling
 * the secret in the test source would leak it into the ClawCode repo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { scanSkillSecrets } from "../skills-secret-scan.js";

const OPENCLAW_SKILLS = join(homedir(), ".openclaw", "skills");

describe("skills-secret-scan", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "skill-scan-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(join(OPENCLAW_SKILLS, "acme-crm")))("canary 1: refuses acme-crm with reason 'high-entropy' at SKILL.md lines 15-25", async () => {
    const skillDir = join(OPENCLAW_SKILLS, "acme-crm");
    const result = await scanSkillSecrets(skillDir);
    expect(result.pass).toBe(false);
    expect(result.offender?.reason).toBe("high-entropy");
    expect(result.offender?.file).toMatch(/SKILL\.md$/);
    expect(result.offender?.line).toBeGreaterThanOrEqual(15);
    expect(result.offender?.line).toBeLessThanOrEqual(25);
    // Preview must NOT contain the literal secret — masked with "***".
    // We don't assert the preview body here (risk of pinning the secret shape);
    // instead we assert the preview is short and contains "***".
    expect(result.offender?.preview).toContain("***");
    expect(result.offender?.preview.length).toBeLessThanOrEqual(60);
  });

  it.skipIf(!existsSync(join(OPENCLAW_SKILLS, "tuya-ac")))("canary 2: allows tuya-ac (plain markdown, op:// credential refs)", async () => {
    const skillDir = join(OPENCLAW_SKILLS, "tuya-ac");
    const result = await scanSkillSecrets(skillDir);
    expect(result.pass).toBe(true);
    expect(result.offender).toBeUndefined();
  });

  it.skipIf(!existsSync(join(OPENCLAW_SKILLS, "frontend-design")))("canary 3: allows frontend-design (content-only SKILL.md)", async () => {
    const skillDir = join(OPENCLAW_SKILLS, "frontend-design");
    const result = await scanSkillSecrets(skillDir);
    expect(result.pass).toBe(true);
    expect(result.offender).toBeUndefined();
  });

  it("canary 4: refuses a synthetic sk-prefix password with reason 'sk-prefix'", async () => {
    // Synthesize a skill dir with a fake sk- token. This is a SYNTHETIC
    // test token — not a real API key. 30 chars matches SK_PREFIX regex.
    const syntheticToken = "sk-" + "a".repeat(30);
    writeFileSync(
      join(tmpDir, "SKILL.md"),
      `---\nname: test\n---\n# Synthetic\n\nCONFIG:\n  password="${syntheticToken}"\n`,
    );
    const result = await scanSkillSecrets(tmpDir);
    expect(result.pass).toBe(false);
    expect(result.offender?.reason).toBe("sk-prefix");
    expect(result.offender?.file).toMatch(/SKILL\.md$/);
  });

  it("canary 5: allows a dir with op://example-vault/item/password credential reference", async () => {
    writeFileSync(
      join(tmpDir, "SKILL.md"),
      "---\nname: opref\n---\n# Test\n\nUse op://example-vault/tuya/client_secret for auth.\n",
    );
    const result = await scanSkillSecrets(tmpDir);
    expect(result.pass).toBe(true);
    expect(result.offender).toBeUndefined();
  });

  it("canary 6: allows a dir with only numeric IDs + model-ids", async () => {
    writeFileSync(
      join(tmpDir, "SKILL.md"),
      [
        "---",
        "name: ids-only",
        "---",
        "# Test",
        "",
        "Channel: 000000000000000103",
        "Model: anthropic-api/claude-sonnet-4-6",
        "Agent: acme-content-creator",
      ].join("\n"),
    );
    const result = await scanSkillSecrets(tmpDir);
    expect(result.pass).toBe(true);
    expect(result.offender).toBeUndefined();
  });

  it("canary 7: skips binary .png files with no false positive", async () => {
    // SKILL.md is clean.
    writeFileSync(
      join(tmpDir, "SKILL.md"),
      "---\nname: with-binary\n---\n# Clean\n",
    );
    // Write random bytes as a fake PNG. These bytes would trivially trigger
    // a high-entropy refusal if the scanner treated them as text.
    const randomBytes = Buffer.from(
      Array.from({ length: 512 }, (_, i) => (i * 17 + 13) % 256),
    );
    writeFileSync(join(tmpDir, "icon.png"), randomBytes);
    const result = await scanSkillSecrets(tmpDir);
    expect(result.pass).toBe(true);
    expect(result.offender).toBeUndefined();
  });

  it("canary 8: allows an empty dir (no SKILL.md, nothing to scan)", async () => {
    // tmpDir is empty — no SKILL.md.
    const result = await scanSkillSecrets(tmpDir);
    expect(result.pass).toBe(true);
    expect(result.offender).toBeUndefined();
  });

  it("skips node_modules and .git subdirs when walking", async () => {
    // A secret hidden inside node_modules should NOT trigger refusal —
    // scanner skips those dirs by design.
    writeFileSync(
      join(tmpDir, "SKILL.md"),
      "---\nname: clean\n---\n# Clean\n",
    );
    mkdirSync(join(tmpDir, "node_modules", "foo"), { recursive: true });
    const syntheticToken = "sk-" + "b".repeat(30);
    writeFileSync(
      join(tmpDir, "node_modules", "foo", "bad.md"),
      `password="${syntheticToken}"\n`,
    );
    const result = await scanSkillSecrets(tmpDir);
    expect(result.pass).toBe(true);
    expect(result.offender).toBeUndefined();
  });
});
