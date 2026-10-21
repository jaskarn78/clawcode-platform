/**
 * Phase 60 Plan 02 — TriggerEngine.
 *
 * The single chokepoint for all non-Discord turn initiation via triggers.
 * Sources register through the TriggerSourceRegistry, events flow through
 * the 3-layer dedup pipeline (LRU -> debounce -> SQLite UNIQUE), then
 * policy evaluation, and finally dispatch via TurnDispatcher with a
 * nanoid causation_id born at ingress (TRIG-08).
 *
 * replayMissed() reads watermarks from TaskStore and polls each source
 * for events missed during daemon downtime (TRIG-06).
 *
 * Plan 60-03 wires this into the daemon boot sequence.
 */

import { nanoid } from "nanoid";
import type { Logger } from "pino";

import type {
  TriggerEvent,
  TriggerSource,
  TriggerEngineOptions,
  TriggerDeliveryFn,
} from "./types.js";
import { DedupLayer } from "./dedup.js";
import { PolicyEvaluator, evaluatePolicy } from "./policy-evaluator.js";
import { TriggerSourceRegistry } from "./source-registry.js";
import { makeRootOriginWithCausation } from "../manager/turn-origin.js";
import type { TurnDispatcher } from "../manager/turn-dispatcher.js";
import type { TaskStore } from "../tasks/store.js";
import {
  SCHEDULED_SILENCE_CONTRACT,
  isScheduledSourceId,
  isSilentTickResponse,
} from "./silence-sentinel.js";

export class TriggerEngine {
  private readonly turnDispatcher: TurnDispatcher;
  private readonly taskStore: TaskStore;
  private readonly log: Logger;
  private readonly config: TriggerEngineOptions["config"];
  private readonly dedup: DedupLayer;
  private readonly _registry: TriggerSourceRegistry;
  private configuredAgents: ReadonlySet<string>;
  private evaluator: PolicyEvaluator | undefined;
  /**
   * Phase 100 follow-up — optional delivery callback invoked after every
   * successful dispatch. When unset, dispatched responses are discarded
   * (pre-fix behavior, kept for back-compat).
   */
  private readonly deliveryFn?: TriggerDeliveryFn;

  constructor(
    options: TriggerEngineOptions,
    configuredAgents: ReadonlySet<string> = new Set(),
    evaluator?: PolicyEvaluator,
  ) {
    this.turnDispatcher = options.turnDispatcher;
    this.taskStore = options.taskStore;
    this.log = options.log.child({ component: "TriggerEngine" });
    this.config = options.config;
    this.configuredAgents = configuredAgents;
    this.evaluator = evaluator;
    this.deliveryFn = options.deliveryFn;
    this._registry = new TriggerSourceRegistry();
    this.dedup = new DedupLayer({
      db: options.taskStore.rawDb,
      lruSize: options.config.dedupLruSize,
      defaultDebounceMs: options.config.defaultDebounceMs,
    });
  }

  // -----------------------------------------------------------------------
  // Source registration
  // -----------------------------------------------------------------------

  /** Register a trigger source. Delegates to the internal registry. */
  registerSource(source: TriggerSource): void {
    this._registry.register(source);
  }

  /** Expose the registry for daemon-level inspection. */
  get registry(): TriggerSourceRegistry {
    return this._registry;
  }

  // -----------------------------------------------------------------------
  // ingest — the 3-layer dedup + policy + dispatch pipeline
  // -----------------------------------------------------------------------

