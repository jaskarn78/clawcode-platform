/**
 * Context health zone classification and transition tracking.
 *
 * Maps context fill percentage to one of four zones:
 * - green: 0-50% (healthy)
 * - yellow: 50-70% (elevated)
 * - orange: 70-85% (high pressure)
 * - red: 85%+ (critical)
 *
 * Zone transitions trigger auto-snapshots on upward entry to yellow+.
 */

/**
 * The four context health zones.
 */
export type ContextZone = "green" | "yellow" | "orange" | "red";

/**
 * Configurable thresholds for zone boundaries.
 * Each value is a fill percentage (0-1) where the zone begins.
 */
export type ZoneThresholds = {
  readonly yellow: number;
  readonly orange: number;
  readonly red: number;
};

/**
 * Record of a zone transition event.
 */
export type ZoneTransition = {
  readonly from: ContextZone;
  readonly to: ContextZone;
  readonly fillPercentage: number;
  readonly timestamp: string;
};

/**
 * Callback invoked when entering an elevated zone (yellow+) on upward transition.
 */
export type SnapshotCallback = (
  agentName: string,
  zone: ContextZone,
  fillPercentage: number,
) => Promise<void>;

/**
 * Numeric severity for zone comparison.
 * Higher value = more severe.
 */
export const ZONE_SEVERITY: Readonly<Record<ContextZone, number>> = {
  green: 0,
  yellow: 1,
  orange: 2,
  red: 3,
};

/**
 * Default zone thresholds matching CTXH-01 spec.
 * green: 0-50%, yellow: 50-70%, orange: 70-85%, red: 85%+
 */
export const DEFAULT_ZONE_THRESHOLDS: ZoneThresholds = {
  yellow: 0.50,
  orange: 0.70,
  red: 0.85,
};

/**
 * Classify a fill percentage into a context zone.
 * Checks from highest threshold to lowest.
 *
 * @param fillPercentage - Context fill as a ratio (0-1)
 * @param thresholds - Zone boundary thresholds
 * @returns The classified zone
 */
export function classifyZone(
  fillPercentage: number,
  thresholds: ZoneThresholds,
): ContextZone {
  if (fillPercentage >= thresholds.red) return "red";
  if (fillPercentage >= thresholds.orange) return "orange";
  if (fillPercentage >= thresholds.yellow) return "yellow";
  return "green";
}

/**
 * Configuration for creating a ContextZoneTracker.
 */
type ContextZoneTrackerConfig = {
  readonly agentName: string;
  readonly thresholds: ZoneThresholds;
  readonly onSnapshot?: SnapshotCallback;
};

/**
 * Tracks context zone transitions for an agent and triggers
 * snapshot callbacks on upward transitions to elevated zones.
 */
export class ContextZoneTracker {
  private readonly agentName: string;
  private readonly thresholds: ZoneThresholds;
  private readonly onSnapshot?: SnapshotCallback;
  private currentZone: ContextZone = "green";

  constructor(config: ContextZoneTrackerConfig) {
    this.agentName = config.agentName;
    this.thresholds = config.thresholds;
    this.onSnapshot = config.onSnapshot;
  }

  /**
   * Get the current zone.
   */
  get zone(): ContextZone {
    return this.currentZone;
  }

  /**
   * Update the tracker with a new fill percentage.
   * Returns a ZoneTransition if the zone changed, null otherwise.
   * Triggers snapshot callback on upward transitions to yellow+.
   *
   * @param fillPercentage - Current context fill as a ratio (0-1)
   * @returns Transition record if zone changed, null otherwise
   */
  async update(fillPercentage: number): Promise<ZoneTransition | null> {
    const newZone = classifyZone(fillPercentage, this.thresholds);

    if (newZone === this.currentZone) {
      return null;
    }

    const transition: ZoneTransition = {
      from: this.currentZone,
      to: newZone,
      fillPercentage,
      timestamp: new Date().toISOString(),
    };

    const oldSeverity = ZONE_SEVERITY[this.currentZone];
    const newSeverity = ZONE_SEVERITY[newZone];

    this.currentZone = newZone;

    // Trigger snapshot on upward transition to yellow or higher
    if (newSeverity >= ZONE_SEVERITY.yellow && newSeverity > oldSeverity && this.onSnapshot) {
      await this.onSnapshot(this.agentName, newZone, fillPercentage);
    }

    return transition;
  }

  /**
   * Reset the tracker to green zone.
   */
  reset(): void {
    this.currentZone = "green";
  }
}
