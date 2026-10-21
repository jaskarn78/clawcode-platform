/**
 * Phase 67 Plan 01 — `assembleConversationBrief` pure helper.
 *
 * Renders the last N session-summary MemoryEntries (written by Phase 66)
 * as a markdown brief suitable for the `conversation_context` section of
 * the context-assembler output. Purely functional: all deps (stores,
 * config, logger) + the `now` epoch are injected, so tests can simulate
 * any historical gap deterministically.
 *
 * SESS-02 — Last-N rendering: queries `findByTag("session-summary")`,
 *   sorts DESC by `createdAt` (ISO 8601 lex-sortable), slices to
 *   `config.sessionCount`, and renders each as a `### Session from …`
 *   markdown block under a stable `## Recent Sessions` heading.
 *
 * SESS-03 — 4-hour gap skip: reads the most recent TERMINATED session via
 *   `listRecentTerminatedSessions(agent, 1)` (excludes status='active').
 *   If the gap between `now` and `endedAt ?? startedAt` is below
 *   `gapThresholdHours`, returns `{ skipped: true, reason: "gap" }` WITHOUT
 *   touching MemoryStore (verified by spy in the paired test suite).
 *
 * agents-forget-across-sessions (2026-04-19): originally called
 *   `listRecentSessions` which included the just-created active session
 *   created by `SessionManager.startAgent` BEFORE buildSessionConfig runs.
 *   That made every startup evaluate gap~=0 and always gap-skip. Switched
 *   to the terminated-only variant so the gap is measured against the
 *   previous terminated session as the design intended.
 *
 * Accumulate budget strategy (CONTEXT.md §Specifics #4):
 *   Build the brief by iteratively adding summaries while total tokens
 *   stay ≤ `config.budgetTokens`. Stop when the next summary would
 *   overflow — never half-truncate mid-summary. If a single summary
 *   already exceeds budget we still accept it (operator can tune budget
 *   upward; dropping to `""` would silently hide content).
 *
 * Immutability: every returned object is `Object.freeze()`d per project
 * convention. The module performs zero side effects aside from the
 * optional pino-style `log.warn` on budget-reached observability.
 */

import type {
  AssembleBriefInput,
  AssembleBriefDeps,
  AssembleBriefResult,
} from "./conversation-brief.types.js";
import { countTokens } from "../performance/token-count.js";
import { renderAgentVisibleTimestamp } from "../shared/agent-visible-time.js";
import type { MemoryEntry } from "./types.js";

/** Default number of recent summaries rendered in the brief (SESS-02). */
export const DEFAULT_RESUME_SESSION_COUNT = 3;

/** Default gap threshold in hours — skip if last session ended less than this ago (SESS-03). */
export const DEFAULT_RESUME_GAP_THRESHOLD_HOURS = 4;

/** Default token budget for the rendered brief — dedicated; NOT shared with resume_summary. */
export const DEFAULT_CONVERSATION_CONTEXT_BUDGET = 2000;

/**
 * Hard floor on the brief's token budget. Below this the section is
 * unlikely to carry a useful summary. Enforced by Zod in `schema.ts` at
 * the config layer; mirrored here as a named constant for callers that
 * construct configs programmatically.
 */
export const MIN_CONVERSATION_CONTEXT_BUDGET = 500;

/** Stable heading — kept constant so prompt-cache remains stable turn-to-turn. */
const STABLE_HEADING = "## Recent Sessions";

/** Milliseconds in one hour — avoids a magic number in gap math. */
const HOUR_MS = 3_600_000;

/**
 * 99-mdrop — tag stamped on session-summary memories whose body is the
 * raw-turn dump (LLM summarize timed out / errored). conversation-brief
 * MUST NOT inject the bloated body verbatim because it blows past the
 * conversation_context budget and silently truncates everything.
 *
 * See: src/memory/session-summarizer.ts buildRawTurnFallback +
 *      .planning/phases/99-memory-translator-and-sync-hygiene/
 *      ADMIN-CLAWDY-MEMORY-DROP-2026-04-27.md
 */
const RAW_FALLBACK_TAG = "raw-fallback";

/**
 * Detect a raw-turn fallback memory. The summarizer adds `raw-fallback`
 * (existing convention since Phase 66). The audit doc proposed
 * `fallback:raw-turn` but we keep the established tag for back-compat.
 */
function isRawTurnFallback(entry: MemoryEntry): boolean {
  return entry.tags.includes(RAW_FALLBACK_TAG);
}

