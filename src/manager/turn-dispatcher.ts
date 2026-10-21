/**
 * TurnDispatcher — the single chokepoint for every agent-turn initiation.
 *
 * Phase 57 foundation. Wraps SessionManager.dispatchTurn / streamFromAgent
 * with:
 *   1. origin-prefixed turnId generation (via makeRootOrigin)
 *   2. caller-owned Turn lifecycle (opens + ends the Turn on behalf of the
 *      caller so a new turn source doesn't duplicate the boilerplate)
 *   3. TurnOrigin threading (stored on the Turn via Turn.id === rootTurnId
 *      and forwarded to the trace row in Plan 57-02)
 *
 * Downstream (Plans 57-02, 57-03, Phases 58-63) plug new sources in by
 * calling turnDispatcher.dispatch(origin, agentName, payload) — no new
 * trace/Turn/session boilerplate per source.
 *
 * This plan (57-01) does NOT migrate DiscordBridge or TaskScheduler —
 * those call sites move in Plan 57-03 after Plan 57-02 threads TurnOrigin
 * through the trace store.
 */

import type { SendImageInput } from "./session-adapter.js";
import type { EvidenceEntry } from "./evidence-ledger.js";
import type { ClaimEntry } from "./claim-ledger.js";
import { stripModelSourcesBlock } from "../discord/sources-footer.js";
import { renderStyleOverlay } from "./output-styles/roster.js";
import { withResearchRoute } from "./research-route.js";
import { getResearchTracker } from "./research-registry.js";
import type { Logger } from "pino";
import { logger } from "../shared/logger.js";
import type { SessionManager } from "./session-manager.js";
import type { TurnOrigin } from "./turn-origin.js";
import type { Turn } from "../performance/trace-collector.js";
import { countTokens } from "../performance/token-count.js";
import { renderMemoryContext, RetrievalCadenceGate, type QueryEmbedder } from "./memory-context-augmenter.js";
import type { EffortLevel } from "../config/schema.js";
import type { MemoryRetrievalResult } from "../memory/memory-retrieval.js";
import { RECALL_FOOTER_TTL_MS, summarizeRecall, type RecallRecord } from "./recall-footer.js";
import { detectCue, extractCueContext } from "../memory/memory-cue.js";
import { wrapMcpToolError, type ErrorClass, type ToolCallError } from "./tool-call-error.js";
import { findAlternativeAgents, type McpStateProvider } from "./find-alternative-agents.js";
import {
  VerificationRunner,
  type PreDeliveryVerifyResult,
  type ResolvedVerificationConfig,
} from "./financial-verification-runner.js";

/** Thrown when dispatch is called with invalid arguments. */
export class TurnDispatcherError extends Error {
  readonly agentName: string | undefined;
  readonly originRootTurnId: string | undefined;
  constructor(message: string, agentName?: string, originRootTurnId?: string) {
    super(`TurnDispatcher: ${message}`);
    this.name = "TurnDispatcherError";
    this.agentName = agentName;
    this.originRootTurnId = originRootTurnId;
  }
}

/**
 * Phase 96 Plan 04 D-10 — post-turn missed-upload detector regex.
 *
 * Matches the D-10 verbatim "file-as-artifact" phrases that should have
 * triggered a clawcode_share_file call. The regex is broad on purpose
 * (LLMs phrase artifact references many ways); the toolCallNames check
 * inside detectMissedUpload guards against false positives when the agent
 * actually DID share. Negative case: text-only Q&A about file content
 * ("the PDF says X") does NOT match — only artifact references do.
 *
 * Pinned by static-grep regression: `grep -q "MISSED_UPLOAD_PATTERN"
 * src/manager/turn-dispatcher.ts`. The verbatim regex tokens
 * (here's|attached|generated|saved to|i made/created/edited) are also
 * pinned by D-10 acceptance.
 */
export const MISSED_UPLOAD_PATTERN =
  /here's|attached|generated|saved to|i (made|created|edited) .* (file|pdf|image|doc)/i;

/**
 * Phase 96 Plan 04 D-10 — post-turn OpenClaw-fallback anti-pattern detector.
 *
 * Catches cases where the bot recommends falling back to OpenClaw to work
 * around a capability gap (filesystem, network, DB, MCP, etc.). OpenClaw
 * is being deprecated; recommending it as a fallback reinforces a sunset
 * path. Operator surfaced this 2026-04-25 in #acme-client-acquisition
 * (DB-access scenario where bot said "I'll spawn a subagent on the
 * OpenClaw side").
 *
 * Pinned by static-grep regression: `grep -q "OPENCLAW_FALLBACK_PATTERN"
 * src/manager/turn-dispatcher.ts`. The verbatim regex tokens
 * (openclaw side|openclaw agent|openclaw host|spawn.*subagent.*openclaw)
 * are also pinned by D-10 acceptance.
 */
export const OPENCLAW_FALLBACK_PATTERN =
  /openclaw (side|agent|host)|spawn.*subagent.*openclaw/i;

/**
 * Phase 96 Plan 04 D-10 — negative-match exception for OpenClaw fallback.
 *
 * `archive/openclaw-sessions/` references are LEGITIMATE (reading historical
 * sessions is a normal operator workflow). Only fallback recommendations
 * are the anti-pattern. When the response also contains this archive path
 * pattern, detectOpenClawFallback skips the alert entirely.
 */
export const OPENCLAW_LEGITIMATE_ARCHIVE_PATTERN = /archive\/openclaw-sessions\//;

/**
 * Phase 91 alert dedup primitive — admin-clawdy alert with throttling.
 *
 * Same shape used by both missed-upload and OpenClaw-fallback detectors;
 * each detector passes a DISTINCT `dedupKey` so they throttle independently
 * (one missed-upload alert in a window does NOT throttle an OpenClaw
 * alert). Production wires this from the daemon's existing
 * sendConflictAlert / admin-clawdy posting primitive (Phase 91 Plan 02).
 */
export type AdminClawdyAlertFn = (message: string, dedupKey: string) => void;

export interface DetectMissedUploadDeps {
  readonly alert: AdminClawdyAlertFn;
}

export type DetectOpenClawFallbackDeps = DetectMissedUploadDeps;

/**
 * Phase 96 Plan 04 D-10 — pure post-turn missed-upload detector.
 *
 * Returns true when the LLM response references a file as an artifact
 * AND clawcode_share_file was NOT called this turn. Fires a soft warning
 * to admin-clawdy via the supplied alert primitive (Phase 91 alert dedup
 * with key 'missed-upload'). Throttled at the alert primitive layer —
 * the same response repeated within a dedup window emits at most one
 * alert.
 *
 * Soft signal — caller does NOT block on the return value. Used purely
 * for operator-side observability so the next system-prompt directive
 * iteration can be informed by real data.
 */
export function detectMissedUpload(
  response: string,
  toolCallNames: readonly string[],
  deps: DetectMissedUploadDeps,
): boolean {
  const referencesArtifact = MISSED_UPLOAD_PATTERN.test(response);
  const sharedFile = toolCallNames.includes("clawcode_share_file");
  if (referencesArtifact && !sharedFile) {
    deps.alert(
      "Possible missed upload — agent response references file as artifact but did not call clawcode_share_file. Operator review.",
      "missed-upload",
    );
    return true;
  }
  return false;
}

/**
 * Phase 96 Plan 04 D-10 — pure post-turn OpenClaw-fallback detector.
 *
 * Sibling of detectMissedUpload — runs alongside in the post-turn hook
 * (separate try/catch so a failure in one does NOT prevent the other).
 * Returns true when the LLM response recommends falling back to OpenClaw
 * for capability work; emits a HIGH-PRIORITY warning to admin-clawdy via
 * the alert primitive (dedup key 'openclaw-fallback', distinct from
 * missed-upload so they throttle independently).
 *
 * Negative-match exception: response containing `archive/openclaw-sessions/`
 * is legitimate (operator workflow reading historical sessions); this
 * skips the alert entirely.
 *
 * Soft signal — non-blocking. Operator reviews and decides whether to
 * tune the system-prompt directive further.
 */
