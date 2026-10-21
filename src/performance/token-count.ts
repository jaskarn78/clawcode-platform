/**
 * Phase 53 — canonical token counter for per-section budget enforcement.
 *
 * Wraps @anthropic-ai/tokenizer v0.0.4 so callers never import the raw
 * library directly. Used by the context-assembler (Wave 2) to emit
 * per-section token counts on the `context_assemble` span metadata,
 * and by the resume-summary budget enforcer (Wave 3).
 *
 * Contract:
 *   - `countTokens("")` returns `0` exactly (short-circuit, no tokenizer call)
 *   - `countTokens(text)` returns a non-negative integer matching Claude's
 *     BPE tokenizer output
 *   - Deterministic: repeated calls with identical input yield identical
 *     integer counts
 *
 * The library's `countTokens` constructs a fresh Tiktoken instance per call
 * and calls `.free()` on it internally, so no resource leak concerns here.
 */

import { countTokens as anthropicCountTokens } from "@anthropic-ai/tokenizer";

/**
 * Count BPE tokens in `text` using Anthropic's Claude tokenizer.
 *
 * @param text - Input string (may be empty)
 * @returns Non-negative integer token count (0 for empty string)
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return anthropicCountTokens(text);
}