  /**
   * Ingest a trigger event through the full pipeline:
   *   1. LRU duplicate check (Layer 1)
   *   2. Per-source debounce (Layer 2)
   *   3. SQLite UNIQUE safety net (Layer 3)
   *   4. Policy evaluation
   *   5. causation_id generation (nanoid)
   *   6. TurnDispatcher dispatch
   *   7. Watermark update
   */
  async ingest(event: TriggerEvent): Promise<void> {
    // Layer 1 — LRU fast-path rejection
    if (this.dedup.isLruDuplicate(event.sourceId, event.idempotencyKey)) {
      this.log.debug(
        { sourceId: event.sourceId, idempotencyKey: event.idempotencyKey },
        "trigger-engine: LRU duplicate — skipping",
      );
      return;
    }

    // Layer 2 — per-source debounce
    const debounced = await this.dedup.debounce(event);
    if (debounced === null) {
      return; // collapsed into a pending timer
    }

    // Layer 3 — SQLite UNIQUE safety net (extended with sourceKind + payload for dry-run)
    const inserted = this.dedup.insertTriggerEvent(
      debounced.sourceId,
      debounced.idempotencyKey,
      debounced.sourceKind,
      typeof debounced.payload === "string"
        ? debounced.payload
        : JSON.stringify(debounced.payload),
    );
    if (!inserted) {
      this.log.debug(
        { sourceId: debounced.sourceId, idempotencyKey: debounced.idempotencyKey },
        "trigger-engine: SQLite UNIQUE duplicate — skipping",
      );
      return;
    }

    // Policy check — use PolicyEvaluator class if available, fallback to legacy wrapper
    const decision = this.evaluator
      ? this.evaluator.evaluate(debounced)
      : evaluatePolicy(debounced, this.configuredAgents);
    if (!decision.allow) {
      this.log.info(
        { sourceId: debounced.sourceId, targetAgent: debounced.targetAgent, reason: decision.reason },
        "trigger-engine: policy rejected event",
      );
      return;
    }

    // Generate causation_id at ingress (TRIG-08)
    const causationId = nanoid();

    // Build origin with causationId
    const origin = makeRootOriginWithCausation(
      "trigger",
      debounced.sourceId,
      causationId,
    );

    // Dispatch via TurnDispatcher — use policy-rendered payload when evaluator is active.
    // Scheduler-family sources get the silence contract appended so a
    // nothing-to-report tick has an achievable way to stay out of the channel
    // (INC-2026-08-14c — see silence-sentinel.ts).
    const payloadStr = isScheduledSourceId(debounced.sourceId)
      ? decision.payload + SCHEDULED_SILENCE_CONTRACT
      : decision.payload;

    // Phase 100 follow-up — capture the response (was previously discarded).
    // The dispatch return value is the agent's reply text. Without surfacing
    // it via deliveryFn, scheduled cron output was generated by the agent but
    // never reached Discord — see docstring on TriggerDeliveryFn.
    const response = await this.turnDispatcher.dispatch(
      origin,
      decision.targetAgent,
      payloadStr,
    );

    // Update watermark BEFORE the delivery attempt. The dispatch itself
    // succeeded; if delivery fails (Discord 503, missing channel, etc.)
    // we still must NOT reprocess this tick on the next replay (that would
    // double-dispatch the same prompt to the agent). Delivery is best-effort.
    this.taskStore.upsertTriggerState(
      debounced.sourceId,
      String(debounced.timestamp),
      null,
    );

    // Phase 100 follow-up — route the response to its delivery surface
    // (Discord channel via webhook or bot-direct). Skip when:
    //   - no deliveryFn wired (back-compat: pre-fix daemons + tests)
    //   - response is empty / whitespace only (nothing to post)
    //   - response is the NO_REPORT sentinel or a short narrated-silence
    //     reply (INC-2026-08-14c — the "Ending silently per instructions"
    //     class must not land in the channel)
    // Failures are logged + swallowed so a delivery hiccup doesn't propagate
    // back into the trigger pipeline.
    if (
      this.deliveryFn &&
      response &&
      response.trim().length > 0 &&
      isSilentTickResponse(response)
    ) {
      this.log.info(
        { sourceId: debounced.sourceId, targetAgent: decision.targetAgent, chars: response.trim().length },
        "trigger-engine: silent tick suppressed (nothing to report)",
      );
    } else if (this.deliveryFn && response && response.trim().length > 0) {
      try {
        // 999.178 R1 — pass the sourceId as the delivery label so a failed
        // scheduled post dead-letters with the schedule name (see
        // scheduled-delivery.ts). Additive 3rd arg; back-compat with 2-arg fns.
        await this.deliveryFn(decision.targetAgent, response, {
          label: debounced.sourceId,
        });
      } catch (err) {
        this.log.warn(
          {
            sourceId: debounced.sourceId,
            targetAgent: decision.targetAgent,
            error: err instanceof Error ? err.message : String(err),
          },
          "trigger-engine: delivery failed (response generated but not delivered)",
        );
      }
    }

    this.log.info(
      { sourceId: debounced.sourceId, targetAgent: debounced.targetAgent, causationId },
      "trigger-engine: event dispatched",
    );
  }

  // -----------------------------------------------------------------------
  // replayMissed — watermark-based replay on daemon restart (TRIG-06)
  // -----------------------------------------------------------------------

  /**
   * Replay missed events from all pollable sources. Reads watermarks
   * from TaskStore, calls each source's poll(since), and ingests the
   * returned events through the standard pipeline (dedup protects
   * against re-processing).
   */
  async replayMissed(): Promise<void> {
    const maxAge = Date.now() - this.config.replayMaxAgeMs;
    let replayed = 0;

    for (const source of this._registry.all()) {
      if (!source.poll) {
        continue; // source doesn't support polling
      }

      const state = this.taskStore.getTriggerState(source.sourceId);
      const watermark = state?.last_watermark ?? null;

      // Skip if watermark is older than maxAge
      if (watermark !== null && parseInt(watermark, 10) < maxAge) {
        this.log.warn(
          { sourceId: source.sourceId, watermark, maxAge },
          "trigger-engine: watermark too old — skipping replay",
        );
        continue;
      }

      const missed = await source.poll(watermark);
      for (const event of missed) {
        try {
          await this.ingest(event);
        } catch (err) {
          // CRITICAL: replayMissed runs BEFORE agent startAll (see daemon.ts),
          // so a missed trigger for an agent that hasn't auto-started yet throws
          // `Agent '<name>' is not running`. One failed event must NEVER abort
          // the replay loop or crash the daemon — log + skip. The agent will
          // resume normal trigger delivery once it has started.
          this.log.warn(
            {
              sourceId: source.sourceId,
              err: err instanceof Error ? err.message : String(err),
            },
            "trigger-engine: replay ingest failed — skipping event (non-fatal)",
          );
        }
      }
      replayed++;
    }

    this.log.info(
      { sourcesReplayed: replayed },
      "trigger-engine: replayMissed complete",
    );
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start all registered sources. */
  startAll(): void {
    for (const source of this._registry.all()) {
      source.start();
    }
  }

  /** Stop all registered sources and clear dedup timers. */
  stopAll(): void {
    for (const source of this._registry.all()) {
      source.stop();
    }
    this.dedup.stopAllTimers();
  }

  // -----------------------------------------------------------------------
  // Hot-reload support
  // -----------------------------------------------------------------------

  /** Update the set of configured agents (for config hot-reload). */
  updateConfiguredAgents(agents: ReadonlySet<string>): void {
    this.configuredAgents = agents;
    // Delegate to the PolicyEvaluator class if active
    if (this.evaluator) {
      this.evaluator.updateConfiguredAgents(agents);
    }
  }

  /**
   * Replace the PolicyEvaluator atomically (for policy hot-reload).
   * Called by PolicyWatcher.onReload when policies.yaml changes.
   */
  reloadEvaluator(evaluator: PolicyEvaluator): void {
    this.evaluator = evaluator;
  }
}
