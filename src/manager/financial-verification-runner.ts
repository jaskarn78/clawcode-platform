/**
 * 2026-07-31 — financial-verification gate runner (side-effecting half).
 *
 * Extracted from `TurnDispatcher.runVerificationGate`
 * (turn-dispatcher.ts, Phase 999.63 Plan 03) and reworked for the fin-client
 * incident: the corrective re-prompt used to occupy the per-agent
 * SerialTurnQueue *after* the user already had their answer, dispatched
 * with `signal: undefined` so an incoming user message could not abort it
 * — the direct upstream of the phantom-typing → "interrupt deadline
 * exceeded" → wedge cascades.
 *
 * The rework adds two mechanisms (operator decision: "decouple + adaptive
 * budget"):
 *
 *   1. YIELD — the hop defers `deferMs` before dispatching and skips when
 *      user traffic arrived; once dispatched it carries an AbortSignal
 *      that `notifyIncomingTurn` (called at TurnDispatcher.dispatch /
 *      dispatchStream entry — the single chokepoint for turn initiation)
 *      fires, so an incoming message frees the queue within
 *      ~INTERRUPT_DEADLINE_MS instead of waiting out a 30-120 s hop.
 *      The corrective hop itself goes through sessionManager.dispatchTurn
 *      directly (NOT TurnDispatcher), so it can never self-abort.
 *
 *   2. ADAPTIVE BUDGET — `decideVerifyBudget` skips the hop when the
 *      parent turn was already heavy (`skipIfTurnMsOver`) and shrinks it
 *      to `low` effort when moderately heavy (`shrinkIfTurnMsOver`).
 *      Knobs resolve per-agent via `verification.*` config;
 *      absent config falls back to VERIFICATION_BUDGET_DEFAULTS.
 *
 * Telemetry contract: the `phase999.63-verify` line keeps its legacy
 * fields byte-identical (tag / agent / financialTokensDetected /
 * verificationToolsCalled / action). New fields are ADDITIVE:
 * `turnCostMs`, `toolExecutionMs`, `effortTier`, `skippedReason`. Ops
 * note: lines with `skippedReason != null` describe hops that were NOT
 * dispatched — filter them out when counting actually-dispatched hops.
 *
 * Fail-open discipline is inherited verbatim: the entire run() body is
 * try/catch-wrapped; any throw emits an `action: "error"` line and
 * returns. The user's turn is never blocked — run() is void-invoked from
 * the dispatch epilogues.
 */

import {
  extractCitations,
  reconcileCitations,
  type EvidenceEntry,
} from "./evidence-ledger.js";
import type { ClaimEntry } from "./claim-ledger.js";
import type { Logger } from "pino";
import type { EffortLevel } from "../config/schema.js";
import {
  VERIFICATION_BUDGET_DEFAULTS,
  NO_CORRECTION_NEEDED,
  evaluateVerification,
  selectCorrective,
} from "./financial-verification-gate.js";
import { isVerificationEnforced } from "./financial-verification-policy.js";
import { decideVerifyBudget } from "./financial-verification-budget.js";
import {
  applyPatchOps,
  parsePatchOps,
  renderCorrectionNote,
} from "./financial-correction-patch.js";
import { icons } from "../discord/icons.js";
import { rewriteIconShortcodes } from "../discord/icon-shortcodes.js";

/** Resolved `verification` config block (loader cascade output). */
export interface ResolvedVerificationConfig {
  readonly enforced?: boolean;
  readonly maxVerifyHops?: number;
  readonly skipIfTurnMsOver?: number;
  readonly shrinkIfTurnMsOver?: number;
  readonly deferMs?: number;
  /**
   * 999.63b — rule-claim class knobs. Rides the existing resolveConfig
   * closure (daemon passes the whole resolved block through), so this
   * stays hot-reload-correct with zero daemon wiring changes.
   */
  readonly ruleClaims?: {
    readonly enabled?: boolean;
    readonly maxVerifyHops?: number;
  };
  /** C — pre-delivery hold mode (off-by-default). */
  readonly holdDelivery?: boolean;
  readonly holdTimeoutMs?: number;
  /** 999.63d/6 — which vocabulary decides a turn is worth narrating. */
  readonly topic?: {
    readonly profile?: "finance" | "legal" | "none";
    readonly extraTerms?: readonly string[];
  };
  /** 999.63d — verified-streaming UX knobs (all off-by-default). */
  readonly ux?: {
    readonly streamStatus?: boolean;
    /** 999.63d/5 — WHEN the trail arms. Default "auto". */
    readonly streamStatusMode?: "always" | "topic" | "auto";
    /** 2026-08-27 — short pre-answer fragments become trail lines. */
    readonly narrationAsTrail?: boolean;
    readonly sourcesFooter?: "off" | "claims" | "always";
    readonly verdictReactions?: boolean;
    readonly modelSourcesLine?: "keep" | "strip" | "flag";
    readonly ledgerButton?: boolean;
    readonly ledgerReaction?: string;
    readonly liveClaims?: boolean;
    readonly statusMessage?: "inline" | "separate";
    readonly unverifiedNotice?: boolean;
    readonly compactBelowChars?: number;
    readonly sourcesCharBudget?: number;
    readonly pendingMarker?: boolean;
    readonly verifiedBadge?: boolean;
  };
}

/** C — outcome of a pre-delivery verification hold. */
export interface PreDeliveryVerifyResult {
  /** The text the bridge should deliver (patched when `corrected`). */
  readonly finalText: string;
  /**
   *   clean     — not flagged, or the hop confirmed nothing needs fixing.
   *   corrected — a correction was produced (either patched into
   *               `finalText`, or riding `followUpPost` when patching
   *               failed and the original must deliver as-is).
   *   timeout   — the hop exceeded holdTimeoutMs; original delivered;
   *               the post-hoc backstop was re-armed.
   *   error     — internal failure; original delivered; backstop re-armed.
   */
  readonly verdict: "clean" | "corrected" | "timeout" | "error";
  /**
   * Compact correction note the bridge must post AFTER delivering
   * `finalText` — only set when a correction exists but could not be
   * patched into the delivered text (note/raw fallback in hold mode).
   */
  readonly followUpPost?: string;
}

