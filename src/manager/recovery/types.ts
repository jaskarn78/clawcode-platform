/**
 * Phase 94 Plan 03 Task 1 — recovery primitive types.
 *
 * D-05 contract surface: RecoveryHandler interface + 4-variant
 * RecoveryOutcome discriminated union + DI-pure RecoveryDeps.
 *
 * Locked invariants (Phase 94-03 plan rule 3):
 *   - 4 RecoveryOutcome variants: recovered | retry-later | give-up |
 *     not-applicable. Adding a 5th variant cascades through registry +
 *     heartbeat consumers. Static-grep pin counts ≥4 distinct kinds.
 *   - MAX_ATTEMPTS_PER_HOUR = 3 (bounded budget). Static-grep pinned —
 *     raising this allows a stuck recovery to loop indefinitely consuming
 *     resources. Above 3, switch to a longer cool-down rather than more
 *     attempts.
 *   - DI-pure: handlers wire execFile / killSubprocess / adminAlert / etc
 *     through deps; no node:child_process imports inside recovery/*.ts.
 *     Production wires real implementations at the daemon edge.
 *
 * Verbatim-error pass-through (Phase 85 TOOL-04 inheritance): handlers
 * receive the verbatim capabilityProbe.error string. Outcome `reason` /
 * `note` fields carry verbatim diagnostic strings — no rewriting.
 */

import type { Logger } from "pino";
import type { McpServerState } from "../../mcp/readiness.js";

/**
 * D-05 recovery outcome — 4-variant discriminated union.
 *
 * Plans consuming this MUST exhaustive-switch + assertNever (compile-time
 * enforcement). The 4 variants cover all cases:
 *   recovered      — handler ran, server is back; heartbeat re-probes
 *   retry-later    — transient handler failure; cool-down + retry
 *   give-up        — terminal handler failure; admin-clawdy alert path
 *   not-applicable — no handler matched the error; no action taken
 */
export type RecoveryOutcome =
  | { readonly kind: "recovered"; readonly serverName: string; readonly handlerName: string; readonly durationMs: number; readonly note?: string }
  | { readonly kind: "retry-later"; readonly serverName: string; readonly handlerName: string; readonly retryAfterMs: number; readonly reason: string }
  | { readonly kind: "give-up"; readonly serverName: string; readonly handlerName: string; readonly reason: string }
  | { readonly kind: "not-applicable"; readonly serverName: string };

/**
 * DI-pure dependency surface for recovery handlers + registry.
 *
 * Production wires at the daemon edge:
 *   - execFile via promisified node:child_process.execFile (Phase 91 sync-runner pattern)
 *   - killSubprocess via SDK subprocess kill API
 *   - adminAlert via discord/webhook-manager bot-direct fallback (Phase 90.1)
 *   - opRead via shelling out to `op read <ref>` (1Password CLI)
 *   - readEnvForServer / writeEnvForServer via SessionManager mcpServer config mutator
 *
 * Tests stub all functions via vi.fn().
 */
export interface RecoveryDeps {
  readonly execFile: (
    cmd: string,
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readonly killSubprocess: (serverName: string) => Promise<void>;
  readonly adminAlert: (text: string) => Promise<void>;
  readonly opRead: (reference: string) => Promise<string>;
  readonly readEnvForServer: (serverName: string) => Record<string, string>;
  readonly writeEnvForServer: (serverName: string, env: Record<string, string>) => Promise<void>;
  readonly now?: () => Date;
  readonly log: Logger;
  /**
   * Phase 999.10 plan 03 (SEC-05) — invalidate the SecretsResolver cache for
   * a given op:// URI before re-resolving. Optional for back-compat with
   * pre-999.10 tests / deps that don't have a cache to invalidate.
   *
   * The op-refresh handler calls this BEFORE deps.opRead(ref) so that a
   * cached stale value (which is what triggered the auth-error in the
   * first place) cannot be returned by opRead's underlying SecretsResolver.
   */
  readonly invalidate?: (reference: string) => void;
}

/**
 * Recovery handler contract — the extension point for new failure modes.
 *
 * Priority is a non-negative integer; lower runs first. The 3 default
 * handlers wire at module load:
 *   - playwright-chromium    priority 10  (specific)
 *   - op-refresh             priority 20  (specific)
 *   - subprocess-restart     priority 100 (last-resort, threshold-gated)
 *
 * `matches` is invoked with the verbatim error string from
 * `state.capabilityProbe.error` and the full McpServerState. Most handlers
 * only need the error; subprocess-restart consults state.capabilityProbe
 * to enforce the 5min degraded-duration threshold.
 *
 * `recover` MUST always resolve to a RecoveryOutcome — never throw.
 * Handler implementations catch internal errors and lift them into
 * `give-up` or `retry-later` outcomes with verbatim reason strings.
 */
export interface RecoveryHandler {
  readonly name: string;
  readonly priority: number;
  matches(error: string, state: McpServerState): boolean;
  recover(serverName: string, deps: RecoveryDeps): Promise<RecoveryOutcome>;
}

/**
 * Bounded budget — D-05 Section 3 contract:
 *   "max 3 attempts per server per hour".
 *
 * Above 3, switch to a longer cool-down rather than more attempts. Static-
 * grep pinned at this exact value.
 */
export const MAX_ATTEMPTS_PER_HOUR = 3;

/** 1-hour rolling window for the per-server attempt budget. */
export const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Per-attempt audit row. Persisted on the SessionHandle (analog to
 * flapHistory from Plan 94-02). Old entries pruned at write time when
 * older than ATTEMPT_WINDOW_MS.
 */
export interface AttemptRecord {
  readonly serverName: string;
  /** ISO8601 — when the attempt was made. */
  readonly attemptedAt: string;
  readonly handlerName: string;
  readonly outcomeKind: RecoveryOutcome["kind"];
}

/**
 * Per-handle attempt history map keyed by serverName. The registry
 * mutates the underlying Map in-place by replacing entries (immutability
 * preserved at the inner-array level — `[...prev, new]`).
 */
export type AttemptHistory = ReadonlyMap<string, readonly AttemptRecord[]>;
