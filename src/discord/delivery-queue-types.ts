/**
 * Types and constants for the Discord delivery queue system.
 * Messages are persisted to SQLite before delivery, enabling retry on failure.
 */

/**
 * Status of a delivery queue entry through its lifecycle.
 */
export type DeliveryStatus = "pending" | "in_flight" | "failed" | "delivered";

/**
 * A single entry in the delivery queue.
 * Immutable -- new objects are created for state transitions.
 */
export type DeliveryEntry = {
  readonly id: string;
  readonly agentName: string;
  readonly channelId: string;
  readonly content: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly lastAttemptAt: string | null;
  readonly nextRetryAt: string | null;
  readonly lastError: string | null;
  readonly deliveredAt: string | null;
};

/**
 * Configuration for the delivery queue behavior.
 */
export type DeliveryQueueConfig = {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly processingIntervalMs: number;
  /**
   * An `in_flight` row whose `last_attempt_at` is older than this window is
   * considered stranded (the delivering process crashed/hung between
   * mark-in_flight and the terminal update) and is reclaimed back to
   * `pending` so it can be retried. The reclaim preserves `attempts`, so the
   * `maxAttempts` cap still terminates a permanently-failing message.
   */
  readonly inFlightReclaimMs: number;
  /**
   * `delivered` rows older than this are pruned (the table otherwise grows
   * unbounded — one row per successfully delivered message, forever).
   */
  readonly deliveredRetentionMs: number;
  /**
   * Cadence for the background maintenance sweep (reclaim + prune). Runs
   * independently of `processingIntervalMs` (which is hot-path delivery).
   */
  readonly maintenanceIntervalMs: number;
};

/**
 * Default delivery queue configuration.
 * - maxAttempts: 3 retries before permanent failure
 * - baseDelayMs: 1s initial retry delay
 * - maxDelayMs: 30s maximum retry delay
 * - processingIntervalMs: 500ms polling interval
 * - inFlightReclaimMs: 5min — reclaim stranded in_flight rows
 * - deliveredRetentionMs: 24h — prune old delivered rows
 * - maintenanceIntervalMs: 60s — reclaim + prune sweep cadence
 */
export const DEFAULT_DELIVERY_QUEUE_CONFIG: DeliveryQueueConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  processingIntervalMs: 500,
  inFlightReclaimMs: 5 * 60 * 1000,
  deliveredRetentionMs: 24 * 60 * 60 * 1000,
  maintenanceIntervalMs: 60 * 1000,
} as const;

/**
 * Aggregate statistics for the delivery queue.
 */
export type DeliveryStats = {
  readonly pending: number;
  readonly inFlight: number;
  readonly failed: number;
  readonly delivered: number;
  readonly totalEnqueued: number;
};

/**
 * Function signature for the actual message delivery mechanism.
 * Accepts agent name, channel ID, and content; throws on failure.
 */
export type DeliverFn = (
  agentName: string,
  channelId: string,
  content: string,
) => Promise<void>;
