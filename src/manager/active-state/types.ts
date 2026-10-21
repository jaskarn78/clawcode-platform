import type { ConversationTurn } from "../../memory/conversation-types.js";
import type { Tier2Facts } from "../compact-extractors/types.js";

export type ActiveStateBlock = {
  readonly primaryClient: string | null;
  readonly inFlightTasks: readonly string[];
  readonly standingRulesAddedToday: readonly string[];
  readonly driveFoldersTouched: readonly string[];
  readonly lastOperatorMessages: readonly string[];
  readonly lastAgentCommitments: readonly string[];
  readonly generatedAt: string;
};

export type BuildActiveStateInput = {
  readonly recentOperatorMessages: readonly string[];
  readonly recentAgentTurns: readonly ConversationTurn[];
  readonly agentName: string;
  readonly clock: () => Date;
  /**
   * Phase 125 Plan 03 — optional Haiku-grounded facts. When present, they
   * WIN over heuristic extraction for primaryClient, inFlightTasks, and
   * standingRulesAddedToday (LLM-grounded > regex). When absent, heuristic-
   * only behavior preserved (Plan 01 back-compat).
   */
  readonly tier2Facts?: Tier2Facts;
};
