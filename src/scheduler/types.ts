import type { SessionManager } from "../manager/session-manager.js";
import type { TurnDispatcher } from "../manager/turn-dispatcher.js";
import type { Logger } from "pino";

/**
 * A single scheduled task entry for an agent.
 * Parsed from clawcode.yaml schedule config.
 */
export type ScheduleEntry = {
  readonly name: string;
  readonly cron: string;
  readonly prompt?: string;
  readonly handler?: () => Promise<void>;
  readonly enabled: boolean;
};

/**
 * Runtime status of a scheduled task.
 * Tracks execution history and next run timing.
 */
export type ScheduleStatus = {
  readonly name: string;
  readonly agentName: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly lastRun: number | null;
  readonly lastStatus: "success" | "error" | "pending";
  readonly lastError: string | null;
  readonly nextRun: number | null;
};

/**
 * Options for creating a TaskScheduler instance.
 */
export type TaskSchedulerOptions = {
  readonly sessionManager: SessionManager;
  /**
   * Phase 57 Plan 03: required TurnDispatcher for routing cron-fired turns.
   * Only the daemon creates TaskScheduler instances, so this is REQUIRED
   * (not optional like BridgeConfig.turnDispatcher). The dispatcher opens
   * the Turn, attaches a `scheduler:<nanoid>`-prefixed TurnOrigin, and
   * ends the Turn on success/error.
   */
  readonly turnDispatcher: TurnDispatcher;
  readonly log: Logger;
};
