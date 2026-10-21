/**
 * Phase 101 document-ingestion engine — shared types.
 *
 * Surface contract for the file-type detection + OCR fallback + page-batching
 * pipeline. All ingestion telemetry fields are required at runtime via
 * `logIngest` (see telemetry.ts).
 */

/** Discriminator for file-type detection (T02). */
export type DocumentType =
  | "text-pdf"
  | "scanned-pdf"
  | "docx"
  | "xlsx"
  | "image"
  | "text";

/** Which OCR backend produced the text (T03). `"none"` when not applicable. */
export type OcrBackend =
  | "tesseract-cli"
  | "tesseract-wasm"
  | "claude-haiku"
  | "claude-sonnet"
  | "mistral"
  | "none";

/**
 * A single page after handler extraction. Image handlers populate `imageBuffer`
 * + dimensions; text handlers populate `text`. Both may be set for mixed
 * extraction strategies.
 */
export type BatchedPage = {
  readonly pageNumber: number;
  readonly imageBuffer?: Buffer;
  readonly text?: string;
  readonly widthPx?: number;
  readonly heightPx?: number;
};

/** Operator-facing hint that escalates the OCR backend selection (D-02). */
export type TaskHint = "high-precision" | "standard";

/** Optional ingestion knobs the engine accepts at its public entrypoint. */
export type IngestOptions = {
  readonly taskHint?: TaskHint;
  readonly extract?: "text" | "structured" | "both";
  readonly force?: boolean;
  /**
   * Phase 101 Plan 02 T03/T04 — explicit OCR backend override threaded
   * through from `ingest_document` MCP tool → daemon → engine → ocrPage.
   * When set to `'mistral'`, gated by `setAllowMistralOcr()` per D-08
   * (throws `"Mistral OCR backend disabled in config"` when the config
   * boolean is false; otherwise invokes the stub which throws
   * `"not yet implemented"`). When unset, the three-tier auto-chain runs.
   */
  readonly backend?: OcrBackend;
};

/** One structured ingestion telemetry record (one per `ingest()` call). */
export type IngestTelemetry = {
  readonly docSlug: string;
  readonly type: DocumentType;
  readonly pages: number;
  readonly ocrUsed: OcrBackend;
  readonly ocrConfidence?: number;
  readonly chunksCreated: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly apiCostUsd?: number;
};

/** Public return shape of the engine's `ingest()` entrypoint. */
export type IngestResult = {
  readonly source: string;
  readonly chunksCreated: number;
  readonly totalChars: number;
  readonly telemetry: IngestTelemetry;
};