export function detectOpenClawFallback(
  response: string,
  deps: DetectOpenClawFallbackDeps,
): boolean {
  const recommendsFallback = OPENCLAW_FALLBACK_PATTERN.test(response);
  const isLegitimateArchive = OPENCLAW_LEGITIMATE_ARCHIVE_PATTERN.test(response);
  if (recommendsFallback && !isLegitimateArchive) {
    deps.alert(
      "HIGH PRIORITY — agent recommended OpenClaw fallback to work around capability gap. OpenClaw is being deprecated; review system prompt + capability config. Operator review required.",
      "openclaw-fallback",
    );
    return true;
  }
  return false;
}

export type DispatchOptions = {
  /** Discord channel id when this turn is Discord-originated; else null. */
  readonly channelId?: string | null;
  /**
   * Phase 57 Plan 03: caller-owned Turn opt-out.
   *
   * When provided, TurnDispatcher:
   *   1. Does NOT open a new Turn via the TraceCollector (avoids duplicate).
   *   2. Calls `turn.recordOrigin(origin)` exactly once to attach provenance.
   *   3. Does NOT call `turn.end()` — caller retains lifecycle ownership
   *      (mirrors the Phase 50 caller-owned Turn contract used by DiscordBridge
   *      and bench-run-prompt so the caller can stamp additional spans BEFORE
   *      the record is committed).
   *
   * Leave undefined to get the default lifecycle (dispatcher opens + ends Turn).
   */
  readonly turn?: Turn;
  /**
   * Phase 59 -- optional AbortSignal. When provided, the target agent's turn
   * is aborted when the signal fires. TaskManager passes its per-task signal
   * here to enforce chain-wide deadlines (HAND-03) and explicit cancellations.
   *
   * Plumbs through to session-adapter's wrapSdkQuery which wires it onto
   * the SDK's native Options.abortController (sdk.d.ts:957).
   */
  readonly signal?: AbortSignal;
  /**
   * Phase 999.154 — native image blocks for this turn (the bridge's budgeted
   * full images + contact sheets). Forwarded verbatim to
   * `SendOptions.images`; undefined ⇒ the unchanged text-only path.
   */
  readonly images?: ReadonlyArray<SendImageInput>;
  /**
   * Phase 83 EFFORT-05 — per-skill effort override for this single turn.
   *
   * When set, the dispatcher:
   *   1. Snapshots the agent's current effort via sessionManager.getEffortForAgent.
   *   2. Calls setEffortForAgent(agentName, skillEffort) BEFORE dispatchTurn /
   *      streamFromAgent — the SDK's q.setMaxThinkingTokens fires before
   *      the turn starts (Plan 01 wired the synchronous path).
   *   3. After the send completes (success OR error, via try/finally),
   *      calls setEffortForAgent(agentName, priorEffort) to restore.
   *
   * Intended caller: Discord slash-command dispatch site that resolves
   * `skillsCatalog.get(commandName)?.effort` and threads it here. When
   * the invoked skill has no `effort:` frontmatter (or the command isn't
   * a skill at all), omit the field / pass undefined — the dispatcher
   * short-circuits to zero effort-touching side effects.
   *
   * Turn-boundary revert (not tool-call / interrupt granularity) — the SDK's
   * serialTurnQueue guarantees at most one turn per handle at a time, so
   * pre-turn apply + post-turn revert is the correct locking window.
   */
  readonly skillEffort?: EffortLevel;
  /**
   * Phase 999.63 Plan 03 D4 — verify-hop count for the financial-
   * verification gate. Defaults to 0 (the original turn). When the gate
   * issues a corrective re-prompt it threads `verifyHopCount = 1` so the
   * gate run on the corrective turn returns `hop-exhausted` and issues NO
   * further re-prompt — the D4 single-hop loop bound.
   */
  readonly verifyHopCount?: number;
  /**
   * UX-C (2026-08-26) — fire-and-forget mid-turn tool-START observer
   * (name only), forwarded to SessionManager.streamFromAgent →
   * SendOptions.onToolUse (the persistent handle already threads it;
   * the OpenAI voice driver is the other consumer). The hold-mode
   * bridge passes it to narrate verification activity on the
   * placeholder message. Undefined ⇒ byte-identical legacy path.
   * Streaming dispatch only — dispatch() has no consumer today.
   */
  readonly onToolUse?: (name: string, input?: unknown) => void;
};

/**
 * Phase 90 MEM-03 — pre-turn memory retriever.
 *
 * Optional DI hook wired by daemon.ts: given an agent name + the user's
 * query text, returns a (frozen) list of relevant memory chunks to
 * prepend to the user's message as a `<memory-context>` block. Lands
 * in the mutable-suffix region (per-turn), NEVER the stable prefix —
 * v1.7 cache stability depends on the stable prefix staying byte-identical
 * across turns.
 *
 * Errors from the retriever are caught and logged — retrieval is strictly
 * best-effort (fail-open): the turn proceeds with the raw user message
 * if retrieval throws.
 */
export type MemoryRetriever = (
  agentName: string,
  query: string,
) => Promise<readonly MemoryRetrievalResult[]>;

/**
 * Phase 90 MEM-05 — cue-memory writer DI signature. Mirrors
 * writeCueMemory(...) from src/memory/memory-cue.ts. When wired, the
 * post-turn hook fires this on every user message whose text matches
 * MEMORY_CUE_REGEX. Fire-and-forget — rejection is warn-logged and does
 * NOT propagate.
 */
export type MemoryCueWriter = (
  args: Readonly<{
    workspacePath: string;
    cue: string;
    context: string;
    turnIso: string;
    messageLink?: string;
  }>,
) => Promise<string>;

/**
 * Phase 90 MEM-06 — subagent-return capture DI signature. Mirrors
 * captureSubagentReturn(...) from src/memory/subagent-capture.ts.
 * Returns null when the subagent_type is gsd-* (D-35 exclusion).
 */
export type SubagentCapture = (
  args: Readonly<{
    workspacePath: string;
    subagent_type: string;
    task_description: string;
    return_summary: string;
    spawned_at_iso: string;
    duration_ms: number;
  }>,
) => Promise<string | null>;

/**
 * Phase 90 MEM-05 — per-agent workspace resolver. Injected by daemon.ts
 * so the dispatcher can derive the on-disk memory/ path without reaching
 * into SessionManager state. Returns undefined when the agent is unknown
 * (daemon not finished registering) — hook short-circuits to no-op.
 */
export type WorkspaceResolver = (agentName: string) => string | undefined;

/**
 * Phase 90 MEM-05 D-32 — Discord reaction adder. When wired, the cue
 * hook fires `discordReact({channelId, messageId}, emoji)` on success of
 * the cue write. Rejection is warn-logged and does NOT propagate
 * (fire-and-forget). OpenAI-endpoint turns and task-scheduled turns skip
 * this entirely (no messageId available).
 */
export type DiscordReactFn = (
  target: Readonly<{ channelId: string; messageId: string }>,
  emoji: string,
) => Promise<void>;

/**
 * Phase 90 MEM-06 — Task tool-return event. Payload the observer needs to
 * construct a captureSubagentReturn call. Shape matches captureSubagentReturn
 * minus workspacePath (resolved via workspaceForAgent).
 */
export type TaskToolReturnEvent = Readonly<{
  subagent_type: string;
  task_description: string;
  return_summary: string;
  spawned_at_iso: string;
  duration_ms: number;
}>;

