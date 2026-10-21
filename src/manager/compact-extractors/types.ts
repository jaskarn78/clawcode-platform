import type { Logger } from "pino";
import type { ConversationTurn } from "../../memory/compaction.js";

export type ExtractMemoriesFn = (text: string) => Promise<readonly string[]>;

/**
 * Phase 125 Plan 03 — Tier 2 structured-extraction output.
 *
 * Mirrors the schema enforced by `tier2-prompt.ts` and validated by
 * `tier2-parser.ts`. Always frozen; absent categories are empty arrays.
 */
export type Tier2Decision = {
  readonly decision: string;
  readonly context: string;
};

export type Tier2StandingRule = {
  readonly rule: string;
  readonly changedAt: string;
};

export type Tier2InFlightTask = {
  readonly task: string;
  readonly state: string;
};

export type Tier2CriticalNumber = {
  readonly context: string;
  readonly value: string;
};

export type Tier2Facts = {
  readonly activeClients: readonly string[];
  readonly decisions: readonly Tier2Decision[];
  readonly standingRulesChanged: readonly Tier2StandingRule[];
  readonly inFlightTasks: readonly Tier2InFlightTask[];
  readonly drivePathsTouched: readonly string[];
  readonly criticalNumbers: readonly Tier2CriticalNumber[];
};

/**
 * DI'd Haiku invocation callback — matches `FlushSummarizeFn` from
 * `src/memory/memory-flush.ts` and `summarizeWithHaiku` in production.
 * Returning empty string is the well-known "skip" signal.
 */
export type Tier2SummarizeFn = (
  prompt: string,
  opts: { readonly signal?: AbortSignal },
) => Promise<string>;

/**
 * Phase 125 Plan 04 — Tier 3 prose summarizer DI shape. Same call contract
 * as `Tier2SummarizeFn`; kept as a distinct alias so the seam can route the
 * two Haiku calls independently if cost or model selection diverges later.
 */
export type Tier3SummarizeFn = (
  prompt: string,
  opts: { readonly signal?: AbortSignal },
) => Promise<string>;

export type ExtractorDeps = Readonly<{
  preserveLastTurns: number;
  preserveVerbatimPatterns: readonly RegExp[];
  clock: () => Date;
  log: Logger;
  agentName: string;
}>;

export type PartitionResult = Readonly<{
  preserved: readonly ConversationTurn[];
  toCompact: readonly ConversationTurn[];
}>;

export type VerbatimGate = (
  turns: readonly ConversationTurn[],
  deps: ExtractorDeps,
) => PartitionResult;

export type DropFilter = (
  turns: readonly ConversationTurn[],
  deps: ExtractorDeps,
) => readonly ConversationTurn[];

export type BuildExtractorDeps = Readonly<{
  preserveLastTurns: number;
  preserveVerbatimPatterns: readonly RegExp[];
  preservedTurns: readonly ConversationTurn[];
  clock: () => Date;
  log: Logger;
  agentName: string;
  maxChunks?: number;
  /**
   * Phase 125 Plan 03 — optional Haiku-driven structured extractor.
   * When undefined, seam falls through to Plan 02 (Tier 1 + Tier 4) only.
   * When present, structured facts are flattened into the output chunks
   * AHEAD of the Tier 4 turns so high-value facts survive `maxChunks`
   * truncation.
   */
  tier2Summarize?: Tier2SummarizeFn;
  /**
   * Phase 125 Plan 03 — optional side-effect callback fired after Tier 2
   * produces facts. Daemon owns the merge: read existing active-state.yaml,
   * merge tier2 facts, write back. Seam stays FS-free.
   */
  onTier2Facts?: (facts: Tier2Facts) => Promise<void>;
  /** Override per-Tier 2 timeout for tests. Production: 30s default. */
  tier2TimeoutMs?: number;
  /**
   * Phase 125 Plan 04 — optional Haiku-driven prose summarizer for the
   * residual compactable region (post-Tier-2, post-Tier-4-drop). When
   * undefined, the seam skips Tier 3 (back-compat with Plan 02/03 tests).
   * When present, a single prose chunk lands AHEAD of the Tier 4 chunks
   * so it survives the `maxChunks` cap.
   */
  tier3Summarize?: Tier3SummarizeFn;
  /** Override per-Tier 3 timeout for tests. Production: 30s default. */
  tier3TimeoutMs?: number;
}>;
