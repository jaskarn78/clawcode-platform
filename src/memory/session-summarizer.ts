/**
 * Session-boundary summarizer — compresses conversation turns into a
 * MemoryEntry at session end/crash.
 *
 * Mirrors consolidation.ts structure: pure helpers + dep-injected pipeline.
 * The pipeline is pure in the "no SDK / no daemon imports" sense; the LLM
 * call is injected as `deps.summarize` so unit tests can exercise every
 * branch (happy path, timeout fallback, LLM error, idempotency, short-
 * session skip) without touching the network.
 *
 * SESS-01: on session end/restart, raw turns compressed via haiku call.
 * SESS-04: stored as MemoryEntry with source="conversation".
 */

import type { ConversationTurn } from "./conversation-types.js";
import type {
  FlushSessionInput,
  FlushSessionResult,
  SummarizeSessionDeps,
  SummarizeSessionInput,
  SummarizeSessionResult,
  SummarizeSuccessFallback,
} from "./session-summarizer.types.js";
import type { MemoryStore } from "./store.js";
import type { MemoryEntry } from "./types.js";

/**
 * Character budget for the conversation turns in a summarization prompt.
 * WP1 (memory overhaul 2026-10-25): turns that do not fit are cut to their
 * head and tail, and the oldest whole turns are dropped once every kept
 * turn would get less than MIN_CHARS_PER_TURN (see fitNewestToBudget).
 */
export const MAX_PROMPT_CHARS = 30_000;

/**
 * WP1 (memory overhaul 2026-10-25): floor for the per-turn budget. A
 * ConversationStore session spans the agent's whole uptime, so the old
 * purely proportional cut gave a 1000-turn session 30 characters per turn
 * (less than the Discord envelope) and the final summary carried nothing
 * usable. When even this many characters per turn would not fit, the
 * oldest whole turns are dropped instead.
 */
export const MIN_CHARS_PER_TURN = 300;

/**
 * WP1: budget for the mid-session checkpoint summaries the final session
 * summary folds in when older turns had to be dropped from its prompt, so
 * the summary that supersedes (and deletes) those checkpoints still covers
 * the early part of a long session.
 */
export const CHECKPOINT_BUDGET_CHARS = 12_000;

/** WP1: per-checkpoint floor inside CHECKPOINT_BUDGET_CHARS. */
export const MIN_CHARS_PER_CHECKPOINT = 1_500;

/** Marker inserted where a turn was cut. Tests and operators grep for it. */
const TRUNCATION_MARKER = "\n\n[...truncated due to length]\n\n";

/**
 * WP1: cut a turn to `maxChars` keeping its head and its tail (60/40)
 * around a marker, so a long answer keeps both its opening and its
 * conclusion. Content at or under the budget is returned unchanged.
 */
export function truncateHeadTail(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const budget = Math.max(0, Math.floor(maxChars));
  const headChars = Math.ceil(budget * 0.6);
  const tailChars = budget - headChars;
  const head = content.slice(0, headChars);
  const tail = tailChars > 0 ? content.slice(content.length - tailChars) : "";
  return head + TRUNCATION_MARKER + tail;
}

/**
 * WP1: fit the newest items of an ordered list into `budget` characters.
 *
 * Returns `start`, the index of the oldest item kept (everything before it
 * is dropped), and `cap`, the length to cut longer kept items to (null when
 * the kept items fit as they are). Old items are dropped only when the kept
 * window could not give each item at least `minEach` characters; inside the
 * window the cap is water-filled, so items shorter than the cap keep every
 * character and the long ones share the rest equally. The newest item is
 * always kept. Content that fits the budget is never dropped or cut.
 */
export function fitNewestToBudget(
  lengths: readonly number[],
  budget: number,
  minEach: number,
): { readonly start: number; readonly cap: number | null } {
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (total <= budget) return { start: 0, cap: null };

  let start = lengths.length;
  let floorCost = 0;
  while (start > 0) {
    const cost = Math.min(lengths[start - 1], minEach);
    if (start < lengths.length && floorCost + cost > budget) break;
    floorCost += cost;
    start--;
  }

  const kept = lengths.slice(start).sort((a, b) => a - b);
  let remaining = budget;
  for (let i = 0; i < kept.length; i++) {
    const share = Math.floor(remaining / (kept.length - i));
    if (kept[i] > share) return { start, cap: Math.max(0, share) };
    remaining -= kept[i];
  }
  return { start, cap: null };
}