export type TurnDispatcherOptions = {
  readonly sessionManager: SessionManager;
  readonly log?: Logger;
  /**
   * Phase 90 MEM-03 — optional pre-turn retrieval hook. When undefined,
   * dispatch proceeds with zero memory augmentation (no <memory-context>
   * block, no perf cost). Wired by daemon.ts once both TurnDispatcher and
   * MemoryScanner/SessionManager are constructed.
   */
  readonly memoryRetriever?: MemoryRetriever;
  /**
   * Phase 999.187 — query embedder for the topic-shift refresh in the
   * retrieval cadence gate. Omitted → the pure K-turn cadence.
   */
  readonly queryEmbedder?: QueryEmbedder;
  /**
   * Phase 90 MEM-05 — cue write hook. When wired, every user message
   * that matches MEMORY_CUE_REGEX (D-30) triggers a background write to
   * {workspace}/memory/YYYY-MM-DD-remember-<nanoid>.md (D-31).
   */
  readonly memoryCueWriter?: MemoryCueWriter;
  /**
   * Phase 90 MEM-05 — per-agent workspace resolver. Required when
   * memoryCueWriter is wired (otherwise the hook has nowhere to write).
   * Also consumed by MEM-06 subagent-capture for the same reason.
   */
  readonly workspaceForAgent?: WorkspaceResolver;
  /**
   * Phase 90 MEM-05 D-32 — Discord reaction post-turn. When wired, a
   * successful cue write triggers a ✅ reaction (or config-overridden
   * emoji) on the originating Discord message.
   */
  readonly discordReact?: DiscordReactFn;
  /**
   * Phase 90 MEM-06 — subagent final-report capture. When wired,
   * handleTaskToolReturn forwards Task tool returns (non-gsd-*) to this
   * hook for disk persistence. D-35 gsd-* exclusion is enforced inside
   * the hook itself (isGsdSubagent).
   */
  readonly subagentCapture?: SubagentCapture;
  /**
   * Phase 94 Plan 04 D-06/D-07 — per-agent MCP state provider for
   * cross-agent alternatives lookup. When wired, `executeMcpTool`'s
   * wrap path populates `ToolCallError.alternatives` with healthy agent
   * names whose backing MCP server has `capabilityProbe.status === "ready"`
   * for the named tool. Absent when not yet wired (Plan 94-04 ships the
   * primitive; daemon edge wiring lives where SessionManager is constructed).
   */
  readonly mcpStateProvider?: McpStateProvider;
  /**
   * Phase 94 Plan 04 D-06 — optional per-class suggestion registry.
   * Daemon edge wires a `Record<ErrorClass, string>` (or callable
   * equivalent) here so the LLM receives operator-actionable hints in
   * the `ToolCallError.suggestion` field. Absent when no suggestions
   * are configured — the LLM still receives the structured wrap with
   * verbatim message + classification + alternatives.
   */
  readonly toolErrorSuggestion?: (errorClass: ErrorClass) => string | undefined;
  /**
   * Phase 96 Plan 04 D-10 — admin-clawdy alert primitive for the post-turn
   * DUAL detector hook (detectMissedUpload + detectOpenClawFallback).
   *
   * When wired, every successful dispatch invokes both detectors with
   * sibling try/catch blocks. Each detector calls alert(message, dedupKey)
   * with a DISTINCT dedup key ('missed-upload' vs 'openclaw-fallback') so
   * they throttle independently. Both are non-blocking — failures in the
   * detector layer never propagate to the caller.
   *
   * Daemon edge wires this from the existing Phase 91 admin-clawdy alert
   * primitive (sendConflictAlert / bot-direct fallback). When omitted, the
   * post-turn hook is a no-op (zero perf cost on the normal path).
   */
  readonly alertAdminClawdy?: AdminClawdyAlertFn;
  /**
   * Phase 96 Plan 04 D-10 — OPTIONAL provider returning the tool-call
   * names executed during the most recent turn FOR THE GIVEN AGENT. When
   * wired, the post-turn detectMissedUpload check uses this to gate the
   * warning (response references file artifact AND clawcode_share_file NOT
   * in the list → fire). When omitted, the missed-upload detector is
   * treated as if no tools ran — same behavior, just less precise.
   *
   * The provider is a closure rather than a per-turn arg to keep the
   * dispatch() signature stable. Production wires this from the
   * SessionManager's per-turn tool-call observer.
   *
   * Phase 999.63 Plan 02 T-02 — signature widened to take `agentName`
   * (the tool-name accumulator is per-agent; `firePostTurnDetectors`
   * already runs inside `dispatch(origin, agentName, ...)`). Production
   * wires this in daemon.ts from `TraceCollector.getActiveTurnToolCallNames`.
   */
  readonly recentToolCallNames?: (agentName: string) => readonly string[];
  /** 2026-08-27 — bounded tool_result text for the active turn (figures provenance). */
  readonly recentToolResultText?: (agentName: string) => string;
  /** 2026-08-27 — evidence ledger for the active turn (sources consulted). */
  readonly recentEvidence?: (agentName: string) => readonly EvidenceEntry[];
  /** 2026-08-27 — claim ledger for the active turn (verify_claim records). */
  readonly recentClaims?: (agentName: string) => readonly ClaimEntry[];
  /**
   * Phase 999.63 Plan 03 D5 — labelled-correction delivery hook. When the
   * financial-verification gate issues a corrective re-prompt, the
   * corrective response is posted to the agent's Discord channel as a
   * SEPARATE message prefixed with `CORRECTION_PREFIX` — NOT by mutating
   * the original draft's delivery path.
   *
   * Optional DI hook, same pattern as `discordReact` / `alertAdminClawdy`.
   * When NOT wired (CLI runner, non-Discord sources, tests), the gate
   * still runs — it dispatches the corrective re-prompt and emits the
   * `phase999.63-verify` telemetry — the correction text simply has no
   * channel to land in (the gate logs that it could not post).
   *
   * Production wires this in daemon.ts to `DiscordBridge.postFinancialCorrection`
   * via the `discordBridgeRef` deferred-resolution pattern.
   */
  readonly postCorrectiveMessage?: (args: {
    agentName: string;
    channelId: string | null;
    text: string;
  }) => Promise<void>;
  /**
   * 999.63c — preferred correction delivery: edit the original message in
   * place when safe (bridge.applyFinancialCorrection), internally falling
   * back to the labelled post. Optional; when unwired the runner keeps
   * the legacy postCorrectiveMessage path byte-identical.
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
  /** 999.63d — verify-behind pending marker (bridge adapters). */
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
  /** 999.63d — ✅ verified-inline badge (bridge adapter). */
  readonly applyVerifiedBadge?: (args: {
    agentName: string;
    turnId: string | null;
  }) => Promise<void>;
  /**
   * 2026-07-31 (supersedes Phase 999.63 Plan 04's
   * `verificationOverride`) — live resolver returning the
   * agent's FULL resolved `verification` config block (enforced
   * + the adaptive-budget knobs), or `undefined` when no block resolved.
   * The runner derives `enforced` from the block and combines it with
   * the `fin-` name-prefix default.
   *
   * Optional DI hook (same pattern as `recentToolCallNames` /
   * `postCorrectiveMessage`). When NOT wired, every agent resolves to
   * `undefined` — prefix-default enforcement + built-in budget defaults,
   * the correct conservative behavior for CLI runners and tests.
   *
   * Production wires this in daemon.ts from
   * `manager.getAgentConfig(agentName)?.verification` (the
   * hot-reload-correct read — the previous boot-time `resolvedAgents`
   * array lookup silently ignored `clawcode reload`).
   */
  readonly resolveVerification?: (
    agentName: string,
  ) => ResolvedVerificationConfig | undefined;
};

/**
 * Phase 94 Plan 04 — return shape from `TurnDispatcher.executeMcpTool`.
 * Mirrors the SDK tool_result slot conceptually:
 *   - `content`: the string the LLM sees (raw success result OR JSON-
 *                stringified ToolCallError on failure)
 *   - `isError`: `true` when content is a wrapped ToolCallError; `false`
 *                on success. Maps directly to the SDK's `is_error` flag
 *                on tool_result blocks so the LLM's tool-result rendering
 *                renders the failure path correctly.
 */
export interface ExecuteMcpToolResult {
  readonly content: string;
  readonly isError: boolean;
}

/**
 * Context-bloat fix #2-A — memory-context retrieval cadence.
 *
 * `augmentWithMemoryContext` used to prepend a fresh ~1500-token
 * `<memory-context>` block to EVERY user message. The SDK retains every
 * user message verbatim, so that retrieval text accumulated linearly
 * (~1500 tok × N turns) — most of it stale, since memory changes slowly
 * between turns.
 *
 * This cadence constant gates the prepend: retrieval refreshes only once
 * every K turns (turn 1, turn 1+K, turn 1+2K, …). Between refreshes the
 * agent still carries the most-recent block from the last refresh, and
 * the `memory_lookup` MCP tool remains the explicit on-demand fallback —
 * so recall is preserved.
 *
 * K = 3 is a deliberately RECALL-SAFE default: frequent enough that
 * auto-retrieval never lags more than two turns behind, while still
 * cutting the growth rate ~3×. This is the single source of truth for K —
 * do not hard-code 3 elsewhere.
 */
