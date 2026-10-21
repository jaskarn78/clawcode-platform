/**
 * Phase 67 — Type contracts for `assembleConversationBrief`.
 *
 * Pure dependency-injected helper types: callers pass deps (stores + config +
 * optional logger) and input (agentName + deterministic `now`), and receive a
 * frozen discriminated-union result indicating either a rendered brief or an
 * explicit skip reason.
 *
 * Keeping the types in a separate module preserves the zero-import boundary
 * between the brief shape (re-used by the Plan 02 assembler wiring) and the
 * implementation (which imports stores + tokenizer).
 */

import type { ConversationStore } from "./conversation-store.js";
import type { MemoryStore } from "./store.js";
import type { LoggerLike } from "./context-summary.js";

/**
 * Immutable input for `assembleConversationBrief`.
 *
 * `now` is injected in epoch milliseconds so gap-threshold math is
 * deterministic in tests — no `Date.now()` monkey-patching or
 * `vi.setSystemTime()` required. Production callers pass `Date.now()`.
 */
export type AssembleBriefInput = {
  readonly agentName: string;
  /** Epoch milliseconds — injected for deterministic gap tests. */
  readonly now: number;
  /**
   * Phase 999.13 TZ-04 (Q1=YES) — operator-local IANA TZ used for the
   * `### Session from <YYYY-MM-DD>` heading date slice. When omitted, the
   * helper falls back to host TZ. A summary persisted at 2026-05-01T02:00Z
   * with `agentTz="America/Los_Angeles"` renders as "Session from 2026-04-30"
   * (operator-perceived date) rather than "2026-05-01" (UTC date). Internal
   * storage (`MemoryEntry.createdAt`) stays UTC ISO; only the rendered
   * heading uses operator-local time.
   */
  readonly agentTz?: string;
};

/**
 * Resolved configuration knobs for the brief helper.
 *
 * All three fields map 1:1 to the `conversationConfigSchema` additions in
 * `src/memory/schema.ts` (`resumeSessionCount`, `resumeGapThresholdHours`,
 * `conversationContextBudget`). Defaults live in `conversation-brief.ts`.
 */
export type AssembleBriefConfig = {
  /** How many recent session summaries to render (default 3). */
  readonly sessionCount: number;
  /** Skip injection when elapsed gap is less than this many hours (default 4). */
  readonly gapThresholdHours: number;
  /** Hard token budget on the rendered brief (default 2000, min 500). */
  readonly budgetTokens: number;
};

/**
 * Dependency bundle. Stores are injected so the helper can be tested with
 * in-memory SQLite fixtures without touching the production filesystem.
 */
export type AssembleBriefDeps = {
  readonly conversationStore: ConversationStore;
  readonly memoryStore: MemoryStore;
  readonly config: AssembleBriefConfig;
  readonly log?: LoggerLike;
};

/**
 * Discriminated-union result. Callers must branch on `skipped` before
 * reading `brief` or `reason` — TypeScript enforces this via the union.
 *
 * Skip reasons:
 *   - `"gap"`: the most recent session ended less than `gapThresholdHours`
 *     ago, so re-injecting context would be redundant (SESS-03).
 *
 * Non-skipped result fields:
 *   - `brief`: rendered markdown (or `""` for zero history).
 *   - `sessionCount`: how many summaries actually made it into `brief`
 *     (may be less than `config.sessionCount` if budget was hit).
 *   - `tokens`: BPE token count of `brief` via `countTokens()`.
 *   - `truncated`: always `false` under the accumulate strategy — we
 *     drop summaries whole rather than slicing mid-content. Reserved
 *     for future hard-truncate fallback if needed.
 */
export type AssembleBriefResult =
  | {
      readonly skipped: false;
      readonly brief: string;
      readonly sessionCount: number;
      readonly tokens: number;
      readonly truncated: boolean;
    }
  | {
      readonly skipped: true;
      readonly reason: "gap";
    };
