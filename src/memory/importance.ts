/**
 * Importance scoring for memory entries.
 *
 * Calculates a deterministic importance score (0.0-1.0) based on
 * content characteristics: length, code blocks, numeric values,
 * and proper nouns. Applied automatically on memory insert.
 */

/**
 * Calculate the importance score for a memory entry.
 *
 * Formula:
 * - lengthScore = min(content.length / 500, 0.3)
 * - entityScore = min(codeBlocks*0.1 + numbers*0.02 + properNouns*0.03, 0.4)
 * - recencyBoost = 0.2 (always applied on insert)
 * - result = clamp(lengthScore + entityScore + recencyBoost, 0, 1)
 *
 * @param content - The memory text content
 * @returns Importance score between 0.0 and 1.0
 */
export function calculateImportance(content: string): number {
  const lengthScore = Math.min(content.length / 500, 0.3);

  const codeBlocks = [...content.matchAll(/```[\s\S]*?```/g)].length;
  const numbers = [...content.matchAll(/\b\d+(?:\.\d+)?\b/g)].length;
  const properNouns = [...content.matchAll(/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b/g)].length;

  const entityScore = Math.min(
    codeBlocks * 0.1 + numbers * 0.02 + properNouns * 0.03,
    0.4,
  );

  const recencyBoost = 0.2;

  return Math.min(Math.max(lengthScore + entityScore + recencyBoost, 0), 1);
}
