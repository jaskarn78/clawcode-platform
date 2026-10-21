import type { CheckModule } from "./types.js";
import { CHECK_REGISTRY } from "./check-registry.js";

/**
 * Return the statically-registered health check modules.
 *
 * Phase 999.8 Plan 03 — replaces the prior readdir+dynamic-import scan,
 * which silently returned 0 modules in production because tsup
 * (`splitting:false`) bundles only `src/cli/index.ts` into a single file
 * and never emits `dist/heartbeat/checks/*.js` for the runtime scanner
 * to read.
 *
 * The async signature is preserved so `runner.ts` and existing tests
 * compile without changes. The `checksDir` argument is intentionally
 * unused — kept for back-compat with callers that still pass a path.
 */
export async function discoverChecks(
  _checksDir: string,
): Promise<readonly CheckModule[]> {
  return CHECK_REGISTRY;
}