/** C — pre-delivery marks older than this are prune-on-touch. */
export const PRE_DELIVERY_MARK_MAX_AGE_MS = 10 * 60 * 1000;

/** DI surface — all closures, mirroring the TurnDispatcher options style. */
export interface VerificationRunnerDeps {
  /**
   * Dispatch the corrective turn on the agent's session queue. Wired to
   * `sessionManager.dispatchTurn(agent, prompt, undefined, { signal })` —
   * NOT TurnDispatcher.dispatch, so no Turn is re-opened, origin is not
   * re-threaded, and the runner's own notifyIncomingTurn hook (which
   * lives at TurnDispatcher entry) can never abort its own hop.
   */
  readonly dispatchCorrective: (
    agentName: string,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<string>;
  /** Per-agent tool-call-name snapshot (TraceCollector-backed). */
  readonly recentToolCallNames?: (agentName: string) => readonly string[];
  /** 2026-08-27 — bounded tool_result text for the active turn (provenance). */
  readonly recentToolResultText?: (agentName: string) => string;
  /** 2026-08-27 — evidence ledger for the active turn (sources consulted). */
  readonly recentEvidence?: (agentName: string) => readonly EvidenceEntry[];
  /** 2026-08-27 — claim ledger for the active turn (verify_claim records). */
  readonly recentClaims?: (agentName: string) => readonly ClaimEntry[];
  /** 2026-08-27 — hosts the model named in its own (stripped) Sources line. */
  readonly recentModelCitedHosts?: (agentName: string) => readonly string[];
  /**
   * Live resolved `verification` block for the agent (hot-reload
   * correct — read from SessionManager.getAgentConfig, NOT a boot-time
   * array; see the daemon wiring).
   */
  readonly resolveConfig?: (
    agentName: string,
  ) => ResolvedVerificationConfig | undefined;
  /** True when the agent has a turn in flight (defer-window check). */
  readonly hasActiveTurn?: (agentName: string) => boolean;
  /** Effort snapshot/set for shrink mode (SessionManager-backed). */
  readonly getEffort?: (agentName: string) => EffortLevel;
  readonly setEffort?: (agentName: string, level: EffortLevel) => void;
  /** Labelled-correction delivery (bridge.postFinancialCorrection). */
  readonly postCorrectiveMessage?: (args: {
    agentName: string;
    channelId: string | null;
    text: string;
  }) => Promise<void>;
  /**
   * 999.63c — preferred correction delivery
   * (bridge.applyFinancialCorrection): edit the original message in place
   * when provably safe, else internally fall back to the labelled post.
   * Returns which path fired for the `correctionDelivery` telemetry
   * rider. When unwired, the runner uses `postCorrectiveMessage` alone
   * (byte-identical legacy behaviour, rider = "post-unwired").
   */
  readonly applyCorrectiveEdit?: (args: {
    agentName: string;
    channelId: string | null;
    turnId: string | null;
    originalResponse: string;
    correctedText: string;
    fallbackText: string;
    footer: string;
  }) => Promise<"edit" | "chunk-edit" | "post">;
  /**
   * 999.63d — verify-behind pending marker
   * (bridge.appendFinancialPendingMarker / removeFinancialPendingMarker).
   * Append returns the message coordinates for the later removal, null
   * when no safe append was possible (chunked delivery, drift, oversize).
   */
  readonly appendPendingMarker?: (args: {
    agentName: string;
    turnId: string | null;
  }) => Promise<{ messageId: string; channelId: string } | null>;
  readonly removePendingMarker?: (args: {
    agentName: string;
    messageId: string;
    channelId: string;
    verified: boolean;
  }) => Promise<void>;
  /**
   * 999.63d — ✅ verified-inline badge (bridge.applyVerifiedBadge).
   * Fired (post-deferMs, fire-and-forget) on unflagged turns with
   * positive verification evidence.
   */
  readonly applyVerifiedBadge?: (args: {
    agentName: string;
    turnId: string | null;
  }) => Promise<void>;
  readonly log: Logger;
  /** Injectable for tests; defaults to setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Per-turn snapshot captured synchronously at the dispatch epilogue. */
export interface VerificationRunArgs {
  readonly agentName: string;
  readonly channelId: string | null;
  readonly response: string;
  readonly verifyHopCount: number;
  /**
   * 999.63c — Turn id (`discord:<trigger-snowflake>`) for delivered-ref
   * lookup on the edit-in-place path. Null when no Turn (CLI runner,
   * corrective hops, tests) — null simply means the edit path can never
   * match and every correction falls back to the post.
   */
  readonly turnId?: string | null;
  /** Wall-time of the parent turn (Turn.getElapsedMs), null when no Turn. */
  readonly turnCostMs: number | null;
  /** Telemetry rider (Turn.getToolExecutionMsSoFar), null when no Turn. */
  readonly toolExecutionMs: number | null;
  /** Telemetry rider (session effort at epilogue), null when unreadable. */
  readonly effortTier: string | null;
  /**
   * 2026-08-27 — size of the inbound user message, so verbosity on short
   * asks is measurable from the log (the 08-27 research had to parse
   * transcripts by hand). Draft size is taken from `response` directly.
   */
  readonly promptChars?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class VerificationRunner {
  private readonly deps: VerificationRunnerDeps;
  /**
   * Per-agent yield state. `epoch` bumps on every incoming turn for the
   * agent; a hop captured under an older epoch skips (defer window) or
   * aborts (in-flight). The controller is only set while a hop is
   * actually dispatched.
   */
  private readonly yieldState = new Map<
    string,
    { epoch: number; controller: AbortController | null }
  >();

  constructor(deps: VerificationRunnerDeps) {
    this.deps = deps;
  }

  /**
   * Called at TurnDispatcher.dispatch / dispatchStream ENTRY for every
   * agent turn. Bumps the agent's epoch and aborts any in-flight
   * corrective hop so real traffic reclaims the SerialTurnQueue slot
   * within ~INTERRUPT_DEADLINE_MS. Observational — never throws.
   */
  notifyIncomingTurn(agentName: string): void {
    try {
      const state = this.yieldState.get(agentName);
      if (!state) {
        this.yieldState.set(agentName, { epoch: 1, controller: null });
        return;
      }
      this.yieldState.set(agentName, {
        epoch: state.epoch + 1,
        controller: null,
      });
      state.controller?.abort();
    } catch {
      // Observational only.
    }
  }

  private currentEpoch(agentName: string): number {
    return this.yieldState.get(agentName)?.epoch ?? 0;
  }

  /**
   * C — turn ids currently owned by a pre-delivery hold. Written
   * synchronously at preDeliveryVerify entry (before its first await) so
   * the epilogue-fired post-hoc run(), which wakes after its deferMs
   * (default 2 s), sees the mark and skips — preventing a duplicate hop.
   * Known caveat: an agent configured with BOTH holdDelivery:true and
   * deferMs:0 narrows the marking window to the synchronous gap and could
   * double-hop; the defaults make this a non-issue.
   */
  private readonly preDeliveryMarks = new Map<string, number>();

  private markPreDelivery(turnId: string): void {
    const now = Date.now();
    for (const [key, at] of this.preDeliveryMarks) {
      if (now - at > PRE_DELIVERY_MARK_MAX_AGE_MS) this.preDeliveryMarks.delete(key);
    }
    this.preDeliveryMarks.set(turnId, now);
  }

  private unmarkPreDelivery(turnId: string): void {
    this.preDeliveryMarks.delete(turnId);
  }

  /** Single-shot check: true when marked (and consumes the mark). */
  private consumePreDeliveryMark(turnId: string): boolean {
    const at = this.preDeliveryMarks.get(turnId);
    if (at === undefined) return false;
    this.preDeliveryMarks.delete(turnId);
    return Date.now() - at <= PRE_DELIVERY_MARK_MAX_AGE_MS;
  }

  /**
   * Run the gate for one completed turn. Void-invoked (fire-and-forget)
   * from the four dispatch epilogues. Entire body fail-open.
   */
  async run(args: VerificationRunArgs): Promise<void> {
    const {
      agentName,
      channelId,
      response,
      verifyHopCount,
      turnCostMs,
      toolExecutionMs,
      effortTier,
    } = args;
    const turnId = args.turnId ?? null;
    // 999.63d — pending-marker coordinates, declared OUTSIDE the try so
    // the outer catch can strip an orphaned marker on any throw.
    let markerRef: { messageId: string; channelId: string } | null = null;
    try {
      // Per-agent scoping short-circuit (CONTEXT.md D6) — a non-enforced
      // agent incurs ZERO gate cost: no classifier, no telemetry line.
      const cfg = this.deps.resolveConfig?.(agentName);
      if (!isVerificationEnforced(agentName, cfg?.enforced)) {
        return;
      }

      const budgetKnobs = {
        maxVerifyHops:
          cfg?.maxVerifyHops ??
          VERIFICATION_BUDGET_DEFAULTS.maxVerifyHops,
        skipIfTurnMsOver:
          cfg?.skipIfTurnMsOver ??
          VERIFICATION_BUDGET_DEFAULTS.skipIfTurnMsOver,
        shrinkIfTurnMsOver:
          cfg?.shrinkIfTurnMsOver ??
          VERIFICATION_BUDGET_DEFAULTS.shrinkIfTurnMsOver,
        deferMs:
          cfg?.deferMs ?? VERIFICATION_BUDGET_DEFAULTS.deferMs,
        // 999.63b — rules-class knobs, same `cfg ?? DEFAULTS` cascade.
        ruleClaimsEnabled:
          cfg?.ruleClaims?.enabled ??
          VERIFICATION_BUDGET_DEFAULTS.ruleClaims.enabled,
        ruleClaimsMaxVerifyHops:
          cfg?.ruleClaims?.maxVerifyHops ??
          VERIFICATION_BUDGET_DEFAULTS.ruleClaims.maxVerifyHops,
      };
      const ruleClaims = {
        enabled: budgetKnobs.ruleClaimsEnabled,
        maxVerifyHops: budgetKnobs.ruleClaimsMaxVerifyHops,
      };

      const toolCallNames = this.deps.recentToolCallNames?.(agentName) ?? [];
      // 2026-08-27 — figures-class provenance (bounded; "" when unavailable).
      const toolResultText = this.deps.recentToolResultText?.(agentName) ?? "";
      // 2026-08-27 — evidence ledger snapshot + citation reconciliation
      // (telemetry-only in PR-1; the gate consumes it in PR-4).
      const evidence = this.deps.recentEvidence?.(agentName) ?? [];
      const extracted = extractCitations(response);
      const modelCited = this.deps.recentModelCitedHosts?.(agentName) ?? [];
      const citations = reconcileCitations(
        { urls: extracted.urls, hosts: [...new Set([...extracted.hosts, ...modelCited])] },
        evidence,
      );
      const evidenceKinds = {
        read: evidence.filter((e) => e.kind === "read").length,
        found: evidence.filter((e) => e.kind === "found").length,
        queried: evidence.filter((e) => e.kind === "queried").length,
        document: evidence.filter((e) => e.kind === "document").length,
      };
      const citedSources = [...new Set(evidence.map((e) => e.host).filter((h): h is string => typeof h === "string"))].slice(0, 5);
      const claims = this.deps.recentClaims?.(agentName) ?? [];
      const claimSummary = {
        n: claims.length,
        verified: claims.filter((c) => c.effectiveVerdict === "verified").length,
        corrected: claims.filter((c) => c.effectiveVerdict === "corrected").length,
        unverified: claims.filter((c) => c.effectiveVerdict === "unverified").length,
        notConsulted: claims.filter((c) => c.sourceStatus === "not-consulted").length,
        dismissed: claims.filter((c) => c.effectiveVerdict === "not-a-claim").length,
        client: claims.filter((c) => c.audience === "client").length,
      };
      const result = evaluateVerification({
        response,
        toolCallNames,
        toolResultText,
        verifyHopCount,
        maxVerifyHops: budgetKnobs.maxVerifyHops,
        ruleClaims,
      });

      // 999.63b — the budget's hops-disabled check must see the EFFECTIVE
      // hop ceiling across classes: with figures at 0 (shadow) but rules
      // enforced (or vice versa), the hop must still be dispatchable.
      const effectiveMaxHops = Math.max(
        budgetKnobs.maxVerifyHops,
        ruleClaims.enabled ? ruleClaims.maxVerifyHops : 0,
      );
      const budget = decideVerifyBudget({
        turnCostMs,
        maxVerifyHops: effectiveMaxHops,
        skipIfTurnMsOver: budgetKnobs.skipIfTurnMsOver,
        shrinkIfTurnMsOver: budgetKnobs.shrinkIfTurnMsOver,
      });
      const syncSkipReason =
        (result.action === "re-prompt" || result.ruleAction === "re-prompt") &&
        budget.mode === "skip"
          ? budget.skippedReason
          : undefined;

      // 999.63d — ✅ verified-inline badge eligibility: nothing flagged
      // for ANY class AND positive verification evidence (rule claims all
      // carrying inline primary-source citations, or figure claims with a
      // verification tool fired this turn). Decided here so the main
      // telemetry line carries the rider; the reaction itself fires
      // post-deferMs (the delivered-message ref does not exist yet at
      // gate-fire time) and is fully fire-and-forget.
      const badgeEligible =
        cfg?.ux?.verifiedBadge === true &&
        this.deps.applyVerifiedBadge !== undefined &&
        turnId !== null &&
        !result.flagged &&
        result.action === "none" &&
        result.ruleAction === "none" &&
        (result.citedRuleClaimsDetected ||
          (result.financialTokensDetected.length > 0 &&
            result.verificationToolsCalled.length > 0));

      // Telemetry — legacy fields byte-identical; new fields additive.
      // Never log the draft body (Information Disclosure T-999.63-03-04).
      this.emitVerifyLine({
        agentName,
        financialTokensDetected: result.financialTokensDetected,
        verificationToolsCalled: result.verificationToolsCalled,
        action: result.action,
        turnCostMs,
        toolExecutionMs,
        effortTier,
        ruleTokensDetected: result.ruleTokensDetected,
        ruleAction: result.ruleAction,
        claimClasses: result.claimClasses,
        citedRuleClaims: result.citedRuleClaimsDetected,
        skippedReason: syncSkipReason,
        promptChars: args.promptChars,
        draftChars: response.length,
        figureProvenance: result.figureProvenance,
        evidenceCount: evidence.length,
        evidenceKinds,
        citedSources,
        unmatchedHosts: citations.unmatchedHosts,
        claimSummary,
        ...(badgeEligible ? { verifiedBadge: true } : {}),
      });

      if (badgeEligible) {
        const badgeSleep = this.deps.sleep ?? defaultSleep;
        void (async () => {
          try {
            await badgeSleep(budgetKnobs.deferMs);
            await this.deps.applyVerifiedBadge?.({ agentName, turnId });
          } catch {
            // Cosmetic — never escalate.
          }
        })();
      }

      // 999.63b — `flagged` ORs the two classes; either class at
      // re-prompt dispatches the (single, merged when combined) hop.
      if (!result.flagged || budget.mode === "skip") {
        return;
      }

      // YIELD step 1 — idle-defer. Capture the epoch, wait deferMs, and
      // skip when traffic arrived (epoch bumped) or a turn is already in
      // flight. This protects the common rapid-fire-follow-up case
      // without ever taking the queue slot.
      const epochAtDecision = this.currentEpoch(agentName);
      const sleep = this.deps.sleep ?? defaultSleep;
      if (budgetKnobs.deferMs > 0) {
        await sleep(budgetKnobs.deferMs);
      }
      if (
        this.currentEpoch(agentName) !== epochAtDecision ||
        (this.deps.hasActiveTurn?.(agentName) ?? false)
      ) {
        this.emitVerifyLine({
          agentName,
          financialTokensDetected: result.financialTokensDetected,
          verificationToolsCalled: result.verificationToolsCalled,
          action: result.action,
          turnCostMs,
          toolExecutionMs,
          effortTier,
          ruleTokensDetected: result.ruleTokensDetected,
          ruleAction: result.ruleAction,
          claimClasses: result.claimClasses,
          skippedReason: "user-traffic",
        });
        return;
      }

      // C — pre-delivery dedupe. When the bridge's hold path took this
      // turn (mark set at preDeliveryVerify entry), the post-hoc hop must
      // not double-fire. Timeout/error verdicts UNMARK before re-arming
      // the backstop, so a fresh backstop run() passes this check.
      if (turnId !== null && this.consumePreDeliveryMark(turnId)) {
        this.emitVerifyLine({
          agentName,
          financialTokensDetected: result.financialTokensDetected,
          verificationToolsCalled: result.verificationToolsCalled,
          action: result.action,
          turnCostMs,
          toolExecutionMs,
          effortTier,
          ruleTokensDetected: result.ruleTokensDetected,
          ruleAction: result.ruleAction,
          claimClasses: result.claimClasses,
          skippedReason: "pre-delivery-handled",
        });
        return;
      }

      // 999.63d — verify-behind pending marker: label the delivered
      // message ("-# Verifying…") while the hop runs behind it. The
      // append is provably-safe-or-skip (pure ladder); null means no
      // marker (chunked delivery, content drift, oversize) and the hop
      // proceeds unlabelled. Placed AFTER every skip path so a skipped
      // hop never markers, and BEFORE dispatch so the label is up while
      // the model works.
      const markerEnabled =
        cfg?.ux?.pendingMarker === true &&
        this.deps.appendPendingMarker !== undefined &&
        this.deps.removePendingMarker !== undefined;
      let markerOutcome:
        | "edit"
        | "restored"
        | "verified-clean"
        | "skipped-no-ref"
        | undefined;
      if (markerEnabled && turnId !== null) {
        markerRef =
          (await this.deps.appendPendingMarker?.({ agentName, turnId })) ??
          null;
        if (markerRef === null) markerOutcome = "skipped-no-ref";
      }

      // YIELD step 2 — abortable dispatch. Register the controller so
      // notifyIncomingTurn can abort; SHRINK mode drops effort to `low`
      // for the hop via the existing snapshot/set/restore pattern
      // (applySkillEffort precedent), restored in `finally`.
      const controller = new AbortController();
      const state = this.yieldState.get(agentName);
      this.yieldState.set(agentName, {
        epoch: state?.epoch ?? epochAtDecision,
        controller,
      });

      // B (2026-08-26 token optimization) — corrective hops ALWAYS run at
      // `low` effort, not only in shrink mode: under the patch contract the
      // hop is a lookup-then-diff task (search the primary source, emit
      // find/replace ops), which needs tool access, not deep reasoning.
      // Snapshot/set/restore is the applySkillEffort precedent; restore in
      // `finally` below.
      let priorEffort: EffortLevel | null = null;
      if (this.deps.getEffort && this.deps.setEffort) {
        try {
          const current = this.deps.getEffort(agentName);
          if (current !== "low" && current !== "off") {
            this.deps.setEffort(agentName, "low");
            priorEffort = current;
          }
        } catch {
          // Best-effort — hop proceeds at current effort.
          priorEffort = null;
        }
      }

      // 999.63b — class-appropriate prompt + prefix (merged when both
      // classes flagged; ONE hop, one correction message).
      const corrective999 = selectCorrective({
        figures: result.action === "re-prompt",
        rules: result.ruleAction === "re-prompt",
      });

      let corrective: string;
      try {
        corrective = await this.deps.dispatchCorrective(
          agentName,
          corrective999.prompt,
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) {
          // A real user message reclaimed the queue — fail open quietly.
          // 999.63d — the marker must never keep saying "verifying" after
          // the hop was abandoned: strip it (fire-and-forget).
          if (markerRef) {
            const mr = markerRef;
            markerRef = null;
            void this.deps.removePendingMarker?.({
              agentName,
              ...mr,
              verified: false,
            });
          }
          this.emitVerifyLine({
            agentName,
            financialTokensDetected: result.financialTokensDetected,
            verificationToolsCalled: result.verificationToolsCalled,
            action: result.action,
            turnCostMs,
            toolExecutionMs,
            effortTier,
            ruleTokensDetected: result.ruleTokensDetected,
            ruleAction: result.ruleAction,
            claimClasses: result.claimClasses,
            skippedReason: "user-traffic-abort",
            ...(markerEnabled ? { markerOutcome: "aborted" as const } : {}),
          });
          return;
        }
        throw err;
      } finally {
        if (priorEffort !== null) {
          try {
            this.deps.setEffort?.(agentName, priorEffort);
          } catch {
            // Restore is best-effort; a failure is logged by the outer catch
            // only if the dispatch itself also failed.
          }
        }
        const post = this.yieldState.get(agentName);
        if (post?.controller === controller) {
          this.yieldState.set(agentName, {
            epoch: post.epoch,
            controller: null,
          });
        }
      }

      // False-positive escape hatch (quick 260521-55j) — sentinel reply
      // suppresses the correction post; one telemetry line with
      // falsePositiveAck: true.
      if (corrective.trim() === NO_CORRECTION_NEEDED) {
        // 999.63d — the hop CONFIRMED the claims: strip the marker and
        // convert the episode into a visible "checked ✓" (✅ reaction).
        if (markerRef) {
          const mr = markerRef;
          markerRef = null;
          markerOutcome = "verified-clean";
          void this.deps.removePendingMarker?.({
            agentName,
            ...mr,
            verified: true,
          });
        }
        const ackResult = evaluateVerification({
          response: corrective,
          toolCallNames: this.deps.recentToolCallNames?.(agentName) ?? [],
          verifyHopCount: 1,
          maxVerifyHops: budgetKnobs.maxVerifyHops,
          ruleClaims,
        });
        this.emitVerifyLine({
          agentName,
          financialTokensDetected: ackResult.financialTokensDetected,
          verificationToolsCalled: ackResult.verificationToolsCalled,
          action: ackResult.action,
          turnCostMs,
          toolExecutionMs,
          effortTier,
          ruleTokensDetected: ackResult.ruleTokensDetected,
          ruleAction: ackResult.ruleAction,
          claimClasses: ackResult.claimClasses,
          falsePositiveAck: true,
          ...(markerOutcome !== undefined ? { markerOutcome } : {}),
        });
        return;
      }

      // B (2026-08-26) — parse the hop reply as patch ops and apply them
      // locally. Three modes:
      //   patch         — ops parsed AND applied: the patched full text
      //                   feeds the edit-in-place path (footer appended by
      //                   the bridge ladder); the fallback post carries the
      //                   COMPACT note, not the full text.
      //   note-fallback — ops parsed but an op's `find` missed (draft
      //                   drifted / model paraphrased): post the compact
      //                   note; never edit (no trustworthy full text).
      //   raw-fallback  — reply is not a patch (contract ignored): legacy
      //                   behavior, post prefix + raw reply (chunked by the
      //                   bridge). Never edit — non-conforming prose must
      //                   not replace a delivered message.
      const patchOps = parsePatchOps(corrective);
      const patchedText =
        patchOps !== null ? applyPatchOps(response, patchOps) : null;
      const correctionMode: "patch" | "note-fallback" | "raw-fallback" =
        patchOps === null
          ? "raw-fallback"
          : patchedText === null
            ? "note-fallback"
            : "patch";

      // D4 — evaluate the corrective outcome once at hop 1 (bounded: with
      // maxVerifyHops <= 2 this re-prompts at most once more via config
      // opt-in; at the default 1 it can only yield hop-exhausted / none).
      // 999.63b: the same hop-1 evaluation bounds the rules class — a
      // corrective reply that itself contains rule claims lands
      // `ruleAction: "hop-exhausted"` and can never loop. Under the patch
      // contract the reader-visible text is the PATCHED draft, so that is
      // what hop 1 evaluates when a patch applied.
      const correctiveResult = evaluateVerification({
        response: patchedText ?? corrective,
        toolCallNames: this.deps.recentToolCallNames?.(agentName) ?? [],
        verifyHopCount: 1,
        maxVerifyHops: budgetKnobs.maxVerifyHops,
        ruleClaims,
      });

      // D5 (updated 999.63c + B) — deliver the correction. The edit path
      // runs ONLY in patch mode (a provably applied patch of the original
      // draft); both fallback modes post. Delivery runs BEFORE the hop-1
      // telemetry line so the line can carry which path fired.
      // 999.178 R1 — lead the correction with the `cc_search` icon (plain
      // text when the set is not loaded, never a Unicode glyph). The
      // corrective body is agent-authored; resolve any `:cc_name:` shortcode
      // it wrote so the post-hoc `postCorrectiveMessage` path never ships a
      // raw shortcode (the `applyCorrectiveEdit` path rewrites again, no-op).
      const notePrefix = icons.prefix("search", corrective999.prefix);
      const noteText = rewriteIconShortcodes(
        patchOps !== null
          ? renderCorrectionNote(patchOps, notePrefix)
          : `${notePrefix}${corrective}`,
        icons,
      );
      let correctionDelivery:
        | "edit"
        | "chunk-edit"
        | "post-fallback"
        | "post-unwired"
        | undefined;
      try {
        if (correctionMode === "patch" && this.deps.applyCorrectiveEdit) {
          const path = await this.deps.applyCorrectiveEdit({
            agentName,
            channelId,
            turnId,
            originalResponse: response,
            correctedText: patchedText as string,
            fallbackText: noteText,
            footer: corrective999.footer,
          });
          correctionDelivery =
            path === "edit"
              ? "edit"
              : path === "chunk-edit"
                ? "chunk-edit"
                : "post-fallback";
        } else if (this.deps.postCorrectiveMessage) {
          await this.deps.postCorrectiveMessage({
            agentName,
            channelId,
            text: noteText,
          });
          correctionDelivery = this.deps.applyCorrectiveEdit
            ? "post-fallback"
            : "post-unwired";
        } else {
          this.deps.log.warn(
            { agent: agentName },
            "phase999.63-verify: corrective re-prompt issued but postCorrectiveMessage is unwired — correction not posted",
          );
        }
      } catch (deliveryErr) {
        // Delivery closures are fail-open by contract; belt-and-braces so
        // a throwing closure can never suppress the telemetry line.
        this.deps.log.warn(
          {
            agent: agentName,
            error: (deliveryErr as Error).message,
          },
          "phase999.63-verify: correction delivery threw (non-fatal)",
        );
      }

      // 999.63d — settle the marker per delivery outcome:
      //   edit          — the in-place content replacement removed the
      //                   marker wholesale; nothing to strip.
      //   anything else — the original (marker included) is still
      //                   standing; strip it so "verifying…" never lies
      //                   next to a posted correction note.
      if (markerRef) {
        const mr = markerRef;
        markerRef = null;
        if (correctionDelivery === "edit") {
          markerOutcome = "edit";
        } else {
          markerOutcome = "restored";
          void this.deps.removePendingMarker?.({
            agentName,
            ...mr,
            verified: false,
          });
        }
      }

      this.emitVerifyLine({
        agentName,
        financialTokensDetected: correctiveResult.financialTokensDetected,
        verificationToolsCalled: correctiveResult.verificationToolsCalled,
        action: correctiveResult.action,
        turnCostMs,
        toolExecutionMs,
        effortTier,
        ruleTokensDetected: correctiveResult.ruleTokensDetected,
        ruleAction: correctiveResult.ruleAction,
        claimClasses: correctiveResult.claimClasses,
        correctionDelivery,
        correctionMode,
        patchOps: patchOps?.length,
        ...(markerOutcome !== undefined ? { markerOutcome } : {}),
      });
    } catch (err) {
      // 999.63d — never leave an orphaned "verifying…" marker behind a
      // crashed hop. Best-effort, its own guard.
      if (markerRef) {
        try {
          const mr = markerRef;
          markerRef = null;
          void this.deps.removePendingMarker?.({
            agentName,
            ...mr,
            verified: false,
          });
        } catch {
          // Absolute fail-open.
        }
      }
      // Fail-open — any throw is trapped; emit an error line and return.
      try {
        this.deps.log.warn(
          {
            tag: "phase999.63-verify",
            agent: agentName,
            financialTokensDetected: [],
            verificationToolsCalled: [],
            action: "error",
            ruleTokensDetected: [],
            ruleAction: "error",
            err: (err as Error).message,
          },
          "phase999.63-verify",
        );
      } catch {
        // Logger itself threw — swallow. Fail-open is absolute.
      }
    }
  }

  /**
   * C (2026-08-26) — pre-delivery verification hold. Called by the bridge
   * at the delivery seam (BEFORE the response lands on Discord) for
   * agents with `verification.holdDelivery: true`. Contract:
   *
   *   - NEVER throws; every failure returns the ORIGINAL text (fail-open).
   *   - Clean drafts return immediately — zero added latency.
   *   - Flagged drafts run the (low-effort, patch-contract) corrective
   *     hop inline, bounded by `holdTimeoutMs`; a successful patch
   *     returns the corrected text with NO footer (nothing wrong was ever
   *     shown publicly).
   *   - A correction that cannot be patched rides `followUpPost` — the
   *     bridge delivers the original then posts the compact note.
   *   - timeout / error verdicts unmark the turn and re-arm the post-hoc
   *     backstop (deliver-then-edit), so verification is never lost.
   *
   * Bounded hold: the 45 s default sits far under the 999.64 stale-turn
   * force-release margins (5 min), so a held delivery can never trip the
   * wedge machinery. The hold is deliberately NOT aborted by incoming
   * user traffic — it is short and the alternative (aborting) would ship
   * the unverified draft the operator asked us never to show.
   */
  async preDeliveryVerify(args: {
    readonly agentName: string;
    readonly channelId: string | null;
    readonly turnId: string | null;
    readonly response: string;
    readonly turnCostMs: number | null;
    readonly toolExecutionMs: number | null;
    readonly effortTier: string | null;
  }): Promise<PreDeliveryVerifyResult> {
    const { agentName, response, turnId, turnCostMs, toolExecutionMs, effortTier } =
      args;
    const clean: PreDeliveryVerifyResult = {
      finalText: response,
      verdict: "clean",
    };
    try {
      const cfg = this.deps.resolveConfig?.(agentName);
      // Defensive re-check (the bridge already gates on both): a
      // non-enforced or non-hold agent passes through untouched and
      // UNMARKED — the post-hoc path keeps full ownership.
      if (
        !isVerificationEnforced(agentName, cfg?.enforced) ||
        cfg?.holdDelivery !== true
      ) {
        return clean;
      }
      if (turnId !== null) this.markPreDelivery(turnId);

      const budgetKnobs = {
        maxVerifyHops:
          cfg?.maxVerifyHops ??
          VERIFICATION_BUDGET_DEFAULTS.maxVerifyHops,
        ruleClaimsEnabled:
          cfg?.ruleClaims?.enabled ??
          VERIFICATION_BUDGET_DEFAULTS.ruleClaims.enabled,
        ruleClaimsMaxVerifyHops:
          cfg?.ruleClaims?.maxVerifyHops ??
          VERIFICATION_BUDGET_DEFAULTS.ruleClaims.maxVerifyHops,
        holdTimeoutMs:
          cfg?.holdTimeoutMs ??
          VERIFICATION_BUDGET_DEFAULTS.holdTimeoutMs,
      };
      const ruleClaims = {
        enabled: budgetKnobs.ruleClaimsEnabled,
        maxVerifyHops: budgetKnobs.ruleClaimsMaxVerifyHops,
      };

      const result = evaluateVerification({
        response,
        toolCallNames: this.deps.recentToolCallNames?.(agentName) ?? [],
        // 2026-08-27 — the hold path never passed provenance text, so
        // figureProvenance could not fire before delivery.
        toolResultText: this.deps.recentToolResultText?.(agentName) ?? "",
        verifyHopCount: 0,
        maxVerifyHops: budgetKnobs.maxVerifyHops,
        ruleClaims,
      });

      // Not flagged for any ENFORCED class → deliver immediately. (Shadow
      // classes surface as hop-exhausted, which correctly does not hold.)
      if (!(result.action === "re-prompt" || result.ruleAction === "re-prompt")) {
        this.emitVerifyLine({
          agentName,
          financialTokensDetected: result.financialTokensDetected,
          verificationToolsCalled: result.verificationToolsCalled,
          action: result.action,
          turnCostMs,
          toolExecutionMs,
          effortTier,
          ruleTokensDetected: result.ruleTokensDetected,
          ruleAction: result.ruleAction,
          claimClasses: result.claimClasses,
          deliveryMode: "hold",
          holdVerdict: "clean",
        });
        return clean;
      }

      const corrective999 = selectCorrective({
        figures: result.action === "re-prompt",
        rules: result.ruleAction === "re-prompt",
      });

      // Low-effort hop (B) with a hard timeout — the ONLY unbounded thing
      // here is the model call, and the abort bounds it.
      let priorEffort: EffortLevel | null = null;
      if (this.deps.getEffort && this.deps.setEffort) {
        try {
          const current = this.deps.getEffort(agentName);
          if (current !== "low" && current !== "off") {
            this.deps.setEffort(agentName, "low");
            priorEffort = current;
          }
        } catch {
          priorEffort = null;
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        budgetKnobs.holdTimeoutMs,
      );
      let corrective: string;
      try {
        corrective = await this.deps.dispatchCorrective(
          agentName,
          corrective999.prompt,
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) {
          // Timeout — fail open: deliver the original now, re-arm the
          // post-hoc backstop (deliver-then-edit) for the correction.
          this.emitVerifyLine({
            agentName,
            financialTokensDetected: result.financialTokensDetected,
            verificationToolsCalled: result.verificationToolsCalled,
            action: result.action,
            turnCostMs,
            toolExecutionMs,
            effortTier,
            ruleTokensDetected: result.ruleTokensDetected,
            ruleAction: result.ruleAction,
            claimClasses: result.claimClasses,
            deliveryMode: "hold",
            holdVerdict: "timeout",
          });
          if (turnId !== null) this.unmarkPreDelivery(turnId);
          void this.run({ ...args, verifyHopCount: 0 });
          return { finalText: response, verdict: "timeout" };
        }
        throw err;
      } finally {
        clearTimeout(timer);
        if (priorEffort !== null) {
          try {
            this.deps.setEffort?.(agentName, priorEffort);
          } catch {
            // Best-effort restore.
          }
        }
      }

      if (corrective.trim() === NO_CORRECTION_NEEDED) {
        this.emitVerifyLine({
          agentName,
          financialTokensDetected: result.financialTokensDetected,
          verificationToolsCalled: result.verificationToolsCalled,
          action: result.action,
          turnCostMs,
          toolExecutionMs,
          effortTier,
          ruleTokensDetected: result.ruleTokensDetected,
          ruleAction: result.ruleAction,
          claimClasses: result.claimClasses,
          falsePositiveAck: true,
          deliveryMode: "hold",
          holdVerdict: "clean",
        });
        return clean;
      }

      const patchOps = parsePatchOps(corrective);
      const patchedText =
        patchOps !== null ? applyPatchOps(response, patchOps) : null;
      const correctionMode: "patch" | "note-fallback" | "raw-fallback" =
        patchOps === null
          ? "raw-fallback"
          : patchedText === null
            ? "note-fallback"
            : "patch";
      this.emitVerifyLine({
        agentName,
        financialTokensDetected: result.financialTokensDetected,
        verificationToolsCalled: result.verificationToolsCalled,
        action: result.action,
        turnCostMs,
        toolExecutionMs,
        effortTier,
        ruleTokensDetected: result.ruleTokensDetected,
        ruleAction: result.ruleAction,
        claimClasses: result.claimClasses,
        deliveryMode: "hold",
        holdVerdict: "corrected",
        correctionMode,
        patchOps: patchOps?.length,
      });
      if (correctionMode === "patch") {
        // The FIRST delivery is already correct — no footer, no public
        // correction ever existed.
        return { finalText: patchedText as string, verdict: "corrected" };
      }
      // Correction exists but cannot be patched into the draft: deliver
      // the original and have the bridge post the compact note after it.
      const notePrefix = icons.prefix("search", corrective999.prefix);
      const followUpPost =
        patchOps !== null
          ? renderCorrectionNote(patchOps, notePrefix)
          : `${notePrefix}${corrective}`;
      return { finalText: response, verdict: "corrected", followUpPost };
    } catch (err) {
      try {
        this.deps.log.warn(
          {
            tag: "phase999.63-verify",
            agent: agentName,
            deliveryMode: "hold",
            holdVerdict: "error",
            err: (err as Error).message,
          },
          "phase999.63-verify",
        );
      } catch {
        // Absolute fail-open.
      }
      if (turnId !== null) this.unmarkPreDelivery(turnId);
      try {
        void this.run({ ...args, verifyHopCount: 0 });
      } catch {
        // Backstop re-arm is best-effort.
      }
      return { finalText: response, verdict: "error" };
    }
  }

  private emitVerifyLine(fields: {
    agentName: string;
    financialTokensDetected: readonly string[];
    verificationToolsCalled: readonly string[];
    action: string;
    turnCostMs: number | null;
    toolExecutionMs: number | null;
    effortTier: string | null;
    ruleTokensDetected: readonly string[];
    ruleAction: string;
    claimClasses: readonly string[];
    /** 999.63d — inline-citation evidence flag (main evaluation line). */
    citedRuleClaims?: boolean;
    /** 999.63d — the ✅ badge fired for this turn (main line). */
    verifiedBadge?: boolean;
    /** 999.63d — verify-behind marker outcome (hop-settlement lines). */
    markerOutcome?:
      | "edit"
      | "restored"
      | "verified-clean"
      | "aborted"
      | "skipped-no-ref";
    skippedReason?: string;
    falsePositiveAck?: boolean;
    /** 999.63c — which delivery path the correction took (hop-1 line only). */
    correctionDelivery?: "edit" | "chunk-edit" | "post-fallback" | "post-unwired";
    /** B — how the hop reply was interpreted (hop-1 line only). */
    correctionMode?: "patch" | "note-fallback" | "raw-fallback";
    /** B — number of parsed patch ops (hop-1 line only, patch/note modes). */
    patchOps?: number;
    /** C — set to "hold" on lines emitted by the pre-delivery path. */
    deliveryMode?: "hold";
    /** C — the hold outcome (pre-delivery lines only). */
    holdVerdict?: "clean" | "corrected" | "timeout" | "error";
    /** 2026-08-27 — inbound user message size (main line). */
    promptChars?: number;
    /** 2026-08-27 — figures satisfied by verbatim tool-result provenance. */
    figureProvenance?: "tool-results";
    /** 2026-08-27 PR-1 — evidence ledger counts (never URLs/text). */
    evidenceCount?: number;
    evidenceKinds?: { read: number; found: number; queried: number; document: number };
    /** 2026-08-27 PR-1 — hosts consulted (≤5). */
    citedSources?: readonly string[];
    /** 2026-08-27 PR-1 — hosts the DRAFT cites that the turn never consulted. */
    unmatchedHosts?: readonly string[];
    /** 2026-08-27 PR-2 — claim ledger counts (never claim text). */
    claimSummary?: { n: number; verified: number; corrected: number; unverified: number; notConsulted: number; dismissed: number; client: number };
    /** 2026-08-27 — delivered draft size (main line). */
    draftChars?: number;
  }): void {
    this.deps.log.info(
      {
        tag: "phase999.63-verify",
        agent: fields.agentName,
        financialTokensDetected: fields.financialTokensDetected,
        verificationToolsCalled: fields.verificationToolsCalled,
        action: fields.action,
        ...(fields.falsePositiveAck ? { falsePositiveAck: true } : {}),
        turnCostMs: fields.turnCostMs,
        toolExecutionMs: fields.toolExecutionMs,
        ...(fields.promptChars !== undefined ? { promptChars: fields.promptChars } : {}),
        ...(fields.figureProvenance !== undefined ? { figureProvenance: fields.figureProvenance } : {}),
        ...(fields.evidenceCount !== undefined ? { evidenceCount: fields.evidenceCount } : {}),
        ...(fields.evidenceKinds !== undefined ? { evidenceKinds: fields.evidenceKinds } : {}),
        ...(fields.citedSources !== undefined ? { citedSources: fields.citedSources } : {}),
        ...(fields.unmatchedHosts !== undefined ? { unmatchedHosts: fields.unmatchedHosts } : {}),
        ...(fields.claimSummary !== undefined ? { claims: fields.claimSummary } : {}),
        ...(fields.draftChars !== undefined ? { draftChars: fields.draftChars } : {}),
        effortTier: fields.effortTier,
        ...(fields.skippedReason !== undefined
          ? { skippedReason: fields.skippedReason }
          : {}),
        // 999.63b additive riders — appended AFTER every legacy key so the
        // legacy key order stays byte-identical for grep/cut pipelines.
        ruleTokensDetected: fields.ruleTokensDetected,
        ruleAction: fields.ruleAction,
        claimClasses: fields.claimClasses,
        ...(fields.citedRuleClaims !== undefined
          ? { citedRuleClaims: fields.citedRuleClaims }
          : {}),
        ...(fields.verifiedBadge !== undefined
          ? { verifiedBadge: fields.verifiedBadge }
          : {}),
        ...(fields.markerOutcome !== undefined
          ? { markerOutcome: fields.markerOutcome }
          : {}),
        ...(fields.correctionDelivery !== undefined
          ? { correctionDelivery: fields.correctionDelivery }
          : {}),
        ...(fields.correctionMode !== undefined
          ? { correctionMode: fields.correctionMode }
          : {}),
        ...(fields.patchOps !== undefined ? { patchOps: fields.patchOps } : {}),
        ...(fields.deliveryMode !== undefined
          ? { deliveryMode: fields.deliveryMode }
          : {}),
        ...(fields.holdVerdict !== undefined
          ? { holdVerdict: fields.holdVerdict }
          : {}),
      },
      "phase999.63-verify",
    );
  }
}
