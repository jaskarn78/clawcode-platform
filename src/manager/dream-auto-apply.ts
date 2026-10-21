/**
 * Phase 95 Plan 02 Task 2 — D-04 dream-result auto-applier.
 * Phase 115 Plan 05 T02 — extended for D-10 5-row hybrid policy.
 *
 * Pure-DI module:
 *   - No SDK imports
 *   - No fs imports (writeDreamLog + scheduleAutoApply are DI'd)
 *   - No MEMORY.md mutations from this module (D-04 surfacing-only invariant
 *     preserved; D-10 mutating side rides on the VetoStore tick which calls
 *     the agent-curated archive primitive — see dream-veto-store.ts apply
 *     callback contract).
 *
 * D-04 contract (intentionally narrow — preserved for backwards compat):
 *   - newWikilinks → applied via deps.applyAutoLinks (Phase 36-41 idiom)
 *   - promotionCandidates + themedReflection + suggestedConsolidations →
 *     SURFACED to the dream log for operator review; never auto-applied
 *
 * Phase 115 D-10 5-row hybrid policy (replaces D-04 for callers that opt in
 * via applyDreamResultD10):
 *   1. newWikilinks                                 → auto-apply (additive)   [D-04 unchanged]
 *   2. promotionCandidates (additive, score >= 80)  → auto-apply with 30-min Discord veto window
 *   3. promotionCandidates (mutating)               → operator-required (NO auto-apply)
 *   4. suggestedConsolidations                      → operator-required        [D-04 unchanged]
 *   5. priority pass (D-05)                          → ALL promotion ALLOWED to mutate; auto-apply with 30-min veto
 *
 * The 3-variant DreamPassOutcome union (completed | skipped | failed) is
 * consumed via the same exhaustive switch idiom established in Plan 95-01.
 */

import type { DreamPassOutcome, DreamResult } from "./dream-pass.js";
import type { WriteDreamLogFn } from "./dream-log-writer.js";
import type {
  ScheduledApply,
  VetoStorePromotion,
  VetoStore,
} from "./dream-veto-store.js";
import type {
  PromotionForSummary,
  PromotionSummaryInput,
} from "./dream-discord-summary.js";

/**
 * Phase 115 D-10 — auto-apply threshold for additive promotion (Row 2).
 * Priority-pass (Row 5) overrides this floor.
 */
export const D10_AUTO_APPLY_PRIORITY_FLOOR = 80;

/** D-10 — veto window length (operator-tunable in future; locked here). */
export const D10_VETO_WINDOW_MS = 30 * 60 * 1000;

/**
 * Discriminated outcome of a single auto-apply attempt. The CLI / Discord
 * renderers (Plan 95-03) match on `kind` for human-readable surfacing.
 */
export type DreamApplyOutcome =
  | {
      readonly kind: "applied";
      readonly appliedWikilinkCount: number;
      readonly surfacedPromotionCount: number;
      readonly surfacedConsolidationCount: number;
      readonly logPath: string;
      /**
       * Phase 999.188 — present when the D-10 applier ran: how many
       * promotion candidates entered the veto window, under which run id,
       * and whether this was a priority pass. Absent on the legacy
       * show-only path.
       */
      readonly runId?: string;
      readonly autoApplyScheduled?: number;
      readonly isPriorityPass?: boolean;
    }
  | {
      readonly kind: "skipped";
      readonly reason: "no-completed-result";
    }
  | {
      readonly kind: "failed";
      readonly error: string;
    };

export interface DreamApplyLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * DI surface. The auto-applier itself stays pure: production wiring at the
 * daemon edge maps `applyAutoLinks` to the Phase 36-41 link applier and
 * `writeDreamLog` to the dream-log-writer module.
 *
 * NOTE: deliberately NO `applyPromotion` or `applyConsolidation` field —
 * surfacing-only invariant pinned at the type level.
 */
export interface ApplyDreamResultDeps {
  readonly applyAutoLinks: (
    agent: string,
    links: ReadonlyArray<{ from: string; to: string }>,
  ) => Promise<{ added: number }>;
  readonly writeDreamLog: WriteDreamLogFn;
  readonly memoryRoot: string;
  readonly now: () => Date;
  readonly log: DreamApplyLog;
}

