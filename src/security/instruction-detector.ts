/**
 * Instruction-pattern detector (SEC-02).
 *
 * Pure string-matching module that identifies potential prompt injection
 * patterns in user messages. Returns a frozen result with risk level and
 * matched pattern sources. ZERO imports -- no external dependencies.
 *
 * Used by the capture helper (Phase 65) to flag suspicious content before
 * it enters the conversation store. Detection never blocks storage.
 */

/** Result of scanning a message for instruction-like patterns. */
export type InstructionDetectionResult = {
  readonly detected: boolean;
  readonly patterns: readonly string[];
  readonly riskLevel: "none" | "low" | "medium" | "high";
};

/**
 * High-risk patterns indicate direct prompt injection attempts.
 * These patterns try to override system instructions, reassign agent identity,
 * or inject system-level markup.
 */
const HIGH_RISK_PATTERNS: readonly RegExp[] = Object.freeze([
  /<\s*system\s*>/i,
  /<<\s*SYS\s*>>/i,
  /\[INST\]/i,
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /disregard\s+(your|all)\s+(previous\s+)?(training|instructions)/i,
]);

/**
 * Medium-risk patterns indicate prompt probing or delimiter abuse.
 * These may be legitimate curiosity but warrant logging.
 */
const MEDIUM_RISK_PATTERNS: readonly RegExp[] = Object.freeze([
  /repeat\s+your\s+(system\s+)?prompt/i,
  /what\s+are\s+your\s+instructions/i,
  /\[\s*SYSTEM\s*\]/i,
  /---\s*\n\s*new\s+conversation\s*\n\s*---/im,
]);

/**
 * Scan user message content for instruction-like patterns.
 *
 * Returns a frozen InstructionDetectionResult:
 * - detected: true if any pattern matched
 * - patterns: array of matched RegExp .source strings
 * - riskLevel: "high" if any high pattern matched, "medium" if only medium, "none" otherwise
 *
 * This function is pure (no side effects) and has zero imports.
 */
export function detectInstructionPatterns(
  content: string,
): InstructionDetectionResult {
  const matched: string[] = [];
  let highFound = false;
  let mediumFound = false;

  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(content)) {
      matched.push(pattern.source);
      highFound = true;
    }
  }

  for (const pattern of MEDIUM_RISK_PATTERNS) {
    if (pattern.test(content)) {
      matched.push(pattern.source);
      mediumFound = true;
    }
  }

  const riskLevel = highFound ? "high" : mediumFound ? "medium" : "none";

  return Object.freeze({
    detected: matched.length > 0,
    patterns: Object.freeze(matched),
    riskLevel,
  });
}