/**
 * Default timeout for the summarize() LLM call.
 *
 * 99-mdrop (audit 2026-04-27, ADMIN-CLAWDY-MEMORY-DROP-2026-04-27.md):
 * bumped from 10_000 → 30_000ms. The 10s ceiling fired during a Haiku
 * latency spike on a 96-turn session, forcing the raw-turn fallback path
 * and causing silent context loss in the next session's resume-brief.
 *
 * 2026-06-18 (dream/summary/consolidation regression): bumped 30_000 →
 * 120_000ms. The haiku-via-bridge path spawns the `claude` binary and the
 * real summarizer / consolidation calls measured 30–64s on prod (large
 * weekly/session payloads). The 30s ceiling SIGTERM'd them mid-flight
 * (`exitCode 143`, even an `exitCode:0` that completed at 30.3s was marked
 * failed by the abort race) → empty summaries → no digest / raw-turn
 * fallback. 120s clears the observed p100 (~64s) with headroom while still
 * bounding a genuinely-hung binary. Shared by the consolidation runner
 * (daemon.ts wires summarizeWithHaiku here). Tests override via
 * `deps.config.timeoutMs`.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Default minimum turn count to trigger summarization. */
export const DEFAULT_MIN_TURNS = 3;

/** Default importance for session-summary MemoryEntries. */
export const DEFAULT_IMPORTANCE = 0.78;

/**
 * WP1: a mid-session checkpoint (flush row) offered to the final session
 * summary: its content and the highest turnIndex it covers.
 */
export type SummaryCheckpoint = Readonly<{
  throughTurnIndex: number;
  content: string;
}>;

/**
 * WP1: the checkpoints that cover turns older than `firstKeptTurnIndex`,
 * oldest first, fitted to CHECKPOINT_BUDGET_CHARS (newest checkpoints win
 * when they do not all fit). A checkpoint covers the turns after the
 * previous checkpoint's cursor up to its own, so it is relevant when that
 * range starts before the first turn the prompt still shows.
 */
function renderCheckpointSections(
  checkpoints: readonly SummaryCheckpoint[],
  firstKeptTurnIndex: number,
): readonly string[] {
  const sorted = checkpoints
    .filter((c) => c.throughTurnIndex >= 0 && c.content.trim().length > 0)
    .sort((a, b) => a.throughTurnIndex - b.throughTurnIndex);
  const relevant = sorted.filter(
    (_, i) => i === 0 || sorted[i - 1].throughTurnIndex + 1 < firstKeptTurnIndex,
  );
  if (relevant.length === 0) return [];
  const fit = fitNewestToBudget(
    relevant.map((c) => c.content.length),
    CHECKPOINT_BUDGET_CHARS,
    MIN_CHARS_PER_CHECKPOINT,
  );
  return relevant.slice(fit.start).map((c) => {
    const content =
      fit.cap !== null && c.content.length > fit.cap
        ? truncateHeadTail(c.content, fit.cap)
        : c.content;
    return `### checkpoint through turn ${c.throughTurnIndex}\n\n${content}`;
  });
}

/**
 * Build the structured prompt for Haiku.
 *
 * Format: a 4-category instruction block (User Preferences, Decisions,
 * Open Threads, Commitments) followed by role-annotated turn headers.
 *
 * WP1 (memory overhaul 2026-10-25): when the turns exceed
 * MAX_PROMPT_CHARS they are fitted with fitNewestToBudget: long turns are
 * cut to their head and tail (truncateHeadTail) so conclusions survive,
 * short turns stay whole, and the oldest whole turns are dropped only when
 * each kept turn would otherwise get less than MIN_CHARS_PER_TURN. When
 * turns were dropped and `opts.checkpoints` is given (the final summary
 * passes the session's mid-session flush rows), the checkpoints covering
 * the dropped turns are included so the summary still spans the whole
 * session. With `opts.segment` the instruction block describes a segment
 * of an ongoing session (the mid-session flush) instead of a completed one.
 *
 * An empty `turns` array still returns a valid prompt — the instruction
 * block is always present so callers cannot produce a malformed request.
 */