export const MEMORY_RETRIEVAL_CADENCE_TURNS = 3;

/**
 * TurnDispatcher — construct once at daemon boot; call dispatch() from
 * every turn source (DiscordBridge, TaskScheduler, future Phase 59 handoff
 * receiver, future Phase 60 trigger engine).
 */
export class TurnDispatcher {
  /**
   * 999.105 Route O — prepend the agent's output-style overlay to the turn's
   * user message. Called at BOTH dispatch seams (dispatch + stream) as a
   * SIBLING of augmentWithMemoryContext, deliberately NOT inside it: that
   * method is cadence-gated, and a style must apply on every turn or it
   * intermittently vanishes. "default" (or unknown) injects NOTHING — the
   * baseline is the absence of an overlay. Unconditional per-turn injection
   * accumulates in the transcript (plan §3, trade taken knowingly; blocks are
   * capped ≤120 words). Fail-open: any error returns the message untouched.
   */
  private applyOutputStyle(agentName: string, message: string): string {
    try {
      const style = this.sessionManager.getStyleForAgent(agentName);
      const overlay = renderStyleOverlay(style);
      return overlay ? overlay + message : message;
    } catch {
      return message;
    }
  }

  /**
   * Research auto-routing (research-route.ts) — a Discord message asking for a
   * deep dive / research / a workflow gets a `<research-routing>` steer, only
   * when the agent opts in (`research.autoRoute`) AND research subagents are
   * live in its session (a tracker is registered). Detection uses the RAW
   * message; the block rides in front of the augmented one. Fail-open.
   */
  private applyResearchRoute(agentName: string, origin: TurnOrigin, rawMessage: string, augmented: string): string {
    try {
      if (origin.source.kind !== "discord") return augmented;
      if (this.sessionManager.getAgentConfig(agentName)?.research?.autoRoute !== true) return augmented;
      const live = getResearchTracker(agentName) !== undefined;
      const routed = withResearchRoute(rawMessage, augmented, live);
      if (routed !== augmented) {
        this.log.info({ agent: agentName, turnId: origin.rootTurnId }, "research: routed a research request to researchers");
      }
      return routed;
    } catch {
      return augmented;
    }
  }

  private readonly sessionManager: SessionManager;
  private readonly log: Logger;
  private readonly memoryRetriever: MemoryRetriever | undefined;
  /**
   * Phase 999.124 — what the last pre-turn retrieval put in front of the
   * model, per session, single-shot. Set in `augmentWithMemoryContext`,
   * consumed by the Discord bridge at its footer mutation point.
   */
  private readonly pendingRecall: Map<string, RecallRecord> = new Map();
  private readonly memoryCueWriter: MemoryCueWriter | undefined;
  private readonly workspaceForAgent: WorkspaceResolver | undefined;
  private readonly discordReact: DiscordReactFn | undefined;
  private readonly subagentCapture: SubagentCapture | undefined;
  private readonly mcpStateProvider: McpStateProvider | undefined;
  private readonly toolErrorSuggestion: ((errorClass: ErrorClass) => string | undefined) | undefined;
  private readonly alertAdminClawdy: AdminClawdyAlertFn | undefined;
  private readonly recentToolCallNames:
    | ((agentName: string) => readonly string[])
    | undefined;
  private readonly recentToolResultText: ((agentName: string) => string) | undefined;
  private readonly recentEvidence: ((agentName: string) => readonly EvidenceEntry[]) | undefined;
  private readonly recentClaims: ((agentName: string) => readonly ClaimEntry[]) | undefined;
  /** 2026-08-27 — same resolver the runner gets; used for delivery-side ux knobs. */
  private readonly resolveVerificationCfg: TurnDispatcherOptions["resolveVerification"];
  /** 2026-08-27 — hosts named in the model's own (stripped) Sources line, per agent, last turn. */
  private readonly lastModelCitedHosts = new Map<string, readonly string[]>();

  /**
   * 2026-08-27 — everything the delivery layer needs to annotate a reply:
   * the evidence + claims ledgers for the agent's active turn and the hosts
   * the model's own Sources line named (stripped before the gate saw it).
   */
  getLedgerSnapshot(agentName: string): {
    readonly evidence: readonly EvidenceEntry[];
    readonly claims: readonly ClaimEntry[];
    readonly modelCitedHosts: readonly string[];
  } {
    return {
      evidence: this.recentEvidence?.(agentName) ?? [],
      claims: this.recentClaims?.(agentName) ?? [],
      modelCitedHosts: this.lastModelCitedHosts.get(agentName) ?? [],
    };
  }

  /**
   * 2026-08-27 — strip the model's trailing `Sources:` block when the agent's
   * ux.modelSourcesLine is strip|flag, remembering the hosts it named so the
   * citation check still sees them. Must run BEFORE fireVerification so the
   * gate snapshot and the delivered text are the same bytes (the correction
   * ladder's startsWith guard depends on it).
   */
  private stripModelSources(agentName: string, response: string): string {
    try {
      const mode = this.resolveVerificationCfg?.(agentName)?.ux?.modelSourcesLine ?? "keep";
      if (mode === "keep") {
        this.lastModelCitedHosts.delete(agentName);
        return response;
      }
      const r = stripModelSourcesBlock(response);
      this.lastModelCitedHosts.set(agentName, r.citedHosts);
      // 2026-08-27 — BOTH "strip" and "flag" remove the model's own block.
      // The daemon appends a deterministic Sources line built from evidence,
      // so leaving the model's prose version in place guaranteed a duplicate
      // ("Sources: acme-db …" immediately above "Sources: CRM › tables").
      // The difference is what happens NEXT: "flag" keeps the cited hosts so
      // decideVerdictMarks can call out anything cited but never opened;
      // "strip" drops them silently. "keep" stays fully legacy.
      return r.text;
    } catch {
      return response;
    }
  }
  /**
   * 2026-07-31 — the extracted financial-verification runner (see
   * financial-verification-runner.ts). Owns the corrective-hop loop,
   * yield mechanism, adaptive budget, and telemetry; the dispatcher only
   * feeds it turn snapshots (fireVerification) and incoming-turn
   * notifications (dispatch/dispatchStream entry).
   */
  private readonly verificationRunner: VerificationRunner;

  /**
   * Context-bloat fix #2-A — per-agent memory-retrieval cadence state.
   *
   * `turnCounter` increments once per `augmentWithMemoryContext` call
   * (i.e. once per dispatched turn). `lastRetrievalTurn` records the
   * turn index on which retrieval last actually ran. A turn refreshes
   * retrieval when it is turn 1 OR at least `MEMORY_RETRIEVAL_CADENCE_TURNS`
   * turns have elapsed since the last refresh. In-memory only — a daemon
   * restart resets the counter, which simply forces a fresh retrieval on
   * the agent's next turn (recall-safe).
   */
  private readonly cadenceGate: RetrievalCadenceGate;

