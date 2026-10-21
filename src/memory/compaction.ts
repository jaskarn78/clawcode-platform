import type { Logger } from "pino";
import type { MemoryStore } from "./store.js";
import type { EmbeddingService } from "./embedder.js";
import type { SessionLogger } from "./session-log.js";
import {
  pruneToolOutputs,
  pruneSavingsPct,
  type ToolOutputTurn,
  type PruneOptions,
} from "./tool-output-prune.js";

/**
 * A single conversation turn for compaction processing.
 */
export type ConversationTurn = {
  readonly timestamp: string;
  readonly role: "user" | "assistant";
  readonly content: string;
};

/**
 * Dependency injection container for CompactionManager.
 */
export type CompactionDeps = {
  readonly memoryStore: MemoryStore;
  readonly embedder: EmbeddingService;
  readonly sessionLogger: SessionLogger;
  readonly log: Logger;
};

/**
 * Abstraction for monitoring context fill percentage.
 * Decoupled from SDK internals since the SDK may not expose this directly.
 */
export type ContextFillProvider = {
  getContextFillPercentage(): number;
};

/**
 * Result of a compaction operation.
 */
export type CompactionResult = {
  readonly logPath: string;
  readonly memoriesCreated: number;
  readonly summary: string;
};

/**
 * CompactionManager handles the flush-before-compact workflow.
 *
 * When context fill exceeds the configured threshold:
 * 1. Flush current conversation to daily session log
 * 2. Record session log entry in store
 * 3. Extract key facts via the provided callback (agent does extraction)
 * 4. Embed and insert each extracted memory
 * 5. Generate a summary for session restart
 */
export class CompactionManager {
  private readonly deps: CompactionDeps;

  constructor(deps: CompactionDeps) {
    this.deps = deps;
  }

  /**
   * Phase 115 Plan 03 sub-scope 9 (Phase 1) — no-LLM tool-output prune.
   *
   * Replaces tool outputs older than the most-recent N turns (default 3)
   * with 1-line `[tool output pruned: <tool> @ <ts>]` markers. Cheap
   * deterministic compression — NO LLM call — useful as a pre-pass
   * before any Phase-2/3 LLM-driven compaction (which Phase 115 defers).
   *
   * Pure pass-through to `pruneToolOutputs`; logs the savings percent so
   * operators can see the compaction firing on the response path. Caller
   * provides the conversation history to compact.
   *
   * Phases 2 (LLM mid-summarization) and 3 (drop oldest) are explicitly
   * DEFERRED per CONTEXT.md "out of scope" line 32.
   *
   * **SUPERSEDED (Phase 999.75 Part A).** The compaction path no longer
   * routes through this primitive — the tiered extractors
   * (`src/manager/compact-extractors/`, Tier 3 truncator + Tier 4 drop)
   * own tool-output compression now, fed by the real SDK transcript via
   * `src/memory/sdk-transcript-reader.ts`. `compactToolOutputs` /
   * `pruneToolOutputs` are NOT wired into compaction; they are retained
   * as a standalone primitive (+ unit test) for any caller that wants a
   * cheap inline marker-replace pass.
   */
  compactToolOutputs(
    turns: readonly ToolOutputTurn[],
    options?: PruneOptions,
  ): ToolOutputTurn[] {
    const before = turns;
    const after = pruneToolOutputs(turns, options);
    const savedPct = pruneSavingsPct(before, after);
    if (savedPct > 0) {
      this.deps.log.info(
        {
          turns: turns.length,
          savedPct: Math.round(savedPct * 10) / 10,
          action: "tool-output-prune-phase1",
        },
        "[diag] tool-output-prune-phase1",
      );
    }
    return after;
  }

  /**
   * Execute the compaction workflow.
   *
   * @param conversation - The current conversation turns to flush
   * @param extractMemories - Callback that extracts key facts from conversation text.
   *   Intentionally a parameter (not hardcoded) -- the agent itself performs extraction.
   * @returns CompactionResult with log path, memory count, and context summary
   */
  async compact(
    conversation: readonly ConversationTurn[],
    extractMemories: (text: string) => Promise<readonly string[]>,
  ): Promise<CompactionResult> {
    const { memoryStore, embedder, sessionLogger, log } = this.deps;

    // Step 1: Flush conversation to daily log (D-04/D-17 step 1)
    const logPath = await sessionLogger.flushConversation(conversation);
    log.info({ logPath, turns: conversation.length }, "flushed conversation to session log");

    // Step 2: Record session log entry in store
    const today = conversation.length > 0
      ? conversation[0].timestamp.slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    memoryStore.recordSessionLog({
      date: today,
      filePath: logPath,
      entryCount: conversation.length,
    });

    // Step 3: Extract key facts via callback (D-18 -- agent extracts)
    const fullText = conversation
      .map((turn) => `[${turn.role}]: ${turn.content}`)
      .join("\n");

    const extractedFacts = await extractMemories(fullText);
    log.info({ factCount: extractedFacts.length }, "extracted memories from conversation");

    // Step 4: Embed and insert each extracted memory
    let memoriesCreated = 0;
    for (const fact of extractedFacts) {
      const embedding = await embedder.embed(fact);
      memoryStore.insert(
        { content: fact, source: "conversation" },
        embedding,
      );
      memoriesCreated++;
    }

    // Step 5: Generate summary (concatenate extracted facts as context)
    const summary = extractedFacts.length > 0
      ? extractedFacts.join("\n- ")
      : "No key facts extracted from conversation.";

    const formattedSummary = extractedFacts.length > 0
      ? `Key context from previous session:\n- ${summary}`
      : summary;

    log.info({ memoriesCreated }, "compaction complete");

    return Object.freeze({
      logPath,
      memoriesCreated,
      summary: formattedSummary,
    });
  }
}

/**
 * CharacterCountFillProvider -- heuristic context fill monitor.
 *
 * Tracks total character count from conversation turns and estimates
 * context fill as a ratio of characters to a configurable maximum.
 * This is a rough proxy since the SDK may not expose actual token counts.
 */
export class CharacterCountFillProvider implements ContextFillProvider {
  private totalCharacters = 0;
  private readonly maxCharacters: number;

  constructor(maxCharacters: number = 200_000) {
    this.maxCharacters = maxCharacters;
  }

  /** Add a conversation turn's content to the character count. */
  addTurn(content: string): void {
    this.totalCharacters += content.length;
  }

  /** Get the current context fill as a ratio (0-1). */
  getContextFillPercentage(): number {
    return Math.min(this.totalCharacters / this.maxCharacters, 1);
  }

  /** Reset the character count (e.g., after compaction). */
  reset(): void {
    this.totalCharacters = 0;
  }
}
