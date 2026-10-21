/**
 * Phase 59 — deterministic payload → sha256 hex digest.
 *
 * REUSES src/shared/canonical-stringify.ts (Phase 55 Plan 02) — DO NOT hand-roll
 * canonical JSON here. Key sort + undefined/NaN/null normalization + array-order
 * preservation semantics are owned by canonicalStringify; divergence breaks
 * LIFE-06 retry integrity (same payload must yield same digest forever).
 *
 * Consumers:
 *   - TaskManager.delegate (Plan 59-02) — stores digest on the tasks row
 *   - TaskManager.retry (Plan 59-02) — re-computes digest on the replayed payload;
 *     must byte-match the stored value or LIFE-06 idempotency breaks (Pitfall 3).
 *
 * Format: `sha256:<64 lowercase hex chars>`. The `sha256:` prefix preserves
 * forward compatibility if a future phase ever introduces a second hash
 * algorithm (grep-able by prefix).
 */

import { createHash } from "node:crypto";
import { canonicalStringify } from "../shared/canonical-stringify.js";

export function computeInputDigest(payload: unknown): string {
  const canonical = canonicalStringify(payload);
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${hex}`;
}
