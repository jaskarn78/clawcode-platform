/**
 * Phase 84 Plan 02 Task 1 — skills-transformer pure-function tests.
 *
 * Tests the frontmatter normalization contract:
 *   - tuya-ac (no frontmatter) → prepend `---\nname:...\ndescription:...\n---\n\n`
 *   - frontend-design / new-reel / self-improving-agent (have frontmatter) →
 *     return byte-for-byte identical content (no-op)
 *   - edge cases: empty string, heading-only content, long first paragraph
 *   - idempotency: running the transformer twice yields same result
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  normalizeSkillFrontmatter,
  hasFrontmatter,
} from "../skills-transformer.js";

const OPENCLAW_SKILLS = join(homedir(), ".openclaw", "skills");

describe("skills-transformer", () => {
  it("(a) tuya-ac real content → output starts with `---\\nname: tuya-ac\\ndescription: `", async () => {
    const content = await readFile(
      join(OPENCLAW_SKILLS, "tuya-ac", "SKILL.md"),
      "utf8",
    );
    expect(hasFrontmatter(content)).toBe(false);
    const out = normalizeSkillFrontmatter(content, "tuya-ac");
    expect(out.startsWith("---\nname: tuya-ac\ndescription: ")).toBe(true);
    // The closing `---` must be present, followed by a blank line + body.
    expect(out).toMatch(/^---\nname: tuya-ac\ndescription: [^\n]+\n---\n\n/);
    // Body (after the prepended frontmatter) must be the original content.
    const bodyStart = out.indexOf("\n---\n\n") + "\n---\n\n".length;
    expect(out.slice(bodyStart)).toBe(content);
  });

  it("(b) frontend-design real content → output === input byte-for-byte", async () => {
    const content = await readFile(
      join(OPENCLAW_SKILLS, "frontend-design", "SKILL.md"),
      "utf8",
    );
    expect(hasFrontmatter(content)).toBe(true);
    const out = normalizeSkillFrontmatter(content, "frontend-design");
    expect(out).toBe(content);
  });

  it("(c) new-reel real content → output === input byte-for-byte (preserves ${CLAUDE_SKILL_DIR})", async () => {
    const content = await readFile(
      join(OPENCLAW_SKILLS, "new-reel", "SKILL.md"),
      "utf8",
    );
    expect(hasFrontmatter(content)).toBe(true);
    const out = normalizeSkillFrontmatter(content, "new-reel");
    expect(out).toBe(content);
    // Belt-and-suspenders: any `${CLAUDE_SKILL_DIR}` occurrences in the
    // original must still be in the output unmodified.
    const origOccurrences = (content.match(/\$\{CLAUDE_SKILL_DIR\}/g) ?? [])
      .length;
    const outOccurrences = (out.match(/\$\{CLAUDE_SKILL_DIR\}/g) ?? []).length;
    expect(outOccurrences).toBe(origOccurrences);
  });

  it("(d) self-improving-agent real content → output === input byte-for-byte", async () => {
    const content = await readFile(
      join(OPENCLAW_SKILLS, "self-improving-agent", "SKILL.md"),
      "utf8",
    );
    expect(hasFrontmatter(content)).toBe(true);
    const out = normalizeSkillFrontmatter(content, "self-improving-agent");
    expect(out).toBe(content);
  });

  it("(e) empty string → fallback description used", () => {
    const out = normalizeSkillFrontmatter("", "my-skill");
    expect(out).toContain("name: my-skill");
    expect(out).toContain(
      "description: Migrated from ~/.openclaw/skills/my-skill",
    );
    expect(out.startsWith("---\nname: my-skill\ndescription: ")).toBe(true);
  });

  it("(f) heading-only content '# Foo\\n\\nBody' → description = 'Foo'", () => {
    const out = normalizeSkillFrontmatter("# Foo\n\nBody paragraph.", "x");
    expect(out).toMatch(/^---\nname: x\ndescription: Foo\n---\n\n/);
  });

  it("(g) 500-char first paragraph → description truncated to 200 chars", () => {
    const long = "a".repeat(500);
    const out = normalizeSkillFrontmatter(long, "longy");
    const match = out.match(/^---\nname: longy\ndescription: ([^\n]+)\n---/);
    expect(match).not.toBeNull();
    const desc = match![1]!;
    expect(desc.length).toBeLessThanOrEqual(200);
    // Must start with the prefix of the source content
    expect(long.startsWith(desc)).toBe(true);
  });

  it("(h) idempotency: normalize(normalize(X)) === normalize(X)", () => {
    const body = "some plain body without frontmatter.\n\nMore text.";
    const once = normalizeSkillFrontmatter(body, "foo");
    const twice = normalizeSkillFrontmatter(once, "foo");
    expect(twice).toBe(once);
  });

  it("(i) hasFrontmatter: detects ---\\n...\\n--- at start", () => {
    expect(hasFrontmatter("---\nname: x\n---\nbody")).toBe(true);
    expect(hasFrontmatter("# Heading\n\nBody")).toBe(false);
    expect(hasFrontmatter("")).toBe(false);
    expect(hasFrontmatter("---\n---\n")).toBe(true); // empty frontmatter OK
  });
});