export function buildSessionSummarizationPrompt(
  turns: readonly ConversationTurn[],
  opts?: {
    readonly segment?: boolean;
    readonly checkpoints?: readonly SummaryCheckpoint[];
  },
): string {
  const fit = fitNewestToBudget(
    turns.map((t) => t.content.length),
    MAX_PROMPT_CHARS,
    MIN_CHARS_PER_TURN,
  );
  const omitted = fit.start;
  const kept = turns.slice(omitted);

  let truncatedTurns = 0;
  const sections: string[] = [];
  for (const turn of kept) {
    let content = turn.content;
    if (fit.cap !== null && content.length > fit.cap) {
      content = truncateHeadTail(content, fit.cap);
      truncatedTurns++;
    }
    sections.push(`### ${turn.role} (turn ${turn.turnIndex})\n\n${content}`);
  }

  const checkpointSections =
    omitted > 0 && kept.length > 0 && opts?.checkpoints
      ? renderCheckpointSections(opts.checkpoints, kept[0].turnIndex)
      : [];

  const subject = opts?.segment
    ? "a segment of an ongoing conversation session (the turns recorded since the previous checkpoint)"
    : "a completed conversation session";
  const notes: string[] = [];
  if (omitted > 0) {
    notes.push(
      `Note: the ${omitted} earliest turn(s) are not shown; only the most recent ${kept.length} turn(s) are.` +
        (checkpointSections.length > 0
          ? " Checkpoint summaries written earlier in this session cover the turns that are not shown: fold them into your summary."
          : ""),
    );
  }
  if (truncatedTurns > 0) {
    notes.push(
      "Note: some turn content was truncated due to length (the start and the end of each cut turn are kept). Summarize what is available.",
    );
  }

  const instructions = `You are summarizing ${subject} into a structured memory entry.
Extract and organize the following from the turns below:

## User Preferences
List preferences the user expressed (communication style, tool choices, formatting).

## Decisions
List concrete decisions made during the session, with brief rationale.

## Open Threads
List topics, questions, or tasks that were discussed but not resolved.

## Commitments
List explicit commitments made by either party (deadlines, promised actions, follow-ups).

Format your response as clean markdown with the exact section headers above.
If a category has nothing, write "(none)" under it — do not omit the header.
Be concise but preserve specific names, dates, and technical details.
${notes.length > 0 ? "\n" + notes.join("\n") : ""}

---

`;

  const checkpointBlock =
    checkpointSections.length > 0
      ? `# Earlier Checkpoints\n\n${checkpointSections.join("\n\n")}\n\n`
      : "";

  return `${instructions}${checkpointBlock}# Conversation Turns\n\n${sections.join("\n\n")}`;
}

/**
 * Deterministic fallback used when the LLM call times out or errors.
 *
 * Returns a markdown dump of raw turns — still embeds and becomes
 * searchable, still marks the session summarized for idempotency. The
 * "raw-fallback" tag is added by the pipeline so operators can find
 * these entries and re-summarize later if desired.
 */
export function buildRawTurnFallback(
  turns: readonly ConversationTurn[],
): string {
  if (turns.length === 0) {
    return "## Raw Turns\n\n(no turns)\n";
  }
  const sections = turns.map(
    (t) => `### ${t.role} (turn ${t.turnIndex})\n\n${t.content}`,
  );
  return `## Raw Turns\n\n${sections.join("\n\n")}\n`;
}

/**
 * 260419-q2z Fix A — deterministic one-line summary for sessions too short
 * to warrant a Haiku call. Guarantees every conversation leaves a
 * MemoryEntry behind (zero-turn sessions are skipped separately).
 *
 * Template:
 *   `{N} turn(s). Last user: "<first 80 chars>". Last agent: "<first 80 chars>".
 *    Tags: [session-summary, short].`
 *
 * Content exceeding 80 chars is truncated with a `...` suffix inside the
 * quotes. Messages ≤ 80 chars render verbatim (no ellipsis).
 */
export function buildShortSessionSummary(
  turns: readonly ConversationTurn[],
): string {
  const truncate = (s: string): string =>
    s.length > 80 ? `${s.slice(0, 80)}...` : s;
  const lastUser = [...turns].reverse().find((t) => t.role === "user");
  const lastAgent = [...turns].reverse().find((t) => t.role === "assistant");
  const userPart = lastUser ? `"${truncate(lastUser.content)}"` : `(none)`;
  const agentPart = lastAgent ? `"${truncate(lastAgent.content)}"` : `(none)`;
  return `${turns.length} turn(s). Last user: ${userPart}. Last agent: ${agentPart}. Tags: [session-summary, short].`;
}

/**
 * Summarize a completed conversation session and write the result as a
 * MemoryEntry.
 *
 * Pipeline (14 steps):
 *  1. Load session via conversationStore.getSession
 *  2. Idempotency: if status=summarized, short-circuit with skipped
 *  3. State machine: if status=active, reject with session-not-terminal
 *  4. Load turns via getTurnsForSession (Pitfall 2: use turns.length, not
 *     session.turnCount — turn_count is eventually-consistent under
 *     fire-and-forget recordTurn writes from Phase 65)
 *  5. Minimum-turns guard (default 3); skip cleanly with no writes
 *  6. Build prompt (buildSessionSummarizationPrompt)
 *  7. Call deps.summarize with an AbortController-driven timeout
 *  8. On success: use the LLM content verbatim
 *  9. On timeout/error/empty-response: use buildRawTurnFallback + tag
 *     "raw-fallback" so the session still becomes summarized (idempotent)
 *     and operators can find these entries and re-summarize later.
 * 10. Embed the chosen content (summary or raw fallback)
 * 11. Build tags ["session-summary", `session:${id}`, optional "raw-fallback"]
 * 12. memoryStore.insert with source="conversation", sourceTurnIds,
 *     skipDedup=true (summaries are unique by definition)
 * 13. conversationStore.markSummarized — non-fatal if it throws (state
 *     race: session may have been re-transitioned by another caller;
 *     the memory row still exists and is searchable)
 * 14. Return frozen success result
 *
 * All paths are non-fatal: summarizeSession NEVER throws to its caller.
 */
