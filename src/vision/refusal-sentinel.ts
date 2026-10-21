/**
 * Phase 999.154 — last-line defense against "analysis" that is really the
 * model saying it received no image. From 2026-05-19 to 2026-09-22 every
 * pre-pass result on the bridge route was exactly this shape and was injected
 * into turns and stored in memory fleet-wide. Whatever the transport does,
 * text matching these shapes is never presented as analysis.
 */

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\b(?:don'?t|do not|cannot|can'?t|unable to)\s+(?:see|view|access|find|detect)\s+(?:an?|the|any)\s+(?:image|chart|graph|picture|photo|file|screenshot|attachment)/i,
  /\bplease\s+(?:provide|share|attach|upload|send)\s+(?:the|an?|your)\s+(?:image|chart|graph|picture|photo|file|screenshot)/i,
  /\bno\s+(?:image|chart|picture|photo|screenshot|attachment)\s+(?:was\s+|is\s+|has been\s+)?(?:attached|provided|included|shared)/i,
  /\b(?:image|chart|file)\s+(?:path\s+)?(?:was\s+|is\s+)?(?:not\s+)?(?:attached|included)\s+to\s+your\s+message/i,
  // "I need an image file path to analyze", "I need the chart or graph image",
  // "I need you to provide the chart", "I need to see the chart" — measured on
  // the 913 distinct bodies stored in prod (2026-09-22).
  /\bI need (?:you to (?:provide|share|upload|send) |to see )?(?:an?|the) (?:image|chart|graph|picture|photo|screenshot|file)\b/i,
  /\bno\s+(?:image|chart|graph|picture|photo|screenshot|attachment)(?:\s+or\s+(?:image|chart|graph|picture|photo|screenshot))?\s+(?:was\s+|is\s+|has been\s+)?(?:attached|provided|included|shared)/i,
  /\bdon'?t see (?:one|it|anything) (?:attached|here|in)/i,
  /\bha(?:s|ve)(?:n'?t| not) (?:provided|shared|attached|sent|uploaded) (?:an?|the|any) (?:image|chart|graph|picture|photo|screenshot|file)\b/i,
];

/**
 * A vision block body cut off by a chunk boundary right after the refusal's
 * opening words ("I don't see", "I don't see a"). Only meaningful INSIDE a
 * vision block — never applied to free text.
 */
export function isTruncatedRefusal(body: string): boolean {
  return /^I (?:don'?t|do not|can'?t|cannot) see(?: (?:an?|the|any))?\.?$/i.test(body.trim());
}

export function isVisionRefusal(text: string): boolean {
  if (text.length === 0) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(text));
}
