/**
 * Phase 95 Plan 01 Task 2 — D-02/D-03 dream prompt builder.
 *
 * Pure module:
 *   - No SDK imports
 *   - No fs imports
 *   - No clock — input is fully deterministic for the same DreamPromptInput
 *
 * Assembles the dream context from 4 sections (D-02):
 *   1. Recent memory chunks (most recent N from memory_chunks SQLite,
 *      sorted lastModified DESC)
 *   2. Current MEMORY.md content
 *   3. Recent conversation summaries (last-3 session-end summaries)
 *   4. Existing wikilinks (graph-edges.json snapshot, raw text)
 *
 * Token budget: ≤32K input. Truncate oldest chunks first if over budget.
 * Estimation: chars/4 heuristic (consistent with v1.7 token budget tuning).
 *
 * D-03 system-prompt template is verbatim from 95-CONTEXT specifics:
 *   "You are <agent>'s reflection daemon..."
 * Subtle wording changes can change LLM output behavior — pinned by
 * static-grep regression tests in 95-01-PLAN action 5.
 *
 * Phase 999.119 pass 2 (2026-09-05) — the budget loops used to re-render
 * and re-measure the WHOLE prompt after every dropped chunk / summary
 * (O(n × total chars); the 1,000-chunk regression test took tens of
 * seconds). Every measurement in this module is a plain character count,
 * so the loops now run on precomputed section lengths and the prompt is
 * rendered once. Output is byte-identical to the previous algorithm
 * (pinned by the equivalence test in dream-prompt-builder.test.ts).
 */

/** Hard cap on the assembled user-prompt input tokens (D-02). */
export const DREAM_PROMPT_INPUT_TOKEN_BUDGET = 32_000;

import { renderAgentVisibleTimestamp } from "../shared/agent-visible-time.js";

/** chars/4 heuristic — matches v1.7 token-budget tuning. */
const CHARS_PER_TOKEN = 4;

/**
 * Memory chunk shape consumed by the dream prompt. Minimal — id + path
 * for citation, body for content, lastModified for oldest-first sort.
 *
 * Distinct from `src/memory/memory-chunks.MemoryChunk` (which is the
 * chunker's output shape) — this is the DI getter contract that 95-02
 * adapts the SQLite getter to. Keep them decoupled so the schema in this
 * file evolves with the dream pass without affecting the chunker.
 */
export type MemoryChunk = Readonly<{
  id: string;
  path: string;
  body: string;
  lastModified: Date;
}>;

/**
 * Conversation-summary shape consumed by the dream prompt. Minimal —
 * sessionId + summary for content, endedAt for ordering. Distinct from
 * the full ConversationSession to keep the DI surface narrow.
 */
export type ConversationSummary = Readonly<{
  sessionId: string;
  summary: string;
  endedAt: Date;
}>;

export interface DreamPromptInput {
  readonly recentChunks: readonly MemoryChunk[];
  readonly memoryMd: string;
  readonly recentSummaries: readonly ConversationSummary[];
  readonly graphEdges: string;
  readonly agentName: string;
  /**
   * Phase 999.13 TZ-04 (Q2=YES) — operator-local IANA TZ used for the
   * `lastModified=…` (chunk header) and `ended …` (summary header)
   * timestamps. The dream-pass agent reads these prompts as agent-visible
   * context. When omitted, falls back to host TZ via the helper. Internal
   * `MemoryChunk.lastModified` and `ConversationSummary.endedAt` Date
   * objects stay UTC; only the rendered prompt uses operator-local time.
   */
  readonly agentTz?: string;
}

export interface BuildDreamPromptResult {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly estimatedInputTokens: number;
}

/**
 * Estimate token count via chars/4 heuristic (Math.ceil so empty strings
 * round up to 0 and one-char strings round up to 1). Pure function.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Same heuristic applied to an already-known character count. */