export async function summarizeSession(
  input: SummarizeSessionInput,
  deps: SummarizeSessionDeps,
): Promise<SummarizeSessionResult> {
  const { agentName, sessionId } = input;
  const timeoutMs = deps.config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minTurns = deps.config?.minTurns ?? DEFAULT_MIN_TURNS;
  const importance = deps.config?.importance ?? DEFAULT_IMPORTANCE;

  // Step 1 — load session
  const session = deps.conversationStore.getSession(sessionId);
  if (!session) {
    deps.log.warn(
      { agent: agentName, session: sessionId },
      "summarize: session not found",
    );
    return Object.freeze({
      skipped: true as const,
      reason: "session-not-found" as const,
    });
  }

  // Step 2 — idempotency: already summarized (Pitfall 5)
  if (session.status === "summarized") {
    return Object.freeze({
      skipped: true as const,
      reason: "already-summarized" as const,
    });
  }

  // Step 3 — state machine: must be in terminal status
  if (session.status === "active") {
    deps.log.warn(
      { agent: agentName, session: sessionId, status: session.status },
      "summarize: session still active — caller must end/crash first",
    );
    return Object.freeze({
      skipped: true as const,
      reason: "session-not-terminal" as const,
    });
  }

  // Step 4 — load turns (use .length, NOT session.turnCount — Pitfall 2)
  const turns = deps.conversationStore.getTurnsForSession(sessionId);

  // Step 5 — turn-count decision tree (260419-q2z Fix A)
  // Zero-turn sessions are genuinely nothing to summarize — skip with a
  // distinct reason so operators can disambiguate empty vs. short.
  if (turns.length === 0) {
    return Object.freeze({
      skipped: true as const,
      reason: "zero-turns" as const,
    });
  }

  // Short-session branch: 1 or 2 turns. Bypass Haiku (cost + latency) and
  // produce a deterministic summary so the conversation leaves a memory
  // trail regardless of length.
  const shortSession = turns.length < minTurns;

  // Step 6-9 — content source: short-session deterministic OR Haiku-with-fallback
  let summaryContent: string;
  let fallback: SummarizeSuccessFallback;

  if (shortSession) {
    summaryContent = buildShortSessionSummary(turns);
    fallback = "short-session";
  } else {
    // WP1 (memory overhaul 2026-10-25): this summary supersedes the
    // session's mid-session flush rows (they are deleted below), so when a
    // long session's oldest turns do not fit the prompt the checkpoints
    // that cover them are folded in. Lookup failure only loses that extra
    // context.
    let checkpoints: readonly SummaryCheckpoint[] = [];
    try {
      checkpoints = listSessionCheckpoints(deps.memoryStore, sessionId, turns);
    } catch (err) {
      deps.log.warn(
        {
          agent: agentName,
          session: sessionId,
          error: (err as Error).message,
        },
        "summarize: could not load mid-session checkpoints (non-fatal)",
      );
    }
    const prompt = buildSessionSummarizationPrompt(turns, { checkpoints });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const llmContent = await Promise.race([
        deps.summarize(prompt, { signal: controller.signal }),
        new Promise<string>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(new Error("summarize timeout after " + timeoutMs + "ms")),
          );
        }),
      ]);
      if (!llmContent || llmContent.trim().length === 0) {
        // Empty LLM response is treated as failure so the session still
        // gets a (raw-fallback) summary row and becomes idempotent.
        throw new Error("summarize returned empty content");
      }
      summaryContent = llmContent;
      fallback = "llm";
    } catch (err) {
      deps.log.warn(
        {
          agent: agentName,
          session: sessionId,
          error: (err as Error).message,
        },
        "summarize failed — using raw-turn fallback",
      );
      summaryContent = buildRawTurnFallback(turns);
      fallback = "raw-turn";
    } finally {
      clearTimeout(timer);
    }
  }

  // Step 10 — embed the chosen content
  let embedding: Float32Array;
  try {
    embedding = await deps.embedder.embed(summaryContent);
  } catch (err) {
    deps.log.warn(
      {
        agent: agentName,
        session: sessionId,
        error: (err as Error).message,
      },
      "embedding failed — aborting summarization",
    );
    // Embedder failed — skip without writing. Session stays in ended/crashed
    // so a later retry (or manual intervention) can try again.
    return Object.freeze({
      skipped: true as const,
      reason: "session-not-terminal" as const,
      turnCount: turns.length,
    });
  }

  // Step 11-12 — build tags, insert MemoryEntry
  const baseTags: string[] = ["session-summary", `session:${sessionId}`];
  if (fallback === "raw-turn") baseTags.push("raw-fallback");
  if (fallback === "short-session") baseTags.push("short");
  const tags = Object.freeze([...baseTags]);
  const sourceTurnIds = Object.freeze(turns.map((t) => t.id));

  let memoryId: string;
  try {
    const entry = deps.memoryStore.insert(
      {
        content: summaryContent,
        source: "conversation",
        importance,
        tags,
        sourceTurnIds,
        // summaries are unique by definition; dedup would incorrectly
        // merge distinct sessions into one summary row.
        skipDedup: true,
      },
      embedding,
    );
    memoryId = entry.id;
  } catch (err) {
    deps.log.warn(
      {
        agent: agentName,
        session: sessionId,
        error: (err as Error).message,
      },
      "memoryStore.insert failed — summarization aborted",
    );
    return Object.freeze({
      skipped: true as const,
      reason: "session-not-terminal" as const,
      turnCount: turns.length,
    });
  }

  // Step 13 — markSummarized (non-fatal if race/state mismatch)
  let markSummarizedSucceeded = false;
  try {
    deps.conversationStore.markSummarized(sessionId, memoryId);
    markSummarizedSucceeded = true;
  } catch (err) {
    deps.log.warn(
      {
        agent: agentName,
        session: sessionId,
        memoryId,
        error: (err as Error).message,
      },
      "markSummarized failed after insert — memory row present but session FK not set",
    );
    // Non-fatal: the memory exists and is searchable; the session FK
    // just wasn't set. Operators can reconcile later.
  }

  // Step 13b — Gap 2 (memory-persistence-gaps): prune raw conversation turns
  // for this session. Only runs AFTER markSummarized succeeded so a partial
  // failure (insert OK, markSummarized failed) leaves turns intact for
  // operator reconcile. The summary row's content already carries either a
  // Haiku compression (LLM path), a raw-turn dump (raw-turn fallback), or a
  // short-session recap — the raw rows are redundant going forward. Session
  // row itself stays intact so the resume-brief gap check keeps working.
  // Non-fatal: delete failures log and return — the caller already has a
  // successful summary result.
  if (markSummarizedSucceeded) {
    // Phase 999.42 capability A (CONTEXT D1) — archive the raw turns into
    // session_archive BEFORE the prune below removes them. This is the
    // exact moment the turns would otherwise be lost: the
    // `conversation_turns_ad` trigger wipes `conversation_turns_fts` when
    // `deleteTurnsForSession` runs, so a durable copy must be captured
    // here. Non-fatal: a failed archive must NOT make summarizeSession
    // throw (see the line-178 "never throws" invariant). Archive failure
    // also does not block the prune — the prune is independent and runs
    // regardless via the separate try/catch below.
    try {
      const archived = deps.conversationStore.archiveSession(sessionId);
      deps.log.info(
        {
          agent: agentName,
          session: sessionId,
          memoryId,
          archivedTurns: archived.turnCount,
        },
        "archived session before prune",
      );
    } catch (err) {
      deps.log.warn(
        {
          agent: agentName,
          session: sessionId,
          memoryId,
          error: (err as Error).message,
        },
        "session archival failed before prune (non-fatal — turns will still be pruned)",
      );
    }

    try {
      const deleted = deps.conversationStore.deleteTurnsForSession(sessionId);
      if (deleted > 0) {
        deps.log.info(
          {
            agent: agentName,
            session: sessionId,
            memoryId,
            deletedTurns: deleted,
          },
          "pruned raw turns after summarization",
        );
      }
    } catch (err) {
      deps.log.warn(
        {
          agent: agentName,
          session: sessionId,
          memoryId,
          error: (err as Error).message,
        },
        "raw-turn pruning failed after summarization (non-fatal — turns will persist)",
      );
    }
  }

  // WP1 (memory overhaul 2026-10-25): the final summary supersedes every
  // mid-session flush row of this session: delete them so they stop
  // crowding search, dedup and the auto-linker. Runs whenever the summary
  // row exists (even when markSummarized raced with another summarizer:
  // either summary supersedes the checkpoints), through the store's
  // delete path so vectors and links go with them. Non-fatal.
  try {
    const removed = deleteMidSessionRows(deps.memoryStore, sessionId);
    if (removed.deleted > 0 || removed.failed > 0) {
      deps.log.info(
        {
          agent: agentName,
          session: sessionId,
          memoryId,
          deletedFlushRows: removed.deleted,
          failedFlushRows: removed.failed,
        },
        "deleted mid-session flush rows superseded by the session summary",
      );
    }
  } catch (err) {
    deps.log.warn(
      {
        agent: agentName,
        session: sessionId,
        memoryId,
        error: (err as Error).message,
      },
      "mid-session flush cleanup failed after summarization (non-fatal)",
    );
  }

  // 260419-q2z Fix A — emit a distinct info log for short-session summaries
  // so dashboards and log-filters can surface them separately from the
  // "session summarized" line fired by session-manager.ts on the Haiku path.
  if (fallback === "short-session") {
    deps.log.info(
      {
        agent: agentName,
        session: sessionId,
        fallback,
        turnCount: turns.length,
        memoryId,
      },
      "short-session summary built",
    );
  }

  // Step 14 — success
  return Object.freeze({
    success: true as const,
    memoryId,
    fallback,
    turnCount: turns.length,
  });
}

