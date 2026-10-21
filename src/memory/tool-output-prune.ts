/**
 * Phase 115 Plan 03 sub-scope 9 — Phase 1 (no-LLM) tool-output pruning.
 *
 * Replaces tool outputs older than the most-recent N turns with 1-line
 * summaries:
 *
 *     [tool output pruned: <tool_name> @ <timestamp>]
 *
 * Goal: shed conversation-history bloat caused by large tool outputs (web
 * fetches, file reads, MCP responses) WITHOUT calling an LLM. Cheap;
 * deterministic; often sufficient on the response-path before any
 * Phase 2 (LLM mid-summarization) or Phase 3 (drop oldest) compaction
 * fires.
 *
 * Phases 2 + 3 are explicitly **DEFERRED** to follow-on phases per
 * Phase 115 CONTEXT.md "out of scope" line 32 — sub-scope 9 ships ONLY
 * this Phase 1 path. The deferral is mentioned in this docstring so a
 * future reader sees where the boundary lies.
 *
 * Pure module — no side-effects, no I/O, no LLM dispatch. Safe to call
 * inline on the response path.
 *
 * **SUPERSEDED (Phase 999.75 Part A) for the compaction path.** Compaction
 * no longer routes through `pruneToolOutputs` — the tiered extractors
 * (`src/manager/compact-extractors/`) own tool-output compression, fed by
 * the real SDK transcript (`src/memory/sdk-transcript-reader.ts`). This
 * function is retained as a standalone primitive for any caller that wants
 * a cheap inline marker-replace pass; it is intentionally NOT deleted.
 */

/**
 * Minimal turn shape pruning operates over. Designed to accept any
 * conversation-turn record carrying `role`, `content`, and the optional
 * tool-metadata fields the marker references. The shape is structurally
 * compatible with both `ConversationTurn` (src/memory/compaction.ts) and
 * the wider tool-aware turn shape Plan 115-04 callers may pass.
 */
export interface ToolOutputTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: string;
  /**
   * When set, the marker uses this name (e.g. "web_search", "Read",
   * "mcp__discord__send"). When unset, the marker uses "<unknown>".
   */
  readonly toolName?: string;
  /**
   * When true, this turn carries a tool output that prune is allowed to
   * replace. When false / undefined, the turn is left alone — a safety
   * net so non-tool-output turns (plain agent reasoning, user messages)
   * pass through untouched even if they happen to contain large bodies.
   *
   * For string-only turn streams that have no per-turn flag, callers can
   * detect via the `tool_use_result` XML envelope inside `content` —
   * `pruneToolOutputs` only rewrites a turn whose `isToolOutput === true`
   * OR whose `content` matches the tool-output XML envelope. This keeps
   * the function back-compat with the existing `ConversationTurn` shape
   * (which has neither field) — those turns pass through.
   */
  readonly isToolOutput?: boolean;
}

export interface PruneOptions {
  /**
   * Number of most-recent turns to PRESERVE verbatim. Default 3.
   * Older turns are eligible for pruning. The window is counted from the
   * end of the array (turns are most-recent-last per project convention).
   */
  readonly keepRecentN?: number;
  /**
   * Minimum char count below which a tool output is left alone (debug-
   * friendly: don't redact 50-char results). Default 200.
   */
  readonly minBytesToPrune?: number;
}

const DEFAULT_KEEP_RECENT = 3;
const DEFAULT_MIN_BYTES = 200;

/**
 * XML envelope used by Claude tool_use_result blocks. Capturing the
 * tool_use_id lets us recover an attribution name when the caller
 * doesn't pass `toolName` on the turn.
 */
const TOOL_OUTPUT_XML_REGEX =
  /<tool_use_result(?:\s+[^>]*?)?>([\s\S]*?)<\/tool_use_result>/g;

/**
 * Build the 1-line summary marker. Format pinned by Plan 115-03 T04
 * acceptance criteria — the marker text is part of the contract Plan
 * 115-04+ may grep for.
 */
function formatPruneMarker(toolName: string, timestamp: string): string {
  return `[tool output pruned: ${toolName} @ ${timestamp}]`;
}

/**
 * Replace tool outputs older than `keepRecentN` with 1-line summaries.
 *
 * Pure: returns a new array. Input array is not mutated; turn objects
 * that are unchanged are returned by reference (the same `ToolOutputTurn`
 * instance) so deep-equality on unaffected turns short-circuits in
 * downstream consumers (Phase 67 conversation-brief diff path).
 *
 * Anti-thrash is **NOT** wired into this signature on purpose — the
 * caller (CompactionManager) owns thrash detection and decides whether
 * to call this function at all. Keeps the function predictable: same
 * input → same output, every time.
 */
export function pruneToolOutputs(
  turns: readonly ToolOutputTurn[],
  options: PruneOptions = {},
): ToolOutputTurn[] {
  const keepRecentN = options.keepRecentN ?? DEFAULT_KEEP_RECENT;
  const minBytes = options.minBytesToPrune ?? DEFAULT_MIN_BYTES;

  if (turns.length === 0) return [];

  // Cutoff: indices < cutoffIdx are eligible for pruning.
  // turns are most-recent-last → preserve the LAST keepRecentN.
  const cutoffIdx = Math.max(0, turns.length - keepRecentN);
  if (cutoffIdx === 0) {
    // Everything is in the protected window — nothing to prune.
    return [...turns];
  }

  const out: ToolOutputTurn[] = new Array(turns.length);

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (i >= cutoffIdx) {
      // Inside the preserve-tail window — pass through verbatim.
      out[i] = turn;
      continue;
    }

    const eligible =
      turn.isToolOutput === true ||
      TOOL_OUTPUT_XML_REGEX.test(turn.content);
    // RegExp.test mutates lastIndex when the regex carries the `g` flag —
    // reset so the next iteration starts fresh.
    TOOL_OUTPUT_XML_REGEX.lastIndex = 0;

    if (!eligible) {
      out[i] = turn;
      continue;
    }

    // Skip tiny outputs (debug-friendly).
    if (turn.content.length < minBytes) {
      out[i] = turn;
      continue;
    }

    const toolName = turn.toolName ?? "<unknown>";
    out[i] = Object.freeze({
      ...turn,
      content: formatPruneMarker(toolName, turn.timestamp),
    });
  }

  return out;
}

/**
 * Compute the percent of bytes saved by a prune pass. Returns 0 when
 * input had no content. Useful for caller-side anti-thrash decisions:
 * if the last two prune passes saved < threshold% each, the caller can
 * skip further prunes until the conversation grows again.
 */
export function pruneSavingsPct(
  before: readonly ToolOutputTurn[],
  after: readonly ToolOutputTurn[],
): number {
  const beforeLen = before.reduce((sum, t) => sum + t.content.length, 0);
  if (beforeLen === 0) return 0;
  const afterLen = after.reduce((sum, t) => sum + t.content.length, 0);
  const saved = Math.max(0, beforeLen - afterLen);
  return (saved / beforeLen) * 100;
}
