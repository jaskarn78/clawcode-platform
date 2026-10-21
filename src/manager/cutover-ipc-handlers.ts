/**
 * Phase 92 GAP CLOSURE — daemon-side IPC handlers for `cutover-verify` +
 * `cutover-rollback`.
 *
 * Pure exported helpers (mirror `handleSetModelIpc` / `handleCutoverButtonActionIpc`
 * pattern) so they're unit-testable in isolation from the daemon's bootstrap.
 *
 * The handlers ONLY validate params + dispatch to the underlying primitives
 * (`runVerifyPipeline` / `runRollbackEngine`). The daemon's closure-based
 * intercept (in daemon.ts) constructs the per-call deps object from the
 * daemon's singletons (TurnDispatcher, list-mcp-status state map, config,
 * resolvedAgents) and passes it through.
 *
 * Returning shape rationale:
 *   - cutover-verify returns `{cutoverReady, gapCount, canaryPassRate, reportPath}`
 *     — projection of the full VerifyOutcome union to the operator-visible
 *     fields the CLI prints. The full union is logged daemon-side for
 *     debugging but not bubbled because operators only care about the
 *     binary signal + the report path.
 *   - cutover-rollback returns `{rewoundCount, errors[]}` — projection of
 *     `RollbackEngineResult` minus the internal counters
 *     (skippedAlreadyRewound, skippedIrreversible) which are debug-only.
 */
import type { Logger } from "pino";

import { ManagerError } from "../shared/errors.js";
import {
  runVerifyPipeline,
  type VerifyPipelineDeps,
} from "../cutover/verify-pipeline.js";
import {
  runRollbackEngine,
  type RollbackEngineDeps,
} from "../cutover/rollback-engine.js";

/**
 * Operator-facing IPC response shape for `cutover-verify`. Mirrors the
 * type the CLI client (cutover-verify.ts) casts to.
 */
export type CutoverVerifyIpcResponse = {
  readonly cutoverReady: boolean;
  readonly gapCount: number;
  readonly canaryPassRate: number;
  readonly reportPath: string;
};

/**
 * IPC params for `cutover-verify`. The CLI sends these via sendIpcRequest;
 * the validation layer rejects bad params with ManagerError → IpcError.
 */
export type CutoverVerifyIpcParams = {
  readonly agent?: unknown;
  readonly applyAdditive?: unknown;
  readonly outputDir?: unknown;
  readonly stagingDir?: unknown;
  readonly depthMsgs?: unknown;
  readonly depthDays?: unknown;
};

/**
 * IPC params for `cutover-rollback`.
 */
export type CutoverRollbackIpcParams = {
  readonly agent?: unknown;
  readonly ledgerTo?: unknown;
  readonly ledgerPath?: unknown;
  readonly dryRun?: unknown;
};

export type CutoverRollbackIpcResponse = {
  readonly rewoundCount: number;
  readonly errors: ReadonlyArray<{
    readonly row: number;
    readonly error: string;
  }>;
};

/**
 * Type-narrowing param validator. Rejects with ManagerError when the
 * required `agent` field is absent or non-string. Returns a sanitized
 * record the daemon can pass to runVerifyPipeline.
 */
function validateVerifyParams(params: CutoverVerifyIpcParams): {
  agent: string;
  applyAdditive: boolean;
  outputDir: string | undefined;
  stagingDir: string | undefined;
  depthMsgs: number | undefined;
  depthDays: number | undefined;
} {
  if (typeof params.agent !== "string" || params.agent.length === 0) {
    throw new ManagerError(
      "cutover-verify: missing or invalid 'agent' param",
    );
  }
  return {
    agent: params.agent,
    applyAdditive: params.applyAdditive === true,
    outputDir:
      typeof params.outputDir === "string" ? params.outputDir : undefined,
    stagingDir:
      typeof params.stagingDir === "string" ? params.stagingDir : undefined,
    depthMsgs:
      typeof params.depthMsgs === "number" ? params.depthMsgs : undefined,
    depthDays:
      typeof params.depthDays === "number" ? params.depthDays : undefined,
  };
}

function validateRollbackParams(params: CutoverRollbackIpcParams): {
  agent: string;
  ledgerTo: string;
  ledgerPath: string | undefined;
  dryRun: boolean;
} {
  if (typeof params.agent !== "string" || params.agent.length === 0) {
    throw new ManagerError(
      "cutover-rollback: missing or invalid 'agent' param",
    );
  }
  if (typeof params.ledgerTo !== "string" || params.ledgerTo.length === 0) {
    throw new ManagerError(
      "cutover-rollback: missing or invalid 'ledgerTo' param (expected ISO 8601)",
    );
  }
  return {
    agent: params.agent,
    ledgerTo: params.ledgerTo,
    ledgerPath:
      typeof params.ledgerPath === "string" ? params.ledgerPath : undefined,
    dryRun: params.dryRun === true,
  };
}

