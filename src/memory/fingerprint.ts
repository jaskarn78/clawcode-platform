/**
 * Personality fingerprint extraction from SOUL.md content.
 *
 * Compresses agent identity into a compact (~300 token) system prompt snippet
 * suitable for on-demand memory loading (LOAD-02).
 */

/** Compact representation of an agent's personality extracted from SOUL.md. */
export type PersonalityFingerprint = {
  readonly name: string;
  readonly emoji: string;
  readonly traits: readonly string[];
  readonly style: string;
  readonly constraints: readonly string[];
  readonly instruction: string;
};

const MAX_TRAITS = 5;
const MAX_CONSTRAINTS = 3;
const MAX_OUTPUT_CHARS = 1200;
const TRUNCATED_TRAITS = 3;
const TRUNCATED_CONSTRAINTS = 2;

const DEFAULT_INSTRUCTION = "Use memory_lookup for deeper identity context when needed";

/** Unicode emoji pattern covering common emoji ranges. */
const EMOJI_PATTERN = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/u;

/**
 * Extract a compact personality fingerprint from SOUL.md content.
 *
 * Parses headings, bullet points, and sections to build a structured
 * identity summary. Returns frozen object with defaults for missing sections.
 */
export function extractFingerprint(soulContent: string): PersonalityFingerprint {
  const lines = soulContent.split("\n");

  const name = extractName(lines);
  const emoji = extractEmoji(lines);
  const sections = parseSections(lines);

  const traits = extractBullets(sections, ["soul", "personality", "traits", "identity"]).slice(0, MAX_TRAITS);
  const style = extractFirstSentence(sections, ["style", "communication"]);
  const constraints = extractBullets(sections, ["constraint", "rule"]).slice(0, MAX_CONSTRAINTS);

  return Object.freeze({
    name,
    emoji,
    traits: Object.freeze(traits),
    style,
    constraints: Object.freeze(constraints),
    instruction: DEFAULT_INSTRUCTION,
  });
}

/**
 * Format a PersonalityFingerprint as a compact markdown snippet.
 *
 * Hard cap: if output exceeds 1200 characters, truncates traits to 3
 * and constraints to 2.
 */
export function formatFingerprint(fp: PersonalityFingerprint): string {
  let output = renderMarkdown(fp);

  if (output.length > MAX_OUTPUT_CHARS) {
    const truncated: PersonalityFingerprint = Object.freeze({
      ...fp,
      traits: Object.freeze(fp.traits.slice(0, TRUNCATED_TRAITS)),
      constraints: Object.freeze(fp.constraints.slice(0, TRUNCATED_CONSTRAINTS)),
    });
    output = renderMarkdown(truncated);
  }

  // Final hard truncation if still over (extremely long individual values)
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS - 3) + "...";
  }

  return output;
}

/** Render fingerprint fields as markdown. */
function renderMarkdown(fp: PersonalityFingerprint): string {
  const parts: string[] = ["## Identity"];

  parts.push(`- **Name:** ${fp.name}${fp.emoji ? ` ${fp.emoji}` : ""}`);

  if (fp.traits.length > 0) {
    parts.push(`- **Core traits:** ${fp.traits.join(", ")}`);
  }

  if (fp.style) {
    parts.push(`- **Style:** ${fp.style}`);
  }

  if (fp.constraints.length > 0) {
    parts.push(`- **Constraints:** ${fp.constraints.join(". ")}`);
  }

  parts.push(`- ${fp.instruction}`);

  return parts.join("\n");
}

/** Extract agent name from the first heading line. */
function extractName(lines: readonly string[]): string {
  for (const line of lines) {
    const match = line.match(/^#+\s+(?:Agent:\s*)?(.+)/);
    if (match) {
      // Remove emoji from name
      const raw = match[1].trim();
      return raw.replace(EMOJI_PATTERN, "").trim();
    }
  }
  return "Agent";
}

/** Extract emoji from the first heading line. */
function extractEmoji(lines: readonly string[]): string {
  for (const line of lines) {
    if (/^#+\s+/.test(line)) {
      const match = line.match(EMOJI_PATTERN);
      return match ? match[0] : "";
    }
  }
  return "";
}

/** Section = heading text (lowercase) -> array of content lines below it. */
type SectionMap = ReadonlyMap<string, readonly string[]>;

/** Parse content into sections keyed by heading text. */
function parseSections(lines: readonly string[]): SectionMap {
  const sections = new Map<string, string[]>();
  let currentKey: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      if (currentKey !== null) {
        sections.set(currentKey, currentLines);
      }
      currentKey = headingMatch[1].trim().toLowerCase();
      currentLines = [];
    } else if (currentKey !== null) {
      currentLines.push(line);
    }
  }

  if (currentKey !== null) {
    sections.set(currentKey, currentLines);
  }

  return sections;
}

/** Extract bullet items from sections whose heading matches any keyword. */
function extractBullets(sections: SectionMap, keywords: readonly string[]): string[] {
  const bullets: string[] = [];

  for (const [heading, lines] of sections) {
    const headingLower = heading.toLowerCase();
    if (keywords.some((kw) => headingLower.includes(kw))) {
      for (const line of lines) {
        const bulletMatch = line.match(/^\s*-\s+(.+)/);
        if (bulletMatch) {
          bullets.push(bulletMatch[1].trim());
        }
      }
    }
  }

  return bullets;
}

/** Extract first sentence from sections whose heading matches any keyword. */
function extractFirstSentence(sections: SectionMap, keywords: readonly string[]): string {
  for (const [heading, lines] of sections) {
    const headingLower = heading.toLowerCase();
    if (keywords.some((kw) => headingLower.includes(kw))) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("-") && !trimmed.startsWith("#")) {
          // Return first sentence (up to period) or entire line
          const sentenceEnd = trimmed.indexOf(".");
          return sentenceEnd >= 0 ? trimmed.slice(0, sentenceEnd + 1) : trimmed;
        }
      }
    }
  }
  return "";
}
