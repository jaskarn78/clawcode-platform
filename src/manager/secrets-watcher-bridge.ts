/**
 * Phase 999.10 Plan 03 — bridge between `ConfigWatcher.onChange` diff and the
 * `SecretsResolver` cache (SEC-05).
 *
 * Why a bridge module: `daemon.ts` is already 4000+ lines and the
 * onChange callback needs to (a) walk the field diff, (b) decide which
 * entries are op:// URI swaps, (c) call invalidate/resolve in the right
 * order — three responsibilities that benefit from being unit-testable
 * without booting the whole daemon. The bridge keeps daemon.ts small and
 * lets the test file import the production code path directly (instead
 * of duplicating the diff-walking shape in test code that could drift).
 *
 * Ordering invariant: invalidate-FIRST then warm-resolve. A stale value
 * cannot leak between the invalidate and resolve calls because resolve
 * starts by checking `cache.get(uri)` (post-invalidate that miss is
 * guaranteed). Concurrent agent spawns racing the watcher are safe by
 * the inflight dedup map in SecretsResolver.
 */

import type pino from "pino";
import type { ConfigDiff } from "../config/types.js";
import type { SecretsResolver } from "./secrets-resolver.js";

/** Tighter than `startsWith` alone — rejects the bare `op://` literal. */
function isOpUri(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("op://") &&
    value.length > "op://".length
  );
}

/**
 * Walk a `ConfigDiff` and reconcile the `SecretsResolver` cache against the
 * field-level changes:
 *
 *   - oldValue is op:// AND differs from newValue → invalidate(oldValue)
 *   - newValue is op:// (regardless of oldValue shape)        → resolve(newValue)
 *
 * Failures during warm-resolve are logged but never thrown — the caller's
 * downstream `configReloader.applyChanges` path must still run for the
 * non-secret parts of the same diff.
 */
export async function applySecretsDiff(
  diff: ConfigDiff,
  resolver: SecretsResolver,
  log: pino.Logger,
): Promise<void> {
  for (const change of diff.changes) {
    const { oldValue, newValue } = change;

    // Invalidate the OLD URI first so a concurrent resolve() during the
    // warm-resolve window cannot serve a stale cached value.
    if (isOpUri(oldValue) && oldValue !== newValue) {
      resolver.invalidate(oldValue);
    }

    // Warm-resolve the NEW URI so the next agent spawn hits a hot cache.
    // Failures land in SecretsResolver's structured warn log; we additionally
    // emit a single watcher-side warn here for operator correlation against
    // the config-change audit trail.
    if (isOpUri(newValue)) {
      try {
        await resolver.resolve(newValue);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn(
          { uri: newValue, fieldPath: change.fieldPath, reason },
          "secrets: warm-resolve after config change failed",
        );
      }
    }
  }
}