// ---------------------------------------------------------------------------
// Gap 3 (memory-persistence-gaps) — mid-session flush
// ---------------------------------------------------------------------------

/**
 * Importance for mid-session flush entries.
 *
 * WP1 (memory overhaul 2026-10-25): 0.65 to 0.4. Flush rows are
 * checkpoints that the final session summary supersedes and deletes; at
 * 0.65 they outranked most saved facts in every importance-weighted path.
 */
export const DEFAULT_FLUSH_IMPORTANCE = 0.4;

/**
 * WP1: minimum turns recorded since the previous flush before a new row
 * is written. Below this the tick is a cheap skip (no Haiku call, no row).
 */
export const DEFAULT_FLUSH_MIN_NEW_TURNS = 4;

/** Tag carried by every mid-session flush row. */
export const MID_SESSION_TAG = "mid-session";

/** WP1: cursor tag on flush rows: `flush-through:<turnIndex>`. */
export const FLUSH_THROUGH_TAG_PREFIX = "flush-through:";

/** `session:<id>` tag shared by flush rows and the final session summary. */
export function sessionTag(sessionId: string): string {
  return `session:${sessionId}`;
}

/** WP1: every mid-session flush row written for `sessionId`. */
export function listMidSessionRows(
  memoryStore: Pick<MemoryStore, "findByTag">,
  sessionId: string,
): readonly MemoryEntry[] {
  return memoryStore
    .findByTag(sessionTag(sessionId))
    .filter((row) => row.tags.includes(MID_SESSION_TAG));
}

