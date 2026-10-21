/**
 * Phase 101 document-ingestion telemetry emitter.
 *
 * One structured log line per ingestion, tagged `phase101-ingest`. Mirrors
 * the `phase136-llm-runtime` / `phase127-resolver` JSON-tag pattern (see
 * CONTEXT.md "Established Patterns") so operators can grep a single tag for
 * the full ingestion picture.
 *
 * Security note (T-101-02): only emits metadata (docSlug, type, page count,
 * confidence, timing). Never logs extracted text content.
 */

import type { Logger } from "pino";
import { logger as sharedLogger } from "../shared/logger.js";
import type { IngestTelemetry } from "./types.js";

/** Single grep tag for operator telemetry across CLI/Discord/dashboard. */
export const INGEST_LOG_TAG = "phase101-ingest";

const REQUIRED_FIELDS: ReadonlyArray<keyof IngestTelemetry> = [
  "docSlug",
  "type",
  "pages",
  "ocrUsed",
  "chunksCreated",
  "p50_ms",
  "p95_ms",
];

/**
 * Emit a `phase101-ingest` JSON log line for one ingestion. Throws if any
 * required field is missing — telemetry is part of the contract.
 *
 * @param t structured ingestion record
 * @param log optional pino logger; defaults to the shared daemon logger
 */
export function logIngest(t: IngestTelemetry, log?: Logger): void {
  for (const field of REQUIRED_FIELDS) {
    if (t[field] === undefined || t[field] === null) {
      throw new Error(
        `phase101-ingest telemetry missing required field: ${field}`,
      );
    }
  }
  (log ?? sharedLogger).info({ tag: INGEST_LOG_TAG, ...t }, INGEST_LOG_TAG);
}
