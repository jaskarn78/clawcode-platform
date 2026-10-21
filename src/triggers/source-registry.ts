/**
 * Phase 60 Plan 02 — TriggerSourceRegistry.
 *
 * Type-safe registry for trigger source plugins. Each source registers
 * once by sourceId; duplicates are rejected to prevent silent overwrites.
 *
 * The registry is engine-internal — external code accesses it via
 * `TriggerEngine.registry` (readonly getter).
 */

import type { TriggerSource } from "./types.js";

export class TriggerSourceRegistry {
  private readonly sources = new Map<string, TriggerSource>();

  /**
   * Register a trigger source. Throws if a source with the same sourceId
   * is already registered — duplicate registration is always a bug.
   */
  register(source: TriggerSource): void {
    if (this.sources.has(source.sourceId)) {
      throw new Error(`TriggerSource already registered: ${source.sourceId}`);
    }
    this.sources.set(source.sourceId, source);
  }

  /** Get a source by id. Returns undefined if not registered. */
  get(sourceId: string): TriggerSource | undefined {
    return this.sources.get(sourceId);
  }

  /** Return all registered sources as a frozen array snapshot. */
  all(): readonly TriggerSource[] {
    return [...this.sources.values()];
  }

  /** Number of registered sources. */
  get size(): number {
    return this.sources.size;
  }
}