/**
 * Apply a dream-pass outcome.
 *
 * Returns a 3-variant DreamApplyOutcome — never throws. Application failures
 * fold into `{kind:'failed', error}`. Wikilinks already persisted are NOT
 * rolled back when the dream-log write subsequently fails (operator-surface
 * reasoning: links are valuable on their own; the operator can investigate
 * the missing log via the structured log line).
 */
export async function applyDreamResult(
  agentName: string,
  outcome: DreamPassOutcome,
  deps: ApplyDreamResultDeps,
): Promise<DreamApplyOutcome> {
  if (outcome.kind !== "completed") {
    deps.log.info(
      `dream-apply: ${agentName} skipped (no completed result; outcome.kind=${outcome.kind})`,
    );
    return { kind: "skipped", reason: "no-completed-result" };
  }

  // Build the entry that flows into the dream log regardless of outcome
  // path (success or failed-application).
  // Phase 99 dream hotfix (2026-04-26): writer expects Date object (calls
  // .toISOString()). deps.now() returns epoch ms (number). Wrap in Date.
  const nowResult = deps.now();
  const timestamp = nowResult instanceof Date ? nowResult : new Date(nowResult);
  const entry = {
    timestamp,
    idleMinutes: 0, // caller (cron tick) supplies actual; primitive doesn't recompute
    model: outcome.model,
    result: outcome.result,
    tokensIn: outcome.tokensIn,
    tokensOut: outcome.tokensOut,
    durationMs: outcome.durationMs,
  };

  let appliedCount = 0;
  let linkErr: unknown = null;
  try {
    const linkArgs = outcome.result.newWikilinks.map((w) => ({
      from: w.from,
      to: w.to,
    }));
    const applyResult = await deps.applyAutoLinks(agentName, linkArgs);
    appliedCount = applyResult.added;
  } catch (err) {
    linkErr = err;
    deps.log.error(
      `dream-apply: ${agentName} applyAutoLinks failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Write the dream log even when applyAutoLinks failed — operator gets a
  // log entry surfacing the failure for diagnosis.
  let logPath: string | null = null;
  let logErr: unknown = null;
  try {
    const logResult = await deps.writeDreamLog({
      agentName,
      memoryRoot: deps.memoryRoot,
      entry,
    });
    logPath = logResult.logPath;
  } catch (err) {
    logErr = err;
    deps.log.error(
      `dream-apply: ${agentName} writeDreamLog failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Failure precedence: applyAutoLinks failure first (more user-facing).
  if (linkErr !== null) {
    return {
      kind: "failed",
      error: linkErr instanceof Error ? linkErr.message : String(linkErr),
    };
  }
  if (logErr !== null) {
    // Wikilinks ARE persisted — no rollback. Operator surfaces the missing
    // log via the structured error message.
    return {
      kind: "failed",
      error: `dream-log-write-failed: ${
        logErr instanceof Error ? logErr.message : String(logErr)
      }`,
    };
  }

  // Both succeeded — applied outcome.
  // Non-null assertion: logErr === null implies logPath was assigned.
  const finalLogPath = logPath as string;
  deps.log.info(
    `dream-apply: ${agentName} applied ${appliedCount} wikilinks; surfaced ${outcome.result.promotionCandidates.length} promotions + ${outcome.result.suggestedConsolidations.length} consolidations; log=${finalLogPath}`,
  );
  return {
    kind: "applied",
    appliedWikilinkCount: appliedCount,
    surfacedPromotionCount: outcome.result.promotionCandidates.length,
    surfacedConsolidationCount: outcome.result.suggestedConsolidations.length,
    logPath: finalLogPath,
  };
}

// ---------------------------------------------------------------------------
// Phase 115 Plan 05 T02 — D-10 hybrid 5-row policy applier.
//
// Extends Phase 95 D-04. The legacy `applyDreamResult` above is preserved
// verbatim (existing tests + production callers keep working). Callers
// that want D-10 semantics (Row 2 auto-apply with veto window, Row 3
// operator-required mutating routing, Row 5 priority-pass override) call
// `applyDreamResultD10` instead.
//
// CRITICAL: D-10 Row 1 (newWikilinks) is unchanged — applied auto-additive
// via deps.applyAutoLinks. The veto store handles Rows 2 + 5; operator-
// required Rows 3 + 4 surface via the Discord summary only.
//
// Per CONTEXT.md D-11: agent-curated archive (clawcode_memory_archive)
// bypasses this entire D-10 review window — that path is operator-trusted
// by definition. This applier ONLY governs the dream-pass-driven flow.
// ---------------------------------------------------------------------------

/**
 * Phase 115 D-10 detection — a promotion candidate is "mutating" if the
 * LLM emitted action="edit" / action="merge" OR targetMode="overwrite".
 * Legacy schema (no action / targetMode) is treated as additive.
 *
 * Row-3 routes mutating → operator-required regardless of priorityScore.
 * Row-5 (priority pass) overrides this routing — mutation allowed.
 *
 * Exported for the test surface (Plan T02 acceptance criterion explicitly
 * greps `isMutating` in the file).
 */
export function isMutating(c: {
  readonly action?: "add" | "edit" | "merge";
  readonly targetMode?: "append" | "overwrite";
}): boolean {
  return (
    c.action === "edit" ||
    c.action === "merge" ||
    c.targetMode === "overwrite"
  );
}

/**
 * Convert a dream-pass promotionCandidate to the VetoStore row shape.
 * Identity mapping today; isolated as a helper so future schema drift
 * stays in one place.
 */
function toVetoPromotion(
  c: DreamResult["promotionCandidates"][number],
  snapshot?: { readonly heading: string | null; readonly body: string } | null,
): VetoStorePromotion {
  return {
    chunkId: c.chunkId,
    currentPath: c.currentPath,
    rationale: c.rationale,
    priorityScore: c.priorityScore,
    action: c.action,
    targetMode: c.targetMode,
    // Phase 999.188 — carry the chunk text so a re-index between schedule
    // and apply cannot lose the promotion.
    ...(snapshot ? { heading: snapshot.heading, body: snapshot.body.slice(0, SNAPSHOT_MAX_CHARS) } : {}),
  };
}

/** Phase 999.188 — cap on the snapshotted chunk body (chunks are ≤1000 tokens anyway). */
export const SNAPSHOT_MAX_CHARS = 6_000;

/**
 * D-10 applier args. The legacy `applyDreamResult(agentName, outcome, deps)`
 * stays — this is a separate sister entry point so existing unit tests
 * pin Phase 95 D-04 semantics unchanged.
 */
export interface ApplyDreamD10Args {
  readonly agentName: string;
  readonly outcome: DreamPassOutcome;
  /** Phase 115 D-05 — true when scheduled by tier-1 truncation trigger. */
  readonly isPriorityPass: boolean;
  readonly memoryRoot: string;
  readonly log: DreamApplyLog;
  /**
   * D-11 Discord summary post-fn. Best-effort — failures DO NOT block
   * auto-apply scheduling. Production wires the agent's Discord channel
   * post; tests pass a vi.fn() spy.
   */
  readonly postDiscordSummary?: (text: string) => Promise<void>;
  /** D-10 Row 2 + Row 5 — veto store handle. */
  readonly vetoStore: VetoStore;
  /**
   * Generate a unique runId for this D-10 dispatch. DI'd so tests can
   * pin the value. Production wraps `nanoid()`.
   */
  readonly nanoid: () => string;
  /** Phase 95 D-04 — wikilink applier (unchanged). */
  readonly applyAutoLinks: (
    agent: string,
    links: ReadonlyArray<{ from: string; to: string }>,
  ) => Promise<{ added: number }>;
  /** D-10 — wall clock for deadline computation. Tests pin to fixed time. */
  readonly now: () => Date;
  /**
   * Phase 999.188 — resolve a chunk by id at schedule time so its text is
   * snapshotted into the veto row. Production wires `store.getMemoryChunk`;
   * omitted → rows carry ids only (pre-999.188 shape).
   */
  readonly resolveChunk?: (
    chunkId: string,
  ) => { readonly heading: string | null; readonly body: string } | null;
  /**
   * Phase 999.188 — the dream log (`<memoryRoot>/dreams/*.md`) that the
   * legacy applier wrote and the dashboard + `/clawcode-status` read from.
   * Best-effort here: a log failure is logged, never fatal — the promotion
   * is the value. Omitted → no dream log (tests).
   */
  readonly writeDreamLog?: WriteDreamLogFn;
  /** Phase 999.188 — operator knob; default D10_AUTO_APPLY_PRIORITY_FLOOR. */
  readonly autoApplyFloor?: number;
  /** Phase 999.188 — operator knob; default D10_VETO_WINDOW_MS. */
  readonly vetoWindowMs?: number;
}

/**
 * D-10 outcome — extended discriminated union. The five-row policy makes
 * the "applied" semantics richer: callers see how many auto-apply rows
 * were scheduled, how many require operator action, and whether the run
 * was a priority-pass override.
 */
export type ApplyDreamD10Outcome =
  | {
      readonly kind: "applied";
      readonly runId: string;
      readonly appliedWikilinkCount: number;
      /** Row 2 + Row 5 — count of candidates scheduled into the veto window. */
      readonly autoApplyScheduled: number;
      /** Row 3 + Row 4 — count of candidates that need operator action. */
      readonly operatorRequiredCount: number;
      readonly isPriorityPass: boolean;
      /** Phase 999.188 — dream log path when `writeDreamLog` was wired and succeeded. */
      readonly logPath?: string;
      readonly surfacedConsolidationCount: number;
    }
  | {
      readonly kind: "skipped";
      readonly reason: "no-completed-result";
    }
  | {
      readonly kind: "failed";
      readonly error: string;
    };

/**
 * Apply a dream-pass outcome under the D-10 5-row policy.
 *
 * Decision tree:
 *   - outcome.kind !== 'completed' → skipped(no-completed-result)
 *   - Row 1: applyAutoLinks(newWikilinks)            (always)
 *   - Row 2: additive ≥80 → schedule with 30-min veto
 *   - Row 3: mutating    → operator-required (UNLESS priority pass)
 *   - Row 4: consolidations → operator-required (always)
 *   - Row 5: priority pass → ALL promotionCandidates eligible (score floor + mutating gate both bypassed)
 *
 * Discord summary fires once per call (any non-zero candidate count).
 * Failures in the Discord post are LOGGED but DO NOT fail the operation
 * — observability is operator-recoverable; auto-apply isn't.
 */
export async function applyDreamResultD10(
  args: ApplyDreamD10Args,
): Promise<ApplyDreamD10Outcome> {
  const {
    agentName,
    outcome,
    isPriorityPass,
    log,
    vetoStore,
    nanoid,
    applyAutoLinks,
    now,
    postDiscordSummary,
    resolveChunk,
    writeDreamLog,
  } = args;
  const autoApplyFloor = args.autoApplyFloor ?? D10_AUTO_APPLY_PRIORITY_FLOOR;
  const vetoWindowMs = args.vetoWindowMs ?? D10_VETO_WINDOW_MS;

  if (outcome.kind !== "completed") {
    log.info(
      `dream-apply-d10: ${agentName} skipped (no completed result; outcome.kind=${outcome.kind})`,
    );
    return { kind: "skipped", reason: "no-completed-result" };
  }

  // ---------------------------------------------------------------------
  // Row 1 — newWikilinks always auto-apply (additive).
  // ---------------------------------------------------------------------
  let appliedWikilinkCount = 0;
  try {
    const linkArgs = outcome.result.newWikilinks.map((w) => ({
      from: w.from,
      to: w.to,
    }));
    const applyResult = await applyAutoLinks(agentName, linkArgs);
    appliedWikilinkCount = applyResult.added;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`dream-apply-d10: ${agentName} applyAutoLinks failed: ${msg}`);
    return { kind: "failed", error: msg };
  }

  // Phase 999.188 — dream log (best-effort). Same entry shape as the legacy
  // applier so `dreams/*.md`, the dashboard and /clawcode-status keep working.
  let logPath: string | undefined;
  if (writeDreamLog) {
    try {
      const ts = now();
      const written = await writeDreamLog({
        agentName,
        memoryRoot: args.memoryRoot,
        entry: {
          timestamp: ts,
          idleMinutes: 0,
          model: outcome.model,
          result: outcome.result,
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          durationMs: outcome.durationMs,
        },
      });
      logPath = written.logPath;
    } catch (err) {
      log.warn(
        `dream-apply-d10: ${agentName} writeDreamLog failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Rows 2 + 3 + 5 — fork promotion candidates.
  //
  //   Row 5 (priority pass): all candidates eligible (override floor + mutating gate)
  //   Row 2 (additive ≥80):  eligible
  //   Row 3 (mutating):      operator-required (unless Row 5)
  // ---------------------------------------------------------------------
  const candidates = outcome.result.promotionCandidates ?? [];
  const eligible: typeof candidates = [];
  const operatorOnly: typeof candidates = [];

  for (const c of candidates) {
    if (isPriorityPass) {
      // Row 5 — all candidates allowed regardless of additive/mutating
      // distinction OR priorityScore floor.
      eligible.push(c);
      continue;
    }
    // Row 3 — mutating routes to operator-required.
    if (isMutating(c)) {
      operatorOnly.push(c);
      continue;
    }
    // Row 2 — additive auto-apply when score >= the floor (default 80).
    if (c.priorityScore >= autoApplyFloor) {
      eligible.push(c);
    } else {
      // Below floor — surface only.
      operatorOnly.push(c);
    }
  }

  const consolidations = outcome.result.suggestedConsolidations ?? [];
  const runId = nanoid();

  // Schedule the auto-apply request (Rows 2 + 5).
  if (eligible.length > 0) {
    const req: ScheduledApply = {
      runId,
      agentName,
      candidates: eligible.map((c) => {
        let snapshot: { heading: string | null; body: string } | null = null;
        if (resolveChunk) {
          try {
            snapshot = resolveChunk(c.chunkId);
          } catch {
            snapshot = null;
          }
        }
        return toVetoPromotion(c, snapshot);
      }),
      deadline: now().getTime() + vetoWindowMs,
      isPriorityPass,
    };
    try {
      await vetoStore.scheduleAutoApply(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        `dream-apply-d10: ${agentName} scheduleAutoApply failed: ${msg}`,
      );
      return { kind: "failed", error: msg };
    }
  }

  // ---------------------------------------------------------------------
  // D-11 — post the structured Discord summary (best-effort).
  // ---------------------------------------------------------------------
  if (
    postDiscordSummary &&
    (eligible.length > 0 || operatorOnly.length > 0 || consolidations.length > 0)
  ) {
    try {
      const summaryInput: PromotionSummaryInput = {
        runId,
        agentName,
        autoApplyCandidates: eligible.map(toSummaryRow),
        operatorRequiredCandidates: operatorOnly.map(toSummaryRow),
        consolidations: consolidations.map((c) => ({
          sources: c.sources,
          newPath: c.newPath,
        })),
        isPriorityPass,
      };
      // Late import to avoid cycles in pure-DI tests that stub out the
      // Discord post entirely.
      const mod = await import("./dream-discord-summary.js");
      const text = mod.buildPromotionSummary(summaryInput);
      await postDiscordSummary(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `dream-apply-d10: ${agentName} Discord summary post failed (non-fatal): ${msg}`,
      );
    }
  }

  log.info(
    `dream-apply-d10: ${agentName} applied=${appliedWikilinkCount} wikilinks; ` +
      `auto-apply scheduled=${eligible.length}; operator-required=${operatorOnly.length + consolidations.length}; ` +
      `runId=${runId}; isPriorityPass=${isPriorityPass}`,
  );

  return {
    kind: "applied",
    runId,
    appliedWikilinkCount,
    autoApplyScheduled: eligible.length,
    operatorRequiredCount: operatorOnly.length + consolidations.length,
    isPriorityPass,
    ...(logPath !== undefined ? { logPath } : {}),
    surfacedConsolidationCount: consolidations.length,
  };
}

/**
 * Lift a dream-pass promotionCandidate into the Discord summary row shape
 * (only the fields the summary builder cares about).
 */
function toSummaryRow(
  c: DreamResult["promotionCandidates"][number],
): PromotionForSummary {
  return {
    chunkId: c.chunkId,
    currentPath: c.currentPath,
    priorityScore: c.priorityScore,
    action: c.action,
    targetMode: c.targetMode,
  };
}