/**
 * Best-effort turn count for the placeholder line.
 *
 * Prefers `sourceTurnIds` (set by the summarizer at insert time). Falls
 * back to counting `### user|assistant` headers in the raw-turn dump,
 * since legacy entries may have been inserted before sourceTurnIds
 * tracking landed. Returns null if neither signal is available — the
 * placeholder still renders but omits the count.
 */
function rawTurnCount(entry: MemoryEntry): number | null {
  if (entry.sourceTurnIds && entry.sourceTurnIds.length > 0) {
    return entry.sourceTurnIds.length;
  }
  const headerMatches = entry.content.match(/^### (?:user|assistant) /gm);
  return headerMatches ? headerMatches.length : null;
}

/**
 * Render the 1-line placeholder for a raw-turn-tagged session.
 *
 * Operator-facing copy: surfaces context-loss without injecting the
 * bloated body. Mirrors the warn-style "⚠" prefix used in dashboards
 * so it visually matches restart-greeting alerts.
 */
function renderRawTurnPlaceholder(entry: MemoryEntry): string {
  const count = rawTurnCount(entry);
  const turns = count !== null ? `${count} turns` : "unknown length";
  return `⚠ Prior session ${turns} — summary unavailable (raw-turn fallback).`;
}

/**
 * Assemble a conversation brief for the given agent.
 *
 * Pure function — all deps + `now` are injected.
 *
 * Returns either:
 *   - `{ skipped: true, reason: "gap" }` when SESS-03 gap check fires, or
 *   - `{ skipped: false, brief, sessionCount, tokens, truncated }` with
 *     the rendered markdown (possibly `""` for zero history).
 */
export function assembleConversationBrief(
  input: AssembleBriefInput,
  deps: AssembleBriefDeps,
): AssembleBriefResult {
  const { agentName, now, agentTz } = input;
  const { conversationStore, memoryStore, config, log } = deps;

  // --- SESS-03 gap check (BEFORE any MemoryStore read) --------------------
  // Short-circuiting here preserves the test-asserted contract: if the
  // daemon was only briefly restarted, we don't even look for summaries.
  //
  // agents-forget-across-sessions (2026-04-19): use the terminated-only
  // variant — SessionManager.startAgent creates a fresh active session
  // BEFORE buildSessionConfig runs, so listRecentSessions would always
  // return that just-started row, collapse the gap to ~0ms, and gap-skip
  // the brief on every daemon boot. Terminated-only is the correct source
  // for "when did the previous session actually end?"
  const recent = conversationStore.listRecentTerminatedSessions(agentName, 1);
  if (recent.length > 0) {
    const last = recent[0]!;
    // For terminated sessions, endedAt is always populated (ended/crashed
    // transitions set it; summarized preserves the prior endedAt). The
    // `?? startedAt` fallback is defensive — a row with status in
    // (ended,crashed,summarized) but endedAt=null would be a schema
    // invariant violation upstream.
    const lastTsIso = last.endedAt ?? last.startedAt;
    // Clock-skew clamp: `Math.max(0, …)` keeps the gap non-negative even
    // when an NTP correction moves the system clock backward between
    // process restarts. Pitfall 7 in 67-RESEARCH.
    const gapMs = Math.max(0, now - new Date(lastTsIso).getTime());
    const thresholdMs = config.gapThresholdHours * HOUR_MS;
    if (gapMs < thresholdMs) {
      return Object.freeze({
        skipped: true as const,
        reason: "gap" as const,
      });
    }
  }

  // --- SESS-02 tag-scoped retrieval --------------------------------------
  // Filter by the `"session-summary"` tag ONLY (not `source === "conversation"`).
  // Other conversation-derived memories (facts, preferences) share the same
  // source and would pollute the brief. Pitfall 6 in 67-RESEARCH.
  const all = memoryStore.findByTag("session-summary");
  const candidates = [...all]
    .filter((m) => m.content.trim().length > 0)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // ISO 8601 lex-sortable DESC
    .slice(0, config.sessionCount);

  if (candidates.length === 0) {
    // Zero history → empty string (no heading, no placeholder). Caller
    // can guard with `if (brief)` to omit the section entirely.
    return Object.freeze({
      skipped: false as const,
      brief: "",
      sessionCount: 0,
      tokens: 0,
      truncated: false,
    });
  }

  // --- Accumulate budget enforcement -------------------------------------
  const accepted: MemoryEntry[] = [];
  let currentBrief = "";
  let currentTokens = 0;

  for (const entry of candidates) {
    const candidateBrief = renderBrief([...accepted, entry], now, agentTz);
    const candidateTokens = countTokens(candidateBrief);

    if (candidateTokens > config.budgetTokens && accepted.length > 0) {
      // Adding this summary would blow past the budget and we already
      // have at least one accepted. Stop here — dropping a whole summary
      // is honest; half-truncating a body would hide content.
      break;
    }

    if (candidateTokens > config.budgetTokens && accepted.length === 0) {
      // Single summary already exceeds budget. Accept it anyway: returning
      // `""` would silently hide content the operator asked for. They can
      // tune the budget upward if this becomes chronic. The `log.warn`
      // below still fires with `actualCount < requestedCount` so this
      // over-budget single-accept is observable.
      accepted.push(entry);
      currentBrief = candidateBrief;
      currentTokens = candidateTokens;
      break;
    }

    accepted.push(entry);
    currentBrief = candidateBrief;
    currentTokens = candidateTokens;
  }

  if (accepted.length < candidates.length) {
    // 99-mdrop telemetry: distinguish "budget truncation" from "no data"
    // so operators can monitor the high-impact case (context-loss risk).
    // truncationReason="budget" means we had more candidates than fit;
    // hasFallbackTagged=true means at least one CONSIDERED candidate was
    // a raw-turn fallback. The combination is the smoking-gun pattern
    // from ADMIN-CLAWDY-MEMORY-DROP-2026-04-27.md:
    //   requestedCount=3, actualCount=1, raw-turn dump in candidates →
    //   the agent is about to lose its working memory silently.
    const hasFallbackTagged = candidates.some(isRawTurnFallback);
    const payload = {
      agent: agentName,
      requestedCount: config.sessionCount,
      actualCount: accepted.length,
      tokens: currentTokens,
      budgetTokens: config.budgetTokens,
      section: "conversation_context",
      truncationReason: "budget" as const,
      hasFallbackTagged,
    };

    // SECURITY: never log brief content — only metadata. Mirrors the
    // `enforceSummaryBudget` warn-log convention.
    if (hasFallbackTagged && log?.error) {
      log.error(
        payload,
        "conversation-brief budget reached — context loss likely",
      );
    } else {
      log?.warn(payload, "conversation-brief budget reached");
    }
  }

  return Object.freeze({
    skipped: false as const,
    brief: currentBrief,
    sessionCount: accepted.length,
    tokens: currentTokens,
    truncated: false,
  });
}

/**
 * Render a frozen array of summaries as markdown under the stable heading.
 * Returns `""` for an empty input (no heading, no trailing whitespace).
 *
 * 99-mdrop — entries tagged `raw-fallback` render as a 1-line placeholder
 * instead of injecting the full raw-turn dump (which would blow the
 * conversation_context budget and truncate the brief silently).
 */
function renderBrief(
  summaries: readonly MemoryEntry[],
  now: number,
  agentTz?: string,
): string {
  if (summaries.length === 0) return "";
  const sections = summaries.map((mem) => {
    // Phase 999.13 TZ-04 (Q1=YES) — operator-local date, NOT UTC date.
    // A summary persisted at 2026-05-01T02:00Z with agentTz=America/Los_Angeles
    // renders as "2026-04-30" (operator-perceived) instead of "2026-05-01"
    // (UTC slice). Internal storage `mem.createdAt` stays UTC ISO; only the
    // rendered heading uses operator-local time.
    const date = renderAgentVisibleTimestamp(mem.createdAt, agentTz).slice(0, 10);
    const when = formatRelativeTime(mem.createdAt, now);
    const body = isRawTurnFallback(mem)
      ? renderRawTurnPlaceholder(mem)
      : mem.content;
    return `### Session from ${date} (${when})\n${body}`;
  });
  return `${STABLE_HEADING}\n\n${sections.join("\n\n")}`;
}

/**
 * Format a past ISO timestamp as "just now" / "N hour(s) ago" / "N day(s) ago".
 * Clamped to zero so future timestamps render as "just now" rather than
 * producing negative strings on clock skew.
 */
function formatRelativeTime(fromIso: string, now: number): string {
  const diffMs = Math.max(0, now - new Date(fromIso).getTime());
  const hours = Math.floor(diffMs / HOUR_MS);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
