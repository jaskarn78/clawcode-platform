/**
 * Phase 61 Plan 01 Task 3 -- WebhookSource TriggerSource adapter.
 *
 * Thin TriggerSource wrapper for webhook HTTP triggers. Unlike polling
 * sources, webhooks are push-driven -- start()/stop() are no-ops and
 * poll() is not implemented.
 *
 * The handleHttp method is called by the webhook HTTP handler on
 * successful HMAC verification. It builds a TriggerEvent with a stable
 * idempotency key and calls ingestFn.
 */

import { createHash } from "node:crypto";
import type { Logger } from "pino";

import type { TriggerEvent, TriggerSource } from "../types.js";
import type { WebhookTriggerSourceConfig } from "../../config/schema.js";
import type { WebhookConfig } from "../../dashboard/webhook-handler.js";

/**
 * Constructor options for WebhookSource.
 */
export type WebhookSourceOptions = Readonly<{
  configs: ReadonlyArray<WebhookTriggerSourceConfig>;
  ingest: (event: TriggerEvent) => Promise<void>;
  log: Logger;
}>;

/**
 * WebhookSource implements TriggerSource for HTTP webhook triggers.
 *
 * - `sourceId`: "webhook" (single source, configs are per-triggerId)
 * - `start()` / `stop()`: no-ops (event-driven via HTTP)
 * - No `poll()` method (webhooks are not replayable from watermarks)
 * - `handleHttp()`: builds TriggerEvent and calls ingestFn on HMAC-verified request
 */
export class WebhookSource implements TriggerSource {
  readonly sourceId = "webhook" as const;

  private readonly ingestFn: (event: TriggerEvent) => Promise<void>;
  private readonly log: Logger;
  private readonly _configMap: ReadonlyMap<string, WebhookConfig>;

  constructor(options: WebhookSourceOptions) {
    this.ingestFn = options.ingest;
    this.log = options.log;

    // Build config map from array
    const map = new Map<string, WebhookConfig>();
    for (const cfg of options.configs) {
      map.set(cfg.triggerId, {
        triggerId: cfg.triggerId,
        secret: cfg.secret,
        targetAgent: cfg.targetAgent,
        maxBodyBytes: cfg.maxBodyBytes,
      });
    }
    this._configMap = map;
  }

  /**
   * Config map for the webhook HTTP handler to look up per-triggerId config.
   */
  get configMap(): ReadonlyMap<string, WebhookConfig> {
    return this._configMap;
  }

  // -------------------------------------------------------------------------
  // Lifecycle (no-ops for push-driven source)
  // -------------------------------------------------------------------------

  /** No-op -- webhooks are event-driven via HTTP, not polling. */
  start(): void {
    this.log.info(
      { sourceId: this.sourceId, triggerCount: this._configMap.size },
      "webhook-source: ready (event-driven)",
    );
  }

  /** No-op -- nothing to clean up. */
  stop(): void {
    // Intentionally empty
  }

  // -------------------------------------------------------------------------
  // HTTP callback
  // -------------------------------------------------------------------------

  /**
   * Handle a verified webhook request. Builds TriggerEvent with a stable
   * idempotency key and calls ingestFn.
   *
   * Idempotency key generation:
   * - When `webhookId` is provided (from X-Webhook-ID header), use it directly.
   *   This is stable across retries by design.
   * - When absent, compute SHA-256 of raw body bytes (content-addressed).
   *   Identical payloads produce identical keys, enabling dedup of retries.
   *
   * NEVER uses Date.now() for idempotency keys -- it varies between retries
   * and defeats TriggerEngine dedup.
   */
  async handleHttp(
    triggerId: string,
    payload: unknown,
    rawBodyBytes: Buffer,
    webhookId?: string,
  ): Promise<void> {
    const config = this._configMap.get(triggerId);
    const targetAgent = config?.targetAgent ?? triggerId;

    let idempotencyKey: string;
    if (webhookId) {
      idempotencyKey = `wh:${triggerId}:${webhookId}`;
    } else {
      const bodyHash = createHash("sha256")
        .update(rawBodyBytes)
        .digest("hex")
        .slice(0, 16);
      idempotencyKey = `wh:${triggerId}:${bodyHash}`;
    }

    const event: TriggerEvent = {
      sourceId: this.sourceId,
      idempotencyKey,
      targetAgent,
      payload,
      timestamp: Date.now(),
    };

    await this.ingestFn(event);
  }
}