  constructor(options: TurnDispatcherOptions) {
    this.sessionManager = options.sessionManager;
    this.log = (options.log ?? logger).child({ component: "TurnDispatcher" });
    this.memoryRetriever = options.memoryRetriever;
    // Phase 999.187 — shared cadence gate (K turns OR topic shift).
    this.cadenceGate = new RetrievalCadenceGate(options.queryEmbedder);
    this.memoryCueWriter = options.memoryCueWriter;
    this.workspaceForAgent = options.workspaceForAgent;
    this.discordReact = options.discordReact;
    this.subagentCapture = options.subagentCapture;
    this.mcpStateProvider = options.mcpStateProvider;
    this.toolErrorSuggestion = options.toolErrorSuggestion;
    this.alertAdminClawdy = options.alertAdminClawdy;
    this.recentToolCallNames = options.recentToolCallNames;
    this.recentToolResultText = options.recentToolResultText;
    this.recentEvidence = options.recentEvidence;
    this.recentClaims = options.recentClaims;
    this.resolveVerificationCfg = options.resolveVerification;
    this.verificationRunner = new VerificationRunner({
      // Corrective hops go through sessionManager.dispatchTurn directly —
      // NOT TurnDispatcher.dispatch — so no Turn is re-opened, origin is
      // not re-threaded, and the notifyIncomingTurn entry hook can never
      // abort the runner's own hop.
      dispatchCorrective: (agentName, prompt, signal) =>
        this.sessionManager.dispatchTurn(agentName, prompt, undefined, {
          signal,
        }),
      recentToolCallNames: options.recentToolCallNames,
      recentToolResultText: options.recentToolResultText,
      recentEvidence: options.recentEvidence,
      recentClaims: options.recentClaims,
      recentModelCitedHosts: (a) => this.lastModelCitedHosts.get(a) ?? [],
      resolveConfig: options.resolveVerification,
      hasActiveTurn: (agentName) => {
        try {
          return this.sessionManager.hasActiveTurn(agentName);
        } catch {
          return false;
        }
      },
      getEffort: (agentName) => this.sessionManager.getEffortForAgent(agentName),
      // 999.63d effort-clobber fix — hop pins/restores are TRANSIENT:
      // they must never write the durable operator-intent effort store.
      setEffort: (agentName, level) =>
        this.sessionManager.setEffortForAgentTransient(agentName, level),
      postCorrectiveMessage: options.postCorrectiveMessage,
      applyCorrectiveEdit: options.applyCorrectiveEdit,
      appendPendingMarker: options.appendPendingMarker,
      removePendingMarker: options.removePendingMarker,
      applyVerifiedBadge: options.applyVerifiedBadge,
      log: this.log,
    });
  }

  /**
   * 2026-07-31 — dispatch-epilogue feeder for the verification runner.
   * Captures the heaviness snapshot SYNCHRONOUSLY (before `turn.end()` on
   * the self-owned branches can commit the trace) and void-invokes the
   * runner. Never throws.
   */
  private fireVerification(
    agentName: string,
    channelId: string | null,
    response: string,
    verifyHopCount: number,
    turn: Turn | undefined,
    promptChars?: number,
  ): void {
    let turnCostMs: number | null = null;
    let toolExecutionMs: number | null = null;
    let effortTier: string | null = null;
    try {
      turnCostMs = turn?.getElapsedMs() ?? null;
    } catch {
      turnCostMs = null;
    }
    try {
      toolExecutionMs = turn?.getToolExecutionMsSoFar() ?? null;
    } catch {
      toolExecutionMs = null;
    }
    try {
      effortTier = this.sessionManager.getEffortForAgent(agentName);
    } catch {
      effortTier = null;
    }
    void this.verificationRunner.run({
      agentName,
      channelId,
      response,
      verifyHopCount,
      // 999.63c — delivered-ref correlation key for edit-in-place
      // corrections; Turn.id is `discord:<trigger-snowflake>`.
      turnId: turn?.id ?? null,
      turnCostMs,
      toolExecutionMs,
      effortTier,
      promptChars,
    });
  }

  /**
   * C (2026-08-26) — pre-delivery verification hold, called by the bridge
   * at the delivery seam for `verification.holdDelivery` agents.
   * Thin adapter: fills the Turn-derived telemetry riders (mirroring
   * fireVerification) and delegates to the runner, which owns
   * classification, the bounded hop, patching, dedupe marks, and the
   * fail-open contract (this method never throws).
   */
  async preDeliveryVerify(args: {
    readonly agentName: string;
    readonly channelId: string | null;
    readonly response: string;
    readonly turn: Turn | undefined;
  }): Promise<PreDeliveryVerifyResult> {
    let turnCostMs: number | null = null;
    let toolExecutionMs: number | null = null;
    let effortTier: string | null = null;
    try {
      turnCostMs = args.turn?.getElapsedMs() ?? null;
    } catch {
      turnCostMs = null;
    }
    try {
      toolExecutionMs = args.turn?.getToolExecutionMsSoFar() ?? null;
    } catch {
      toolExecutionMs = null;
    }
    try {
      effortTier = this.sessionManager.getEffortForAgent(args.agentName);
    } catch {
      effortTier = null;
    }
    return this.verificationRunner.preDeliveryVerify({
      agentName: args.agentName,
      channelId: args.channelId,
      turnId: args.turn?.id ?? null,
      response: args.response,
      turnCostMs,
      toolExecutionMs,
      effortTier,
    });
  }

  /**
   * Phase 96 Plan 04 D-10 — post-turn DUAL detector hook.
   *
   * Invoked at the end of every successful TurnDispatcher.dispatch() /
   * dispatchStream() call (BEFORE returning to the caller). Runs both
   * detectMissedUpload AND detectOpenClawFallback in SIBLING try/catch
   * blocks so a failure in one detector does NOT prevent the other from
   * firing. Neither blocks the caller — both detectors are non-blocking
   * soft signals that surface to admin-clawdy via Phase 91 alert dedup.
   *
   * No-op when alertAdminClawdy is not wired (zero perf cost on the
   * normal path).
   */
  private firePostTurnDetectors(agentName: string, response: string): void {
    if (!this.alertAdminClawdy) return;
    const alert = this.alertAdminClawdy;
    // Phase 999.63 Plan 02 T-02 — pass `agentName` so the wired
    // recentToolCallNames closure reads the correct agent's active-turn
    // tool-name accumulator.
    const toolCallNames = this.recentToolCallNames?.(agentName) ?? [];

    // Sibling 1 — missed-upload (non-blocking).
    try {
      detectMissedUpload(response, toolCallNames, { alert });
    } catch (err) {
      try {
        this.log.warn(
          { err: (err as Error).message },
          "missed-upload detector failed (non-blocking)",
        );
      } catch {
        // Logger threw — swallow.
      }
    }

    // Sibling 2 — OpenClaw-fallback (non-blocking).
    // SEPARATE try/catch so a failure here can't prevent missed-upload from
    // running and vice versa. Each detector has its OWN failure isolation.
    try {
      detectOpenClawFallback(response, { alert });
    } catch (err) {
      try {
        this.log.warn(
          { err: (err as Error).message },
          "openclaw-fallback detector failed (non-blocking)",
        );
      } catch {
        // Logger threw — swallow.
      }
    }
  }


  /**
   * Phase 94 Plan 04 D-06 — single-source-of-truth MCP tool-call wrap site.
   *
   * Runs the supplied executor exactly ONCE. On success, returns the
   * verbatim content the executor resolved. On rejection, routes the
   * failure through `wrapMcpToolError` (populating alternatives via
   * `findAlternativeAgents` when a state provider is wired) and returns
   * the JSON-stringified `ToolCallError` shape with `isError: true`.
   *
   * NO SILENT RETRY here. Recovery (Plan 94-03) is heartbeat-driven and
   * lives at the connection layer; this method's contract is single-
   * attempt-then-wrap so the LLM sees the structured failure and adapts
   * naturally (asks the user, switches to an alternative agent, etc.).
   *
   * Production tool-call execution paths funnel through this method so
   * the wrap behavior is uniform across every MCP-backed tool. Direct
   * invocation of MCP tool calls without this wrap is a regression and
   * pinned by static-grep against the call site.
   */
  async executeMcpTool(
    toolName: string,
    executor: () => Promise<string>,
  ): Promise<ExecuteMcpToolResult> {
    try {
      const content = await executor();
      return { content, isError: false };
    } catch (err) {
      const wrapped: ToolCallError = wrapMcpToolError(err as Error, {
        tool: toolName,
        findAlternatives: this.mcpStateProvider
          ? () => findAlternativeAgents(toolName, this.mcpStateProvider!)
          : undefined,
        suggestionFor: this.toolErrorSuggestion,
      });
      // Best-effort log so operators can correlate the wrap with the
      // upstream symptom; observational only — never breaks the wrap path.
      try {
        this.log.warn(
          {
            tool: toolName,
            errorClass: wrapped.errorClass,
            alternatives: wrapped.alternatives,
          },
          "mcp tool call rejected — wrapped as ToolCallError",
        );
      } catch {
        // observational path — never block the wrap
      }
      return { content: JSON.stringify(wrapped), isError: true };
    }
  }