function estimateTokensForLength(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Build the D-03 system prompt. Verbatim from 95-CONTEXT specifics —
 * "<agent>'s reflection daemon" is the LLM-facing marker line. Pinned
 * by P1 test + static-grep regression rules.
 */
function buildSystemPrompt(agentName: string): string {
  return `You are ${agentName}'s reflection daemon. Your job is to read recent memory chunks, the core MEMORY.md, recent conversation summaries, and the existing wikilink graph, then emit a structured reflection.

CRITICAL OUTPUT RULES:
1. Your response MUST be valid JSON, parseable by JSON.parse() with no preprocessing.
2. The FIRST character MUST be '{' (no narrative preamble like "Picking up...", "Here's the reflection...", or "Sure!").
3. The LAST character MUST be '}' (no trailing commentary, no closing remarks).
4. NO markdown code fences (no \`\`\`json wrapper).
5. NO explanation text before or after the JSON object.
6. If you cannot produce valid JSON for any reason (input unclear, no patterns found, internal error), output this EXACT fallback envelope and NOTHING else:
{"newWikilinks":[],"promotionCandidates":[],"themedReflection":"","suggestedConsolidations":[]}
NEVER output prose like "Noted —", "I'll do my best", "Picking up where we left off", or any other chat-style preamble.

Required JSON schema (all 4 fields mandatory; use empty arrays/strings if no content):
{
  "newWikilinks": [{"from": "memory/path.md", "to": "memory/other.md", "rationale": "..."}],
  "promotionCandidates": [{"chunkId": "...", "currentPath": "memory/...", "rationale": "...", "priorityScore": 0-100}],
  "themedReflection": "1-3 paragraph narrative summary of recent activity",
  "suggestedConsolidations": [{"sources": ["memory/A.md", "memory/B.md"], "newPath": "memory/consolidations/X.md", "rationale": "..."}]
}

Focus on:
- Connections that are NEW (not already in graph-edges.json)
- Chunks referenced 3+ times in recent memory but NOT in MEMORY.md (promotion candidates)
- Themes spanning multiple recent chunks (consolidation candidates)
- 1-3 paragraph narrative on what happened recently (placed inside the themedReflection JSON string)`;
}

/**
 * Render one memory chunk as a fenced markdown block. Path + lastModified
 * appear so the LLM can cite specific chunks in its output.
 *
 * Phase 999.13 TZ-04 (Q2=YES) — `agentTz` (optional) controls operator-
 * local rendering of `lastModified`. Falls back to host TZ when omitted.
 */
function renderChunk(c: MemoryChunk, agentTz?: string): string {
  return `### ${c.path} (id=${c.id}, lastModified=${renderAgentVisibleTimestamp(c.lastModified, agentTz)})\n\n${c.body}`;
}

/**
 * Render one conversation summary as a fenced markdown block.
 *
 * Phase 999.13 TZ-04 (Q2=YES) — `agentTz` (optional) controls operator-
 * local rendering of `endedAt`. Falls back to host TZ when omitted.
 */
function renderSummary(s: ConversationSummary, agentTz?: string): string {
  return `### Session ${s.sessionId} (ended ${renderAgentVisibleTimestamp(s.endedAt, agentTz)})\n\n${s.summary}`;
}

/** Separator between rendered entries inside a section. */
const ENTRY_SEPARATOR = "\n\n";
/** Placeholder for an empty section. */
const EMPTY_SECTION = "(none)";

/** Join rendered entries, or the placeholder when there are none. */
function joinSection(rendered: readonly string[]): string {
  return rendered.length === 0 ? EMPTY_SECTION : rendered.join(ENTRY_SEPARATOR);
}

/** Character count `joinSection(rendered)` would have — without building it. */
function joinedLength(rendered: readonly string[]): number {
  if (rendered.length === 0) return EMPTY_SECTION.length;
  let total = ENTRY_SEPARATOR.length * (rendered.length - 1);
  for (const s of rendered) total += s.length;
  return total;
}

/** A free-text section, or the placeholder when blank. */
function textSection(text: string): string {
  return text.trim().length === 0 ? EMPTY_SECTION : text;
}

/**
 * Compose the user prompt from the 4 D-02 sections. Each empty source
 * falls back to "(none)" so the LLM gets a stable structure regardless
 * of input cardinality.
 */
function assembleUserPrompt(
  chunkSection: string,
  memorySection: string,
  summarySection: string,
  wikiSection: string,
): string {
  return `## Recent memory chunks

${chunkSection}

## MEMORY.md

${memorySection}

## Recent conversation summaries

${summarySection}

## Existing wikilinks

${wikiSection}`;
}

/** Characters the scaffold (headers + blank lines) contributes on its own. */
const SCAFFOLD_LENGTH = assembleUserPrompt("", "", "", "").length;

/**
 * Phase 999.113 WS-2 — appended to any section shortened to fit the budget so
 * the reflection model can tell truncation from genuine absence.
 */
const TRUNCATION_MARKER = "\n\n…[truncated to fit the dream prompt budget]";

/**
 * Shorten `s` to at most `maxChars`, leaving room for the marker. Pure.
 */
function truncateWithMarker(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  // Not enough room for a marker — hard-cut. Honouring the cap outranks
  // annotating it.
  if (maxChars <= TRUNCATION_MARKER.length) {
    return s.slice(0, Math.max(0, maxChars));
  }
  return s.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Shrink one section by exactly the current overflow, converting the token
 * overage back to characters via the same chars/4 heuristic used to measure
 * it. `totalChars` is the length of system prompt + rendered user prompt.
 * Returns `section` untouched when already within budget. Pure.
 */
function shrinkToFit(section: string, totalChars: number): string {
  const overflowTokens =
    estimateTokensForLength(totalChars) - DREAM_PROMPT_INPUT_TOKEN_BUDGET;
  if (overflowTokens <= 0) return section;
  const overflowChars = overflowTokens * CHARS_PER_TOKEN;
  return truncateWithMarker(
    section,
    Math.max(0, section.length - overflowChars - TRUNCATION_MARKER.length),
  );
}

/**
 * Assemble the dream system + user prompts within the 32K input-token
 * budget. Oldest-first chunk truncation drops the LEAST recent entries
 * if the rendered prompt exceeds DREAM_PROMPT_INPUT_TOKEN_BUDGET.
 *
 * Truncation algorithm:
 *   1. Sort chunks lastModified DESC (newest first)
 *   2. Measure the prompt (section lengths + scaffold)
 *   3. While estimated > budget AND chunks > 0: drop tail (oldest)
 *   4. Degrade the remaining sections (wikilinks → summaries → MEMORY.md)
 *   5. Render once; final clamp
 *
 * Pure function — no I/O, no clock. Same input → same output (modulo
 * Date.toISOString() which is itself deterministic).
 */
export function buildDreamPrompt(
  input: DreamPromptInput,
): BuildDreamPromptResult {
  const systemPrompt = buildSystemPrompt(input.agentName);
  const tz = input.agentTz;

  // Sort newest first so dropping from the tail removes the oldest.
  // Slice + sort to avoid mutating the caller's input array.
  const sortedChunks = [...input.recentChunks].sort(
    (a, b) => b.lastModified.getTime() - a.lastModified.getTime(),
  );

  // Render every entry exactly once; the budget loops below work on the
  // rendered lengths, never on the assembled prompt.
  let renderedChunks: string[] = sortedChunks.map((c) => renderChunk(c, tz));
  let renderedSummaries: string[] = input.recentSummaries.map((s) =>
    renderSummary(s, tz),
  );
  let graphEdges = input.graphEdges;
  let memoryMd = input.memoryMd;

  const totalChars = (): number =>
    systemPrompt.length +
    SCAFFOLD_LENGTH +
    joinedLength(renderedChunks) +
    textSection(memoryMd).length +
    joinedLength(renderedSummaries) +
    textSection(graphEdges).length;

  const overBudget = (): boolean =>
    estimateTokensForLength(totalChars()) > DREAM_PROMPT_INPUT_TOKEN_BUDGET;

  // Step 1 — drop oldest chunks first (original D-02 behaviour).
  while (overBudget() && renderedChunks.length > 0) {
    renderedChunks = renderedChunks.slice(0, -1);
  }

  // Phase 999.113 WS-2 (2026-08-28) — chunk-dropping ALONE cannot honour the
  // cap: the loop above exits when `chunks` empties whether or not the budget
  // was met. The old comment here conceded that the non-chunk sections were
  // never truncated and called it "the caller's responsibility" — in practice
  // no caller enforced it, so the fleet-admin agent (largest MEMORY.md and
  // graph) shipped a prompt 3.5x the declared cap. The oversized request was
  // rejected outright, the bridge discarded the reason, and Admin Clawdy
  // silently stopped dreaming for 14 days. A module that documents a "Hard
  // cap" must actually enforce it, so degrade the remaining sections in
  // ascending order of reflective value.

  // Step 2 — truncate the wikilink snapshot. Large, mechanical, and the least
  // load-bearing for reflection; a partial edge list still suppresses
  // duplicate-link proposals.
  if (overBudget()) {
    graphEdges = shrinkToFit(graphEdges, totalChars());
  }

  // Step 3 — drop oldest conversation summaries (newest carry the most signal).
  while (overBudget() && renderedSummaries.length > 0) {
    renderedSummaries = renderedSummaries.slice(0, -1);
  }

  // Step 4 — trim MEMORY.md last: it is the agent's curated core, the single
  // most valuable section, so it degrades only when nothing else remains.
  if (overBudget()) {
    memoryMd = shrinkToFit(memoryMd, totalChars());
  }

  let userPrompt = assembleUserPrompt(
    joinSection(renderedChunks),
    textSection(memoryMd),
    joinSection(renderedSummaries),
    textSection(graphEdges),
  );

  // Step 5 — final clamp. Steps 2-4 operate on section inputs, so scaffold and
  // headers could still leave the assembly marginally over. This makes the cap
  // an unconditional guarantee rather than a best effort: the returned prompt
  // can never exceed budget, whatever the input shape.
  if (estimateTokens(systemPrompt + userPrompt) > DREAM_PROMPT_INPUT_TOKEN_BUDGET) {
    const systemChars = systemPrompt.length;
    const promptCharBudget = Math.max(
      0,
      DREAM_PROMPT_INPUT_TOKEN_BUDGET * CHARS_PER_TOKEN - systemChars,
    );
    userPrompt = truncateWithMarker(userPrompt, promptCharBudget);
  }

  const estimatedInputTokens = estimateTokens(systemPrompt + userPrompt);
  return { systemPrompt, userPrompt, estimatedInputTokens };
}
