/**
 * Phase 84 Plan 02 Task 1 — SKILL.md frontmatter normalizer.
 *
 * Pure functions, no fs I/O. Consumed by the migration apply path to
 * ensure every migrated SKILL.md has `name:` + `description:` YAML
 * frontmatter readable by `src/skills/scanner.ts` (extractVersion /
 * extractDescription / extractEffortFrontmatter).
 *
 * Contract:
 *   - If content already has `---\n...\n---` frontmatter at the top,
 *     return it unchanged byte-for-byte. This preserves author intent
 *     (including the `description:` value, `license:`, `metadata:`,
 *     `effort:`, etc.) for frontend-design / new-reel / self-improving-
 *     agent, which ship with proper frontmatter.
 *   - Otherwise, prepend a minimal frontmatter block:
 *       ---
 *       name: <skillName>
 *       description: <derived from first non-empty line>
 *       ---
 *     (blank line + original content follow). This handles tuya-ac,
 *     which opens with `# tuya-ac — Tuya Smart AC Control` (no YAML).
 *
 * Description derivation:
 *   - First non-empty, non-comment line of the body
 *   - Heading markers (`#+\s*`) stripped from the front
 *   - Trimmed; single-line only; capped at 200 chars
 *   - Fallback: `"Migrated from ~/.openclaw/skills/<skillName>"`
 *
 * Idempotency: running `normalizeSkillFrontmatter` twice produces the
 * same output — once the first pass adds frontmatter, the second pass
 * detects it via `hasFrontmatter` and returns unchanged.
 */

// Matches a YAML frontmatter block at the start of the file. Permits an
// empty body (`---\n---`) — the inner `[\s\S]*?` is wrapped with an
// optional non-empty alternation so `---\n---` parses as valid empty
// frontmatter and `---\nfoo: bar\n---` parses as valid non-empty.
const FRONTMATTER_HEAD_RE = /^---\n(?:[\s\S]*?\n)?---/;

/**
 * Returns true iff `content` begins with a valid YAML frontmatter block
 * (`---\n...\n---`). Used by the transformer pre-check and by callers
 * that want to classify a SKILL.md without invoking the full rewrite.
 */
export function hasFrontmatter(content: string): boolean {
  return FRONTMATTER_HEAD_RE.test(content);
}

/**
 * Extract a one-line, ≤200-char human-readable description from body
 * content. Prefers the first non-empty, non-HTML-comment line; strips
 * leading heading markers (`# `, `## `, ...); falls back to a migration
 * stub when the body is empty or otherwise yields no usable string.
 */
function extractFirstLineAsDescription(
  content: string,
  skillName: string,
): string {
  const lines = content.split("\n");
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // Skip HTML comments — sometimes used for editor hints.
    if (trimmed.startsWith("<!--")) continue;
    // Strip leading heading markers `#`, `##`, `###`... plus their spaces.
    const stripped = trimmed.replace(/^#+\s*/, "").trim();
    if (stripped.length === 0) continue;
    // Replace any embedded newlines (defensive — already split but keep
    // the guarantee in case a caller passes pre-joined content).
    const singleLine = stripped.replace(/\s*\n\s*/g, " ");
    if (singleLine.length <= 200) return singleLine;
    return singleLine.slice(0, 200);
  }
  return `Migrated from ~/.openclaw/skills/${skillName}`;
}

/**
 * Normalize SKILL.md frontmatter for migration.
 *
 * If the content already has YAML frontmatter, return it unchanged
 * (byte-identical). Otherwise prepend a minimal frontmatter block with
 * `name:` + `description:`.
 *
 * `description:` is derived from the first usable body line; see
 * `extractFirstLineAsDescription` for the rules. The v2.2 scanner.ts
 * extracts `version:` from frontmatter and otherwise reads the first
 * body paragraph as description — so this transformer's output works
 * with both paths: the explicit frontmatter AND the legacy paragraph
 * fallback.
 */
export function normalizeSkillFrontmatter(
  content: string,
  skillName: string,
): string {
  if (hasFrontmatter(content)) return content;
  const description = extractFirstLineAsDescription(content, skillName);
  return `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${content}`;
}