function turnIndexById(
  turns: readonly ConversationTurn[],
): ReadonlyMap<string, number> {
  const indexById = new Map<string, number>();
  for (const turn of turns) indexById.set(turn.id, turn.turnIndex);
  return indexById;
}

/**
 * WP1: the highest turnIndex one flush row covers, or -1 when it says
 * nothing about it. Reads the `flush-through:N` tag and falls back to the
 * row's sourceTurnIds (rows written before the tag existed).
 */
function flushCursorOf(
  row: MemoryEntry,
  indexById: ReadonlyMap<string, number>,
): number {
  let cursor = -1;
  for (const tag of row.tags) {
    if (!tag.startsWith(FLUSH_THROUGH_TAG_PREFIX)) continue;
    const n = Number(tag.slice(FLUSH_THROUGH_TAG_PREFIX.length));
    if (Number.isInteger(n) && n > cursor) cursor = n;
  }
  for (const turnId of row.sourceTurnIds ?? []) {
    const turnIndex = indexById.get(turnId);
    if (turnIndex !== undefined && turnIndex > cursor) cursor = turnIndex;
  }
  return cursor;
}

/**
 * WP1: the highest turnIndex already covered by a mid-session flush row
 * of `sessionId`, or -1 when nothing has been flushed yet. Reads the
 * `flush-through:N` tag and falls back to the row's sourceTurnIds (rows
 * written before the tag existed), so a daemon restart or a legacy row
 * never causes the whole session to be re-summarized.
 */
export function findLastFlushedTurnIndex(
  memoryStore: Pick<MemoryStore, "findByTag">,
  sessionId: string,
  turns: readonly ConversationTurn[],
): number {
  const indexById = turnIndexById(turns);
  let cursor = -1;
  for (const row of listMidSessionRows(memoryStore, sessionId)) {
    const rowCursor = flushCursorOf(row, indexById);
    if (rowCursor > cursor) cursor = rowCursor;
  }
  return cursor;
}