  /**
   * Dispatch a non-streaming turn. Mirrors SessionManager.dispatchTurn's
   * return shape (the collected response string).
   *
   * Opens a Turn via the agent's TraceCollector (if wired), sets id to
   * origin.rootTurnId (already source-prefixed), and ends the Turn with
   * success/error before returning/throwing. If no collector is wired
   * for `agentName` (test scenarios / agent not yet running), dispatch
   * still succeeds — it forwards `undefined` for the Turn arg.
   */
  async dispatch(
    origin: TurnOrigin,
    agentName: string,
    message: string,
    options: DispatchOptions = {},
  ): Promise<string> {
    if (agentName.length === 0) {
      throw new TurnDispatcherError("agentName must be non-empty", agentName, origin.rootTurnId);
    }

    // 2026-07-31 — real traffic yields the verify hop: bump the agent's
    // epoch (skips a deferred hop) and abort any in-flight corrective
    // dispatch so this turn reclaims the queue slot within
    // ~INTERRUPT_DEADLINE_MS. Internally guarded; never throws.
    this.verificationRunner.notifyIncomingTurn(agentName);

    // Phase 83 EFFORT-05 — capture prior effort + apply per-skill override.
    // Only reaches into the session handle when options.skillEffort is set
    // (zero side effects on the normal path). Snapshot happens AT dispatch
    // time so live /clawcode-effort changes between turns propagate correctly.
    const priorEffort = this.applySkillEffort(agentName, options.skillEffort);

    // Phase 90 MEM-05 — fire-and-forget cue detection on the RAW user
    // message (not the augmented one). Runs BEFORE the SDK send so the
    // cue write races the turn; scanner picks it up on the next poll
    // (but the current turn still sees any prior standing rules via MEM-03
    // retrieval). Synchronous caller: no await — .catch on the inner
    // Promise swallows rejections with a warn log.
    this.maybeFireCueHook(origin, agentName, message, options.channelId ?? null);

    // Phase 90 MEM-03 — pre-turn hybrid RRF retrieval. Prepends a
    // <memory-context> block to the user message when chunks are found.
    // Lands in mutable suffix — stable prefix cache untouched. Fail-open.
    // Context-bloat #2 — `options.turn` (caller-owned, the production
    // path) is threaded so the rendered block size is measurable.
    const augmentedMessage = this.applyOutputStyle(
      agentName,
      this.applyResearchRoute(
        agentName,
        origin,
        message,
        await this.augmentWithMemoryContext(agentName, message, options.turn),
      ),
    );

    // Phase 57 Plan 03: caller-owned Turn branch. When the caller provided
    // their own Turn (DiscordBridge pre-opens the Turn + receive-span before
    // calling us), attach the origin and forward — caller retains end() ownership.
    if (options.turn) {
      try { options.turn.recordOrigin(origin); } catch { /* non-fatal — trace side-effect */ }
      try {
        let response = await this.sessionManager.dispatchTurn(agentName, augmentedMessage, options.turn, { signal: options.signal });
        // Phase 96 D-10 — post-turn DUAL detector hook. Non-blocking; runs after
        // SDK send completes, before returning to caller-owned-Turn caller.
        // Caller-owned Turn: still registered here (caller ends it later), so
        // the Phase 999.63 recentToolCallNames closure sees a live active turn.
        this.firePostTurnDetectors(agentName, response);
        // Phase 999.63 Plan 03 — financial-verification gate. Fire-and-forget
        // (void): the corrective re-prompt runs AFTER this dispatch returns
        // the original draft; never blocks the caller. See <serial-turn-queue-
        // analysis> for deadlock-freedom.
        response = this.stripModelSources(agentName, response);
        this.fireVerification(
          agentName,
          options.channelId ?? null,
          response,
          options.verifyHopCount ?? 0,
          options.turn,
          message.length,
        );
        return response;
      } finally {
        this.restoreEffort(agentName, priorEffort);
      }
    }

    const turn = this.openTurn(origin, agentName, options.channelId ?? null);
    if (turn) {
      try { turn.recordOrigin(origin); } catch { /* non-fatal */ }
    }
    try {
      let response = await this.sessionManager.dispatchTurn(agentName, augmentedMessage, turn, { signal: options.signal });
      // Phase 96 D-10 — post-turn DUAL detector hook (missed-upload +
      // openclaw-fallback). Non-blocking sibling try/catch in
      // firePostTurnDetectors. Soft warnings to admin-clawdy via Phase 91
      // alert dedup (distinct keys).
      // Phase 999.63 Plan 02 T-02 [Rule 1 — bug fix] — runs BEFORE
      // turn.end(): end() calls collector.unregisterActiveTurn, so the
      // wired recentToolCallNames closure must observe the turn while it is
      // still registered. The two operations are independent (detectors
      // only read accumulated tool names; end() commits the trace) — the
      // prior order silently fed the detectors [] on every self-owned turn.
      this.firePostTurnDetectors(agentName, response);
      // Phase 999.63 Plan 03 — financial-verification gate (self-owned-Turn
      // dispatch branch). Fire-and-forget; runs before turn.end() so the
      // gate's recentToolCallNames snapshot still sees a live active turn,
      // for the same reason firePostTurnDetectors does (Plan 02 deviation #1).
      response = this.stripModelSources(agentName, response);
      this.fireVerification(
        agentName,
        options.channelId ?? null,
        response,
        options.verifyHopCount ?? 0,
        turn,
        message.length,
      );
      try { turn?.end("success"); } catch { /* non-fatal — trace write is best-effort */ }
      return response;
    } catch (err) {
      try { turn?.end("error"); } catch { /* non-fatal */ }
      throw err;
    } finally {
      this.restoreEffort(agentName, priorEffort);
    }
  }

  /**
   * Dispatch a streaming turn. Mirrors SessionManager.streamFromAgent.
   * Same Turn lifecycle contract as dispatch().
   */
  async dispatchStream(
    origin: TurnOrigin,
    agentName: string,
    message: string,
    onChunk: (accumulated: string) => void,
    options: DispatchOptions = {},
  ): Promise<string> {
    if (agentName.length === 0) {
      throw new TurnDispatcherError("agentName must be non-empty", agentName, origin.rootTurnId);
    }

    // 2026-07-31 — yield hook, same contract as dispatch() above.
    this.verificationRunner.notifyIncomingTurn(agentName);

    // Phase 83 EFFORT-05 — same pre/post wrap as dispatch().
    const priorEffort = this.applySkillEffort(agentName, options.skillEffort);

    // Phase 90 MEM-05 — fire-and-forget cue hook (same contract as dispatch).
    this.maybeFireCueHook(origin, agentName, message, options.channelId ?? null);

    // Phase 90 MEM-03 — pre-turn retrieval + <memory-context> wrap.
    // Context-bloat #2 — thread `options.turn` for section measurement.
    const augmentedMessage = this.applyOutputStyle(
      agentName,
      this.applyResearchRoute(
        agentName,
        origin,
        message,
        await this.augmentWithMemoryContext(agentName, message, options.turn),
      ),
    );

    // Phase 57 Plan 03: caller-owned Turn branch (see dispatch() for rationale).
    if (options.turn) {
      try { options.turn.recordOrigin(origin); } catch { /* non-fatal */ }
      try {
        let response = await this.sessionManager.streamFromAgent(agentName, augmentedMessage, onChunk, options.turn, { signal: options.signal, onToolUse: options.onToolUse, images: options.images });
        // Phase 96 D-10 — post-turn DUAL detector hook (caller-owned-Turn streaming branch).
        // Caller-owned Turn: still registered here — see dispatch() branch above.
        this.firePostTurnDetectors(agentName, response);
        // Phase 999.63 Plan 03 — financial-verification gate
        // (caller-owned-Turn streaming branch). Fire-and-forget.
        response = this.stripModelSources(agentName, response);
        this.fireVerification(
          agentName,
          options.channelId ?? null,
          response,
          options.verifyHopCount ?? 0,
          options.turn,
          message.length,
        );
        return response;
      } finally {
        this.restoreEffort(agentName, priorEffort);
      }
    }

    const turn = this.openTurn(origin, agentName, options.channelId ?? null);
    if (turn) {
      try { turn.recordOrigin(origin); } catch { /* non-fatal */ }
    }
    try {
      let response = await this.sessionManager.streamFromAgent(
        agentName,
        augmentedMessage,
        onChunk,
        turn,
        { signal: options.signal, onToolUse: options.onToolUse, images: options.images },
      );
      // Phase 96 D-10 — post-turn DUAL detector hook (streaming branch).
      // Phase 999.63 Plan 02 T-02 [Rule 1 — bug fix] — runs BEFORE
      // turn.end() so the recentToolCallNames closure observes a live
      // active turn (see the non-streaming dispatch() branch for rationale).
      this.firePostTurnDetectors(agentName, response);
      // Phase 999.63 Plan 03 — financial-verification gate (self-owned-Turn
      // streaming branch). Fire-and-forget; runs before turn.end().
      response = this.stripModelSources(agentName, response);
      this.fireVerification(
        agentName,
        options.channelId ?? null,
        response,
        options.verifyHopCount ?? 0,
        turn,
        message.length,
      );
      try { turn?.end("success"); } catch { /* non-fatal */ }
      return response;
    } catch (err) {
      try { turn?.end("error"); } catch { /* non-fatal */ }
      throw err;
    } finally {
      this.restoreEffort(agentName, priorEffort);
    }
  }

