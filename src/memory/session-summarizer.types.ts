/**
 * Session-boundary summarizer types.
 *
 * Pure type module — no runtime imports beyond peer types.
 *
 * SESS-01 + SESS-04: compresses a completed conversation session into a
 * standard MemoryEntry tagged as a session summary. Types are injected so
 * the pipeline is testable in isolation (no SDK, no daemon coupling).
 */

import type { ConversationStore } from "./conversation-store.js";
import type { MemoryStore } from "./store.js";
import type { EmbeddingService } from "./embedder.js";
import type { Logger } from "pino";

/**
 * Pluggable LLM call. Production wires this to sdk.query() with Haiku.
 * Tests wire a mock (vi.fn()) that returns canned markdown.
 *
 * The AbortSignal is passed so well-behaved implementations can cancel
 * the underlying HTTP request when the summarizer-level timeout fires.
 */
export type SummarizeFn = (
  prompt: string,
  opts: { readonly signal?: AbortSignal },
) => Promise<string>;

/** Tunable behavior for the summarizer pipeline. */
export type SummarizerConfig = {
  /** Hard timeout for the summarize() call in milliseconds. Default 10_000. */
  readonly timeoutMs?: number;
  /** Minimum turn count required to produce a summary. Default 3. */
  readonly minTurns?: number;
  /** Importance assigned to the resulting MemoryEntry. Default 0.78. */
  readonly importance?: number;
};

/** All dependencies required by the summarizer. Injected for testability. */
export type SummarizeSessionDeps = {
  readonly conversationStore: ConversationStore;
  readonly memoryStore: MemoryStore;
  readonly embedder: EmbeddingService;
  readonly summarize: SummarizeFn;
  readonly log: Logger;
  readonly config?: SummarizerConfig;
};

/** Input to summarizeSession. */
export type SummarizeSessionInput = {
  readonly agentName: string;
  readonly sessionId: string;
};

/**
 * Fallback discriminator for a successful summarization.
 *
 * - "llm"           — Haiku summarized the turns (happy path).
 * - "raw-turn"      — LLM timed out or errored; raw-turn dump was used instead.
 * - "short-session" — session had fewer than minTurns turns (1 or 2); a
 *                     deterministic short-summary was built without calling
 *                     the LLM. Quick task 260419-q2z Fix A.
 */
export type SummarizeSuccessFallback = "llm" | "raw-turn" | "short-session";

/**
 * Discriminated union of possible outcomes.
 *
 * `success: true` — a MemoryEntry was written and the session was transitioned
 * to status="summarized" (or attempted to — markSummarized failure is
 * logged but non-fatal).
 *
 * `skipped: true` — no MemoryEntry was written; the reason discriminates why.
 */
export type SummarizeSessionResult =
  | {
      readonly success: true;
      readonly memoryId: string;
      /**
       * Which content-generation path produced this summary.
       *
       * Quick task 260419-q2z Fix A — promoted from boolean to discriminated
       * string so short-session summaries are distinguishable from raw-turn
       * fallbacks downstream (dashboards, log filters).
       */
      readonly fallback: SummarizeSuccessFallback;
      readonly turnCount: number;
    }
  | {
      readonly skipped: true;
      readonly reason:
        | "already-summarized"
        | "insufficient-turns" // retained for back-compat; post-260419-q2z, short-session fallback supplants this
        | "session-not-found"
        | "session-not-terminal"
        | "zero-turns"; // 260419-q2z Fix A — distinct from insufficient-turns
      readonly turnCount?: number;
    };

// ---------------------------------------------------------------------------
// Gap 3 (memory-persistence-gaps) — mid-session flush types
// ---------------------------------------------------------------------------

/** Input to flushSessionMidway. */
export type FlushSessionInput = {
  readonly agentName: string;
  readonly sessionId: string;
  /**
   * 1-based sequence number for this flush (first flush = 1, second = 2, ...).
   * Encoded into the memory row's tags as `flush:N` so operators can
   * trace the evolution of a long-running session post-mortem.
   */
  readonly flushSequence: number;
};

/**
 * Outcome of a mid-session flush.
 *
 * `success: true` — a MemoryEntry tagged "mid-session" was written. The
 * underlying conversation session remains status="active" and its raw
 * turns remain intact — this is a checkpoint, not a termination.
 *
 * `skipped: true` — the session was not in a flushable state (wrong status,
 * not found, zero turns).
 */
export type FlushSessionResult =
  | {
      readonly success: true;
      readonly memoryId: string;
      readonly fallback: SummarizeSuccessFallback;
      readonly turnCount: number;
      readonly flushSequence: number;
    }
  | {
      readonly skipped: true;
      readonly reason:
        | "session-not-found"
        | "session-not-active"
        | "zero-turns";
      readonly turnCount?: number;
    };