/**
 * DI surface for `handleCutoverVerifyIpc`. Production wires Plans
 * 92-01..05 modules + report writer; tests pass `vi.fn()` stubs.
 *
 * The deps object is a SUBSET of `VerifyPipelineDeps` — the daemon
 * fills in the agent + flags from validated params and merges with
 * its singleton-backed phase functions / sub-deps.
 *
 * The `buildPipelineDeps` factory pattern is used (instead of passing
 * `VerifyPipelineDeps` directly) so the daemon can compute output/staging
 * dirs, sub-dep maps, and DI hooks ONCE per call without having to
 * thread agent + flags through 7 nested objects.
 */
export type CutoverVerifyHandlerDeps = {
  /**
   * Build the full VerifyPipelineDeps from the operator-supplied params.
   * The daemon implements this against its singletons; tests stub it to
   * return a hermetic deps object.
   */
  readonly buildPipelineDeps: (resolved: {
    agent: string;
    applyAdditive: boolean;
    outputDir: string | undefined;
    stagingDir: string | undefined;
    depthMsgs: number | undefined;
    depthDays: number | undefined;
  }) => Promise<VerifyPipelineDeps>;
  readonly log: Logger;
};

/**
 * Daemon-side IPC handler for `cutover-verify`. Validates params,
 * builds the VerifyPipelineDeps via DI, runs runVerifyPipeline, and
 * projects the VerifyOutcome to the operator-visible response shape.
 *
 * Failure handling:
 *   - Per-phase failures (kind="ingest-failed" / "profile-failed" / etc.)
 *     surface as cutoverReady=false WITHOUT a reportPath (the pipeline
 *     halts before writing the report). The CLI prints the JSON
 *     summary so the operator can read the error context.
 *   - verified-ready → cutoverReady=true + report metadata
 *   - verified-not-ready → cutoverReady=false + report metadata + gaps
 */
export async function handleCutoverVerifyIpc(
  params: CutoverVerifyIpcParams,
  deps: CutoverVerifyHandlerDeps,
): Promise<CutoverVerifyIpcResponse> {
  const resolved = validateVerifyParams(params);
  const pipelineDeps = await deps.buildPipelineDeps(resolved);

  const outcome = await runVerifyPipeline(pipelineDeps);

  // Project VerifyOutcome → operator-visible response. Per-phase failures
  // map to cutoverReady=false with empty reportPath; the daemon log carries
  // the full outcome.kind for ops investigation.
  if (outcome.kind === "verified-ready") {
    deps.log.info(
      { agent: resolved.agent, kind: outcome.kind },
      "cutover-verify: pipeline completed (ready)",
    );
    return {
      cutoverReady: true,
      gapCount: outcome.gapCount,
      canaryPassRate: outcome.canaryPassRate,
      reportPath: outcome.reportPath,
    };
  }
  if (outcome.kind === "verified-not-ready") {
    deps.log.info(
      {
        agent: resolved.agent,
        kind: outcome.kind,
        gaps: outcome.gapCount,
        destructive: outcome.destructiveCount,
      },
      "cutover-verify: pipeline completed (not ready)",
    );
    return {
      cutoverReady: false,
      gapCount: outcome.gapCount,
      canaryPassRate: outcome.canaryPassRate,
      reportPath: outcome.reportPath,
    };
  }
  // Per-phase failure — log full outcome + return cutoverReady=false.
  // reportPath="" because the pipeline halted before/at the report stage.
  deps.log.warn(
    { agent: resolved.agent, outcome },
    "cutover-verify: pipeline failed",
  );
  return {
    cutoverReady: false,
    gapCount: 0,
    canaryPassRate: 0,
    reportPath: "",
  };
}

/**
 * DI surface for `handleCutoverRollbackIpc`. Same factory pattern as the
 * verify handler — daemon constructs RollbackEngineDeps lazily so the
 * common per-call params don't have to be threaded through every test.
 */
export type CutoverRollbackHandlerDeps = {
  readonly buildEngineDeps: (resolved: {
    agent: string;
    ledgerTo: string;
    ledgerPath: string | undefined;
    dryRun: boolean;
  }) => Promise<RollbackEngineDeps>;
  readonly log: Logger;
};

/**
 * Daemon-side IPC handler for `cutover-rollback`. Validates params,
 * builds RollbackEngineDeps via DI, runs the LIFO rewind engine, and
 * projects the RollbackEngineResult to the operator response.
 *
 * The full result (skippedAlreadyRewound, skippedIrreversible counts) is
 * logged daemon-side for ops investigation but not bubbled — operators
 * only need rewoundCount + per-row errors.
 */
export async function handleCutoverRollbackIpc(
  params: CutoverRollbackIpcParams,
  deps: CutoverRollbackHandlerDeps,
): Promise<CutoverRollbackIpcResponse> {
  const resolved = validateRollbackParams(params);
  const engineDeps = await deps.buildEngineDeps(resolved);

  const result = await runRollbackEngine(engineDeps);

  deps.log.info(
    {
      agent: resolved.agent,
      ledgerTo: resolved.ledgerTo,
      dryRun: resolved.dryRun,
      rewoundCount: result.rewoundCount,
      skippedAlreadyRewound: result.skippedAlreadyRewound,
      skippedIrreversible: result.skippedIrreversible,
      errorCount: result.errors.length,
    },
    "cutover-rollback: completed",
  );

  return {
    rewoundCount: result.rewoundCount,
    errors: result.errors.map((e) => ({
      row: e.row,
      error: e.error,
    })),
  };
}
