/**
 * Phase 101 Plan 02 T05 — fail-mode alerts (U7, SC-7).
 *
 * Surfaces structured failure metadata to admin-clawdy via a Phase 91
 * alert-style WebhookManager.send() shape. Mirrors the Phase 127
 * `recordStall` pattern from `src/manager/stream-stall-callback.ts`:
 *
 *   - Module-level deps injection at daemon boot (`setIngestAlertDeps`).
 *   - Late-bind so a missing logger / sender during boot doesn't crash
 *     the alert emission path.
 *   - Pino log + Discord post (severity:'error' only) — severity:'warn'
 *     stays in logs to avoid alert fatigue.
 *   - Security: alerts NEVER include extracted field VALUES (T-101-06).
 *     Only metadata (docSlug, missingFields[], reason, ocrConfidence).
 *
 * Five reason codes round-trip the recordIngestAlert surface (covers ≥95%
 * of expected failure modes per SC-7):
 *   - 'ocr-low-confidence'           — all three OCR tiers underperformed
 *   - 'extraction-missing-required'  — zod.parse failed on the structured pass
 *   - 'max-pages-exceeded'           — DoS guard at MAX_PAGES=500
 *   - 'mistral-disabled'             — backend='mistral' with config off (D-08)
 *   - 'embedder-failure'             — embedder.embedV2() threw during chunk pass
 */

import type { Logger } from "pino";
import type { DocumentType } from "./types.js";

export const INGEST_ALERT_TAG = "phase101-ingest-alert";

export type IngestAlertReason =
  | "ocr-low-confidence"
  | "extraction-missing-required"
  | "max-pages-exceeded"
  | "mistral-disabled"
  | "embedder-failure";

export type IngestAlertSeverity = "warn" | "error";

export type IngestAlert = {
  readonly docSlug: string;
  readonly type: DocumentType | "unknown";
  readonly reason: IngestAlertReason;
  readonly severity: IngestAlertSeverity;
  readonly ocrConfidence?: number;
  readonly missingFields?: readonly string[];
  /** Per-agent attribution — used to route the Discord post to admin-clawdy. */
  readonly agent?: string;
};

export type IngestAlertDeps = {
  readonly logger?: Logger;
  readonly postToAdminClawdy?: (msg: string) => Promise<void>;
};

// Module-level deps — injection at boot mirrors the Phase 127
// stream-stall-callback shape. Late-bind so a stall fired before the
// daemon finishes wiring its logger/webhook surface still emits the
// pino log without throwing.
let moduleDeps: IngestAlertDeps = {};

/** Daemon edge sets this once at boot. Tests reset between cases. */
export function setIngestAlertDeps(deps: IngestAlertDeps): void {
  moduleDeps = deps;
}

/** Inspect current deps (test-only). */
export function _getIngestAlertDepsForTests(): IngestAlertDeps {
  return moduleDeps;
}

/**
 * Format the 2-line Discord message for admin-clawdy. Keeps the payload
 * compact and predictable (no extracted text). Per T-101-06, only
 * docSlug + reason + counted metadata leaves the alerts pipeline.
 */
function formatAlertMessage(alert: IngestAlert): string {
  const agentPrefix = alert.agent ? `${alert.agent}: ` : "";
  const reasonText: Record<IngestAlertReason, string> = {
    "ocr-low-confidence": `OCR confidence below threshold across all tiers (${
      alert.ocrConfidence !== undefined
        ? `last tier ${Math.round(alert.ocrConfidence * 100)}%`
        : "no tier returned text"
    })`,
    "extraction-missing-required": `structured extraction failed (missing fields: ${
      (alert.missingFields ?? []).slice(0, 5).join(", ") || "unspecified"
    })`,
    "max-pages-exceeded": "document exceeded MAX_PAGES cap",
    "mistral-disabled":
      "Mistral OCR backend requested but defaults.documentIngest.allowMistralOcr=false (D-08)",
    "embedder-failure": "embedder.embedV2() threw during chunk embedding",
  };
  const head = `${agentPrefix}couldn't parse ${alert.docSlug} (${alert.type})`;
  const tail = `${reasonText[alert.reason]}, recommend manual review`;
  return `${head} — ${tail}`;
}

/**
 * Emit one ingestion failure alert. Always emits the pino log line
 * tagged `phase101-ingest-alert` with the structured metadata. Only
 * severity:'error' alerts get posted to admin-clawdy — severity:'warn'
 * stays in logs to avoid alert fatigue on recoverable degradations
 * (e.g. OCR fell back to Claude vision successfully).
 *
 * Fire-and-forget; the Discord post is awaited but its rejection
 * never surfaces past the catch handler — alerts must never poison
 * the ingest path.
 */
export async function recordIngestAlert(alert: IngestAlert): Promise<void> {
  const { logger, postToAdminClawdy } = moduleDeps;

  // Pino log — always emitted (mirrors stall-callback shape).
  // Only metadata; never extracted text (T-101-06).
  const logPayload = {
    tag: INGEST_ALERT_TAG,
    docSlug: alert.docSlug,
    type: alert.type,
    reason: alert.reason,
    severity: alert.severity,
    ...(alert.ocrConfidence !== undefined
      ? { ocrConfidence: alert.ocrConfidence }
      : {}),
    ...(alert.missingFields !== undefined
      ? { missingFieldsCount: alert.missingFields.length }
      : {}),
    ...(alert.agent !== undefined ? { agent: alert.agent } : {}),
  };
  if (logger) {
    if (alert.severity === "error") {
      logger.error(logPayload, INGEST_ALERT_TAG);
    } else {
      logger.warn(logPayload, INGEST_ALERT_TAG);
    }
  } else {
    // No logger wired (tests, boot race) — write to console as a fallback
    // so the alert is never silently dropped.
    // eslint-disable-next-line no-console
    console.warn(INGEST_ALERT_TAG, JSON.stringify(logPayload));
  }

  // Discord sink — fire-and-forget; severity:'error' only.
  if (alert.severity === "error" && postToAdminClawdy) {
    try {
      await postToAdminClawdy(formatAlertMessage(alert));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (logger) {
        logger.warn(
          { tag: INGEST_ALERT_TAG, err: msg },
          "phase101 ingest-alert discord post failed",
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "phase101-ingest-alert-discord-failed",
          JSON.stringify({ err: msg }),
        );
      }
    }
  }
}
