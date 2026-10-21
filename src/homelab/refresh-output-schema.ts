/**
 * Phase 999.47 Plan 02 Task 1 — frozen `.refresh-last.json` schema.
 *
 * This Zod v4 schema defines the contract between Plan 03's
 * `scripts/refresh.sh` (the writer) and Plan 02's
 * `src/heartbeat/checks/homelab-refresh.ts` (the reader). It must remain
 * stable across phases because the bash script writes against the exact
 * field names below, and `journalctl -u clawcode -g phase999.47-homelab-refresh`
 * grep targets depend on the value flow staying byte-identical to SC-7.
 *
 * Cross-field invariant (D-04c "noisy commit, never silent"):
 *   - `ok === false` MUST be accompanied by a non-empty `failureReason`.
 *   - `ok === true` allows `failureReason === null`.
 *
 * Counts are `z.int().nonnegative()` — negative counts indicate a
 * writer bug and reject at parse time so the heartbeat tick logs a
 * structured warning rather than emitting noise to operators.
 */

import { z } from "zod/v4";

const refreshCountsSchema = z.object({
  hostCount: z.int().nonnegative(),
  vmCount: z.int().nonnegative(),
  containerCount: z.int().nonnegative(),
  driftCount: z.int().nonnegative(),
  tunnelCount: z.int().nonnegative(),
  dnsCount: z.int().nonnegative(),
});

/** Frozen `.refresh-last.json` contract. */
export const refreshOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    ranAt: z.iso.datetime(),
    ok: z.boolean(),
    commitsha: z.string().min(1).nullable(),
    noDiff: z.boolean(),
    counts: refreshCountsSchema,
    failureReason: z.string().nullable(),
    consecutiveFailures: z.int().nonnegative(),
  })
  .refine(
    (data) =>
      data.ok === true || (typeof data.failureReason === "string" && data.failureReason.length > 0),
    {
      message: "failureReason must be a non-empty string when ok is false (D-04c)",
      path: ["failureReason"],
    },
  );

/** Inferred frozen-contract type. */
export type RefreshOutput = z.infer<typeof refreshOutputSchema>;
