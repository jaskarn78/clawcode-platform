/**
 * Phase 96 Plan 01 D-06 — single-source-of-truth filesystem boundary check.
 *
 * Cache-hit fast path → on-miss live fs.access fallback. Snapshot keyed
 * by canonical absPath (resolved symlinks via realpath/resolve). NO path-
 * prefix startsWith — exact-match Map lookup. D-06 explicitly forbids
 * startsWith because ACLs can grant per-subtree access; a parent ready
 * snapshot does NOT imply subtree readability.
 *
 * Pure-DI module:
 *   - No SDK imports
 *   - No node:fs imports (production wires at daemon edge)
 *   - No bare Date constructor (no clock dependency at this layer)
 *
 * Static-grep regression pin (96-01-PLAN.md): every fs read/share site
 * MUST go through `checkFsCapability(path, snapshot, deps)`. CI grep
 * ensures no direct `fs.readFile`/`fs.access` in tool implementations
 * bypassing this check.
 */

import type {
  FsCapabilityMode,
  FsCapabilitySnapshot,
} from "./persistent-session-handle.js";

/**
 * Discriminated-union outcome of the boundary check.
 *
 * - allowed:true carries the canonical absPath (post-realpath/resolve)
 *   for the caller to use in subsequent fs.readFile / share calls. Mode
 *   distinguishes RO from RW so write-mode tools can refuse RO paths.
 * - allowed:false carries the verbatim reason — Phase 85 TOOL-04
 *   inheritance (no wrapping; Plan 96-03/96-04 ToolCallError does the
 *   classification at the executor edge).
 */
export type CheckFsCapabilityResult =
  | {
      readonly allowed: true;
      readonly canonicalPath: string;
      readonly mode: FsCapabilityMode;
    }
  | { readonly allowed: false; readonly reason: string };

/**
 * Pure-DI deps surface. Production wires node:fs/promises.access +
 * a canonicalizer (realpath with resolve fallback) at the daemon edge.
 * Tests stub both. fsConstants carries R_OK only (write-mode probe is
 * out of scope for this plan).
 */
export interface CheckFsCapabilityDeps {
  /** Wraps node:fs/promises.access. */
  readonly fsAccess: (path: string, mode: number) => Promise<void>;
  /** node:fs.constants — R_OK only. */
  readonly fsConstants: { readonly R_OK: number };
  /**
   * Canonicalize the raw path: try realpath; on ENOENT fall back to
   * path.resolve only. Production wires this from a small helper that
   * combines both; tests stub directly. Throws on unexpected failures
   * (the boundary check returns allowed:false with the verbatim reason).
   */
  readonly canonicalize: (rawPath: string) => Promise<string>;
}

/**
 * Boundary check: cache-hit fast path → on-miss live fs.access fallback.
 *
 * Algorithm:
 *   1. Canonicalize rawPath via deps.canonicalize. Failure → allowed:false
 *      with verbatim reason. (Symlinks resolve, .. collapses, no leading
 *      relative paths.)
 *   2. Cache hit on the canonical key with status='ready' → allowed:true
 *      with the cached mode. Cache hits with status='degraded' or
 *      'unknown' fall through to step 3 — stale or never-probed entries
 *      should not short-circuit a fresh check.
 *   3. Live fs.access(canonical, R_OK). Success → allowed:true mode='ro'.
 *      Failure → allowed:false with verbatim reason.
 *
 * D-06 invariant: snapshot keys are canonical absPaths produced by
 * realpath/resolve — exact-match Map lookup only. NEVER startsWith.
 *
 * @param rawPath  User-supplied path (may contain `..` or symlinks)
 * @param snapshot ReadonlyMap from runFsProbe (keyed by canonical absPath)
 * @param deps     DI surface
 */
export async function checkFsCapability(
  rawPath: string,
  snapshot: ReadonlyMap<string, FsCapabilitySnapshot>,
  deps: CheckFsCapabilityDeps,
): Promise<CheckFsCapabilityResult> {
  let canonical: string;
  try {
    canonical = await deps.canonicalize(rawPath);
  } catch (err) {
    return {
      allowed: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Fast path — exact-match cache lookup. D-06: NO startsWith. A parent
  // ready entry does NOT imply subtree readability.
  const cached = snapshot.get(canonical);
  if (cached?.status === "ready") {
    return {
      allowed: true,
      canonicalPath: canonical,
      mode: cached.mode,
    };
  }

  // On-miss: live fs.access(R_OK) fallback. Cached entries with
  // status='degraded' OR 'unknown' fall through here too — stale beliefs
  // don't short-circuit a fresh check (D-CONTEXT freshness contract).
  try {
    await deps.fsAccess(canonical, deps.fsConstants.R_OK);
    return {
      allowed: true,
      canonicalPath: canonical,
      mode: "ro",
    };
  } catch (err) {
    return {
      allowed: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
