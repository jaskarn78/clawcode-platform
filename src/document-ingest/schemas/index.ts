/**
 * Phase 101 Plan 02 T02 — extraction-schema registry.
 *
 * Maps schemaName → zod schema. The MCP `ingest_document` tool's `schemaName`
 * input + `extractStructured()`'s type parameter both index into this registry
 * so the wire surface and the runtime parse share a single source of truth.
 *
 * D-06 deferred schemas (`brokerageStatement`, `retirement401k`, `formADV`)
 * plug in here as concrete daily-workflow needs surface.
 */

import { ExtractedTaxReturn } from "./extracted-tax-return.js";

export const EXTRACTION_SCHEMAS = {
  taxReturn: ExtractedTaxReturn,
} as const;

export type ExtractionSchemaName = keyof typeof EXTRACTION_SCHEMAS;

export { ExtractedTaxReturn, type ExtractedTaxReturnT } from "./extracted-tax-return.js";
