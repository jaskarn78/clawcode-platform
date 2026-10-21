import type { SessionManager } from "./session-manager.js";
import type { EscalationBudget, AgentBudgetConfig } from "../usage/budget.js";
import { BudgetExceededError } from "../usage/budget.js";

/**
 * Configuration for the escalation monitor.
 */
export type EscalationConfig = {
  readonly errorThreshold: number;
  readonly escalationModel: "sonnet" | "opus";
  readonly keywordTriggers: readonly string[];
};

/**
 * Default escalation configuration.
 */
export const DEFAULT_ESCALATION_CONFIG: EscalationConfig = {
  errorThreshold: 3,
  escalationModel: "sonnet",
  keywordTriggers: ["this needs opus"],
} as const;

/**
 * Monitors agent responses for capability failures and transparently
 * escalates to a more capable model via fork when haiku hits its limits.
 *
 * Fork sessions (names containing "-fork-") are never monitored to
 * prevent escalation feedback loops.
 *
 * Concurrent escalation requests for the same agent are serialized
 * via a per-agent lock set.
 */
/**
 * Optional budget enforcement and alert configuration for EscalationMonitor.
 */
export type EscalationBudgetOptions = {
  readonly budget?: EscalationBudget;
  readonly budgetConfigs?: ReadonlyMap<string, AgentBudgetConfig>;
  readonly alertCallback?: (agent: string, model: string, threshold: "warning" | "exceeded") => void;
};

export class EscalationMonitor {
  private readonly sessionManager: SessionManager;
  private readonly config: EscalationConfig;
  private readonly errorCounts: Map<string, number> = new Map();
  private readonly escalating: Set<string> = new Set();
  private readonly budget: EscalationBudget | undefined;
  private readonly budgetConfigs: ReadonlyMap<string, AgentBudgetConfig> | undefined;
  private readonly alertCallback: ((agent: string, model: string, threshold: "warning" | "exceeded") => void) | undefined;

  constructor(
    sessionManager: SessionManager,
    config: EscalationConfig,
    budgetOptions?: EscalationBudgetOptions,
  ) {
    this.sessionManager = sessionManager;
    this.config = config;
    this.budget = budgetOptions?.budget;
    this.budgetConfigs = budgetOptions?.budgetConfigs;
    this.alertCallback = budgetOptions?.alertCallback;
  }

  /**
   * Check whether an agent response warrants escalation to a more capable model.
   *
   * Returns false for fork sessions (prevents feedback loops).
   * Returns false if escalation is already in progress for this agent.
   * Returns true if consecutive error count reaches threshold.
   * Returns true if response contains a keyword trigger (case-insensitive).
   * Resets error count on successful non-trigger responses.
   */
  shouldEscalate(agentName: string, response: string, isError: boolean): boolean {
    // Skip fork sessions to prevent feedback loops
    if (agentName.includes("-fork-")) {
      return false;
    }

    // Skip if already escalating this agent
    if (this.escalating.has(agentName)) {
      return false;
    }

    if (isError) {
      const count = (this.errorCounts.get(agentName) ?? 0) + 1;
      this.errorCounts.set(agentName, count);
      return count >= this.config.errorThreshold;
    }

    // Check keyword triggers on non-error responses
    const lowerResponse = response.toLowerCase();
    for (const trigger of this.config.keywordTriggers) {
      if (lowerResponse.includes(trigger.toLowerCase())) {
        return true;
      }
    }

    // Non-error, no keyword -- reset error count
    this.errorCounts.set(agentName, 0);
    return false;
  }

  /**
   * Escalate a request by forking a session with a more capable model.
   *
   * The fork is ephemeral: created, used for one response, then stopped —
   * the stop runs in a `finally`, so a failed turn cannot leak the session.
   * The per-agent lock is always released in the finally block, even on error.
   * Error count is reset after successful escalation.
   */
  async escalate(agentName: string, message: string): Promise<string> {
    // Budget guard: check before allowing escalation
    if (this.budget && this.budgetConfigs) {
      const budgetConfig = this.budgetConfigs.get(agentName);
      if (budgetConfig && !this.budget.canEscalate(agentName, this.config.escalationModel, budgetConfig)) {
        const threshold = this.budget.checkAlerts(agentName, this.config.escalationModel, budgetConfig);
        if (threshold && this.budget.shouldAlert(agentName, this.config.escalationModel, threshold)) {
          this.alertCallback?.(agentName, this.config.escalationModel, threshold);
        }
        throw new BudgetExceededError(agentName, this.config.escalationModel);
      }
    }

    this.escalating.add(agentName);
    try {
      const fork = await this.sessionManager.forkSession(agentName, {
        modelOverride: this.config.escalationModel,
      });
      let response: string;
      try {
        response = await this.sessionManager.dispatchTurn(fork.forkName, message);
      } finally {
        // A dispatchTurn throw used to skip this stop entirely, leaking the
        // forked session until the ~120min fork reaper (default off) ran.
        // Swallow stop failures so they can never mask the turn's error —
        // same idiom as `forkAdvisorConsult` in daemon.ts.
        await this.sessionManager.stopAgent(fork.forkName).catch(() => {});
      }
      this.errorCounts.set(agentName, 0);

      // Record usage after successful escalation
      if (this.budget) {
        // Rough token estimate: ~4 chars per token for input + output
        const estimatedTokens = Math.ceil((message.length + response.length) / 4);
        this.budget.recordUsage(agentName, this.config.escalationModel, estimatedTokens);

        // Check alert thresholds after recording
        if (this.budgetConfigs) {
          const budgetConfig = this.budgetConfigs.get(agentName);
          if (budgetConfig) {
            const threshold = this.budget.checkAlerts(agentName, this.config.escalationModel, budgetConfig);
            if (threshold && this.budget.shouldAlert(agentName, this.config.escalationModel, threshold)) {
              this.alertCallback?.(agentName, this.config.escalationModel, threshold);
            }
          }
        }
      }

      return response;
    } finally {
      this.escalating.delete(agentName);
    }
  }

  /**
   * Manually reset the error counter for a specific agent.
   */
  resetErrorCount(agentName: string): void {
    this.errorCounts.set(agentName, 0);
  }
}