  /**
   * Context-bloat fix #2-A — cadence gate for `augmentWithMemoryContext`.
   *
   * Increments the per-agent turn counter and returns whether retrieval
   * should run THIS turn. Retrieval runs on turn 1 and then every
   * `MEMORY_RETRIEVAL_CADENCE_TURNS` turns thereafter; intervening turns
   * skip the prepend (the agent still carries the last refresh's block).
   * Called exactly once per dispatched turn from `augmentWithMemoryContext`.
   */
  private shouldRefreshMemoryContext(
    agentName: string,
    query: string,
  ): Promise<{ refresh: boolean; reason: string }> {
    // Phase 999.187 — delegated to the shared RetrievalCadenceGate so the v2
    // and v3 paths apply one rule: turn 1, every K turns, or a topic shift.
    return this.cadenceGate.shouldRefresh(agentName, query);
  }

  /**
   * Context-bloat #2 measurement — record the per-turn `<memory-context>`
   * block size on a `context_assemble` span.
   *
   * `clawcode context-audit` aggregates `section_tokens` from spans named
   * `context_assemble`. The memory-context block is built here in the
   * dispatcher (after assembly), so it never reached that span before —
   * the audit was blind to it. This opens a short-lived `context_assemble`
   * span carrying ONLY `{ section_tokens: { memory_context } }`; the audit
   * reads each section independently, so a partial blob is fine.
   *
   * No-op when `turn` is undefined (untraced callers — tests, the
   * self-owned dispatch path). Fully best-effort: any trace error is
   * swallowed so the turn proceeds.
   */
  private emitMemoryContextSection(turn: Turn | undefined, tokens: number): void {
    if (!turn) return;
    try {
      const span = turn.startSpan("context_assemble");
      span.setMetadata({ section_tokens: { memory_context: tokens } });
      span.end();
    } catch {
      // Trace emission is observational — never fail the turn over it.
    }
  }

  /**
   * Phase 90 MEM-03 — augment the user message with retrieved memory
   * chunks as a `<memory-context>` prefix. Runs only when a memoryRetriever
   * was wired (DI), the message is non-trivially short, and retrieval
   * returns chunks. Fail-open: any retriever error or no-chunks-found
   * result yields the original message unchanged.
   *
   * Context-bloat fix #2-A — the retrieval+prepend is now gated on a
   * per-agent cadence (`MEMORY_RETRIEVAL_CADENCE_TURNS`). On a non-refresh
   * turn the original message is returned unchanged, so no new
   * `<memory-context>` block accumulates in the SDK transcript. The
   * counter still advances on every turn so the cadence stays aligned.
   *
   * Landing region: mutable suffix (the per-turn user message body). The
   * stable prefix (system prompt / SOUL / IDENTITY / MEMORY.md auto-load
   * per Plan 90-01) is NOT touched — v1.7 two-block cache stability is
   * preserved.
   *
   * Measurement (context-bloat #2) — when a `turn` is threaded (production
   * path: DiscordBridge pre-opens the Turn), the rendered `<memory-context>`
   * block's token count is emitted onto a `context_assemble` span as
   * `section_tokens.memory_context`, so `clawcode context-audit` can
   * measure the cadence-gated section. Untraced callers skip emission.
   */
  private async augmentWithMemoryContext(
    agentName: string,
    message: string,
    turn?: Turn,
  ): Promise<string> {
    if (!this.memoryRetriever) return message;
    const query = message.trim();
    if (query.length === 0) return message;
    // Context-bloat fix #2-A — advance the cadence counter and gate the
    // retrieval. The counter advances once per turn that actually reaches
    // here (retriever wired + non-empty query); on a non-refresh turn we
    // return the original message so no new <memory-context> block lands.
    const cadence = await this.shouldRefreshMemoryContext(agentName, query);
    if (!cadence.refresh) {
      return message;
    }
    if (cadence.reason === "topic-shift") {
      this.log.debug({ agent: agentName }, "memory-context: refreshed on topic shift");
    }
    // Phase 999.119 pass 2 — time the retrieval itself. The
    // `context_assemble` span emitted below carries only the rendered
    // block's token count (zero duration), so until now nothing measured
    // how long the pre-turn memory lookup actually took. Best-effort: a
    // trace failure never touches the turn.
    let retrievalSpan: ReturnType<Turn["startSpan"]> | undefined;
    try {
      retrievalSpan = turn?.startSpan("memory_retrieval");
    } catch {
      retrievalSpan = undefined;
    }
    const endRetrievalSpan = (extra: Record<string, unknown>): void => {
      if (!retrievalSpan) return;
      try {
        retrievalSpan.setMetadata(extra);
        retrievalSpan.end();
      } catch {
        /* observational */
      }
      retrievalSpan = undefined;
    };
    try {
      const chunks = await this.memoryRetriever(agentName, query);
      endRetrievalSpan({
        chunks: chunks.length,
        memories: chunks.filter((c) => c.source === "memory").length,
      });
      if (chunks.length === 0) return message;
      // Phase 999.124 — record the recall for the reply footer (opt-out per
      // agent via `memoryRecallFooter: false`). Guarded so a session manager
      // without the config lookup (tests, standalone) never breaks the turn.
      if (this.recallFooterEnabled(agentName)) {
        this.pendingRecall.set(agentName, summarizeRecall(chunks));
      }
      // Phase 141 — shared renderer (single source for the block format, used by
      // both the v2 dispatch here and the v3 MemoryContextAugmenter).
      const wrapper = renderMemoryContext(chunks);
      // Context-bloat #2 measurement — emit the rendered block's token
      // count onto a `context_assemble` span so `context-audit` can see
      // the `memory_context` section. Best-effort: a trace failure must
      // never break the turn (the whole augment path is fail-open).
      this.emitMemoryContextSection(turn, countTokens(wrapper));
      return wrapper + message;
    } catch (err) {
      endRetrievalSpan({ error: (err as Error).message });
      this.log.warn(
        { agent: agentName, error: (err as Error).message },
        "memory retrieval failed — continuing without context (fail-open)",
      );
      return message;
    }
  }

  /** Phase 999.124 — per-agent opt-out; absent config = on. */
  private recallFooterEnabled(agentName: string): boolean {
    const sm = this.sessionManager as {
      getAgentConfig?: (name: string) => { memoryRecallFooter?: boolean } | undefined;
    };
    if (typeof sm.getAgentConfig !== "function") return true;
    try {
      return sm.getAgentConfig(agentName)?.memoryRecallFooter !== false;
    } catch {
      return true;
    }
  }

