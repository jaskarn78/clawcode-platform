/**
 * Phase 125 Plan 03 — Tier 2 Haiku structured extraction prompt.
 *
 * Mirrors `src/memory/session-summarizer.ts:buildSessionSummarizationPrompt`
 * (D-03 — reuse the proven shape, do NOT invent a fresh worker). The
 * structural difference is the output contract: this prompt forces a STRICT
 * YAML block with a fixed key schema, no prose preamble, no JSON. Phase 95
 * dreaming hit JSON-fence + narrative-preamble bugs (commits f38ae00,
 * ca0122b, 509ff03); the parser at `tier2-parser.ts` is hardened against
 * the same modes, but the prompt is the first line of defence.
 *
 * Pure function — no I/O. Determinism is verified by tests.
 */

/** Cap so the per-compaction Haiku spend is bounded. */
export const MAX_PROMPT_CHARS = 6_000;

/**
 * Sentinel-friendly schema description — KEEP THE EXACT KEY NAMES in sync
 * with `Tier2Facts` in `./types.ts` and the Zod schema in `./tier2-parser.ts`.
 * Diverging key names produces silent "empty facts" parses.
 */
const SCHEMA_BLOCK = `activeClients: [name1, name2]
decisions:
  - decision: "..."
    context: "..."
standingRulesChanged:
  - rule: "..."
    changedAt: "ISO"
inFlightTasks:
  - task: "..."
    state: "..."
drivePathsTouched: ["clients/Foo/", "..."]
criticalNumbers:
  - context: "..."
    value: "$45M AUM"`;

/**
 * Build the structured-extraction prompt.
 *
 * `text` is the compacted-region text the daemon already builds (the
 * concatenated `[role]: content` lines that `compactForAgent` flushes).
 * We truncate from the head if it exceeds MAX_PROMPT_CHARS so the most
 * recent turns survive — Haiku's context budget is the cost-sensitive
 * resource here.
 */
export function buildTier2ExtractionPrompt(text: string): string {
  let payload = text;
  if (payload.length > MAX_PROMPT_CHARS) {
    payload =
      "[...older turns truncated for prompt-size cap]\n" +
      payload.slice(payload.length - MAX_PROMPT_CHARS);
  }

  return `You are extracting load-bearing facts from a compacted conversation segment.

Output ONLY a single YAML block with the EXACT keys below. Do NOT emit prose, do NOT emit JSON, do NOT wrap in markdown fences. The first character of your reply MUST be the letter "a" (activeClients).

Schema (keep keys verbatim — empty arrays are fine, omit nothing):

${SCHEMA_BLOCK}

Rules:
- activeClients: distinct client/project names mentioned (max 20).
- decisions: concrete agreements ("we agreed X", "we decided Y") — not speculation (max 20).
- standingRulesChanged: rules added, removed, or amended in this segment (max 20). changedAt is ISO 8601 if present in the text, otherwise an empty string.
- inFlightTasks: tasks the operator or agent has not yet completed (max 20). state is a short phrase ("blocked on X", "waiting on Y", "in progress").
- drivePathsTouched: file/folder paths referenced (clients/Foo/, drive paths, repo paths) (max 30).
- criticalNumbers: recover-or-lose-it numbers — AUM figures, dollar amounts, dates, prices, counts. value is the verbatim string, context is the surrounding meaning (max 30).
- If a category has nothing, emit an empty array (\`[]\`) — do NOT omit the key.

# Conversation segment

${payload}
`;
}