/**
 * WP1: the session's mid-session flush rows as checkpoints for the final
 * summary prompt (rows whose coverage cannot be determined are left out).
 */
export function listSessionCheckpoints(
  memoryStore: Pick<MemoryStore, "findByTag">,
  sessionId: string,
  turns: readonly ConversationTurn[],
): readonly SummaryCheckpoint[] {
  const indexById = turnIndexById(turns);
  const checkpoints: SummaryCheckpoint[] = [];
  for (const row of listMidSessionRows(memoryStore, sessionId)) {
    const throughTurnIndex = flushCursorOf(row, indexById);
    if (throughTurnIndex < 0) continue;
    checkpoints.push(Object.freeze({ throughTurnIndex, content: row.content }));
  }
  return Object.freeze(checkpoints);
}

/**
 * WP1: delete every mid-session flush row of `sessionId` through the
 * store's delete path (vectors, links and the session FK go with it).
 * Per-row failures are counted and skipped; only the lookup can throw.
 */
export function deleteMidSessionRows(
  memoryStore: Pick<MemoryStore, "findByTag" | "delete">,
  sessionId: string,
): { readonly deleted: number; readonly failed: number } {
  let deleted = 0;
  let failed = 0;
  for (const row of listMidSessionRows(memoryStore, sessionId)) {
    try {
      if (memoryStore.delete(row.id)) deleted++;
    } catch {
      failed++;
    }
  }
  return Object.freeze({ deleted, failed });
}

/**
 * Write a non-terminating mid-session summary.
 *
 * This is the periodic-flush counterpart to {@link summarizeSession}. Unlike
 * the session-boundary path, this function:
 *   - Requires the session to be in status="active" (NOT ended/crashed).
 *   - Does NOT call markSummarized — the session stays live.
 *   - Does NOT delete raw turns — they are still needed for future flushes
 *     and for the final session-boundary summary.
 *   - Writes a MemoryEntry tagged ["mid-session", `session:${id}`,
 *     `flush:${N}`, `flush-through:${turnIndex}`] with `skipDedup: true`
 *     so multiple flushes coexist.
 *
 * WP1 (memory overhaul 2026-10-25): the flush is incremental: only the
 * turns recorded since the previous flush (cursor from
 * `input.afterTurnIndex`, else recovered from the session's existing flush
 * rows) are summarized, and a tick with fewer than `flushMinNewTurns`
 * (default 4) new turns is skipped without a Haiku call. Previously every
 * tick re-summarized the whole session, which on the production host
 * produced 95 percent of all memory rows. The final summary deletes the
 * flush rows (see summarizeSession).
 *
 * Pipeline mirrors summarizeSession (same prompt, same timeout, same fallback
 * semantics) so the two code paths produce compatible summaries.
 *
 * All paths are non-fatal: flushSessionMidway NEVER throws to its caller.
 * It is safe to wire to a setInterval without a catch block.
 */
