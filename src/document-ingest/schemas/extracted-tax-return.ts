/**
 * Phase 101 Plan 02 T02 — canonical `ExtractedTaxReturn` schema (D-06).
 *
 * Locked verbatim from `101-CONTEXT.md` lines 56-74. Plan 02's extractor uses
 * this schema's zod-derived JSON Schema (via `z.toJSONSchema`) to drive the
 * Anthropic tool-use call, then parses the tool result through this same
 * `ExtractedTaxReturn.parse(...)` so the contract is bidirectional.
 *
 * Versioning (D-07): every extracted record carries
 * `extractionSchemaVersion: "v1"`. When the schema evolves to v2, historical
 * v1 records remain valid; the operator opts in to re-extraction via
 * `ingest_document --force`.
 */

import { z } from "zod";

export const ExtractedTaxReturn = z.object({
  taxYear: z.number().int(),
  taxpayerName: z.string(),
  box1Wages: z.number().nullable(),
  scheduleC: z
    .object({
      netProfit: z.number().nullable(),
      grossReceipts: z.number().nullable(),
      expenses: z.array(
        z.object({ category: z.string(), amount: z.number() }),
      ),
    })
    .nullable(),
  backdoorRoth: z
    .object({ amount: z.number(), year: z.number() })
    .nullable(),
  iraDeduction: z.number().nullable(),
  qbi: z.object({ deduction: z.number() }).nullable(),
  extractionSchemaVersion: z.literal("v1"),
});

export type ExtractedTaxReturnT = z.infer<typeof ExtractedTaxReturn>;
