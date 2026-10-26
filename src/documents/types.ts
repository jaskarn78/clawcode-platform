/**
 * Document module types.
 * All types are readonly per project immutability convention.
 */

/** A single chunk of a document stored with its embedding. */
export type DocumentChunk = {
  readonly id: string;
  readonly source: string;
  readonly chunkIndex: number;
  readonly content: string;
  readonly startChar: number;
  readonly endChar: number;
  readonly createdAt: string;
};

/** Result of ingesting a document into the store. */
export type IngestResult = {
  readonly source: string;
  readonly chunksCreated: number;
  readonly totalChars: number;
};

/** A search result from the document store with similarity and context. */
export type DocumentSearchResult = {
  readonly chunkId: string;
  readonly source: string;
  readonly chunkIndex: number;
  readonly content: string;
  /**
   * Base similarity (1 - distance). Preserved for backward compat with the
   * search-documents MCP tool response shape at server.ts:1220-1234.
   */
  readonly similarity: number;
  readonly contextBefore: string | null;
  readonly contextAfter: string | null;
  /**
   * Phase 999.43 Plan 03 — final score per D-02 LOCKED VERBATIM:
   *   weightedScore = similarity × agentWeight × contentWeight × recencyBoost
   * Equal to `similarity` for legacy callers that omit `agentWeight` AND for
   * chunks whose `documents` row is missing (LEFT JOIN null → multipliers
   * default to 1.0). Always present (additive field).
   */
  readonly weightedScore?: number;
  /**
   * Phase 999.43 Plan 03 — true iff the document was ingested within the
   * last 7 days (D-02 recency cutoff). Query-time computed from
   * documents.ingested_at vs now() per D-07 (NOT stored).
   */
  readonly recencyBoostApplied?: boolean;
  /**
   * Phase 999.43-fu2 Path A T03 — persisted on-disk path for image
   * attachments (image MIME). Null for PDF/docx/xlsx and other non-image
   * source kinds. Surfaced to the agent via the `search_documents` MCP tool
   * so charts/graphs can be re-viewed when shape semantics matter beyond
   * OCR text. Subject to the 24h attachment-cleanup policy
   * (cleanupAttachments in src/discord/attachments.ts) — agents should
   * treat retrieval of an aged image path as best-effort.
   */
  readonly sourceImagePath?: string | null;
  /**
   * Memory overhaul (2026-10-25) WP3: provenance from the `documents` row so
   * the search_documents tool can tell the agent what the document is, when
   * it arrived and who sent it. All null when the row is missing.
   */
  readonly filename?: string | null;
  readonly ingestedAt?: string | null;
  readonly userName?: string | null;
  readonly channelName?: string | null;
  readonly sourceKind?: string | null;
};