export async function flushSessionMidway(
  input: FlushSessionInput,
  deps: SummarizeSessionDeps,
): Promise<FlushSessionResult> {
  const { agentName, sessionId, flushSequence } = input;
  const timeoutMs = deps.config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minTurns = deps.config?.minTurns ?? DEFAULT_MIN_TURNS;
  const importance = deps.config?.importance ?? DEFAULT_FLUSH_IMPORTANCE;
  const minNewTurns =
    deps.config?.flushMinNewTurns ?? DEFAULT_FLUSH_MIN_NEW_TURNS;

  // Step 1 — load session
  const session = deps.conversationStore.getSession(sessionId);
  if (!session) {
    deps.log.warn(
      { agent: agentName, session: sessionId },
      "flush: session not found",
    );
    return Object.freeze({
      skipped: true as const,
      reason: "session-not-found" as const,
    });
  }

  // Step 2 — state machine: mid-session flush ONLY fires for active sessions.
  // If the session has already been ended/crashed/summarized, the final-path
  // summarizer owns this session and the mid-session flush MUST not interfere.
  if (session.status !== "active") {
    return Object.freeze({
      skipped: true as const,
      reason: "session-not-active" as const,
    });
  }

  // Step 3 — load turns
  const turns = deps.conversationStore.getTurnsForSession(sessionId);
  if (turns.length === 0) {
    return Object.freeze({
      skipped: true as const,
      reason: "zero-turns" as const,
    });
  }

  // Step 3b (WP1): only the turns after the previous flush's cursor.
  const afterTurnIndex =
    input.afterTurnIndex ??
    findLastFlushedTurnIndex(deps.memoryStore, sessionId, turns);
  const newTurns = turns.filter((t) => t.turnIndex > afterTurnIndex);
  if (newTurns.length < minNewTurns) {
    deps.log.debug(
      {
        agent: agentName,
        session: sessionId,
        flushSequence,
        afterTurnIndex,
        newTurnCount: newTurns.length,
        minNewTurns,
      },
      "flush skipped: not enough new turns since the previous flush",
    );
    return Object.freeze({
      skipped: true as const,
      reason: "insufficient-new-turns" as const,
      turnCount: turns.length,
      newTurnCount: newTurns.length,
    });
  }
  const lastTurnIndex = newTurns.reduce(
    (max, t) => (t.turnIndex > max ? t.turnIndex : max),
    afterTurnIndex,
  );

  // Step 4-7: content source (mirrors summarizeSession) over the new turns
  const shortSession = newTurns.length < minTurns;
  let summaryContent: string;
  let fallback: SummarizeSuccessFallback;

  if (shortSession) {
    summaryContent = buildShortSessionSummary(newTurns);
    fallback = "short-session";
  } else {
    const prompt = buildSessionSummarizationPrompt(newTurns, { segment: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const llmContent = await Promise.race([
        deps.summarize(prompt, { signal: controller.signal }),
        new Promise<string>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(new Error("flush timeout after " + timeoutMs + "ms")),
          );
        }),
      ]);
      if (!llmContent || llmContent.trim().length === 0) {
        throw new Error("flush summarize returned empty content");
      }
      summaryContent = llmContent;
      fallback = "llm";
    } catch (err) {
      deps.log.warn(
        {
          agent: agentName,
          session: sessionId,
          flushSequence,
          error: (err as Error).message,
        },
        "flush summarize failed — using raw-turn fallback",
      );
      summaryContent = buildRawTurnFallback(newTurns);
      fallback = "raw-turn";
    } finally {
      clearTimeout(timer);
    }
  }

  // Step 8 — embed
  let embedding: Float32Array;
  try {
    embedding = await deps.embedder.embed(summaryContent);
  } catch (err) {
    deps.log.warn(
      {
        agent: agentName,
        session: sessionId,
        flushSequence,
        error: (err as Error).message,
      },
      "flush embedding failed — aborting flush",
    );
    return Object.freeze({
      skipped: true as const,
      reason: "zero-turns" as const,
      turnCount: turns.length,
    });
  }

  // Step 8b (WP1): the session may have ended while this flush was
  // summarizing (a Haiku call takes up to timeoutMs). The final summary
  // owns an ended session and deletes its flush rows, so a row written
  // now would outlive it as an orphan checkpoint. Re-check right before
  // the insert (no await in between).
  const current = deps.conversationStore.getSession(sessionId);
  if (!current || current.status !== "active") {
    deps.log.debug(
      { agent: agentName, session: sessionId, flushSequence },
      "flush discarded: session ended while it was being summarized",
    );
    return Object.freeze({
      skipped: true as const,
      reason: "session-not-active" as const,
      turnCount: newTurns.length,
    });
  }

  // Step 9 — tags + insert. Note the distinct `mid-session` discriminator
  // so post-mortem queries can filter final summaries vs. intermediate
  // checkpoints, and the `flush-through:N` cursor the next flush resumes
  // from. `skipDedup: true` because repeated flushes intentionally
  // produce distinct memory rows.
  const baseTags: string[] = [
    MID_SESSION_TAG,
    sessionTag(sessionId),
    `flush:${flushSequence}`,
    `${FLUSH_THROUGH_TAG_PREFIX}${lastTurnIndex}`,
  ];
  if (fallback === "raw-turn") baseTags.push("raw-fallback");
  if (fallback === "short-session") baseTags.push("short");
  const tags = Object.freeze([...baseTags]);
  const sourceTurnIds = Object.freeze(newTurns.map((t) => t.id));

  let memoryId: string;
  try {
    const entry = deps.memoryStore.insert(
      {
        content: summaryContent,
        source: "conversation",
        importance,
        tags,
        sourceTurnIds,
        skipDedup: true,
      },
      embedding,
    );
    memoryId = entry.id;
  } catch (err) {
    deps.log.warn(
      {
        agent: agentName,
        session: sessionId,
        flushSequence,
        error: (err as Error).message,
      },
      "flush memoryStore.insert failed",
    );
    return Object.freeze({
      skipped: true as const,
      reason: "zero-turns" as const,
      turnCount: turns.length,
    });
  }

  deps.log.info(
    {
      agent: agentName,
      session: sessionId,
      memoryId,
      flushSequence,
      fallback,
      turnCount: newTurns.length,
      afterTurnIndex,
      lastTurnIndex,
    },
    "mid-session flush written",
  );

  return Object.freeze({
    success: true as const,
    memoryId,
    fallback,
    turnCount: newTurns.length,
    flushSequence,
    lastTurnIndex,
  });
}