  /**
   * Phase 999.124 — hand the recall record for `agentName`'s latest turn to
   * the delivery epilogue, ONCE. Undefined when the turn's retrieval did
   * not run (cadence), returned nothing, or the record is older than
   * {@link RECALL_FOOTER_TTL_MS} (its turn never reached delivery).
   */
  consumeRecallFooter(agentName: string, now: number = Date.now()): RecallRecord | undefined {
    const record = this.pendingRecall.get(agentName);
    this.pendingRecall.delete(agentName);
    if (!record) return undefined;
    return now - record.at <= RECALL_FOOTER_TTL_MS ? record : undefined;
  }

  /**
   * Phase 83 EFFORT-05 — apply a per-skill effort override, returning the
   * prior level so the caller can revert in a finally block.
   *
   * Returns null when no override is requested (skillEffort undefined) —
   * the caller uses this sentinel to short-circuit the revert. Never
   * throws: if the snapshot or setEffort calls fail (agent not running,
   * SDK rejection), we log a warning and return null so the turn still
   * proceeds without the override. The revert path is gated on non-null,
   * so a failed apply means a failed no-op revert — state stays coherent.
   */
  private applySkillEffort(agentName: string, skillEffort: EffortLevel | undefined): EffortLevel | null {
    if (!skillEffort) return null;
    // Quick 260715-j1j (D9, layer 2) — defensively clamp ultracode → xhigh.
    // Layer 1 is the scanner's frontmatter rejection (extractEffortFrontmatter
    // returns null for ultracode); this clamp holds even if that layer is
    // ever bypassed, so a skill can never flip the native-Workflow
    // orchestration mode mid-turn. The revert path (restoreEffort) is
    // deliberately unclamped — restoring a prior ultracode goes back through
    // the setEffortForAgent gate legitimately.
    const effectiveEffort: EffortLevel = skillEffort === "ultracode" ? "xhigh" : skillEffort;
    try {
      const prior = this.sessionManager.getEffortForAgent(agentName);
      // 999.63d effort-clobber fix — skill pins are TRANSIENT (handle
      // only, no durable persist; see setEffortForAgentTransient).
      this.sessionManager.setEffortForAgentTransient(agentName, effectiveEffort);
      return prior;
    } catch (err) {
      this.log.warn(
        { agent: agentName, skillEffort, error: (err as Error).message },
        "turn-dispatcher: skill-effort apply failed — continuing without override",
      );
      return null;
    }
  }

  /**
   * Phase 83 EFFORT-05 — revert to the prior effort level in the finally block.
   *
   * Pairs with applySkillEffort: invoked even on error paths so a runaway
   * turn cannot leave an agent stuck at an elevated level. Null priorEffort
   * means "no override was applied" → no-op. Revert failures are logged
   * and swallowed (same rationale as apply: a transient SDK failure must
   * never propagate past the turn boundary as a hidden exception on top
   * of whatever the original dispatch returned).
   */
  private restoreEffort(agentName: string, priorEffort: EffortLevel | null): void {
    if (priorEffort === null) return;
    try {
      // 999.63d effort-clobber fix — restore is TRANSIENT: the prior
      // level was live on this handle moments ago (an ultracode restore
      // needs no re-gating), and persisting it is exactly the boot-race
      // that clobbered the operator's stored override.
      this.sessionManager.setEffortForAgentTransient(agentName, priorEffort);
    } catch (err) {
      this.log.warn(
        { agent: agentName, priorEffort, error: (err as Error).message },
        "turn-dispatcher: skill-effort revert failed — agent may be at wrong level",
      );
    }
  }

  /**
   * Phase 90 MEM-05 — cue detection + writeCueMemory + Discord ✅ reaction,
   * all wrapped in a fire-and-forget canary per Phase 83/86/87/89 blueprint.
   *
   * The synchronous caller returns immediately — the cue write + reaction
   * race the agent turn. The scanner picks up the new memory file within
   * ≤1s (chokidar awaitWriteFinish 300ms + stabilityThreshold + ready),
   * so the standing rule is available on the NEXT turn's retrieval pass.
   *
   * Rejections on any leg (cue writer throw, Discord reaction failure) are
   * warn-logged and DO NOT propagate — the user's turn must complete
   * regardless of the cue-capture side-channel's health.
   */
  private maybeFireCueHook(
    origin: TurnOrigin,
    agentName: string,
    userMessage: string,
    channelId: string | null,
  ): void {
    if (!this.memoryCueWriter || !this.workspaceForAgent) return;
    const detection = detectCue(userMessage);
    if (!detection.match || !detection.captured) return;
    const workspace = this.workspaceForAgent(agentName);
    if (!workspace) return; // agent not yet registered / workspace unknown
    const turnIso = new Date().toISOString();
    const context = extractCueContext(userMessage);
    // Extract the originating Discord message id (if any) so the reaction
    // and discord_link frontmatter land correctly. The TurnOrigin shape
    // carries the sourceId under source.id; we only fire the reaction for
    // discord-originated turns (OpenAI / scheduler / task / trigger have
    // nothing to react to).
    const messageId: string | undefined =
      origin.source.kind === "discord" ? origin.source.id : undefined;
    // discord_link frontmatter — left undefined here because constructing
    // a canonical discord.com/channels/<guild>/<channel>/<message> URL
    // requires the guildId which TurnDispatcher doesn't carry. Consumers
    // (memory retrieval / operators) can look up the link via the
    // message_id if needed. Future plan can add the full URL by threading
    // guildId through DispatchOptions.
    const messageLink: string | undefined = undefined;

    const writer = this.memoryCueWriter;
    const reactor = this.discordReact;
    void writer({
      workspacePath: workspace,
      cue: detection.captured,
      context,
      turnIso,
      messageLink,
    })
      .then(() => {
        if (messageId && channelId && reactor) {
          void reactor({ channelId, messageId }, "✅").catch((err) => {
            this.log.warn(
              { err: (err as Error).message, agent: agentName, messageId },
              "cue discord reaction failed (non-fatal)",
            );
          });
        }
      })
      .catch((err) => {
        this.log.warn(
          { err: (err as Error).message, agent: agentName },
          "cue memory write failed (non-fatal)",
        );
      });
  }

  /**
   * Phase 90 MEM-06 — public entry point for Task-tool-return observers.
   *
   * Invoked by the session adapter (or its tool-return stream-observer)
   * when a Task tool call resolves with a subagent's final report. Does
   * NOT take an AbortSignal — this is a persistence side-channel, not a
   * turn-lifecycle operation.
   *
   * D-35 exclusion lives inside captureSubagentReturn itself (isGsdSubagent
   * short-circuits there), so we don't re-check here; keeps the public
   * interface decoupled from the exclusion policy.
   */
  async handleTaskToolReturn(
    agentName: string,
    event: TaskToolReturnEvent,
  ): Promise<void> {
    if (!this.subagentCapture || !this.workspaceForAgent) return;
    const workspace = this.workspaceForAgent(agentName);
    if (!workspace) return;
    const capture = this.subagentCapture;
    // Fire-and-forget discipline — never reject back to the caller. The
    // SDK's Task tool call continues regardless of whether this persists.
    void capture({
      workspacePath: workspace,
      subagent_type: event.subagent_type,
      task_description: event.task_description,
      return_summary: event.return_summary,
      spawned_at_iso: event.spawned_at_iso,
      duration_ms: event.duration_ms,
    }).catch((err) => {
      this.log.warn(
        {
          err: (err as Error).message,
          agent: agentName,
          subagent_type: event.subagent_type,
        },
        "subagent capture failed (non-fatal)",
      );
    });
  }

  /**
   * Open a Turn for this dispatch via the agent's TraceCollector. Returns
   * undefined when no collector is wired for the agent (tests / agent not
   * running). Non-fatal failure path — matches the existing DiscordBridge
   * + TaskScheduler pattern of wrapping startTurn in try/catch.
   */
  private openTurn(origin: TurnOrigin, agentName: string, channelId: string | null) {
    try {
      const collector = this.sessionManager.getTraceCollector(agentName);
      if (!collector) return undefined;
      return collector.startTurn(origin.rootTurnId, agentName, channelId);
    } catch (err) {
      this.log.warn(
        { agent: agentName, rootTurnId: origin.rootTurnId, error: (err as Error).message },
        "turn-dispatcher: trace setup failed — continuing without tracing",
      );
      return undefined;
    }
  }
}
