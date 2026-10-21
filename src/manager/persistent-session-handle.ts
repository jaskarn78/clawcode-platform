/**
 * Phase 73 Plan 01 — Persistent per-agent SDK session handle.
 *
 * ONE sdk.query({ prompt: asyncIterable, options: {...} }) per agent lifetime
 * PER EPOCH. `handle.swap(newSessionId)` opens a new epoch by closing the
 * current SDK query and constructing a fresh one resumed against the new
 * session id (Phase 124 Plan 05 — live hot-swap for operator-triggered
 * compaction). Within a single epoch the original invariants hold; the swap
 * is gated through the SerialTurnQueue so it cannot interleave with an
 * in-flight turn.
 *
 * Replaces wrapSdkQuery's per-turn sdk.query() pattern from session-adapter.ts.
 * See 73-RESEARCH.md Pattern 1 for the SDK contract + Pitfalls 1/2/3.
 *
 * Invariants (enforced by tests in __tests__/persistent-session-handle.test.ts
 * + __tests__/persistent-session-handle-swap.test.ts):
 *   - Exactly ONE sdk.query() call per handle PER EPOCH, regardless of turn
 *     count within that epoch. Swap opens a new epoch.
 *   - The driverIter (Query[Symbol.asyncIterator]) is captured ONCE per epoch
 *     and consumed across all turns in that epoch; each per-turn
 *     `iterateUntilResult` breaks out when its `result` message arrives,
 *     leaving the next turn's messages for the next invocation.
 *   - Abort mid-turn races `q.interrupt()` with a 2s deadline. First to fire
 *     ends the turn handler with an AbortError and releases the queue slot.
 *   - onError fires when the generator throws; any in-flight turn rejects with
 *     the same error; `generatorDead` flag prevents further sends.
 *   - SessionHandle public surface is byte-identical to session-adapter's
 *     SessionHandle type (swap is an additive-optional extension).
 *   - swap() builds the new SDK query BEFORE closing the old one. If the SDK
 *     rejects the rebuild, the old epoch remains intact and the caller sees
 *     swap rejection; never leaves the handle in a half-built state.
 */

import { evidenceFromToolResult, evidenceFromToolUse } from "./evidence-ledger.js";
// Phase 999.114 — the effort-`off` thinking guard keys on the catalog family
// flag (`requiresThinking`) instead of a hardcoded model id literal.
import { deriveFamily } from "./model-resolver.js";
import { MODEL_FAMILY_CATALOG } from "../shared/model-catalog.js";
import { emitTodoUpdate } from "../discord/todo-mirror.js";
import type { SdkModule, SdkPlanUsage, SdkQuery, SdkQueryOptions, SdkStreamMessage, SdkUserMessage, SlashCommand, ModelInfo, PermissionMode } from "./sdk-types.js";
import type {
  SessionHandle,
  SendOptions,
  SendImageInput,
  UsageCallback,
  PrefixHashProvider,
  SkillTrackingConfig,
  AdvisorObserverConfig,
  AdapterBaseOptions,
} from "./session-adapter.js";
// Phase 127 — stream-stall supervisor module. Single chokepoint for the
// no-useful-tokens timeout (per feedback_silent_path_bifurcation.md): the
// production iteration loop AND the test-only wrapSdkQuery path both
// import this factory so the trip logic is testable in isolation.
import {
  createStreamStallTracker,
  streamEventHasUsefulDelta,
  type StreamStallTracker,
  type StreamStallPayload,
} from "./stream-stall-tracker.js";
// WS-1 (999.99 structural delivery) — turn-attributed stream demux. When the
// per-agent `attributedStream` flag is on, each epoch's raw driver iterator
// is owned by an AttributedStreamDemux; the legacy iteration loop consumes
// the demuxed turn iterator UNCHANGED, and self-fired (orphan) turn output
// delivers via onOrphanTurnOutput instead of buffering into the next reply.
import { AttributedStreamDemux } from "./attributed-stream-demux.js";
// 999.171 — per-turn live-thinking fan-out (the bridge registers the sink).
import { emitThinkingTokens } from "./thinking-sink.js";
import { logSuggestionDrop, offerPromptSuggestion, routePromptSuggestion } from "./suggestion-sink.js";
import { TaskIdMap } from "./task-id-map.js";
import { ResearchTracker } from "./research-tracker.js";
import {
  asksToResumeResearch,
  discordMessageIdOf,
  registerResearchTracker,
  setLiveDiscordTurn,
} from "./research-registry.js";
import { BackgroundTaskBoard, registerBackgroundBoard } from "./background-task-board.js";
import { join as joinPath } from "node:path";
// Debug session `in-tool-wedge-recovery` work-stream (B) — the WedgeInfo
// shape attached to the thrown AbortError so the Discord layer can decide
// auto-rerun vs notify. Type-only import; the classifier module is pure
// and has no local imports, so no cycle.
import type { WedgeInfo } from "./tool-mutation-classifier.js";
// Work-stream (C), FORK 8 — `isDetachableTool` decides whether a wedged
// in-flight tool can be cleanly detached via `Query.backgroundTasks`
// (Bash / Task) vs must fall back to the blunt `forceReleaseTurn`.
import { isDetachableTool } from "./tool-mutation-classifier.js";
// Phase 117 Plan 04 T03 — typed advisor event payloads. The observer
// emits the two events via `advisorObserver.advisorEvents.emit(name, payload)`
// where payload conforms to these shapes. RESEARCH §13.10 — emitter
// ownership lives on SessionManager; payload shapes live in src/advisor/types.ts.
import type {
  AdvisorInvokedEvent,
  AdvisorResultedEvent,
} from "../advisor/types.js";
import type { Turn, Span } from "../performance/trace-collector.js";
import type { EffortLevel } from "../config/schema.js";
import type { McpServerState } from "../mcp/readiness.js";
import type { FlapHistoryEntry } from "./filter-tools-by-capability-probe.js";
import type { AttemptRecord } from "./recovery/types.js";
import type { RateLimitTracker } from "../usage/rate-limit-tracker.js";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * Phase 94 Plan 01 — capability probe types re-anchored at this file path
 * for the static-grep regression pins (the plan's acceptance criteria
 * verify `export type CapabilityProbeStatus`, `interface CapabilityProbeSnapshot`,
 * and `capabilityProbe?:` are all visible at this path). Single source of
 * truth for the runtime types lives in src/mcp/readiness.ts where
 * McpServerState is defined; the structural-typing equivalents below are
 * verified against the canonical types via the assignment expressions at
 * module-load — any drift fails to compile.
 *
 * D-02 status enum locked at exactly 5 values:
 *   "ready" | "degraded" | "reconnecting" | "failed" | "unknown"
 * Adding a 6th value cascades through Plans 94-02/03/04/07.
 *
 * The `capabilityProbe?:` field on McpServerState is additive-optional —
 * Phase 85 callers ignoring the new field continue to compile/execute
 * unchanged.
 */
export type CapabilityProbeStatus =
  | "ready"
  | "degraded"
  | "reconnecting"
  | "failed"
  | "unknown";

export interface CapabilityProbeSnapshot {
  /** ISO8601 — when this probe last ran. */
  readonly lastRunAt: string;
  /** Current capability status (D-02 5-value enum). */
  readonly status: CapabilityProbeStatus;
  /** Verbatim error message from the failed probe (Phase 85 TOOL-04). */
  readonly error?: string;
  /** ISO8601 — most recent ready outcome; preserved across degraded ticks. */
  readonly lastSuccessAt?: string;
}

// Compile-time structural-equivalence guard: the local types above must
// remain assignable to the canonical types in readiness.ts in both
// directions. If the readiness.ts definition drifts, this assignment
// fails at build time. The capabilityProbe?: field shape is the
// additive-optional extension on McpServerState.
const _capabilityProbeStatusGuard: CapabilityProbeStatus =
  "ready" as import("../mcp/readiness.js").CapabilityProbeStatus;
void _capabilityProbeStatusGuard;
const _capabilityProbeSnapshotGuard: CapabilityProbeSnapshot = {
  lastRunAt: "",
  status: "unknown",
} as import("../mcp/readiness.js").CapabilityProbeSnapshot;
void _capabilityProbeSnapshotGuard;

/**
 * Phase 96 Plan 01 D-CONTEXT — filesystem capability primitives.
 *
 * 3-value status enum (ready|degraded|unknown) — INTENTIONALLY DIVERGES
 * from Phase 94's 5-value MCP capability enum because filesystem capability
 * has no reconnect/failed analog: operator-driven ACL changes don't
 * transition through transient connect states. A path is either readable
 * NOW (ready), declared-but-not-readable (degraded), or never probed
 * (unknown).
 *
 * Adding a 4th value (such as the Phase 94 transient-state enum entries)
 * requires explicit STATE.md decision and cascades through Plans
 * 96-02/03/04/05/07 consumers. Pinned by static-grep in 96-01-PLAN.md.
 *
 * Mode enum models POSIX read/write permissions:
 *   - "rw"     — fs.access(R_OK | W_OK) succeeded
 *   - "ro"     — fs.access(R_OK) succeeded; W_OK either denied or not probed
 *   - "denied" — fs.access(R_OK) failed
 *
 * Verbatim error pass-through (Phase 85 TOOL-04 inheritance): the `error`
 * field carries the raw `err.message` from `fs.access` — no wrapping, no
 * classification at probe layer. ToolCallError schema (Phase 94 D-06) does
 * the classification at the executor edge in 96-03 / 96-04.
 */
export type FsCapabilityStatus =
  | "ready"          // fs.access(R_OK) succeeded — path readable now
  | "degraded"       // declared in fileAccess but fs.access failed
  | "unknown";       // never probed (boot pre-warm-path)

export type FsCapabilityMode = "rw" | "ro" | "denied";

export interface FsCapabilitySnapshot {
  /** D-02 3-value status enum. */
  readonly status: FsCapabilityStatus;
  /** POSIX read/write mode classification. */
  readonly mode: FsCapabilityMode;
  /** ISO8601 — when this probe last ran. */
  readonly lastProbeAt: string;
  /** ISO8601 — most recent ready outcome; preserved across degraded ticks. */
  readonly lastSuccessAt?: string;
  /** Verbatim error from fs.access — Phase 85 TOOL-04 inheritance. */
  readonly error?: string;
}
import { AsyncPushQueue, SerialTurnQueue } from "./persistent-session-queue.js";
import { extractSkillMentions } from "../usage/skill-usage-tracker.js";
import { mapEffortToTokens } from "./effort-mapping.js";
// FIND-123-A.next T-02 — structural spawn wrapper for the SDK's
// `spawnClaudeCodeProcess` hook. Single import point — the closure +
// per-handle pidSink live for the handle's lifetime so every (re-)spawn
// inside `buildEpoch` writes the latest pid into the same sink the
// daemon reads at shutdown via `handle.getClaudePid()`.
import { makeDetachedSpawn, type ClaudePidSink } from "./detached-spawn.js";

/** Deadline (ms) the abort path waits after calling q.interrupt() before
 *  throwing AbortError. Pitfall 3 guard — SDK may not emit `result` on abort. */
const INTERRUPT_DEADLINE_MS = 2000;

/**
 * v3 (claude-code-interactive) sessions carry a `v3-<agent>` sessionId, stamped
 * in `session-adapter.ts`. Their in-process SDK token stream is INERT by design
 * — real tokens flow through the PTY — so the phase127 `no-useful-tokens` stall
 * watchdog mis-fires on every v3 turn past threshold (observed live: 60 false
 * `phase127-stream-stall` aborts, all on "v3-research", ~210s > 180s). v3
 * liveness/abort is owned by the PtySupervisor, so the SDK stall tracker is
 * skipped for these sessions. Exported for unit test.
 */
export function isV3Session(sessionId: string): boolean {
  return sessionId.startsWith("v3-");
}

/**
 * Phase 999.98 D4 — Fable effort-`off` thinking-budget guard.
 *
 * `mapEffortToTokens("off")` returns literal `0` → `setMaxThinkingTokens(0)` →
 * thinking DISABLED. Opus 4.8 tolerates a disabled-thinking turn; the Fable
 * family 400s on it. `effort-mapping.ts` is kept PURE (it has no notion of the
 * live model) — this guard lives ONLY at the two runtime `setMaxThinkingTokens`
 * call sites in the handle (setEffort + swap-reapply), which is the only place
 * the resolved `currentModel` is known.
 *
 * Maps a `0` budget to `null` (model-default thinking) for any executor in a
 * family flagged `requiresThinking`; every other (budget, model) pair passes
 * through unchanged. Pure so both call sites share one implementation and it is
 * unit-testable.
 *
 * Phase 999.114 — was an exact literal test `currentModel === "claude-fable-5"`.
 * That silently stopped covering Fable the moment the `fable` alias repinned to
 * `claude-fable-5-1`, whose thinking is adaptive-ALWAYS-ON — i.e. it would have
 * dropped the guard on the very model that most needs it. Now derived from the
 * catalog family flag, so it covers every present and future Fable id.
 */
function guardEffortBudgetForModel(
  budget: number | null,
  currentModel: string | undefined,
): number | null {
  if (budget !== 0 || currentModel === undefined) return budget;
  const family = deriveFamily(currentModel);
  if (family !== null && MODEL_FAMILY_CATALOG[family].requiresThinking) {
    return null;
  }
  return budget;
}

/**
 * INC-2026-06-05 — known-fast tool classification for the stream-stall
 * tracker's split pause ceiling (see `DEFAULT_FAST_MAX_PAUSE_DURATION_MS`).
 *
 * A tool is "fast" only if it reliably returns in seconds, so a pause that
 * outlasts the short fast ceiling (~2 min) while ONLY such tools are in flight
 * is an SDK-generator hang — not a legitimately-slow tool — and should settle
 * the turn quickly rather than waiting the 15-min slow ceiling sized for heavy
 * Bash/browser work.
 *
 * CONSERVATIVE BY DESIGN: this is an ALLOWLIST. Any tool not matched here
 * (including every unknown / future tool, and deliberately Bash + all
 * browser/scrape/web/search MCP tools) is treated as SLOW and keeps the exact
 * 15-min behaviour it has today — so no existing tool can regress into a
 * false-abort. The triggering INC-2026-06-05 wedge was a hung
 * `mcp__acme-db__mysql_query`; the local read/search tools and the
 * seconds-scale finance MCP tools share the same "never legitimately minutes"
 * property. Extend this list only with tools proven to return in seconds.
 *
 * Fleet-audit-2026-06-16 (H2) — added the local-filesystem WRITE tools
 * (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) alongside the existing local
 * READ tools (`Read`, `Grep`, `Glob`). They are pure local-disk operations
 * that return in milliseconds — the SAME "never legitimately minutes" property
 * that already qualifies `Read`. Before this, a lone hung `Edit` was classed
 * SLOW and waited the full 15-min {@link DEFAULT_MAX_PAUSE_DURATION_MS} ceiling
 * (sized for heavy Bash/browser work) instead of the 2-min fast ceiling —
 * the residual Read/Edit tool-wedge tail the audit measured. `Bash` stays SLOW
 * BY DESIGN (heavy fin Bash legitimately runs 5–12 min). The mixed-batch rule
 * is unchanged: an `Edit` running ALONGSIDE a slow `Bash` keeps the full 15-min
 * ceiling (every outstanding pause must be fast for the short ceiling to apply).
 */
const FAST_TOOL_EXACT = new Set<string>([
  "Read",
  "Grep",
  "Glob",
  "ToolSearch",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);
const FAST_TOOL_PREFIXES = [
  "mcp__acme-db__",
  "mcp__acme-content__",
  "mcp__finnhub__",
] as const;
/**
 * 2026-08-27 — flatten every `tool_result` block's text in a user message:
 * string content, or each `{type:"text"}` part of an array. Non-user /
 * malformed shapes yield []. Sibling of `toolResultIdsFromMessage`.
 */
export function toolResultBlocksFromMessage(
  msg: unknown,
): readonly { readonly id: string; readonly text: string }[] {
  const content = ((msg as { message?: { content?: unknown[] } } | null)?.message
    ?.content ?? []) as unknown[];
  if (!Array.isArray(content)) return [];
  const out: { id: string; text: string }[] = [];
  for (const raw of content) {
    const block = raw as { type?: string; tool_use_id?: unknown; content?: unknown };
    if (block?.type !== "tool_result") continue;
    const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    if (typeof block.content === "string") {
      if (block.content.length > 0) out.push({ id, text: block.content });
    } else if (Array.isArray(block.content)) {
      for (const part of block.content) {
        const t = (part as { type?: string; text?: unknown })?.text;
        if (typeof t === "string" && t.length > 0) out.push({ id, text: t });
      }
    }
  }
  return out;
}

/**
 * INC-2026-06-05 — extract the `tool_use_id`s a `user`/tool_result SDK stream
 * message reports results for. The ONLY reliable correlation is each
 * `tool_result` CONTENT block's `tool_use_id`: top-level tool results arrive
 * with the message-level `parent_tool_use_id` set to `null` (proven by the
 * `inc-260605-resume-probe`), so that field MUST NOT be used to match a paused
 * tool. Returns every tool_result block's id — a single user message can carry
 * a PARALLEL batch (e.g. multiple concurrent quote calls). Tolerant of any
 * shape: non-user messages / missing content / non-tool_result blocks yield [].
 */
export function toolResultIdsFromMessage(msg: unknown): readonly string[] {
  const content = ((msg as { message?: { content?: unknown[] } } | null)?.message
    ?.content ?? []) as unknown[];
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const raw of content) {
    const block = raw as { type?: string; tool_use_id?: unknown };
    if (
      block?.type === "tool_result" &&
      typeof block.tool_use_id === "string" &&
      block.tool_use_id.length > 0
    ) {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
}

export function isFastTool(name: string | undefined | null): boolean {
  if (!name) return false;
  if (FAST_TOOL_EXACT.has(name)) return true;
  return FAST_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Message prefix of the Part B no-masquerade guard's AbortError (quick task
 * 260714-mkq). Single-sourced (INC-2026-07-26) because the workflow
 * orchestrator's step-retry classifier matches rejections on this prefix —
 * the identical failure signature auto-recovers on the channel path via
 * wedge-recovery, and the workflow path now gets one bounded retry. The
 * full message appends `(reason=<trip-reason>[, inFlightTools=<detail>])`.
 */
export const STREAM_STALL_MASQUERADE_PREFIX =
  "stream-stall abort masqueraded as a result message";

/**
 * Build a SessionHandle backed by one long-lived sdk.query({ prompt: asyncIterable }).
 *
 * @param sdk SDK module (wrapper around @anthropic-ai/claude-agent-sdk)
 * @param baseOptions Options carried per-agent (model, cwd, systemPrompt, etc.)
 *                    + optional adapter-only `mutableSuffix` for per-turn prompt
 *                    prepending (stripped before forwarding to sdk.query).
 * @param initialSessionId The session id established at handle creation. Becomes
 *                         the `resume` argument on the single sdk.query call so
 *                         the SDK picks up the existing JSONL state.
 * @param usageCallback Optional per-turn usage telemetry hook.
 * @param prefixHashProvider Optional per-turn prefix-hash recorder (CACHE-04).
 * @param skillTracking Optional per-turn skill-mention tracker.
 */
export function createPersistentSessionHandle(
  sdk: SdkModule,
  baseOptions: AdapterBaseOptions,
  initialSessionId: string,
  usageCallback?: UsageCallback,
  prefixHashProvider?: PrefixHashProvider,
  skillTracking?: SkillTrackingConfig,
  // Phase 117 Plan 04 T03/T04 — native advisor observer. Threaded
  // through from SessionManager.makeAdvisorObserver(agent); when
  // absent (test paths, fork-backend agents, missing budget) the
  // observer is a no-op. RESEARCH §13.10 (production wiring).
  advisorObserver?: AdvisorObserverConfig,
  // 999.103 WS-1 — the agent's config name, for the TodoWrite mirror.
  // Explicit rather than derived: skillTracking.agentName is absent for
  // skill-less agents and advisorObserver is absent on the fork backend,
  // so neither is a reliable identity. Optional for test callers.
  agentName?: string,
): SessionHandle {
  const turnQueue = new SerialTurnQueue();

  // Phase 124 follow-up — turn-start timestamp slot.
  //
  // Set at the TOP of the inner callback passed to `turnQueue.run` inside
  // `send` / `sendAndCollect` / `sendAndStream` (after the queue actually
  // dispatches the turn — not before, which would count queue-wait time).
  // Cleared in `finally` so a turn that rejects (AbortError, generator-dead,
  // etc.) still releases the slot. Read by `compact-session` IPC to enforce
  // the ERR_TURN_TOO_LONG safety budget (CONTEXT D-03 step 2).
  //
  // Deliberately NOT instrumented inside `swap()` — swap also routes through
  // turnQueue.run but it is not a user turn; instrumenting it would skew the
  // budget and cause a no-op compaction swap to register as an active turn.
  let turnStartedAt: number | null = null;

  // Quick task 260521-4sa (999.64) — last-SDK-activity timestamp slot.
  //
  // Set to Date.now() (a) at turn start alongside `turnStartedAt`, and (b) on
  // EVERY SDK message consumed in `iterateUntilResult` (not only useful-token
  // deltas — a turn working a tool batch emits assistant/user messages with no
  // text delta and must still count as active). Cleared to null in the same
  // `finally` blocks that clear `turnStartedAt`.
  //
  // Read externally via `getLastTurnActivityAt()` → SessionManager →
  // heartbeat watchdog. Distinct from StreamStallTracker's per-turn-local
  // `lastUsefulTokenAt`, which has no SessionManager-reachable accessor.
  let lastTurnActivityAt: number | null = null;

  // WS-1 (999.99 structural delivery) — handle-scoped stall-control slot.
  // Set by iterateUntilResult (attributed mode only) right after it
  // constructs the per-turn stream-stall tracker; cleared on every exit
  // path alongside `currentInterruptFn`. The AttributedStreamDemux pump
  // calls pause() when an ORPHAN turn opens (the daemon turn will see
  // silence while the foreign turn streams — without the pause, Phase 127
  // would false-positive-interrupt after 180s and kill the orphan turn)
  // and resume() when it closes. Null between daemon turns → no-op.
  let currentStallControl: {
    readonly pause: () => void;
    readonly resume: () => void;
    /** 999.155 — orphan-turn frame: proof of life, re-arms the max-pause window. */
    readonly progress: () => void;
  } | null = null;

  // 999.171 — turn id of the in-flight sendAndStream (the only send path with
  // a status-trail consumer). The demux's onThinkingTokens callback routes a
  // DAEMON turn's `system/thinking_tokens` frames to the thinking sink under
  // this id. Declared here, above buildEpoch, because epoch-0 is built at
  // construction; the callback reads it at call time, so the binding
  // survives epoch swaps. Cleared (identity-checked) when the send ends.
  let currentThinkingTurnId: string | null = null;

  // 999.172 — daemon send token → Discord turn id, recorded by sendAndStream
  // ONLY (the send path a Discord user's message takes). send() and
  // sendAndCollect() — cron, IPC, ask-agent (the Event Dossier's wakes) —
  // never record, so their turns' prompt suggestions route to
  // "no-discord-turn" and are dropped. A suggestion arrives AFTER its turn's
  // send has returned, so entries outlive the send; the map is bounded
  // instead of cleared (oldest evicted first).
  const streamTurnIdByToken = new Map<number, string>();
  const STREAM_TURN_ID_MAP_CAP = 32;
  const rememberStreamTurn = (token: number, turnId: string): void => {
    streamTurnIdByToken.set(token, turnId);
    while (streamTurnIdByToken.size > STREAM_TURN_ID_MAP_CAP) {
      const oldest = streamTurnIdByToken.keys().next().value;
      if (oldest === undefined) break;
      streamTurnIdByToken.delete(oldest);
    }
  };
  // 999.173 — tool_use id → background task id, learned from task_started.
  // stopTask takes the TASK id; the detach path and the research card only
  // know tool_use ids / task ids respectively. Reads the live `q` at call
  // time so a post-swap epoch is targeted.
  const taskIds = new TaskIdMap({ stopTask: (taskId) => q.stopTask(taskId) });

  // Strip adapter-only fields; enable streaming input mode via AsyncIterable
  // prompt + includePartialMessages for token-level streaming.
  // Phase 127 — also strip the stream-stall supervisor knobs
  // (`streamStallTimeoutMs` + `onStreamStall`). They are consumed by the
  // iteration loop below via closure, never by `sdk.query`.
  const {
    mutableSuffix,
    streamStallTimeoutMs: streamStallTimeoutMsOption,
    // Phase 145 WS2 — per-session absolute turn-duration ceiling override.
    // Handle-only (stripped before `sdk.query` by stripHandleOnlyFields, same
    // as streamStallTimeoutMs). Plan 01 threaded it from the loader cascade
    // onto AgentSessionConfig → baseOptions. Read here and passed into the
    // stream-stall tracker so a workflow-worker session can LIFT the 20-min
    // default ceiling with a LARGE FINITE value. The tracker's constructor
    // rejects 0/Infinity/non-finite, so "lifting" is always a finite ceiling —
    // never a disabled one (the activity-based stall trips stay armed too).
    maxTurnDurationMs: maxTurnDurationMsOption,
    onStreamStall: onStreamStallOption,
    // Handle-only — consumed by makeDetachedSpawn below to wrap the spawn in
    // bwrap; pulled OUT of `sdkOptions` so it never reaches `sdk.query`.
    sandboxPlan,
    // WS-1 (999.99 structural delivery) — handle-only attributed-stream pair.
    // Consumed by buildEpoch below (demux construction + orphan delivery
    // sink); never reaches sdk.query.
    attributedStream: attributedStreamOption,
    onOrphanTurnOutput: onOrphanTurnOutputOption,
    // 999.173 — handle-only research settings (the tracker below); never
    // reaches sdk.query. The real SDK options ride in sdkOptions.
    researchSubagents: researchSubagentsOption,
    ...sdkOptions
  } = baseOptions;
  // Phase 127 — default threshold matches the loader cascade fallback.
  // When the adapter omitted the field (legacy call site, test path that
  // didn't thread it through), we still construct the tracker so the
  // protection is on by default. Operators can disable by setting a
  // huge value in clawcode.yaml (the schema enforces max 1_800_000ms).
  const streamStallTimeoutMs = streamStallTimeoutMsOption ?? 180_000;
  // 999.172 — what the CLI's initialize request carries for this handle's
  // lifetime (swap reuses the same sdkOptions). Read by the ux status reply.
  const startedUxFeatures = Object.freeze({
    promptSuggestions: (sdkOptions as { promptSuggestions?: unknown }).promptSuggestions === true,
  });

  // 999.173 — research subagents. The tracker is HANDLE-owned (it outlives an
  // epoch swap, which itself kills the researchers and is reported as such).
  // Present only when research is on for this session AND the agent is named
  // (the registry is keyed by agent; the launch gate and the card buttons
  // find the tracker there).
  const researchTracker: ResearchTracker | null =
    researchSubagentsOption !== undefined && agentName !== undefined && attributedStreamOption === true
      ? new ResearchTracker({
          agentName,
          maxConcurrent: researchSubagentsOption.maxConcurrent,
          holdTimeoutMs: researchSubagentsOption.holdTimeoutMs,
          maxResearcherMs: researchSubagentsOption.budgets.maxMinutes * 60_000,
          stopTask: (taskId) => q.stopTask(taskId),
          // Approved launches not yet started: stopped once task_started names them.
          stopForToolUse: (toolUseId) => {
            taskIds.stopForToolUse(toolUseId);
          },
          // Findings journals live in the agent's own workspace (owner-isolated).
          ...(typeof (sdkOptions as { cwd?: unknown }).cwd === "string"
            ? { journalRoot: joinPath((sdkOptions as { cwd: string }).cwd, "research") }
            : {}),
          // Fail-open delivery: through the same orphan sink as any self-fired
          // output, as a reply to the request when the origin is known.
          deliver: (text, replyTo) => {
            onOrphanTurnOutputOption?.({
              text,
              originKind: null,
              isError: false,
              classification: "orphan-signaled",
              ...(replyTo !== null ? { replyTo } : {}),
            });
          },
        })
      : null;
  // 999.178 — the agent's own background work (non-research tasks): card,
  // wake typing, and the status ping's "background" line.
  const backgroundBoard: BackgroundTaskBoard | null =
    agentName !== undefined && attributedStreamOption === true ? new BackgroundTaskBoard({ agentName }) : null;
  const unregisterBackgroundBoard =
    backgroundBoard !== null && agentName !== undefined ? registerBackgroundBoard(agentName, backgroundBoard) : null;
  const unregisterResearchTracker =
    researchTracker !== null && agentName !== undefined
      ? registerResearchTracker(agentName, researchTracker)
      : null;
  // Resume index + recovery of journals a crash left running (fire-and-forget).
  void researchTracker?.recoverFromDisk();

  // FIND-123-A.next T-02 — per-handle mutable PID sink. Populated by
  // `makeDetachedSpawn` on every (re-)spawn the SDK performs for this
  // handle; read by the daemon's shutdown path via `getClaudePid()` to
  // group-kill the claude process tree BEFORE `manager.stopAll()` so MCP
  // grandchildren can't reparent to PID 1 while the SDK's normal close
  // runs. Cleared in `close()` so a terminal shutdown never group-kills
  // a recycled PID. Sink mutates on every spawn (locked sink semantics);
  // the swap path's `buildEpoch` call rolls the value forward.
  const pidSink: ClaudePidSink = { pid: null };
  // When `sandboxPlan` is present (non-admin agent with sandbox.enabled), the
  // spawned claude is wrapped in bwrap; pass-through otherwise. The captured
  // PID is bwrap's (the pgid leader), so the shutdown group-kill still reaps
  // the whole sandbox tree.
  const detachedSpawn = makeDetachedSpawn(pidSink, sandboxPlan);

  /**
   * Phase 124 Plan 05 — epoch builder. Each call constructs a fresh SDK query
   * + matching AsyncPushQueue + driverIter for the supplied session id. The
   * stripped `sdkOptions` are reused so the swap path inherits the agent's
   * boot-time wiring (model, cwd, systemPrompt, MCP servers, etc.) and only
   * the resume target rolls forward.
   *
   * FIND-123-A.next T-02 — `spawnClaudeCodeProcess` flows through every
   * epoch (initial + every swap). The same `detachedSpawn` closure +
   * `pidSink` are reused so a swap on claude crash + daemon respawn
   * updates the sink to the new PID atomically.
   */
  function buildEpoch(resumeSessionId: string): {
    readonly q: SdkQuery;
    readonly inputQueue: AsyncPushQueue<SdkUserMessage>;
    readonly driverIter: AsyncIterator<SdkStreamMessage>;
    readonly demux: AttributedStreamDemux | null;
  } {
    const ipq = new AsyncPushQueue<SdkUserMessage>();
    const nextQ: SdkQuery = sdk.query({
      // AsyncPushQueue<SdkUserMessage> is an AsyncIterable<SdkUserMessage>.
      // The real SDK type is AsyncIterable<SDKUserMessage> with a richer shape;
      // SdkUserMessage is our narrower local projection — the SDK accepts any
      // iterable of user messages, and the extra fields we push (message,
      // parent_tool_use_id) are ignored by the SdkUserMessage cast.
      prompt: ipq as unknown as AsyncIterable<SdkUserMessage>,
      options: {
        ...sdkOptions,
        resume: resumeSessionId,
        // Token-level streaming — adapter's stream_event branch consumes these.
        // Cast: local SdkQueryOptions is narrower than the real SDK Options
        // (missing includePartialMessages); see sdk-types.ts deferred-items.
        includePartialMessages: true,
        // FIND-123-A.next T-02 — structural spawn override; see import
        // banner above for the lifecycle invariants.
        spawnClaudeCodeProcess: detachedSpawn,
      } as SdkQueryOptions,
    });
    const iter = (nextQ as unknown as AsyncIterable<SdkStreamMessage>)[Symbol.asyncIterator]();
    // WS-1 — legacy consumption (flag off): the loop reads the raw iterator
    // directly, byte-identical to pre-WS-1 behavior.
    if (attributedStreamOption !== true) {
      return { q: nextQ, inputQueue: ipq, driverIter: iter, demux: null };
    }
    // Attributed consumption: the demux is the SOLE reader of the raw
    // iterator; the loop consumes the demuxed turn iterator. Orphan hooks:
    //   - onOrphanOutput → the daemon-wired delivery sink (already guarded
    //     inside the demux; the extra try here is belt-and-suspenders).
    //   - onOrphanTurnStart/End → pause/resume the in-flight daemon turn's
    //     stall tracker via the handle-scoped slot (null when no daemon turn
    //     is iterating — a no-op, correct: nothing to protect).
    //   - onActivity → keep the 999.64 stale-turn watchdog fed while a
    //     foreign turn streams (the daemon turn is legitimately waiting).
    // 999.99 review — a demux without a delivery sink silently drops every
    // orphan output (`clawcode run` / misconfigured recipes). Loud one-time
    // boot warning so the misconfiguration is grep-able, not invisible.
    if (!onOrphanTurnOutputOption) {
      console.warn(
        JSON.stringify({
          component: "attributed-demux",
          // `resumeSessionId` (the buildEpoch param): the handle-scoped
          // `sessionId` binding is TDZ during the epoch-0 construction.
          sessionId: resumeSessionId,
          msg: "ws1-orphan-delivery: attributedStream is ON but no orphan sink is wired — self-fired turn output will be logged and dropped",
        }),
      );
    }
    const dmx = new AttributedStreamDemux({
      raw: iter,
      onOrphanOutput: (out) => {
        try {
          // 999.173 — while researchers run, a self-fired parent turn is
          // interim filler: it folds into the research card. Once they are
          // done, the next one is the synthesis: a reply to the request.
          // An abandoned user turn's late output and error results are not
          // research wakes: they keep their ordinary delivery (the sink
          // suppresses errors) and never land in the card or a reply.
          const routed = researchTracker !== null && out.classification !== "abandoned-daemon" && !out.isError;
          if (!routed) researchTracker?.skipOrphanOutput();
          const route = routed ? researchTracker!.routeOrphanOutput(out.text) : { kind: "pass" as const };
          if (route.kind === "fold") return;
          onOrphanTurnOutputOption?.(
            route.kind === "reply" ? { ...out, replyTo: route.replyTo } : out,
          );
        } catch {
          // fire-and-forget delivery sink — never break the pump
        }
      },
      // 999.173 — a background researcher's lane never feeds a daemon turn;
      // its frames feed the findings journal instead.
      ...(researchTracker !== null
        ? {
            isDetachedChild: (id: string) => researchTracker.isDetachedChild(id),
            onChildFrame: (ev: { parentToolUseId: string; frame: SdkStreamMessage }) =>
              researchTracker.observeChild(ev.parentToolUseId, ev.frame),
          }
        : {}),
      // 999.99 review (telemetry blackout) — orphan/abandoned turns' result
      // frames never reach the legacy loop's extractUsage; charge them here
      // so usage.db / advisor budget keep counting self-fired traffic.
      onTurnUsage: (frame) => {
        try {
          extractUsage(frame);
        } catch {
          // observational — never break the pump
        }
      },
      onOrphanTurnStart: () => {
        if (turnStartedAt !== null) lastTurnActivityAt = Date.now();
        currentStallControl?.pause();
        researchTracker?.setSelfFiredTurnOpen(true);
        backgroundBoard?.setSelfFiredTurnOpen(true);
      },
      onOrphanTurnEnd: () => {
        if (turnStartedAt !== null) lastTurnActivityAt = Date.now();
        currentStallControl?.resume();
        researchTracker?.setSelfFiredTurnOpen(false);
        backgroundBoard?.setSelfFiredTurnOpen(false);
      },
      // A user message folded into a research wake took its output: settle
      // the research instead of re-posting filler later.
      onOrphanMergedIntoDaemon: () => {
        researchTracker?.absorbSelfFiredOutput();
      },
      // 999.155 — a foreign (or misclassified) turn streaming ahead of ours is
      // proof the generator is alive. Without this the paused daemon turn's
      // max-pause window was anchored at the orphan's first frame and tripped
      // at exactly +15:00 (projects 2026-09-22, killed mid-SSH and re-run).
      onOrphanActivity: () => {
        currentStallControl?.progress();
      },
      // 999.171 (SC-4) — live thinking reaches a renderer only for the OPEN
      // DAEMON turn, under that send's own turn id. Orphan / idle / abandoned
      // frames belong to no operator turn and are dropped here.
      onThinkingTokens: (ev) => {
        if (ev.openKind !== "daemon") return;
        const turnId = currentThinkingTurnId;
        if (turnId === null) return;
        emitThinkingTokens(turnId, { estimatedTokens: ev.estimatedTokens });
      },
      // 999.172 — the safety gate: a suggestion is offered to the bridge only
      // for a Discord-user turn (sendAndStream's token → turn id); orphan,
      // superseded and send()/sendAndCollect() turns drop with a reason.
      onPromptSuggestion: (ev) => {
        const route = routePromptSuggestion(ev, (token) => streamTurnIdByToken.get(token));
        if (route.kind === "drop") {
          logSuggestionDrop({ turnId: null, agentName: agentName ?? null, reason: route.reason });
          return;
        }
        offerPromptSuggestion(route.turnId, route.suggestion, { agentName: agentName ?? "" });
      },
      onActivity: () => {
        if (turnStartedAt !== null) lastTurnActivityAt = Date.now();
      },
      // 999.173 — task bookkeeping (idle frames included: a background task's
      // task_started often lands while the parent is idle).
      onTaskFrame: (frame) => {
        taskIds.observe(frame);
        researchTracker?.observe(frame);
        backgroundBoard?.observe(frame);
      },
      // 999.173 — the tracker counts self-fired wake turns by their result;
      // 999.178 — the board shows tasks that outlive the turn that closed.
      ...(researchTracker !== null || backgroundBoard !== null
        ? {
            onResultFrame: (frame: SdkStreamMessage) => {
              researchTracker?.observe(frame);
              backgroundBoard?.observe(frame);
            },
          }
        : {}),
      log: {
        info: (obj: unknown, msg?: unknown) =>
          console.info(JSON.stringify({ component: "attributed-demux", sessionId, msg, obj })),
        warn: (obj: unknown, msg?: unknown) =>
          console.warn(JSON.stringify({ component: "attributed-demux", sessionId, msg, obj })),
        error: (obj: unknown, msg?: unknown) =>
          console.error(JSON.stringify({ component: "attributed-demux", sessionId, msg, obj })),
      },
    });
    return { q: nextQ, inputQueue: ipq, driverIter: dmx.turnIterator(), demux: dmx };
  }

  // Epoch-0 binding. Mutated by handle.swap (Phase 124 Plan 05) — every
  // closure that reads q / inputQueue / driverIter must do so via these
  // bindings, NEVER via a captured local copy, so the swap takes effect on
  // the very next dispatch.
  let { q, inputQueue, driverIter, demux } = buildEpoch(initialSessionId);

  let sessionId = initialSessionId;
  // Phase 124 Plan 05 — monotonic epoch counter. Incremented on every
  // successful swap; exposed via handle.getEpoch() for test assertions and
  // for downstream consumers that need to observe an epoch boundary (e.g.
  // skill caches or prefix-hash provider invalidation).
  let epoch = 0;
  // Phase 83 EFFORT-04 — widened from v2.1 set ("low"|"medium"|"high"|"max")
  // to the full v2.2 EffortLevel union (adds "xhigh", "auto", "off").
  let currentEffort: EffortLevel =
    (baseOptions.effort ?? "low") as EffortLevel;
  // Phase 86 MODEL-03 — per-handle runtime model mirror.
  // Initialized from baseOptions.model (which is the resolved SDK model id
  // passed by session-adapter.ts, NOT the config alias). Updated by
  // handle.setModel; read by handle.getModel and surfaced downstream via
  // SessionManager.getModelForAgent (Plan 02 /clawcode-status).
  let currentModel: string | undefined = baseOptions.model;
  // Phase 87 CMD-02 — per-handle runtime permission-mode mirror.
  // Initialized from baseOptions.permissionMode (passed by session-adapter.ts;
  // default "default" when unset). Updated by handle.setPermissionMode; read
  // by handle.getPermissionMode and surfaced via SessionManager for the
  // /clawcode-permissions slash command.
  let currentPermissionMode: PermissionMode =
    (baseOptions.permissionMode as PermissionMode | undefined) ?? "default";
  const errorHandlers: Array<(err: Error) => void> = [];
  const endHandlers: Array<() => void> = [];
  let closed = false;
  let generatorDead = false;
  let generatorError: Error | null = null;

  // Quick task 260419-nic — public interrupt primitive slot.
  // iterateUntilResult installs its fireInterruptOnce on entry and clears on
  // exit. handle.interrupt() reads and invokes if set. Never holds a stale
  // reference across turns — guarded by `closed` + explicit clears in the
  // try/finally + catch path of iterateUntilResult.
  let currentInterruptFn: (() => void) | null = null;

  // Debug session `in-tool-wedge-recovery` work-stream (B) — in-flight tool
  // probe slot. iterateUntilResult installs a closure that returns the
  // names of every top-level tool currently in flight (paused, awaiting a
  // tool_result); it is cleared on every turn exit.
  //
  // WHY a handle-scoped slot (not just a local in iterateUntilResult): the
  // 999.64 heartbeat sweep force-releases a wedged turn via
  // `forceReleaseTurn()` — a HANDLE method that runs OUTSIDE the
  // iterateUntilResult closure and bypasses the Phase 127 `onStall` path.
  // For a sweep-released wedge to still carry the in-flight tool list out
  // to the recovery layer, `forceReleaseTurn()` must be able to read what
  // was in flight at force-release time — hence this slot. Mirrors the
  // `currentInterruptFn` slot pattern exactly (install on entry, clear on
  // every exit, guarded by `closed`).
  let currentInFlightToolsFn: (() => readonly string[]) | null = null;
  // Debug session `in-tool-wedge-recovery` work-stream (C), FORK 8 — a
  // PARALLEL in-flight tool probe that returns id+name PAIRS (not just
  // names). `backgroundTasks(toolUseId)` needs the tool_use id; the B-era
  // `currentInFlightToolsFn` exposes only names. Kept as a separate slot
  // (rather than widening B's signature) so the B catch-path call sites
  // stay byte-identical — minimal regression surface. Installed/cleared
  // at the exact same points as `currentInFlightToolsFn`.
  let currentInFlightToolUsesFn:
    | (() => readonly { readonly id: string; readonly name: string }[])
    | null = null;
  // Set by `forceReleaseTurn()` to the in-flight tool snapshot captured at
  // force-release time, and consumed by the iterateUntilResult catch path
  // so the thrown AbortError carries `wedgeInfo` even on the sweep route.
  // Null between turns / when no sweep force-release happened this turn.
  let sweepForceReleaseInFlightTools: readonly string[] | null = null;

  // Phase 85 Plan 01 TOOL-01 — per-handle MCP state mirror (owned by
  // SessionManager; handle is a thin read surface for TurnDispatcher-scope
  // consumers in Plans 02 + 03). Updated at warm-path gate + on every
  // mcp-reconnect heartbeat tick.
  let currentMcpState: ReadonlyMap<string, McpServerState> = new Map();

  // Phase 94 Plan 02 TOOL-03 — per-handle flap-history Map for the D-12
  // 5min flap-stability window. Lazily initialized; persists across all
  // session-config rebuilds for this handle so the filter's flap-tracker
  // correctly counts ready ↔ non-ready transitions over time. The filter
  // mutates this Map on every call; same handle → same Map identity.
  const flapHistory: Map<string, FlapHistoryEntry> = new Map();

  // Phase 94 Plan 03 TOOL-04/05/06 — per-handle recovery-attempt history.
  // Lazily-initialized at handle-construction; the registry mutates in-place
  // per heartbeat tick. Stable Map identity is the contract — bounded
  // 3-attempts-per-hour budget accumulates across ticks via this Map.
  const recoveryAttemptHistory: Map<string, AttemptRecord[]> = new Map();

  // Phase 87 CMD-01 — cache of SDK-reported slash commands. Populated once via
  // q.initializationResult() on first call; subsequent calls hit the cache.
  // Kept null on failure so the next call retries — the SDK may not be ready
  // at the moment of first query (e.g. early in the warm-path).
  let supportedCommandsCache: readonly SlashCommand[] | null = null;

  // Phase 999.98 D7 — cache of the SDK-reported entitled model set. Populated
  // once via q.initializationResult() on first getSupportedModels() call.
  // DECISION: unlike supportedCommandsCache, this is NOT reset on swap (see the
  // swap() comment) — the entitled model set is account-scoped and does not
  // change across a same-account session swap, so re-pulling it would be waste.
  let supportedModelsCache: readonly ModelInfo[] | null = null;

  // Phase 96 Plan 01 D-CONTEXT — per-handle filesystem capability snapshot
  // mirror. Lazy-init: undefined until the first runFsProbe outcome is
  // populated by SessionManager (boot probe + heartbeat tick + on-demand).
  // Accessor returns an empty Map when null so callers can read
  // unconditionally without a reachable null path. Mirrors the Phase 85
  // getMcpState/setMcpState pair exactly — 6th application of the post-
  // construction DI mirror pattern (after McpState, FlapHistory,
  // RecoveryAttemptHistory, SupportedCommands, and ModelMirror).
  let _fsCapabilitySnapshot: ReadonlyMap<string, FsCapabilitySnapshot> | undefined;

  // Phase 103 OBS-04 / OBS-05 — per-handle RateLimitTracker mirror. Lazy-init:
  // undefined until SessionManager calls setRateLimitTracker after handle
  // construction. The iterateUntilResult dispatch branch reads via closure
  // (`_rateLimitTracker` resolved at branch-eval time) so a late injection is
  // picked up on the very next message. 7th application of the post-
  // construction DI mirror pattern (after McpState, FlapHistory,
  // RecoveryAttemptHistory, SupportedCommands, ModelMirror, FsCapability).
  // Pitfall 8: messages arriving in the handle-construction → injection race
  // window are silently dropped — best-effort capture is acceptable.
  let _rateLimitTracker: RateLimitTracker | undefined;

  function notifyError(err: Error): void {
    generatorDead = true;
    generatorError = err;
    // 999.173 — the CLI generator is gone and its background researchers with it.
    researchTracker?.failOpen("generator-dead");
    for (const h of errorHandlers) {
      try {
        h(err);
      } catch {
        // swallow to avoid cascading failures
      }
    }
  }

  // Context-bloat fix #3c — first-turn-only continuity suffix.
  //
  // `mutableSuffix` carries the session-continuity block (resume summary +
  // Recent Sessions brief). Its job is to ORIENT the agent at the start of
  // a resumed session. After turn 1 the same content is already in the SDK
  // transcript, so re-prepending it every turn is pure waste (~3.5K tok ×
  // (N-1) turns). This flag is consumed once: it starts false, flips true
  // on the first `promptWithMutable` call that actually prepends the
  // suffix, and after that the suffix is omitted.
  //
  // SWAP RE-ARM: a compaction `handle.swap()` forks a fresh SDK session;
  // the continuity content is NOT carried into the fork's first turn. The
  // swap path resets this flag to false so the very next turn re-sends the
  // continuity block ONCE — treating a swap as a fresh first turn.
  // Continuity is worth more than a few tokens (recall-safe default).
  let continuityConsumed = false;

  function promptWithMutable(message: string): string {
    if (!mutableSuffix || mutableSuffix.length === 0) return message;
    if (continuityConsumed) return message;
    continuityConsumed = true;
    return `${mutableSuffix}\n\n${message}`;
  }

  /**
   * Build an SDKUserMessage for streaming input mode. The real SDK shape is
   * `{ type, message: { role, content }, parent_tool_use_id }`; our local
   * `SdkUserMessage` type is narrower. We build the richer shape and cast —
   * the SDK accepts the extra fields.
   *
   * Multimodal: when `images` is present and non-empty, `message.content`
   * becomes an Anthropic content-block ARRAY — a leading text block followed
   * by one `image` block per attachment (base64 source). With no images it
   * stays the original string path (byte-identical to the pre-vision
   * behavior — prompt-cache prefix unaffected). The top-level `content`
   * mirror ALWAYS stays the text string for back-compat with the only
   * reader (the `typeof === "string"`-guarded path in iterateUntilResult).
   */
  function buildUserMessage(
    content: string,
    images?: ReadonlyArray<SendImageInput>,
  ): SdkUserMessage {
    const messageContent =
      images && images.length > 0
        ? [
            // Omit an empty text block — Anthropic rejects zero-length text
            // content blocks; an image-only turn sends just the image block(s).
            ...(content.length > 0 ? [{ type: "text", text: content }] : []),
            ...images.map((img) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: img.mediaType,
                data: img.data,
              },
            })),
          ]
        : content;
    return {
      type: "user",
      message: { role: "user", content: messageContent },
      parent_tool_use_id: null,
      // `content` mirrors the narrow local SdkUserMessage field for back-compat
      // with any consumer reading SdkUserMessage.content directly. ALWAYS the
      // text string (never the block array) — the multimodal payload lives on
      // `message.content`.
      content,
    } as unknown as SdkUserMessage;
  }

  /** Safely invoke the UsageCallback with a result message. */
  function extractUsage(msg: SdkStreamMessage): void {
    if (msg.type !== "result") return;

    // Phase 117 Plan 04 T04 — ground-truth advisor iteration count
    // (RESEARCH §2.1 parse-site B + §13.6 message_delta).
    //
    // The terminal SDKResultMessage's `usage.iterations[]` is the
    // authoritative count of every advisor sub-inference that fired
    // during the turn (filtered on `type === "advisor_message"`).
    // Each entry consumes one daily-budget slot. The per-block scan
    // at iterateUntilResult :579 (T03) is the EARLY signal for
    // Discord visibility; only this terminal path charges the budget
    // (RESEARCH §6 Pitfall 4 — no double-record).
    //
    // Observational ONLY: any failure (missing iterations, malformed
    // entry, AdvisorBudget DB write error) is silently swallowed so
    // the message path is never broken (matches the existing
    // usageCallback try/catch immediately below).
    if (advisorObserver) {
      try {
        const iterations = (msg as { usage?: { iterations?: unknown[] | null } })
          .usage?.iterations;
        if (Array.isArray(iterations)) {
          for (const entry of iterations) {
            if (
              entry !== null &&
              typeof entry === "object" &&
              (entry as { type?: unknown }).type === "advisor_message"
            ) {
              try {
                advisorObserver.advisorBudget.recordCall(
                  advisorObserver.agentName,
                );
              } catch {
                // DB write failed — keep iterating, never break message path
              }
            }
          }
        }
      } catch {
        // observational only — never break the message path
      }
    }

    if (!usageCallback) return;
    try {
      const result = msg as {
        total_cost_usd?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          // Token-accuracy fix (2026-06-11) — the cache halves of input. On a
          // big-system-prompt Opus agent these are ~90%+ of real input; the
          // prior mapping read only input_tokens (fresh) and dropped these, so
          // "Tokens In" displayed ~20× too low. Captured into separate columns
          // (tokens_in stays = fresh) — see usage_events schema.
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        num_turns?: number;
        duration_ms?: number;
        model?: string;
      };
      usageCallback({
        tokens_in: typeof result.usage?.input_tokens === "number" ? result.usage.input_tokens : 0,
        tokens_out: typeof result.usage?.output_tokens === "number" ? result.usage.output_tokens : 0,
        cost_usd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0,
        turns: typeof result.num_turns === "number" ? result.num_turns : 0,
        model: typeof result.model === "string" ? result.model : "",
        duration_ms: typeof result.duration_ms === "number" ? result.duration_ms : 0,
        cache_read_tokens:
          typeof result.usage?.cache_read_input_tokens === "number"
            ? result.usage.cache_read_input_tokens
            : 0,
        cache_creation_tokens:
          typeof result.usage?.cache_creation_input_tokens === "number"
            ? result.usage.cache_creation_input_tokens
            : 0,
      });
    } catch {
      // observational path — never break the message flow
    }
  }

  /**
   * Drive the shared driverIter until the turn-terminating `result` message
   * arrives, handling tracing, streaming chunks, cache telemetry, and skill
   * tracking. Breaks out of iteration on `result` so the NEXT turn's messages
   * remain on the iterator for the next call (Pattern 1 "iteration boundary").
   */
  async function iterateUntilResult(
    onChunk: ((accumulated: string) => void) | null,
    turn: Turn | undefined,
    signal: AbortSignal | undefined,
    onToolUse?: ((name: string, input?: unknown) => void) | null,
  ): Promise<string> {
    const endToEnd = turn?.startSpan("end_to_end", {});
    const firstToken = turn?.startSpan("first_token", {});
    let firstTokenEnded = false;
    const activeTools = new Map<
      string,
      {
        readonly span: Span;
        readonly hitCountAtOpen: number;
        readonly openedAtMs: number;
      }
    >();
    // Quick task 260521-3or — tool-aware stall tracker pause/resume
    // balance map. Keyed by the id of each top-level tool_use block this
    // turn has paused the stream-stall tracker for; the VALUE is the tool
    // NAME. A tool_result only resume()s a tool this turn actually paused
    // — so the pause/resume pairs stay balanced across parallel batches
    // and survive duplicate/missing SDK messages (idempotent: the Map
    // membership check gates both set and delete). Unlike `activeTools`,
    // this map is NOT span-gated — it tracks tool lifecycle even when
    // tracing is off, because the stall tracker must be tool-aware
    // regardless.
    //
    // Debug session `in-tool-wedge-recovery` work-stream (B) — this was a
    // `Set<id>` (quick task 260521-3or); promoted to `Map<id, name>` so a
    // wedge can surface the in-flight tool NAME(s) to the recovery layer
    // (the tool name is needed to classify read-only vs mutating). The
    // pause/resume balance semantics are byte-identical: `.has()` still
    // gates, `.set(id,name)` replaces `.add(id)`, `.delete(id)` unchanged.
    const pausedToolUseIds = new Map<string, string>();
    // 2026-08-27 — tool name by tool_use id (top-level AND child-lane), so the
    // tool_result seam can attribute result text to the tool that produced
    // it for the evidence ledger. Bounded.
    const toolNamesByUseId = new Map<string, string>();
    const rememberToolName = (id: unknown, name: unknown): void => {
      if (typeof id !== "string" || typeof name !== "string" || name.length === 0) return;
      if (toolNamesByUseId.size >= 512) toolNamesByUseId.clear();
      toolNamesByUseId.set(id, name);
    };
    // INC-2026-07-26 (client-a-personal workflow RCA) — per-tool open timestamps,
    // maintained in lockstep with `pausedToolUseIds` (same set/delete/clear
    // sites). A PARALLEL map rather than widening the value type because four
    // existing consumers read `.values()` as tool NAMES (trip snapshot, orphan
    // drain, fast/slow resume tag, catch fallback) — keeping their shape
    // byte-identical keeps the wedge-classification path untouched. Read only
    // at stall-trip time to compute per-tool ages for the diagnostics payload
    // (both 2026-07-26 aborts were undiagnosable from logs because the trip
    // line carried no tool identity).
    const pausedToolOpenedAt = new Map<string, number>();
    const textParts: string[] = [];
    const blockTextParts: string[] = [];
    let streamedText = "";
    let interruptCalled = false;
    // Phase 127 — per-turn stream-stall tracker. Constructed at iteration
    // entry so the threshold + onStall handler are captured fresh each
    // turn (a yaml hot-reload between turns picks up the new threshold via
    // the closure-captured baseOptions reference — the tracker re-reads
    // `streamStallTimeoutMs` from the outer closure at construction time;
    // mid-turn yaml edits land on the NEXT turn's tracker).
    //
    // On trip:
    //   1. Emit structured `phase127-stream-stall` log line (operator
    //      grep target: `journalctl -u clawcode | grep phase127-stream-stall`).
    //   2. Invoke `fireInterruptOnce()` which calls `q.interrupt()` + arms
    //      the abort-deadline race. The existing INTERRUPT_DEADLINE_MS
    //      guarantee (2s) ensures the in-flight turn terminates within
    //      bounded time even if `q.interrupt()` hangs.
    //   3. Forward payload to `onStreamStallOption` if the operator wired
    //      one (Plan 02 attaches Discord notification + session-log row).
    //
    // The tracker is created BEFORE the for-await loop so a stall
    // detected before the first message lands still trips. Cleanup
    // happens in BOTH success (`return`) AND catch paths via
    // `streamStallTracker.stop()` calls below — T-127-04 mitigation
    // prevents leaked setIntervals on abort.
    let streamStallTracker: StreamStallTracker | null = null;
    // Debug session `in-tool-wedge-recovery` work-stream (B) — the last
    // StreamStallPayload the tracker tripped with this turn. Captured in
    // the onStall handler so the catch path can read the trip `reason`
    // ("no-useful-tokens" vs "max-pause-exceeded") onto the WedgeInfo.
    // Null when the tracker never tripped (turn aborted by some other
    // path, e.g. an operator interrupt) — the catch then defaults the
    // reason to "no-useful-tokens".
    let lastStreamStallPayload: StreamStallPayload | null = null;
    // quick task 260714-mkq review Finding 1 — trip-time snapshot of the
    // in-flight tool NAMES, captured inside `onStall` alongside
    // `lastStreamStallPayload`. Needed because the Part B no-masquerade guard
    // throws its AbortError AFTER closeAllSpans() has already drained
    // `pausedToolUseIds` — so on the raced-result path the catch's live-map
    // read yields [] and `decideWedgeRecovery` misclassifies a MUTATING
    // in-flight tool as auto-rerun-safe (silently re-running the mutation).
    // The catch prefers this snapshot whenever the tracker tripped this turn.
    let lastStallInFlightToolNames: readonly string[] | null = null;
    // INC-2026-07-26 — human-readable trip-time snapshot of the in-flight
    // tools WITH per-tool age ("WebFetch(893s), Bash(882s)"). Captured inside
    // `onStall` alongside the names snapshot above; consumed by the
    // no-masquerade guard's AbortError message so the workflow orchestrator's
    // "workflow worker turn failed" log line (which records err.message)
    // self-identifies the offending tool(s) — both 2026-07-26 aborts required
    // a multi-hour log reconstruction because this detail was dropped.
    let lastStallInFlightToolDetail: string | null = null;
    try {
      // v3 inert-stream fix (2026-06-14, see isV3Session): a v3
      // (claude-code-interactive / PTY) session's in-process SDK token stream
      // is inert by design — real tokens flow through the PTY — so the
      // `no-useful-tokens` activity trip false-aborts every long v3 turn (60
      // observed `phase127-stream-stall` aborts, all sessionId "v3-research",
      // ~210s > 180s). We DISABLE only the token-activity trips for v3 (via
      // tokenActivityTripsEnabled) rather than skipping the whole tracker, so
      // the absolute 20-min `max-turn-duration` wall-clock backstop stays
      // armed — the PtySupervisor owns process lifecycle (spawn/restart/kill),
      // NOT a per-turn settle, so without this ceiling a genuinely hung v3
      // turn would never settle and would leak its queue slot (QUEUE_FULL).
      streamStallTracker = createStreamStallTracker({
        thresholdMs: streamStallTimeoutMs,
        // Phase 145 WS2 — pass the per-session ceiling override ONLY when set.
        // When undefined (the entire current fleet) the key is OMITTED so the
        // tracker takes its DEFAULT_MAX_TURN_DURATION_MS (20-min) default →
        // effective ceiling unchanged for non-worker sessions. When set (a
        // workflow-worker session) the tracker uses the larger finite ceiling,
        // letting a long worker turn run past 20 min. NOTE: this only lifts the
        // absolute wall-clock backstop — `tokenActivityTripsEnabled` is left
        // untouched, so the no-useful-tokens / max-pause activity-based stall
        // detection that catches a genuinely hung worker stays fully armed.
        ...(typeof maxTurnDurationMsOption === "number"
          ? { maxTurnDurationMs: maxTurnDurationMsOption }
          : {}),
        tokenActivityTripsEnabled: !isV3Session(sessionId),
        onStall: (payload: StreamStallPayload) => {
          // Debug session `in-tool-wedge-recovery` work-stream (B) —
          // record the trip payload so the catch path can carry the trip
          // `reason` onto the WedgeInfo attached to the thrown AbortError.
          lastStreamStallPayload = payload;
          // Finding 1 (260714-mkq review) — snapshot the in-flight tool names
          // AT TRIP TIME, before any raced `result` message lets the success
          // branch run closeAllSpans() (which drains pausedToolUseIds). The
          // catch prefers this snapshot so a mutating in-flight tool is still
          // visible to decideWedgeRecovery on the raced-result path.
          lastStallInFlightToolNames = [...pausedToolUseIds.values()];
          // INC-2026-07-26 — per-tool age snapshot for the diagnostics
          // payload + the no-masquerade error message. Same trip-time
          // capture window as the names snapshot above.
          const tripNow = Date.now();
          const inFlightTools = [...pausedToolUseIds].map(([id, name]) => {
            const openedAt = pausedToolOpenedAt.get(id);
            return {
              name,
              ageMs: typeof openedAt === "number" ? tripNow - openedAt : -1,
            };
          });
          lastStallInFlightToolDetail =
            inFlightTools.length > 0
              ? inFlightTools
                  .map((t) => `${t.name}(${Math.round(t.ageMs / 1000)}s)`)
                  .join(", ")
              : null;
          // Single structured log line — operator-visible without
          // requiring Discord wiring (Plan 02). Mirrors Phase 115
          // quickwin + Phase 999.54 precedent.
          //
          // Debug session `phase127-stall-abort-miss` Option 1 — the line
          // now carries `reason` ("no-useful-tokens" vs the new
          // "max-pause-exceeded" ceiling trip) and `pauseDurationMs` so an
          // in-tool generator hang is no longer fully silent. Grep
          // `phase127-stream-stall` + `"reason":"max-pause-exceeded"` to
          // confirm an in-tool wedge was caught by the ceiling backstop.
          try {
            console.info(
              "phase127-stream-stall",
              JSON.stringify({
                lastUsefulTokenAgeMs: payload.lastUsefulTokenAgeMs,
                thresholdMs: payload.thresholdMs,
                reason: payload.reason,
                ...(payload.pauseDurationMs !== undefined
                  ? { pauseDurationMs: payload.pauseDurationMs }
                  : {}),
                ...(payload.turnDurationMs !== undefined
                  ? { turnDurationMs: payload.turnDurationMs }
                  : {}),
                // INC-2026-07-26 — the in-flight tool identity + per-tool age
                // that made the 2026-07-26 aborts diagnosable only via a
                // multi-hour probe-log reconstruction. [] when the trip fired
                // with no tool in flight (a plain no-useful-tokens stall).
                inFlightTools,
                sessionId,
              }),
            );
          } catch {
            // Observational path — never break the trip behavior.
          }
          // Hand to the optional operator-injected callback. Plan 02
          // wires Discord notification + session-log row here.
          try {
            onStreamStallOption?.(payload);
          } catch {
            // Operator callback failures must not prevent the abort.
          }
          // Abort the in-flight turn via the existing interrupt path —
          // re-uses the 2s deadline race so a misbehaving SDK can't
          // hang the turn even on trip.
          fireInterruptOnce();
        },
      });
    } catch (err) {
      // Tracker construction can throw only for invalid threshold
      // (defensive guard). Log and continue without the tracker rather
      // than crashing the turn — protective behavior is missing but
      // observability is preserved.
      try {
        console.error(
          "phase127-tracker-construction-failed",
          err instanceof Error ? err.message : String(err),
        );
      } catch {
        // Observational path — never break.
      }
    }
    // WS-1 (999.99 structural delivery) — publish this turn's stall control
    // to the handle-scoped slot so the demux pump can pause/resume it around
    // ORPHAN turns (a foreign turn streaming means the daemon turn
    // legitimately sees silence — without the pause, the 180s
    // no-useful-tokens trip would interrupt-kill the foreign turn). If an
    // orphan is ALREADY mid-flight when this turn starts, begin paused —
    // the demux's onOrphanTurnEnd resumes. Cleared on every exit path
    // alongside currentInterruptFn. Attributed mode only: the slot is
    // never populated on the legacy path, so legacy behavior is untouched.
    if (attributedStreamOption === true) {
      currentStallControl = {
        pause: () => {
          try {
            streamStallTracker?.pause({ fast: false });
          } catch {
            // defensive — pause is inert after stop
          }
        },
        resume: () => {
          try {
            streamStallTracker?.resume({ fast: false });
          } catch {
            // defensive — resume is inert after stop
          }
        },
        progress: () => {
          try {
            streamStallTracker?.markToolProgress();
          } catch {
            // defensive — inert after stop
          }
        },
      };
      if (demux?.isOrphanTurnOpen()) {
        currentStallControl.pause();
      }
    }
    const stopStreamStallTracker = (): void => {
      try {
        streamStallTracker?.stop();
      } catch {
        // Idempotent stop, but guard against pathological clearInterval errors.
      }
      streamStallTracker = null;
    };
    /**
     * Phase 115 Plan 08 T01 — per-batch roundtrip timer for sub-scope 17(a).
     * Ported from session-adapter.ts:iterateWithTracing (the test-only path).
     * Opens on the first tool_use of a parent assistant message, closes when
     * the NEXT parent assistant arrives — wall-clock interval covering SDK
     * dispatch + tool runtime + result delivery + LLM resume.
     *
     * Per-batch (not per-tool) so parallel batches collapse to one interval.
     * Multi-batch turns accumulate via Turn.addToolRoundtripMs sums.
     */
    let batchOpenedAtMs: number | null = null;

    const closeAllSpans = (): void => {
      for (const entry of activeTools.values()) {
        entry.span.end();
        // Phase 115 Plan 08 T01 — final-batch execution-side fallback. If
        // the SDK terminated mid-tool (error / abort / timeout) the
        // user-message tool_result branch never fired, so addToolExecutionMs
        // would be skipped for these spans. Compute a best-effort duration
        // from openedAtMs at termination so the column doesn't undercount
        // pathological turns. Wrapped in try/catch — observability MUST
        // NEVER break the message path (Phase 50 invariant).
        try {
          const executionMs = Date.now() - entry.openedAtMs;
          (turn as { addToolExecutionMs?: (ms: number) => void })
            .addToolExecutionMs?.(executionMs);
        } catch {
          // Observational only — never break.
        }
      }
      // Quick task 260521-3or — tool-aware stall tracker orphan drain.
      // If the SDK terminated mid-tool (error / abort / timeout) the
      // user-message tool_result branch never fired for some tools, so
      // their pause() was never balanced by a resume(). Drain every
      // still-pending pause here so an orphaned tool does not leave the
      // tracker permanently paused for a subsequent reuse window.
      // Placed BEFORE stopStreamStallTracker() runs on the cleanup path;
      // resume()-after-stop() is itself a safe no-op, so the ordering is
      // defensive only. Runs on BOTH the success and catch cleanup
      // paths because closeAllSpans() is invoked from both.
      // Work-stream (B) — `pausedToolUseIds` is now a Map; iterating it
      // yields [id, name] entries. One resume() per orphan; INC-2026-06-05
      // mirrors each orphan's fast/slow tag (from its tool name) so the
      // tracker's slow-pause count drains to exactly zero. (The tracker also
      // hard-zeroes slowPauseDepth on the 1→0 transition, so this is belt-and-
      // suspenders — but keeping the tags balanced avoids relying on that.)
      for (const orphanName of pausedToolUseIds.values()) {
        try {
          streamStallTracker?.resume({ fast: isFastTool(orphanName) });
        } catch {
          // Defensive — resume() is inert/idempotent; never break cleanup.
        }
      }
      pausedToolUseIds.clear();
      pausedToolOpenedAt.clear();
      activeTools.clear();
      // Phase 115 Plan 08 T01 — final-batch roundtrip fallback. If the run
      // terminated before the LLM emitted a "next parent assistant" message
      // (terminal error, normal completion, or final result-only path), the
      // currently-open batch timer would otherwise be lost. Close it here
      // so the column reflects every batch the run observed. Reset to null
      // so a second invocation (success finally + catch path) cannot
      // double-count.
      try {
        if (batchOpenedAtMs !== null && turn) {
          const roundtripMs = Date.now() - batchOpenedAtMs;
          (turn as { addToolRoundtripMs?: (ms: number) => void })
            .addToolRoundtripMs?.(roundtripMs);
          batchOpenedAtMs = null;
        }
      } catch {
        // Observational only — never break.
      }
      if (!firstTokenEnded) {
        firstToken?.end();
        firstTokenEnded = true;
      }
      endToEnd?.end();
    };

    // Per-iteration deadline arm hook. Set at the top of each loop iteration
    // when the deadline hasn't yet been armed. Consumed by fireInterruptOnce
    // so that an external handle.interrupt() call (quick-task 260419-nic) can
    // arm the deadline on the currently-pending driverIter.next() race —
    // otherwise the iteration would hang indefinitely waiting for a `result`
    // message that never arrives. Cleared once the arm fires or iteration
    // proceeds past the current step.
    let armDeadlineForCurrentIteration: (() => void) | null = null;

    const fireInterruptOnce = (): void => {
      if (interruptCalled) return;
      interruptCalled = true;
      try {
        // Fire-and-forget — Pitfall 3 guard (don't await on hot path).
        // The `.catch` is LOAD-BEARING: q.interrupt() can REJECT
        // asynchronously — notably the claude-code-interactive (v3) backend
        // rejects with V3UnsupportedMutatorError because the daemon holds no
        // live Query (abort there degrades to a PTY supervisor restart,
        // Stage 2). A bare `void`-discard surfaces that as an UNHANDLED
        // rejection and crashes the daemon (Node 22 default — observed live
        // 2026-05-26 when a v3 agent stalled). Promise.resolve(...).catch()
        // covers the async reject; the try/catch still covers a sync throw.
        void Promise.resolve(q.interrupt()).catch(() => {
          /* interrupt failure (incl. v3 unsupported) is not fatal */
        });
      } catch {
        // ignore — a synchronous interrupt throw is likewise not fatal
      }
      // Quick task 260419-nic — arm the deadline for the currently-pending
      // driverIter.next() race so the turn rejects with AbortError within
      // INTERRUPT_DEADLINE_MS instead of hanging forever.
      if (armDeadlineForCurrentIteration) {
        try {
          armDeadlineForCurrentIteration();
        } catch {
          // ignore — never fatal
        }
      }
    };

    // Quick task 260419-nic — install handle-level interrupt slot for the
    // duration of this turn. Cleared in every exit path (success finally,
    // catch, and step.done throw) below.
    currentInterruptFn = fireInterruptOnce;
    // 999.99 review CRITICAL (ghost window) — identity + epoch stamps for
    // this turn. A ghost iteration surviving a force-release (up to the 2s
    // interrupt deadline) must NEVER wipe a SUCCESSOR turn's slots or
    // poison a fresh epoch with generator-dead: every clear below is
    // identity-guarded (`=== myInterruptFn`), and notifyError is skipped
    // when the epoch advanced under us (compaction swap during the window).
    const myInterruptFn = fireInterruptOnce;
    const myStallControl = currentStallControl;
    const myEpoch = epoch;

    // Debug session `in-tool-wedge-recovery` work-stream (B) — install the
    // in-flight tool probe for this turn. Reads `pausedToolUseIds` (the
    // tool-aware pause/resume balance map) so a force-release happening
    // OUTSIDE this closure (the 999.64 heartbeat sweep's
    // `forceReleaseTurn()`) can still snapshot what was mid-execution.
    // Returns tool NAMES (the Map values). Empty when no tool is in
    // flight — that is the pure-text-hang case, auto-retry-safe. Cleared
    // on every exit path alongside `currentInterruptFn`.
    currentInFlightToolsFn = (): readonly string[] => [
      ...pausedToolUseIds.values(),
    ];
    // Work-stream (C), FORK 8 — install the parallel id+name probe.
    // `pausedToolUseIds` is a Map<id, name>; this exposes the [id, name]
    // pairs `backgroundTasks(toolUseId)` needs. Cleared on every exit
    // alongside `currentInFlightToolsFn`.
    currentInFlightToolUsesFn = (): readonly {
      readonly id: string;
      readonly name: string;
    }[] => [...pausedToolUseIds.entries()].map(([id, name]) => ({ id, name }));
    // Work-stream (B) — reset the sweep snapshot at turn entry so a
    // leftover from a previous turn can never bleed into this turn's
    // wedge classification. It is (re)populated only if `forceReleaseTurn()`
    // fires for THIS turn.
    sweepForceReleaseInFlightTools = null;

    // If already aborted on entry, fire interrupt immediately and race deadline.
    if (signal?.aborted) {
      fireInterruptOnce();
    }

    try {
      // Pre-register abort listener so a late abort during iteration also races.
      const abortHandler = (): void => {
        fireInterruptOnce();
      };
      if (signal && !signal.aborted) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      try {
        for (;;) {
          // Each iteration races driverIter.next() against:
          //   - abort deadline (2s from interrupt() call)
          // so aborted turns don't hang waiting for a `result` that may never arrive.
          const nextPromise = driverIter.next();
          let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
          let deadlineReject: ((err: Error) => void) | null = null;
          const deadlinePromise = new Promise<never>((_resolve, reject) => {
            if (interruptCalled) {
              deadlineTimer = setTimeout(() => {
                const err = new Error("Aborted: interrupt deadline exceeded");
                err.name = "AbortError";
                reject(err);
              }, INTERRUPT_DEADLINE_MS);
            } else {
              // Track the reject so a later abort can arm the deadline.
              deadlineReject = reject;
            }
          });

          // Shared deadline-arm closure used by (a) the signal abort handler,
          // (b) the already-aborted branch below, and (c) quick-task 260419-nic's
          // handle.interrupt() path via fireInterruptOnce → armDeadlineForCurrentIteration.
          const armDeadline = (): void => {
            if (deadlineTimer || !deadlineReject) return;
            deadlineTimer = setTimeout(() => {
              const err = new Error("Aborted: interrupt deadline exceeded");
              err.name = "AbortError";
              deadlineReject!(err);
            }, INTERRUPT_DEADLINE_MS);
          };
          // Expose to fireInterruptOnce for this iteration.
          armDeadlineForCurrentIteration = armDeadline;
          // If interrupt() was already called BEFORE this iteration started
          // (previous iteration consumed a message, then handle.interrupt()
          // fired), arm the deadline immediately so this iteration's
          // driverIter.next() doesn't hang.
          if (interruptCalled) {
            armDeadline();
          }

          // If signal fires between now and the next message, arm the deadline.
          const lateAbortHandler = (): void => {
            fireInterruptOnce();
            armDeadline();
          };
          if (signal && !signal.aborted) {
            signal.addEventListener("abort", lateAbortHandler, { once: true });
          } else if (signal?.aborted) {
            armDeadline();
          }

          let step: IteratorResult<SdkStreamMessage>;
          try {
            step = await Promise.race([nextPromise, deadlinePromise]);
          } finally {
            if (deadlineTimer) clearTimeout(deadlineTimer);
            if (signal) signal.removeEventListener("abort", lateAbortHandler);
            // Clear per-iteration arm hook so a stale closure doesn't fire
            // after the iteration proceeds.
            armDeadlineForCurrentIteration = null;
          }

          if (step.done) {
            // 999.99 review — identity-guarded clears (a ghost must not
            // wipe a successor turn's slots).
            if (currentInterruptFn === myInterruptFn) currentInterruptFn = null;
            if (currentStallControl === myStallControl) currentStallControl = null;
            if (interruptCalled) {
              // Interrupted turn woken with done:true — either
              // drainForAbandon void-resolved this ghost's waiter after a
              // force-release, or the stream genuinely ended mid-abort.
              // Classify as an ABORT (wedge-recovery path), NOT
              // generator-dead: notifyError here would falsely brick the
              // handle for successor turns (999.99 review corruption #2).
              const abortErr = new Error(
                "Aborted: stream ended after interrupt (force-release/abandon)",
              );
              abortErr.name = "AbortError";
              throw abortErr;
            }
            // Stream ended without a result — treat as generator-dead.
            throw new Error("generator-dead");
          }
          const msg = step.value;

          // Quick task 260521-4sa (999.64) — mark SDK activity. ANY consumed
          // message counts (assistant/user/tool messages all reach here),
          // BEFORE branching on msg.type — so a long tool batch with no text
          // deltas is never falsely flagged stale by the heartbeat watchdog.
          lastTurnActivityAt = Date.now();
          // 999.173 — legacy (non-demux) path learns task ids here; idempotent
          // with the demux tap.
          taskIds.observe(msg);

          // -- assistant message: drive first_token + tool_call span opens --
          if (msg.type === "assistant") {
            const parentToolUseId =
              (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
            // 2026-08-27 — child-lane (subagent) tool_use: evidence-ONLY pass.
            // Reviewer fan-outs open sources the parent turn cites; without
            // this every such source would read as never-consulted. Spans,
            // pause/stall and onToolUse stay top-level-only as before.
            if (parentToolUseId !== null) {
              try {
                const childBlocks = ((msg as { message?: { content?: unknown[] } }).message?.content ?? []) as unknown[];
                for (const cb of childBlocks) {
                  const b = cb as { type?: string; id?: unknown; name?: unknown; input?: unknown };
                  if (b?.type !== "tool_use" || typeof b.name !== "string" || typeof b.id !== "string") continue;
                  rememberToolName(b.id, b.name);
                  for (const e of evidenceFromToolUse(b.name, b.id, b.input, Date.now())) {
                    (turn as { recordEvidence?: (x: typeof e) => void } | undefined)?.recordEvidence?.(e);
                  }
                }
              } catch {
                // Observational only.
              }
            }
            if (parentToolUseId === null) {
              const contentBlocks = ((msg as { message?: { content?: unknown[] } }).message?.content ?? []) as unknown[];
              const toolUseCount = contentBlocks.filter(
                (b) => (b as { type?: string }).type === "tool_use",
              ).length;
              const isParallelBatch = toolUseCount > 1;

              // Voice §4 — surface tool STARTS (client `tool_use` AND server-side
              // `server_tool_use`, e.g. web_search) to the OpenAI voice driver so
              // it can emit an `event: tool` label. Fire-and-forget + fully
              // guarded: this is the every-turn hot path, so an observer fault
              // must NEVER break dispatch. Only the voice driver passes onToolUse.
              if (onToolUse) {
                for (const b of contentBlocks) {
                  const bt = (b as { type?: string }).type;
                  if (bt === "tool_use" || bt === "server_tool_use") {
                    const nm = (b as { name?: unknown }).name;
                    if (typeof nm === "string" && nm.length > 0) {
                      try {
                        // 999.63d ADDENDUM — additive second arg: the raw
                        // tool input, for sanitized activity narration
                        // (streamStatus trail). Existing single-param
                        // consumers are unaffected.
                        onToolUse(nm, (b as { input?: unknown }).input);
                      } catch {
                        // Observational only — never break the message path.
                      }
                    }
                  }
                }
              }

              // Phase 115 Plan 08 T01 — sub-scope 17(a/b) split-latency.
              // Ported from session-adapter.ts:iterateWithTracing (test-only
              // path) into the production iterateUntilResult so traces.db
              // columns `tool_execution_ms`, `tool_roundtrip_ms`, and
              // `parallel_tool_call_count` actually populate.
              //
              // (1) Close the prior batch's roundtrip timer FIRST. This
              //     parent assistant message represents the LLM resuming
              //     after the previous batch's tool_results — exactly the
              //     wall-clock interval we want to record. Try/catch so an
              //     observability failure cannot break the dispatch path
              //     (Phase 50 invariant).
              try {
                if (batchOpenedAtMs !== null && turn) {
                  const roundtripMs = Date.now() - batchOpenedAtMs;
                  (turn as { addToolRoundtripMs?: (ms: number) => void })
                    .addToolRoundtripMs?.(roundtripMs);
                  batchOpenedAtMs = null;
                }
              } catch {
                // Observational only — never break the message path.
              }
              // (2) Record the parallel batch size for sub-scope 17(b).
              //     Only fire when this message HAS tool_use blocks;
              //     pure-text parent assistant messages don't contribute to
              //     the MAX.
              try {
                if (toolUseCount > 0 && turn) {
                  (turn as { recordParallelToolCallCount?: (n: number) => void })
                    .recordParallelToolCallCount?.(toolUseCount);
                  // (3) Open the next batch's roundtrip timer at the moment
                  //     this message was observed — closest available proxy
                  //     for "LLM finished generating tool_use". Will be
                  //     closed when the NEXT parent assistant arrives.
                  batchOpenedAtMs = Date.now();
                }
              } catch {
                // Observational only — never break the message path.
              }

              // Phase 117 Plan 04 T03 — pending advisor tool_use id, scoped
              // to THIS assistant message's content[]. Per RESEARCH §13.3,
              // `server_tool_use{name:"advisor"}` and the matching
              // `advisor_tool_result` block arrive in the SAME assistant
              // message's content array (typically with text blocks around
              // them); the id correlator must outlive a single loop
              // iteration but reset between assistant messages. The advisor
              // server tool is single-call-per-turn under the SDK's default
              // max_uses (RESEARCH §13.5) — message-scope is sufficient.
              let pendingAdvisorToolUseId: string | null = null;
              // Capture the assistant message's uuid for turnId correlation
              // (RESEARCH §13.10 — AdvisorInvokedEvent.turnId carries the
              // SDK message id so listeners can match :invoked → :resulted
              // pairs even across interleaved per-agent streams).
              const messageUuid =
                typeof (msg as { uuid?: unknown }).uuid === "string"
                  ? (msg as { uuid: string }).uuid
                  : sessionId;

              for (const raw of contentBlocks) {
                const block = raw as {
                  type?: string;
                  name?: string;
                  id?: string;
                  text?: string;
                  tool_use_id?: string;
                  content?: unknown;
                };
                if (block.type === "text" && !firstTokenEnded) {
                  firstToken?.end();
                  firstTokenEnded = true;
                }
                if (block.type === "text" && typeof block.text === "string") {
                  blockTextParts.push(block.text);
                }
                if (block.type === "tool_use" && block.id && block.name) {
                  // Quick task 260521-3or — tool-aware stall tracker.
                  // A top-level tool is starting; pause the stream-stall
                  // tracker so tool-execution time is deliberately NOT
                  // counted toward the stall. Heavy fin-client
                  // tools (browser / Bash / mysql, p95 5-12 min) emit no
                  // deltas while running — without this the detector
                  // would false-trip a legitimately-waiting turn. A
                  // genuinely dead stream — no deltas, no thinking, AND
                  // no tool executing — still trips at the threshold.
                  // The membership check makes the pause idempotent
                  // against duplicate SDK tool_use blocks. ACCEPTED
                  // RISK: a tool that dies without delivering a
                  // tool_result and without reaching closeAllSpans
                  // would leave the tracker paused — bounded by the
                  // catch-path stopStreamStallTracker(), the
                  // closeAllSpans() orphan drain below, and the
                  // turn-level ERR_TURN_TOO_LONG budget.
                  if (!pausedToolUseIds.has(block.id)) {
                    // Work-stream (B) — store id → tool name (was a Set of
                    // ids). The name is the operative datum for the
                    // read-only-vs-mutating wedge classification.
                    pausedToolUseIds.set(block.id, block.name);
                    // INC-2026-07-26 — lockstep open-timestamp for per-tool
                    // age in the stall-trip diagnostics.
                    pausedToolOpenedAt.set(block.id, Date.now());
                    // INC-2026-06-05 — tag fast tools so a hung seconds-scale
                    // tool settles via the short fast ceiling (~2 min) instead
                    // of the 15-min slow ceiling. Unknown/heavy tools → slow.
                    streamStallTracker?.pause({ fast: isFastTool(block.name) });
                  }
                  // Phase 999.63 Plan 02 — feed the Turn's tool-call-name
                  // accumulator. This line was lost in the Phase 73 port
                  // from wrapSdkQuery (the only prior call site, now dead
                  // code) into this production handle: the span below
                  // opened fine, but Turn.toolCallNames stayed empty, so
                  // the financial-verification gate saw
                  // `verificationToolsCalled: []` on 100% of prod checks
                  // and re-prompted every financial turn (2026-07-31
                  // fin-client incident).
                  try {
                    turn?.recordToolCallName(block.name);
                  } catch {
                    // Observational only — never break the message path.
                  }
                  // 2026-08-27 — evidence ledger (tool INPUT seam): WebFetch url, SQL
                  // tables, ingested/read client documents. Observational.
                  try {
                    rememberToolName(block.id, block.name);
                    const evInput = (raw as { input?: unknown }).input;
                    for (const e of evidenceFromToolUse(block.name, block.id, evInput, Date.now())) {
                      (turn as { recordEvidence?: (x: typeof e) => void } | undefined)?.recordEvidence?.(e);
                    }
                  } catch {
                    // Observational only.
                  }
                  // 999.103 WS-1 — TodoWrite mirror (v2/SDK capture seam).
                  // `input` is present on the raw block; the destructure
                  // above deliberately omits it, so read it here, narrowly,
                  // for exactly this one tool. Best-effort COSMETIC — the
                  // emit helper swallows everything.
                  if (block.name === "TodoWrite" && agentName) {
                    const input = (raw as { input?: unknown }).input;
                    const todos =
                      typeof input === "object" && input !== null
                        ? (input as { todos?: unknown }).todos
                        : undefined;
                    if (Array.isArray(todos) && todos.length > 0) {
                      emitTodoUpdate(agentName, todos);
                    }
                  }
                  const span = turn?.startSpan(`tool_call.${block.name}`, {
                    tool_use_id: block.id,
                    tool_name: block.name,
                    is_parallel: isParallelBatch,
                    cached: false,
                  });
                  if (span) {
                    const hitCountAtOpen =
                      (turn as { toolCache?: { hitCount: () => number } } | undefined)
                        ?.toolCache?.hitCount() ?? 0;
                    activeTools.set(block.id, {
                      span,
                      hitCountAtOpen,
                      openedAtMs: Date.now(),
                    });
                  }
                }
                // Phase 999.63 — server-side tools (`server_tool_use`, e.g.
                // the native `web_search`) also count as turn tool calls
                // for the verification gate. Recording only — the pause/
                // span/stall machinery above is deliberately NOT engaged
                // for server blocks (they execute provider-side and emit
                // no local tool_result to close a span against).
                if (
                  block.type === "server_tool_use" &&
                  typeof block.name === "string" &&
                  block.name.length > 0
                ) {
                  try {
                    turn?.recordToolCallName(block.name);
                  } catch {
                    // Observational only — never break the message path.
                  }
                }
                // Phase 117 Plan 04 T03 — native advisor observation
                // (corrected per RESEARCH §13.1 + §13.3 + §13.4).
                //
                // Two block shapes to observe inside the SAME content[]:
                //
                //   1. `server_tool_use{name:"advisor"}` — the executor
                //      signals "consult advisor now." Per §13.1 the
                //      `input` is ALWAYS empty `{}`; the advisor builds
                //      its view from the full transcript server-side, so
                //      we deliberately do NOT extract a `question`.
                //      Emit `advisor:invoked` carrying the toolUseId for
                //      pair correlation.
                //
                //   2. `advisor_tool_result` — the advisor's answer (or
                //      redaction / error). Per §13.4 the `content` field
                //      is a discriminated union of three variants. Emit
                //      `advisor:resulted` with the discriminant in `kind`
                //      and the variant-specific payload in `text` or
                //      `errorCode`.
                //
                // Wrapped in try/catch — observational only; RESEARCH §6
                // Pitfall 1 + Pitfall 7 invariant: a listener throw MUST
                // NOT break the message path.
                if (
                  advisorObserver &&
                  block.type === "server_tool_use" &&
                  block.name === "advisor" &&
                  typeof block.id === "string"
                ) {
                  pendingAdvisorToolUseId = block.id;
                  try {
                    const payload: AdvisorInvokedEvent = {
                      agent: advisorObserver.agentName,
                      turnId: messageUuid,
                      toolUseId: block.id,
                    };
                    advisorObserver.advisorEvents.emit(
                      "advisor:invoked",
                      payload,
                    );
                  } catch {
                    // observational only — never break the message path
                  }
                }
                if (
                  advisorObserver &&
                  block.type === "advisor_tool_result" &&
                  typeof block.tool_use_id === "string" &&
                  block.tool_use_id === pendingAdvisorToolUseId
                ) {
                  try {
                    const content = block.content as
                      | { type: "advisor_result"; text: string }
                      | { type: "advisor_redacted_result"; encrypted_content: string }
                      | { type: "advisor_tool_result_error"; error_code: string }
                      | null
                      | undefined;
                    const kind =
                      content && typeof content === "object" && "type" in content
                        ? content.type
                        : undefined;
                    if (
                      kind === "advisor_result" ||
                      kind === "advisor_redacted_result" ||
                      kind === "advisor_tool_result_error"
                    ) {
                      const payload: AdvisorResultedEvent = {
                        agent: advisorObserver.agentName,
                        turnId: messageUuid,
                        toolUseId: pendingAdvisorToolUseId,
                        kind,
                        text:
                          kind === "advisor_result"
                            ? (content as { text: string }).text
                            : undefined,
                        errorCode:
                          kind === "advisor_tool_result_error"
                            ? (content as { error_code: string }).error_code
                            : undefined,
                      };
                      advisorObserver.advisorEvents.emit(
                        "advisor:resulted",
                        payload,
                      );
                    }
                  } catch {
                    // observational only — never break the message path
                  }
                  pendingAdvisorToolUseId = null;
                }
              }
            }
            if (typeof (msg as { content?: string }).content === "string" && (msg as { content: string }).content.length > 0) {
              textParts.push((msg as { content: string }).content);
            }
          }

          // -- token-level streaming via SDKPartialAssistantMessage --
          // Phase 127 — useful-token tracker reset. The SAME predicate that
          // drives `streamedText` (text_delta) AND a broader predicate
          // covering tool-use streams (input_json_delta.partial_json) both
          // mark the tracker so the stall countdown restarts on any visible
          // forward progress (D-02 anti-pattern definition).
          if ((msg as { type?: string }).type === "stream_event") {
            // Phase 127 useful-token reset — quick task 260714-mkq made this
            // LANE-AGNOSTIC. A useful delta on ANY lane (top-level OR a native
            // in-session Workflow/Task child lane whose `parent_tool_use_id` is
            // set) marks the tracker so the no-useful-tokens countdown restarts
            // on any visible forward progress. Counting child-lane deltas is
            // the fix for the 2026-07-14 prod incident where three native
            // Workflow runs were killed by the stall watchdog: their streamed
            // output is `parent_tool_use_id`-tagged, so the OLD
            // `parentToolUseId === null` gate excluded it and the still-working
            // parent turn looked wedged. Genuine-wedge detection is preserved:
            // a stream with NO delta on any lane never marks and still trips at
            // thresholdMs. The predicate is single-sourced in
            // stream-stall-tracker.ts (chokepoint per
            // feedback_silent_path_bifurcation.md — the predicate unit test
            // exercises the SAME function, including a child-lane fixture).
            if (streamEventHasUsefulDelta(msg)) {
              streamStallTracker?.markUsefulToken();
            }

            // Editor pipeline stays TOP-LEVEL-only: child-lane (Workflow/Task)
            // output must NEVER leak into the user-facing streamedText. The
            // message-level `parent_tool_use_id === null` gate is the top-level
            // discriminator (proven by inc-260605-resume-probe); only a
            // top-level text_delta lands in the stream (tool-use partial_json
            // never reached the editor stream pre-127 either).
            const parentToolUseId =
              (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
            if (parentToolUseId === null && onChunk !== null) {
              const event = (msg as {
                event?: {
                  type?: string;
                  delta?: { type?: string; text?: string };
                };
              }).event;
              if (event?.type === "content_block_delta") {
                const isTextDelta =
                  event.delta?.type === "text_delta" &&
                  typeof event.delta.text === "string" &&
                  event.delta.text.length > 0;
                if (isTextDelta && event.delta) {
                  if (!firstTokenEnded) {
                    firstToken?.end();
                    firstTokenEnded = true;
                  }
                  streamedText += event.delta.text ?? "";
                  onChunk(streamedText);
                }
              }
            }
          }

          // -- tool_use_result closes matching tool_call span --
          if (msg.type === ("user" as SdkStreamMessage["type"])) {
            // INC-2026-06-05 OBSERVE-ONLY probe (remove after diagnosis). The
            // resume gate below keys off the message-level `parent_tool_use_id`;
            // we suspect some top-level tool_results arrive with that field null
            // while the matching id lives only on the `tool_result` CONTENT block.
            // This logs BOTH correlations per tool-result message so a few normal
            // tool turns tell us whether the current gate misses results that DID
            // arrive (case a — wrong field, the block-id fix works) or whether the
            // result never arrives at all (case b — generator hang, only the
            // ceiling helps). Pure logging; no behavior change. Wrapped so it can
            // never break the message path.
            try {
              const probeParent =
                (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
              const probeContent = ((msg as { message?: { content?: unknown[] } }).message
                ?.content ?? []) as unknown[];
              const resultBlockIds = probeContent
                .filter((b) => (b as { type?: string }).type === "tool_result")
                .map((b) => (b as { tool_use_id?: string }).tool_use_id ?? null);
              if (resultBlockIds.length > 0 || probeParent) {
                const pausedIds = [...pausedToolUseIds.keys()];
                console.info(
                  "inc-260605-resume-probe",
                  JSON.stringify({
                    sessionId,
                    parentToolUseId: probeParent,
                    resultBlockIds,
                    pausedIds,
                    gateResumes: !!probeParent && pausedToolUseIds.has(probeParent),
                    blockResumes: resultBlockIds.some(
                      (id) => id !== null && pausedToolUseIds.has(id),
                    ),
                  }),
                );
              }
            } catch {
              // observational — never break the message path
            }
            // INC-2026-06-05 FIX — correlate on the tool_result CONTENT block's
            // `tool_use_id`, NOT the message-level `parent_tool_use_id`. The
            // probe (`inc-260605-resume-probe`) proved top-level tool results
            // arrive with `parent_tool_use_id: null` while the matching id lives
            // only on the content block — so the old gate (`if (toolUseId)` on
            // the null parent) NEVER fired resume()/span-close for top-level
            // tools. Consequence: the stall tracker stayed paused for the entire
            // tool-using turn (pausedIds grew unbounded), so the 180s
            // no-useful-tokens detector was effectively disabled, and tool spans
            // only closed at turn end via closeAllSpans.
            //
            // Iterate ALL tool_result blocks — a single user message can carry a
            // PARALLEL batch (e.g. multiple finnhub quotes) — and resume + close
            // the span for each one this turn actually paused. Subagent-safe by
            // construction: only TOP-LEVEL tool_use ids are added to
            // pausedToolUseIds / activeTools (the pause site is gated on
            // `parentToolUseId === null`), so a subagent tool_result's id is
            // never a member here. The `closeAllSpans` orphan-drain at turn end
            // remains the safety net for a tool that genuinely never returns.
            {
              // INC-2026-07-26 review — child-lane discriminator for the
              // liveness branch below. Child-lane tool results arrive with the
              // MESSAGE-level parent_tool_use_id set to the paused parent
              // tool's id (top-level results carry null, proven by the
              // inc-260605 probe). Only child-lane results are trustworthy
              // progress evidence: a duplicate/stale TOP-LEVEL result id
              // (absent from pausedToolUseIds) proves nothing about the
              // still-outstanding batch and must not extend a real hang.
              const resultMsgParentToolUseId =
                (msg as { parent_tool_use_id?: string | null })
                  .parent_tool_use_id ?? null;
              // 2026-08-27 — figures-class provenance PRODUCER (production
              // path). The first cut of this (7ef998a8) landed in
              // session-adapter.ts inside `wrapSdkQuery`, which no production
              // code reaches — the same Phase-73 port loss documented above
              // for toolCallNames. Hand every tool_result's text to the Turn
              // so the verification gate can see whether a figure in the
              // draft came out of a tool this turn. Bounded inside
              // recordToolResultText; observational; never throws into the
              // message path.
              try {
                for (const { id, text } of toolResultBlocksFromMessage(msg)) {
                  (turn as { recordToolResultText?: (t: string) => void } | undefined)
                    ?.recordToolResultText?.(text);
                  // 2026-08-27 — evidence ledger (tool RESULT seam): search
                  // result links (WebSearch `Links:`, brave JSON).
                  const producedBy = toolNamesByUseId.get(id) ?? pausedToolUseIds.get(id) ?? "";
                  if (producedBy.length > 0) {
                    for (const e of evidenceFromToolResult(producedBy, id, text, Date.now())) {
                      (turn as { recordEvidence?: (x: typeof e) => void } | undefined)?.recordEvidence?.(e);
                    }
                  }
                }
              } catch {
                // Observational only.
              }
              for (const tid of toolResultIdsFromMessage(msg)) {
                // Resume the stall tracker (re-arms the no-useful-tokens
                // countdown from this instant; tool-execution time was excluded).
                // Mirror the pause()'s fast/slow tag. Idempotent via the set —
                // a duplicate tool_result is a harmless miss.
                if (pausedToolUseIds.has(tid)) {
                  const resumedFast = isFastTool(pausedToolUseIds.get(tid));
                  pausedToolUseIds.delete(tid);
                  pausedToolOpenedAt.delete(tid);
                  streamStallTracker?.resume({ fast: resumedFast });
                } else if (resultMsgParentToolUseId !== null) {
                  // INC-2026-07-26 — a tool_result under a non-null message
                  // parent_tool_use_id is CHILD-LANE activity: a paused parent
                  // tool's sub-lane settling (only top-level tool_use ids
                  // enter pausedToolUseIds). It proves the paused batch is
                  // alive, so it re-arms the evidence-anchored max-pause
                  // window — the 2026-07-26 reviews-complaints worker was
                  // killed at the ceiling while its single parent tool
                  // demonstrably streamed child results. A top-level result
                  // whose id is NOT paused (duplicate / stale) falls through
                  // WITHOUT marking progress — it proves nothing about the
                  // outstanding batch (review finding). No-op while unpaused.
                  streamStallTracker?.markToolProgress();
                }
                // Close the matching tool_call span (Phase 115 sub-scope 17(a)
                // execution-latency: span duration = tool_use_emitted →
                // tool_result_arrived). Wrapped so observability never breaks
                // the message path (Phase 50 invariant).
                const entry = activeTools.get(tid);
                if (entry) {
                  try {
                    const hitCountNow =
                      (turn as { toolCache?: { hitCount: () => number } } | undefined)
                        ?.toolCache?.hitCount() ?? entry.hitCountAtOpen;
                    if (hitCountNow > entry.hitCountAtOpen) {
                      entry.span.setMetadata({
                        cached: true,
                        cache_hit_duration_ms: Date.now() - entry.openedAtMs,
                      });
                    }
                  } catch {
                    // observational — never break message path
                  }
                  entry.span.end();
                  try {
                    const executionMs = Date.now() - entry.openedAtMs;
                    (turn as { addToolExecutionMs?: (ms: number) => void })
                      .addToolExecutionMs?.(executionMs);
                  } catch {
                    // Observational only — never break the message path.
                  }
                  activeTools.delete(tid);
                }
              }
            }
          }

          // -- rate_limit_event: forward to per-handle tracker (Phase 103 OBS-05) --
          // Observational like extractUsage — never breaks the message flow.
          // SDK fires rate_limit_event inline on the same async iterator as
          // assistant/result/stream_event/user; per Research Pattern 1 the only
          // correct hook point is here in the per-agent loop. Branch is
          // positioned BEFORE the `result` branch so result still terminates
          // the turn (the two are mutually exclusive on `msg.type`, but the
          // ordering documents intent and keeps the result-terminator path
          // unchanged). Pitfall 8: tracker may be undefined during the race
          // window between handle construction and SessionManager's
          // `setRateLimitTracker` call — silently drop in that case.
          if ((msg as { type?: string }).type === "rate_limit_event") {
            try {
              const event = msg as unknown as { rate_limit_info?: SDKRateLimitInfo };
              if (event.rate_limit_info) {
                _rateLimitTracker?.record(event.rate_limit_info);
              }
            } catch {
              // observational — never break message flow (matches extractUsage)
            }
          }

          // -- result message: terminates THIS turn; capture telemetry --
          if (msg.type === "result") {
            const resMsg = msg as {
              session_id?: string;
              result?: string;
              subtype?: string;
              is_error?: boolean;
              usage?: {
                input_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              };
            };
            if (resMsg.session_id) sessionId = resMsg.session_id;
            extractUsage(msg);

            // Cache telemetry (Phase 52 Plan 01 + Plan 02 CACHE-04).
            if (turn) {
              try {
                const u = resMsg.usage ?? {};
                const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
                const cacheCreation = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
                const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;

                let prefixHash: string | undefined;
                let cacheEvictionExpected: boolean | undefined;
                try {
                  if (prefixHashProvider) {
                    const probe = prefixHashProvider.get();
                    if (probe && typeof probe.current === "string" && probe.current.length > 0) {
                      prefixHash = probe.current;
                      cacheEvictionExpected =
                        probe.last === undefined ? false : probe.current !== probe.last;
                    }
                  }
                } catch {
                  // provider threw — continue with token counts only
                }

                turn.recordCacheUsage({
                  cacheReadInputTokens: cacheRead,
                  cacheCreationInputTokens: cacheCreation,
                  inputTokens: input,
                  prefixHash,
                  cacheEvictionExpected,
                });

                try {
                  if (prefixHash !== undefined) {
                    prefixHashProvider?.persist(prefixHash);
                  }
                } catch {
                  // persistence failure — observational path, never break message
                }
              } catch {
                // never break the send flow due to cache-capture failure
              }
            }

            // Skill-mention capture (Phase 53 Plan 03).
            try {
              if (skillTracking) {
                const assistantText = [...textParts, ...blockTextParts].join("\n");
                const mentioned = extractSkillMentions(
                  assistantText,
                  skillTracking.skillCatalogNames,
                );
                skillTracking.skillUsageTracker.recordTurn(skillTracking.agentName, {
                  mentionedSkills: mentioned,
                });
              }
            } catch {
              // observational — never break message path
            }

            closeAllSpans();
            // Phase 127 — stop tracker on success exit. Idempotent;
            // safe to pair with the catch-path stop below (T-127-04).
            stopStreamStallTracker();

            // Part B (quick task 260714-mkq) — NO-MASQUERADE guard. If the
            // stall watchdog tripped THIS turn, a `result` message can still
            // race back inside INTERRUPT_DEADLINE_MS and reach this success
            // branch (the interrupt aborted the turn, but the SDK emitted a
            // final `result` before the generator threw). Returning it via any
            // of the three result-branch returns below would let the KILLED
            // turn masquerade as a clean completion — invisible to operator and
            // model (the 2026-07-14 hallucinated-status bug). Throw an
            // AbortError instead so the outer catch routes this turn through the
            // wedge-recovery path: it reads `lastStreamStallPayload`, attaches
            // `wedgeInfo`, and the bridge surfaces the operator notice + primes
            // the model that the prior turn was aborted. This single guard
            // covers ALL THREE returns (resMsg.result, soft-recovered
            // error_during_execution, streamedText/textParts) because they all
            // sit below it. Fires for EVERY trip mode (no-useful-tokens,
            // max-pause-exceeded, max-turn-duration) — the correct superset.
            // `lastStreamStallPayload` is mutated only inside the `onStall`
            // closure, which TS control-flow analysis does not track — it would
            // otherwise narrow this read to `null` (then `never` after the
            // guard). Read once through an explicit cast to the declared union,
            // the same idiom the catch block below uses.
            const trippedStallPayload = lastStreamStallPayload as
              | StreamStallPayload
              | null;
            if (trippedStallPayload !== null) {
              // INC-2026-07-26 — carry the trip-time in-flight tool detail in
              // the message so downstream logs (the workflow orchestrator
              // records err.message verbatim) self-identify the offending
              // tool(s). The message PREFIX is load-bearing: the workflow
              // step-retry classifier matches on
              // STREAM_STALL_MASQUERADE_PREFIX — extend only after `reason=`.
              const toolDetail = lastStallInFlightToolDetail as string | null;
              const stallAbortErr = new Error(
                `${STREAM_STALL_MASQUERADE_PREFIX} (reason=${trippedStallPayload.reason}` +
                  (toolDetail !== null ? `, inFlightTools=${toolDetail}` : "") +
                  `)`,
              );
              stallAbortErr.name = "AbortError";
              throw stallAbortErr;
            }

            if (typeof resMsg.result === "string" && resMsg.result.length > 0) {
              return resMsg.result;
            }
            if (resMsg.subtype !== "success" && resMsg.is_error) {
              // Soft-recover on `error_during_execution`: Anthropic returns
              // this stop_reason on transient long-output / mid-stream
              // failures (~30 occurrences in 5d, consistent across deploys
              // — not a regression). When we have streamed text captured
              // before the error landed, treat it as a successful turn end
              // and append a short note so the operator knows generation
              // was cut short and can ask for continuation.
              //
              // The other SDKResultError subtypes (error_max_turns,
              // error_max_budget_usd, error_max_structured_output_retries)
              // are user-visible budget / control failures — keep throwing
              // so the operator's restart-recovery flow stays observable.
              if (
                resMsg.subtype === "error_during_execution" &&
                (streamedText.length > 0 || blockTextParts.length > 0)
              ) {
                const partial =
                  streamedText.length > 0
                    ? streamedText
                    : blockTextParts.join("\n");
                const extra = resMsg as unknown as {
                  num_turns?: number;
                  duration_ms?: number;
                };
                console.warn(
                  JSON.stringify({
                    component: "persistent-session-handle",
                    action: "error_during_execution-soft-recovered",
                    subtype: resMsg.subtype,
                    partialLength: partial.length,
                    turnCount: extra.num_turns,
                    durationMs: extra.duration_ms,
                    msg: "soft-recovered error_during_execution with partial streamed text",
                  }),
                );
                return (
                  partial +
                  "\n\n*(Generation was cut short by Anthropic. Ask me to continue if you need more.)*"
                );
              }
              throw new Error(`Agent error: ${resMsg.subtype}`);
            }
            return streamedText.length > 0 ? streamedText : textParts.join("\n");
          }
        }
      } finally {
        if (signal) signal.removeEventListener("abort", abortHandler);
        // Quick task 260419-nic — clear handle-level interrupt slot on every
        // exit path (success and error). Post-turn handle.interrupt() is a no-op.
        // 999.99 review — identity-guarded so a ghost's late exit cannot
        // wipe the successor turn's freshly-installed slots.
        if (currentInterruptFn === myInterruptFn) currentInterruptFn = null;
        if (currentStallControl === myStallControl) currentStallControl = null;
        // Work-stream (B) — clear the in-flight tool probe on every exit
        // path so a stale closure can never bleed into the next turn.
        //
        // IMPORTANT ordering note: this inner `finally` runs DURING stack
        // unwinding, BEFORE the outer `catch` below. So we must NOT clear
        // `sweepForceReleaseInFlightTools` here — the catch path needs it
        // to build the WedgeInfo. The catch clears it itself; the success
        // path leaves it null (a successful turn was never force-released).
        currentInFlightToolsFn = null;
        // Work-stream (C), FORK 8 — clear the parallel id+name probe on the
        // same exit path as its B-era sibling above.
        currentInFlightToolUsesFn = null;
        // Phase 127 — defense-in-depth: also stop the tracker on any
        // finally exit so a code path that returns without hitting the
        // success branch above (e.g. break-out paths added in future
        // patches) still cleans up the interval (T-127-04).
        stopStreamStallTracker();
      }
    } catch (err) {
      // Debug session `in-tool-wedge-recovery` work-stream (B) — snapshot
      // the in-flight tool names BEFORE closeAllSpans() runs (it clears
      // `pausedToolUseIds`). THREE sources, in priority order (Finding 1,
      // 260714-mkq review, added source 2):
      //   1. `sweepForceReleaseInFlightTools` — set by `forceReleaseTurn()`
      //      when the 999.64 heartbeat sweep force-released this turn. The
      //      sweep route bypasses the Phase 127 `onStall` path, so this is
      //      the ONLY way a sweep-released wedge surfaces its in-flight
      //      tools (both 2026-05-21 production wedges took this route).
      //   2. `lastStallInFlightToolNames` — the TRIP-TIME snapshot captured
      //      inside `onStall`. Preferred whenever the tracker tripped this
      //      turn: on the raced-result path (Part B no-masquerade guard) the
      //      success branch already ran closeAllSpans() and DRAINED
      //      `pausedToolUseIds` before the guard's AbortError reaches this
      //      catch — reading the live map there yields [] and
      //      decideWedgeRecovery would silently auto-rerun a MUTATING tool.
      //      Also the conservative choice on the deadline-race path: a tool
      //      in flight AT TRIP TIME stays visible even if its result trickled
      //      in during the 2s interrupt window (errs toward "notify").
      //   3. The live `pausedToolUseIds` values — non-tracker aborts (e.g.
      //      operator interrupt), where the turn is still inside this closure
      //      when the catch fires, so the map is still populated.
      // Whether the 999.64 heartbeat sweep force-released this turn —
      // captured into a local NOW, before `sweepForceReleaseInFlightTools`
      // is cleared below, so the `wedgeReason` computation further down can
      // still read it. (`sweepForceReleaseInFlightTools` is the slot;
      // `wasSweepForceReleased` is the durable snapshot of "was it set".)
      // Both stall locals are mutated only inside the `onStall` closure —
      // read through explicit casts (same idiom as `trippedPayload` below).
      const wasSweepForceReleased = sweepForceReleaseInFlightTools !== null;
      const stallTrippedThisTurn =
        (lastStreamStallPayload as StreamStallPayload | null) !== null;
      const stallTripSnapshot = lastStallInFlightToolNames as
        | readonly string[]
        | null;
      const inFlightToolNamesAtCatch: readonly string[] =
        sweepForceReleaseInFlightTools ??
        (stallTrippedThisTurn && stallTripSnapshot !== null
          ? stallTripSnapshot
          : [...pausedToolUseIds.values()]);
      closeAllSpans();
      // Phase 127 — stop the tracker on catch path. Defense-in-depth
      // against AbortError + generator-dead exits (T-127-04 mitigation).
      stopStreamStallTracker();
      // Quick task 260419-nic — also clear on error path (defense in depth;
      // the try/finally above already clears, but pair this with closeAllSpans).
      // 999.99 review — identity-guarded (ghost-safe), same as the finally.
      if (currentInterruptFn === myInterruptFn) currentInterruptFn = null;
      if (currentStallControl === myStallControl) currentStallControl = null;
      // Work-stream (B) — clear the in-flight tool probe + sweep snapshot
      // on the error path so they never leak across turns. Work-stream (C)
      // — clear the parallel id+name probe on the same path.
      currentInFlightToolsFn = null;
      currentInFlightToolUsesFn = null;
      sweepForceReleaseInFlightTools = null;
      // If abort path caused the error, propagate as AbortError; otherwise
      // this is a generator-dead scenario — notify error handlers.
      if (
        (err instanceof Error && err.name === "AbortError") ||
        signal?.aborted
      ) {
        const abortErr = err instanceof Error ? err : new Error(String(err));
        abortErr.name = "AbortError";
        // Work-stream (B) — attach the WedgeInfo so the Discord recovery
        // layer (bridge.ts / subagent-thread-spawner.ts) can decide
        // auto-rerun vs notify. `reason` discriminates the trip mode:
        // "sweep-force-release" when the 999.64 sweep recorded the
        // snapshot, otherwise the Phase 127 tracker reason (carried on
        // `lastStreamStallPayload`, defaulting to "no-useful-tokens" for a
        // non-tracker abort e.g. an operator interrupt). An empty
        // `inFlightToolNames` is a pure-text hang — auto-retry-safe.
        // `lastStreamStallPayload` is mutated only inside the `onStall`
        // closure, which TS control-flow analysis does not track — it
        // would otherwise narrow this read to `null`. Read once through an
        // explicit cast to the declared union (same idiom as bridge.ts's
        // `lastAdvisorResult` snapshot).
        const trippedPayload = lastStreamStallPayload as
          | StreamStallPayload
          | null;
        const wedgeReason: WedgeInfo["reason"] = wasSweepForceReleased
          ? "sweep-force-release"
          : (trippedPayload?.reason ?? "no-useful-tokens");
        (abortErr as Error & { wedgeInfo?: WedgeInfo }).wedgeInfo = {
          reason: wedgeReason,
          inFlightToolNames: inFlightToolNamesAtCatch,
        };
        throw abortErr;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      // 999.99 review — epoch stamp: a ghost's generator-dead landing after
      // a compaction swap must not poison the FRESH epoch's generatorDead
      // flag (the swap already reset it; the ghost belongs to the old one).
      if (myEpoch === epoch) {
        notifyError(e);
      }
      throw e;
    }
  }

  // Phase 999.100 — mid-turn steer injection state. The per-turn counter
  // resets when the SerialTurnQueue in-flight IDENTITY changes (peekInFlight
  // ref compare), so the three send paths need no bookkeeping of their own.
  let midturnInjectCount = 0;
  let midturnInjectTurnRef: Promise<unknown> | null = null;

  // 999.99 review CRITICAL — the in-flight send's demux token. Set by the
  // send paths right after registerDaemonSend, cleared in their finally.
  // forceReleaseTurn reads it to abandon the demux turn BEFORE freeing the
  // SerialTurnQueue slot (the only moment the abandon precondition — no
  // concurrent consumer — is guaranteed on the force-release path).
  let currentSendToken: number | null = null;

  const handle: SessionHandle = {
    get sessionId(): string {
      return sessionId;
    },

    async send(message: string, turn?: Turn, options?: SendOptions): Promise<void> {
      if (closed) throw new Error(`Session ${sessionId} is closed`);
      if (generatorDead) {
        throw generatorError ?? new Error(`Session ${sessionId} closed: generator-dead`);
      }
      await turnQueue.run(async () => {
        turnStartedAt = Date.now();
        lastTurnActivityAt = Date.now();
        try {
          // WS-1 — register the daemon-send expectation BEFORE the push so
          // the demux classifies the upcoming turn as ours (no-op when null).
          const sendToken = demux ? demux.registerDaemonSend() : null;
          currentSendToken = sendToken;
          try {
            inputQueue.push(buildUserMessage(promptWithMutable(message), options?.images));
            await iterateUntilResult(null, turn, options?.signal);
          } catch (err) {
            // 999.99-F2 — every abnormal exit of iterateUntilResult means the
            // turn's result was NOT consumed (a normal return IS the result).
            // Tell the demux so the late frames/result re-route to the orphan
            // sink instead of poisoning the next dispatch. Token-gated: a
            // force-release that already abandoned this turn makes this call
            // a strict no-op (no-op on legacy too).
            if (demux && sendToken !== null) {
              demux.abandonDaemonTurn(sendToken, err instanceof Error ? err.message : String(err));
            }
            throw err;
          } finally {
            if (currentSendToken === sendToken) currentSendToken = null;
          }
        } finally {
          turnStartedAt = null;
          lastTurnActivityAt = null;
        }
      });
    },

    async sendAndCollect(message: string, turn?: Turn, options?: SendOptions): Promise<string> {
      if (closed) throw new Error(`Session ${sessionId} is closed`);
      if (generatorDead) {
        throw generatorError ?? new Error(`Session ${sessionId} closed: generator-dead`);
      }
      return turnQueue.run(async () => {
        turnStartedAt = Date.now();
        lastTurnActivityAt = Date.now();
        try {
          // WS-1 — register the daemon-send expectation BEFORE the push so
          // the demux classifies the upcoming turn as ours (no-op when null).
          const sendToken = demux ? demux.registerDaemonSend() : null;
          currentSendToken = sendToken;
          try {
            inputQueue.push(buildUserMessage(promptWithMutable(message), options?.images));
            return await iterateUntilResult(null, turn, options?.signal);
          } catch (err) {
            // 999.99-F2 — abnormal exit ⇒ result unconsumed; re-route the
            // abandoned turn to the orphan sink, token-gated (see send()).
            if (demux && sendToken !== null) {
              demux.abandonDaemonTurn(sendToken, err instanceof Error ? err.message : String(err));
            }
            throw err;
          } finally {
            if (currentSendToken === sendToken) currentSendToken = null;
          }
        } finally {
          turnStartedAt = null;
          lastTurnActivityAt = null;
        }
      });
    },

    async sendAndStream(
      message: string,
      onChunk: (accumulated: string) => void,
      turn?: Turn,
      options?: SendOptions,
    ): Promise<string> {
      if (closed) throw new Error(`Session ${sessionId} is closed`);
      if (generatorDead) {
        throw generatorError ?? new Error(`Session ${sessionId} closed: generator-dead`);
      }
      return turnQueue.run(async () => {
        turnStartedAt = Date.now();
        lastTurnActivityAt = Date.now();
        try {
          // WS-1 — register the daemon-send expectation BEFORE the push so
          // the demux classifies the upcoming turn as ours (no-op when null).
          const sendToken = demux ? demux.registerDaemonSend() : null;
          currentSendToken = sendToken;
          // 999.171 — route this turn's live thinking to its own turn id.
          // send()/sendAndCollect() have no status-trail consumer, so they
          // leave the slot null (their daemon turns emit nothing).
          const thinkingTurnId = turn?.id ?? null;
          currentThinkingTurnId = thinkingTurnId;
          // 999.172 — only this send path can own a prompt suggestion.
          if (sendToken !== null && thinkingTurnId !== null) rememberStreamTurn(sendToken, thinkingTurnId);
          // 999.173 — the research launch gate admits researchers only while a
          // Discord-user turn is live. send()/sendAndCollect() (cron, IPC,
          // ask-agent, Event Dossier wakes) never set this.
          const originMessageId = discordMessageIdOf(turn?.id);
          const clearLiveTurn =
            researchTracker !== null && agentName !== undefined && originMessageId !== null && turn !== undefined
              ? setLiveDiscordTurn(
                  agentName,
                  {
                    turnId: turn.id,
                    messageId: originMessageId,
                    channelId: turn.channelId ?? null,
                    resumeRequested: asksToResumeResearch(message),
                  },
                  // A self-fired wake turn still running ahead of this queued
                  // message must not borrow it to fan out.
                  () => !(demux?.isOrphanTurnOpen() ?? false),
                )
              : null;
          try {
            inputQueue.push(buildUserMessage(promptWithMutable(message), options?.images));
            return await iterateUntilResult(
              onChunk,
              turn,
              options?.signal,
              options?.onToolUse,
            );
          } catch (err) {
            // 999.99-F2 — abnormal exit ⇒ result unconsumed; re-route the
            // abandoned turn to the orphan sink, token-gated (see send()).
            if (demux && sendToken !== null) {
              demux.abandonDaemonTurn(sendToken, err instanceof Error ? err.message : String(err));
            }
            throw err;
          } finally {
            if (currentSendToken === sendToken) currentSendToken = null;
            if (currentThinkingTurnId === thinkingTurnId) currentThinkingTurnId = null;
            clearLiveTurn?.();
          }
        } finally {
          turnStartedAt = null;
          lastTurnActivityAt = null;
        }
      });
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Quick task 260419-nic — clear handle-level interrupt slot so any
      // post-close handle.interrupt() call is a hard no-op.
      currentInterruptFn = null;
      currentStallControl = null;
      // 999.171 — no live thinking is routed after terminal close.
      currentThinkingTurnId = null;
      // FIND-123-A.next T-02 — clear the pid sink at terminal close so a
      // subsequent daemon shutdown sweep does not group-kill a PID that
      // has already been recycled by the kernel. Locked sink semantics.
      pidSink.pid = null;
      inputQueue.end();
      try {
        q.close();
      } catch {
        // ignore — close may already be in-flight
      }
      // WS-1 — stop the demux pump at terminal close (no-op on legacy path).
      try {
        demux?.stop();
      } catch {
        // best-effort teardown
      }
      // 999.173 — after the demux flush: settle the research card and deliver
      // any folded text (researchers die with the process).
      try {
        researchTracker?.dispose("close");
        unregisterResearchTracker?.();
        backgroundBoard?.dispose();
        unregisterBackgroundBoard?.();
      } catch {
        // best-effort teardown
      }
      for (const h of endHandlers) {
        try {
          h();
        } catch {
          // swallow
        }
      }
    },

    onError(handler: (err: Error) => void): void {
      errorHandlers.push(handler);
    },

    onEnd(handler: () => void): void {
      endHandlers.push(handler);
    },

    setEffort(level: EffortLevel): void {
      const previousEffort = currentEffort;
      currentEffort = level;
      // Phase 83 EFFORT-01 — close the P0 silent no-op (PITFALLS §Pitfall 1).
      // mapEffortToTokens returns 0 for "off", null for "auto", or an
      // explicit integer budget for the leveled modes. setMaxThinkingTokens
      // is async on the SDK (sdk.d.ts:1728) but we intentionally do NOT
      // await — setEffort must stay synchronous because the slash-command
      // / IPC call path cannot yield. Rejections are logged-and-swallowed
      // so a transient SDK failure never crashes a healthy turn.
      // Phase 999.98 D4 — Fable effort-`off`→null guard. `currentModel` is
      // seeded from the resolved SDK id (line ~396), so for a `model: fable`
      // agent it is "claude-fable-5" before any setModel; the guard fires
      // correctly at boot. Opus 4.8 keeps `0`; Fable's `0` becomes `null`.
      const budget = guardEffortBudgetForModel(
        mapEffortToTokens(level),
        currentModel,
      );
      // Quick 260715-j1j (D3) + review CR-01 — ultracode enter/exit fires the
      // apply_flag_settings control request as an INDEPENDENT fire-and-forget
      // chain, invoked BEFORE the budget call (synchronous call order
      // preserves control-request wire order). The budget below is
      // deliberately NOT gated on the flag resolving: on the prod 2.1.158
      // pin the unknown control request may reject (never verified — only
      // 2.1.210 was), and a transient SDK error on ANY CLI must not silently
      // drop the budget. Either way the agent degrades to plain xhigh — the
      // budget always lands.
      if (level === "ultracode") {
        console.info(
          "[effort] entering ultracode — requires claude >=2.1.210; an older CLI rejects/ignores the flag and degrades to plain xhigh",
        );
        void q.applyFlagSettings({ ultracode: true }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[effort] ultracode enter applyFlagSettings failed: ${msg}`);
        });
      } else if (previousEffort === "ultracode") {
        // Leaving ultracode — clear the mode flag (the CLI injects its
        // ultra_effort_exit reminder). The new budget below applies
        // regardless of the flag outcome (CR-01: an exit-flag rejection must
        // not leave the agent thinking at the old, possibly higher, budget).
        void q.applyFlagSettings({ ultracode: false }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[effort] ultracode exit applyFlagSettings failed: ${msg}`);
        });
      }
      void q.setMaxThinkingTokens(budget).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[effort] setMaxThinkingTokens(${String(budget)}) failed: ${msg}`);
      });
    },

    getEffort(): EffortLevel {
      return currentEffort;
    },

    setModel(modelId: string): void {
      currentModel = modelId;
      // Phase 86 MODEL-03 — SDK canary pattern (Phase 83 blueprint).
      // q.setModel is async on the SDK (sdk.d.ts:1711) but we DO NOT await —
      // setModel must stay synchronous because the IPC / slash call path
      // cannot yield. Rejections are logged-and-swallowed so a transient
      // SDK failure never crashes a healthy turn. Regression pinned by
      // spy test in persistent-session-handle-model.test.ts.
      void q.setModel(modelId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[model] setModel(${modelId}) failed: ${msg}`);
      });
    },

    getModel(): string | undefined {
      return currentModel;
    },

    setPermissionMode(mode: PermissionMode): void {
      currentPermissionMode = mode;
      // Phase 87 CMD-02 — SDK canary pattern (Phase 83/86 blueprint applied).
      // q.setPermissionMode is async on the SDK (sdk.d.ts:1704) but we DO
      // NOT await — setPermissionMode must stay synchronous because the
      // IPC / slash call path cannot yield. Rejections are logged-and-
      // swallowed so a transient SDK failure never crashes a healthy turn.
      // Regression pinned by spy test in
      // persistent-session-handle-permission.test.ts (P1-P5).
      void q.setPermissionMode(mode).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[permission] setPermissionMode(${mode}) failed: ${msg}`);
      });
    },

    getPermissionMode(): PermissionMode {
      return currentPermissionMode;
    },

    /**
     * Quick task 260419-nic — public mid-turn interrupt primitive.
     *
     * When a turn is in-flight (currentInterruptFn installed by
     * iterateUntilResult), fires the SDK q.interrupt() via the captured
     * closure. The in-flight send/sendAndCollect/sendAndStream rejects with
     * AbortError within the INTERRUPT_DEADLINE_MS (2s) window via the
     * existing abort-deadline race inside iterateUntilResult.
     *
     * No-op when:
     *   - handle is closed (currentInterruptFn cleared in close())
     *   - no turn is in-flight (slot is null between turns)
     *   - q.interrupt() was already called this turn (fireInterruptOnce guard)
     *
     * Synchronous by design — q.interrupt() is fire-and-forget.
     */
    interrupt(): void {
      if (closed) return;
      const fn = currentInterruptFn;
      if (fn) fn();
    },

    /**
     * Quick task 260419-nic — in-flight turn probe.
     *
     * Returns true only when a turn is actively iterating driverIter.
     * False on freshly-created handle, between turns, and after close().
     * Backed by SerialTurnQueue.hasInFlight() — single source of truth.
     */
    hasActiveTurn(): boolean {
      return !closed && turnQueue.hasInFlight();
    },

    /**
     * Phase 999.100 — push a user message into the RUNNING turn's input
     * stream (no interrupt). See the SessionHandle type doc for the
     * contract; spike-verified mid-turn consumption on claude 2.1.211.
     *
     * Synchronous guard-and-push: no awaits between the in-flight identity
     * read and the inputQueue.push, so the check-push pair is atomic
     * w.r.t. this process. Spill race (999.99 review correction — the
     * earlier "harmless under WS-1" claim was WRONG when a dispatch is
     * queued): with a demux present, injection additionally requires the
     * daemon turn to be open ON THE WIRE (isDaemonTurnOpen below). The
     * result frame must therefore arrive in the same tick as this check to
     * spill — a sub-ms window (vs the previous whole classification span).
     * RESIDUAL, accepted + documented: a spill landing while a NEXT
     * dispatch is already queued can steal that dispatch's expectation
     * (its reply then detours to the ⏱️ sink and the dispatch answers the
     * steer text). Bridge policy keeps steering gated on
     * hasAttributedStream, so the legacy path — where a spill would
     * silently poison the stream — never injects at all.
     *
     * Deliberately RAW push: no promptWithMutable wrap (a steering envelope
     * must not accrete memory-context suffixes) and no trace Turn (the
     * injection rides the already-open turn). The lastTurnActivityAt bump
     * keeps the 999.64 stale-turn watchdog from misreading the now-longer
     * turn while the model integrates the guidance.
     */
    injectMidTurn(
      text: string,
      opts?: { readonly maxPerTurn?: number },
    ): { injected: boolean; reason?: "closed" | "idle" | "cap" } {
      if (closed || generatorDead) return { injected: false, reason: "closed" };
      const ref = turnQueue.peekInFlight();
      if (ref === null) return { injected: false, reason: "idle" };
      // 999.99 review (steer-spill) — with a demux present, also require
      // the daemon turn to be open ON THE WIRE. Once the turn's result has
      // been routed stream-side, a push would become the NEXT turn's
      // opening input (an expectation-less spill turn that could steal a
      // queued dispatch's classification). Declining here makes the bridge
      // fall back to a normal queued dispatch — always correct.
      if (demux && !demux.isDaemonTurnOpen()) {
        return { injected: false, reason: "idle" };
      }
      if (ref !== midturnInjectTurnRef) {
        midturnInjectTurnRef = ref;
        midturnInjectCount = 0;
      }
      const cap = opts?.maxPerTurn ?? 3;
      if (midturnInjectCount >= cap) return { injected: false, reason: "cap" };
      midturnInjectCount += 1;
      inputQueue.push(buildUserMessage(text));
      if (lastTurnActivityAt !== null) lastTurnActivityAt = Date.now();
      return { injected: true };
    },

    /**
     * 999.99 review — capability probe: was this session built with the
     * attributed-stream demux? The bridge gates the ENTIRE mid-turn
     * steering feature on this (a steering stop on a legacy session would
     * abandon an unread result and re-seed the off-by-one the demux
     * exists to kill).
     */
    hasAttributedStream(): boolean {
      return !closed && demux !== null;
    },

    /**
     * 999.99 review — is a self-fired (orphan) turn streaming right now?
     * The 999.64 stale-turn sweep consults this: a daemon turn waiting
     * behind a long orphan turn shows no activity of its own, and
     * force-releasing it would interrupt the HEALTHY foreign turn.
     */
    isOrphanTurnOpen(): boolean {
      return !closed && (demux?.isOrphanTurnOpen() ?? false);
    },

    /**
     * Phase 124 follow-up — turn-start timestamp accessor.
     *
     * Returns the ms-epoch time the in-flight turn began (set at the top of
     * the inner turnQueue.run callback inside send / sendAndCollect /
     * sendAndStream). Null when no turn is in-flight, between turns, after
     * a resolved or rejected turn, and after close(). Read by the
     * `compact-session` IPC handler to enforce the ERR_TURN_TOO_LONG safety
     * budget (CONTEXT D-03 step 2).
     *
     * Single source of truth — the daemon mirrors this via SessionManager's
     * `getTurnStartedAt(name)` rather than maintaining a parallel map.
     */
    getTurnStartedAt(): number | null {
      if (closed) return null;
      return turnStartedAt;
    },

    /**
     * Quick task 260521-4sa (999.64) — last-SDK-activity timestamp accessor.
     *
     * Returns the ms-epoch time the in-flight turn last consumed an SDK
     * message (set at turn start, then refreshed on every message in
     * `iterateUntilResult`). Null on a fresh handle, between turns, and after
     * close(). The heartbeat watchdog reads this (via SessionManager) to
     * distinguish a genuinely active turn from a wedged one.
     */
    getLastTurnActivityAt(): number | null {
      if (closed) return null;
      return lastTurnActivityAt;
    },

    /**
     * Quick task 260521-4sa (999.64) — force-release a wedged turn lock.
     *
     * The wedge: an SDK turn hangs inside `iterateUntilResult` — `next()`
     * never resolves, no abort fires — so `SerialTurnQueue.run`'s `.finally()`
     * never clears the per-agent lock and every subsequent inbound message is
     * skipped at the heartbeat layer.
     *
     * Recovery, in order (the order is load-bearing):
     *   1. Capture the queue's TRACKING in-flight ref via `peekInFlight()`.
     *      Return false immediately if null — no turn to release (idempotent).
     *   2. Fire `interrupt()` FIRST so the ghost `iterateUntilResult` is
     *      aborted (existing `fireInterruptOnce` → `q.interrupt()` + 2s
     *      abort-deadline race). This prevents a dead turn from producing
     *      side effects after the slot is cleared (threat T-99964-02).
     *   3. `turnQueue.forceClearInFlight(ref)` — identity-checked, so a turn
     *      that rolled the slot over since step 1 is never clobbered.
     *
     * Returns true iff the slot was cleared. No-op false return when no turn
     * is in flight or the ref no longer matches.
     */
    forceReleaseTurn(): boolean {
      if (closed) return false;
      const ref = turnQueue.peekInFlight();
      if (ref === null) return false;
      // Debug session `in-tool-wedge-recovery` work-stream (B) — snapshot
      // the in-flight tool names BEFORE firing the interrupt. The 999.64
      // heartbeat sweep reaches a wedged turn ONLY via this method, and
      // this route does NOT pass through the Phase 127 `onStall` handler.
      // Recording the snapshot here is the sole way a sweep-released
      // wedge can surface its in-flight tools to the recovery layer — the
      // iterateUntilResult catch path reads `sweepForceReleaseInFlightTools`
      // when building the WedgeInfo on the thrown AbortError. Both
      // 2026-05-21 production wedges were sweep-released subagents, so
      // this is the load-bearing path, not an edge case. Captured even
      // when empty (a pure-text hang) — an empty array is a valid
      // auto-retry-safe WedgeInfo.
      sweepForceReleaseInFlightTools = currentInFlightToolsFn
        ? currentInFlightToolsFn()
        : [];
      // Abort the ghost iteration BEFORE clearing the slot.
      const fn = currentInterruptFn;
      if (fn) fn();
      // 999.99 review CRITICAL — abandon the in-flight send's demux turn
      // NOW, while the slot is still held (the ONLY moment on this path
      // where no successor consumer can exist). The ghost's late frames
      // and result re-route to the orphan sink instead of feeding the next
      // dispatch, and the ghost's own catch-side abandon (up to 2s later)
      // becomes a token-gated no-op instead of corrupting turn B.
      if (demux && currentSendToken !== null) {
        try {
          demux.abandonDaemonTurn(currentSendToken, "force-release");
        } catch {
          // never block the release path
        }
      }
      // 999.171 — the released turn no longer owns live thinking. Its ghost's
      // finally would clear the slot too, but only once it exits; a successor
      // send()/sendAndCollect() (which never sets the slot) must not inherit it.
      currentThinkingTurnId = null;
      return turnQueue.forceClearInFlight(ref);
    },

    /**
     * Debug session `in-tool-wedge-recovery` work-stream (C), FORK 8 —
     * clean-detach-or-force-release a wedged turn.
     *
     * The 999.64 heartbeat sweep calls this INSTEAD of the blunt
     * `forceReleaseTurn()`. Decision (all in the handle — the runner stays
     * narrow):
     *
     *   - NO turn in flight  → `"no-turn"` (idempotent no-op).
     *   - EVERY in-flight tool is detachable (Bash / Task — see
     *     `isDetachableTool`) → attempt `q.backgroundTasks(toolUseId)` for
     *     each. If at least one detach reports `true`, the SDK delivers a
     *     synthetic "running in the background" tool_result and the
     *     in-flight turn RESUMES — NO abort, NO `q.interrupt()`, NO
     *     `forceClearInFlight`, NO `wedgeInfo`. Returns `"detached"`. This
     *     is the clean, non-destructive recovery: the user's request keeps
     *     going. Best-effort `stopTask` cleanup is fired after a successful
     *     detach (swallowed — a D-state child is irreducible).
     *   - The batch contains a NON-detachable tool (an MCP tool, or a
     *     non-task built-in), OR `backgroundTasks` returned `false` for
     *     every detachable tool (the task already settled / wrong id), OR
     *     the detach threw → FALL BACK to the existing `forceReleaseTurn()`
     *     body (interrupt + forceClearInFlight). Returns `"released"` (or
     *     `"no-turn"` if the turn settled in the meantime). The
     *     force-release path aborts the turn → the iterateUntilResult catch
     *     attaches `wedgeInfo` → work-stream (B)'s smart recovery fires as
     *     before. A MIXED batch is NEVER half-detached — half a batch
     *     falling off the SDK queue would leave an inconsistent state;
     *     conservative whole-batch fallback is deliberate.
     *
     * Async (unlike `forceReleaseTurn`) because `backgroundTasks` is a
     * Promise. The caller (the sweep) bounds it with a timeout so a sick
     * SDK can never block the heartbeat tick.
     *
     * INVARIANT (the no-double-recovery guarantee): the `"detached"` branch
     * does NOT call `forceReleaseTurn`, `q.interrupt()`, or
     * `fireInterruptOnce` — so a detached turn never throws an AbortError
     * and never gets a `wedgeInfo`. B's smart recovery is keyed on
     * `wedgeInfo`, so it correctly does NOT fire for a detach. Only the
     * `"released"` fallback aborts → only it triggers B.
     */
    async tryBackgroundOrRelease(): Promise<
      "detached" | "released" | "no-turn"
    > {
      if (closed) return "no-turn";
      // No turn in flight → nothing to do (idempotent).
      if (turnQueue.peekInFlight() === null) return "no-turn";

      const inFlight = currentInFlightToolUsesFn
        ? currentInFlightToolUsesFn()
        : [];

      // Decide: can the WHOLE in-flight batch be cleanly detached? An
      // empty batch (a pure-text hang — no tool in flight) is NOT
      // detachable: there is no foreground task to background, so it must
      // take the force-release path. A mixed batch (any non-detachable
      // member) also falls back — never half-detach.
      const allDetachable =
        inFlight.length > 0 &&
        inFlight.every((t) => isDetachableTool(t.name));

      if (allDetachable) {
        let anyDetached = false;
        for (const tool of inFlight) {
          try {
            const detached = await q.backgroundTasks(tool.id);
            if (detached) {
              anyDetached = true;
              // Best-effort subprocess cleanup — fire-and-forget. The
              // backgrounded task keeps running; stopTask asks the SDK to
              // stop it. A D-state child cannot be killed — that is
              // irreducible; swallow and move on, never block the sweep.
              // 999.173 — stopTask takes the TASK id, not this tool_use id
              // (passing tool.id was a silent no-op). The map stops now if
              // task_started was seen, else as soon as it arrives. Rejections
              // are swallowed inside (v3 V3UnsupportedMutatorError).
              taskIds.stopForToolUse(tool.id);
            }
          } catch {
            // A backgroundTasks throw for one tool → treat as not-detached
            // for that tool; the loop continues, and if NOTHING detaches
            // we fall through to force-release below.
          }
        }
        if (anyDetached) {
          // Clean detach succeeded — the SDK resumes the turn with a
          // synthetic tool_result. Do NOT interrupt, do NOT force-clear:
          // the turn must continue. (No-double-recovery invariant.)
          return "detached";
        }
        // Every detachable tool reported false / threw — the foreground
        // tasks already settled or never registered. Fall through to
        // force-release (the turn is still wedged on something).
      }

      // Fallback — force-release (the existing blunt path). Reuse the
      // handle's own `forceReleaseTurn()` so the B-era snapshot + interrupt
      // + forceClearInFlight semantics stay single-sourced.
      const released = handle.forceReleaseTurn?.() ?? false;
      return released ? "released" : "no-turn";
    },

    async stopTask(taskId: string): Promise<boolean> {
      if (closed || typeof taskId !== "string" || taskId.length === 0) return false;
      try {
        await q.stopTask(taskId);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Debug session `in-tool-wedge-recovery` work-stream (B) — fetch the
     * SDK's per-MCP-tool read-only/destructive annotations.
     *
     * Calls `q.mcpServerStatus()` (the SDK's live MCP server snapshot) and
     * projects each connected server into the minimal
     * `McpToolAnnotationSnapshot` shape the wedge classifier consumes.
     * Defensive throughout: a malformed entry is skipped, a thrown SDK
     * call resolves to `[]`. NEVER throws — the classifier degrades to its
     * static clawcode-MCP allowlist when this returns empty.
     *
     * Called at most once per wedge by the recovery layer.
     */
    async getMcpToolAnnotations(): Promise<
      readonly import("./tool-mutation-classifier.js").McpToolAnnotationSnapshot[]
    > {
      if (closed) return [];
      try {
        const raw = await q.mcpServerStatus();
        if (!Array.isArray(raw)) return [];
        const out: import("./tool-mutation-classifier.js").McpToolAnnotationSnapshot[] =
          [];
        for (const entry of raw) {
          const server = entry as {
            name?: unknown;
            tools?: unknown;
          };
          if (typeof server.name !== "string") continue;
          const tools = Array.isArray(server.tools)
            ? server.tools
                .map((t) => {
                  const tool = t as { name?: unknown; annotations?: unknown };
                  if (typeof tool.name !== "string") return null;
                  const ann = tool.annotations as
                    | { readOnly?: unknown; destructive?: unknown }
                    | undefined;
                  return {
                    name: tool.name,
                    ...(ann && typeof ann === "object"
                      ? {
                          annotations: {
                            ...(typeof ann.readOnly === "boolean"
                              ? { readOnly: ann.readOnly }
                              : {}),
                            ...(typeof ann.destructive === "boolean"
                              ? { destructive: ann.destructive }
                              : {}),
                          },
                        }
                      : {}),
                  };
                })
                .filter(
                  (
                    t,
                  ): t is {
                    name: string;
                    annotations?: {
                      readOnly?: boolean;
                      destructive?: boolean;
                    };
                  } => t !== null,
                )
            : undefined;
          out.push({ name: server.name, ...(tools ? { tools } : {}) });
        }
        return out;
      } catch {
        // SDK call failed — degrade to the classifier's static fallback.
        return [];
      }
    },

    /**
     * 2026-09-24 remote-mcp-reconnect — SDK status per server name. Reads
     * `q` at call time so a live hot-swap (swapToSession) is honored.
     * NEVER throws.
     */
    async getMcpServerStatuses(): Promise<ReadonlyMap<string, string>> {
      const out = new Map<string, string>();
      if (closed) return out;
      try {
        const raw = await q.mcpServerStatus();
        if (!Array.isArray(raw)) return out;
        for (const entry of raw) {
          const e = entry as { name?: unknown; status?: unknown };
          if (typeof e.name === "string" && typeof e.status === "string") {
            out.set(e.name, e.status);
          }
        }
      } catch {
        // degrade to "unknown" — caller treats a missing entry as not-failed
      }
      return out;
    },

    /**
     * 2026-09-24 remote-mcp-reconnect — respawn one MCP server in place.
     * THROWS on failure or when the backend's query object lacks the
     * control request (feature-detected; non-SDK backends).
     */
    async reconnectMcpServer(serverName: string): Promise<void> {
      if (closed) throw new Error("session handle is closed");
      if (typeof q.reconnectMcpServer !== "function") {
        throw new Error("reconnectMcpServer not supported by this backend");
      }
      await q.reconnectMcpServer(serverName);
    },

    /**
     * Phase 124 Plan 05 — live hot-swap to a forked SDK session.
     *
     * Closes the current SDK Query and constructs a fresh one resumed
     * against `newSessionId`. The handle identity is preserved; downstream
     * consumers (daemon `sessions` Map, Discord bridge, etc.) keep their
     * existing reference. The swap is serialized through the SerialTurnQueue
     * so it cannot interleave with an in-flight `send` — when a turn is
     * mid-flight, the swap enqueues and runs after the turn resolves.
     *
     * Fallback safety: the new SDK query is constructed BEFORE the old one
     * is closed. If `sdk.query` throws on the rebuild path, the old epoch
     * remains intact and the rejection propagates to the caller — the
     * compaction handler then surfaces `swapped_live: false` and the
     * operator-manual `clawcode restart` path stays available.
     *
     * No-op when the handle is closed or when `newSessionId` equals the
     * current sessionId (re-swap to the same id is wasted work).
     *
     * Resets `supportedCommandsCache` so the next caller re-pulls
     * `q.initializationResult()` from the new SDK query. Re-applies
     * `currentModel` / `currentEffort` / `currentPermissionMode` on the
     * new q so the operator-visible state survives the epoch boundary.
     */
    async swap(newSessionId: string): Promise<void> {
      if (closed) {
        throw new Error(`Session ${sessionId} is closed; cannot swap`);
      }
      if (newSessionId === sessionId) {
        // Idempotent no-op — same epoch.
        return;
      }
      // Serialize behind any in-flight turn. SerialTurnQueue is depth-1, so
      // a 2nd concurrent swap rejects with QUEUE_FULL — same shape as the
      // 3rd-concurrent-send case. Caller (daemon-compact-session-ipc) catches
      // and reports swapped_live:false on rejection.
      await turnQueue.run(async () => {
        // Build the new epoch FIRST (commit-point safety). If sdk.query
        // throws, the old q/inputQueue/driverIter are untouched and the
        // caller sees the rejection; no half-built state.
        const next = buildEpoch(newSessionId);

        // Past the commit point — tear down the old epoch.
        try {
          inputQueue.end();
        } catch {
          // Best-effort — old queue may already be ended.
        }
        try {
          q.close();
        } catch {
          // Best-effort — old SDK query may already be closing.
        }
        // WS-1 — stop the old epoch's demux pump (no-op on legacy path).
        try {
          demux?.stop();
        } catch {
          // Best-effort teardown.
        }
        // 999.173 — closing the old query killed its background researchers.
        researchTracker?.failOpen("swap");

        // Swap closure bindings — every closure that reads via `q`,
        // `driverIter`, `inputQueue` resolves the binding at call time, so
        // the next `send` dispatches into the new SDK query.
        q = next.q;
        inputQueue = next.inputQueue;
        driverIter = next.driverIter;
        demux = next.demux;
        sessionId = newSessionId;
        epoch += 1;

        // New SDK query — clear generator-dead flag (it tracks the OLD
        // generator's lifecycle, and the swap discarded that generator
        // intentionally) and invalidate the cached supported-commands.
        generatorDead = false;
        generatorError = null;
        supportedCommandsCache = null;
        // Phase 999.98 D7 — deliberately do NOT reset supportedModelsCache here.
        // The entitled model set is account-scoped and a same-account swap does
        // not change it, so the cached catalog stays valid across the epoch.

        // Context-bloat fix #3c — re-arm the continuity suffix. The forked
        // SDK session does NOT carry the continuity block, so the next
        // turn after a swap must re-send it once. Reset is inside
        // `turnQueue.run` so it is serialized with sends — no turn can
        // observe a half-swapped flag.
        continuityConsumed = false;

        // Re-apply per-handle runtime mutations on the new q so the
        // operator-visible state survives the epoch boundary. Each setter
        // is fire-and-forget on the SDK side (sdk.d.ts:1704/1711/1728 are
        // async but the handle's existing setters never await); we mirror
        // that contract here so swap stays fast.
        try {
          // Phase 999.98 D4 — same Fable effort-`off`→null guard on the
          // swap-reapply path so a re-applied "off" after an epoch boundary
          // never re-introduces the disabled-thinking 400 on a Fable agent.
          const budget = guardEffortBudgetForModel(
            mapEffortToTokens(currentEffort),
            currentModel,
          );
          // Quick 260715-j1j (D3) + review CR-01 — the ultracode mode flag is
          // per-SDK-query state; a swapped-in query boots without it. Re-fire
          // the flag as an INDEPENDENT fire-and-forget chain (invoked before
          // the budget call — call order preserves wire order); the budget
          // below always lands regardless of the flag outcome (CR-01
          // decoupling, same rationale as setEffort above).
          if (currentEffort === "ultracode") {
            void q.applyFlagSettings({ ultracode: true }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[swap] ultracode re-apply applyFlagSettings failed: ${msg}`);
            });
          }
          void q.setMaxThinkingTokens(budget).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[swap] setMaxThinkingTokens(${String(budget)}) failed: ${msg}`);
          });
        } catch {
          // Never let reapply failure poison the swap.
        }
        if (currentModel !== undefined) {
          try {
            void q.setModel(currentModel).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[swap] setModel(${currentModel}) failed: ${msg}`);
            });
          } catch {
            // Never let reapply failure poison the swap.
          }
        }
        try {
          void q.setPermissionMode(currentPermissionMode).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[swap] setPermissionMode(${currentPermissionMode}) failed: ${msg}`);
          });
        } catch {
          // Never let reapply failure poison the swap.
        }
      });
    },

    /** 999.172 — the session-start UX options this handle was built with (see SessionHandle). */
    getStartedUxFeatures(): Readonly<{ promptSuggestions: boolean }> {
      return startedUxFeatures;
    },

    /**
     * Phase 124 Plan 05 — observable epoch counter. Starts at 0; incremented
     * once per successful `swap`. Tests assert the boundary; downstream
     * consumers (prefix-hash provider, etc.) can detect a fresh SDK query
     * by tracking this value across calls.
     */
    getEpoch(): number {
      return epoch;
    },

    /**
     * FIND-123-A.next T-02 — read the live claude subprocess PID captured
     * by the structural spawn wrapper at the most recent (re-)spawn.
     *
     * Returns null when:
     *   - the SDK has not yet spawned (race window between handle
     *     construction and the first `query()`-driven spawn)
     *   - the handle has been closed (terminal-shutdown sink-clear)
     *   - the SDK respawn path failed before producing a child PID
     *
     * Read by the daemon's shutdown sequence to `process.kill(-pid,
     * SIGTERM)` the claude process group BEFORE `manager.stopAll()`,
     * which closes the SDK normally and otherwise lets MCP grandchildren
     * reparent to PID 1.
     */
    getClaudePid(): number | null {
      return pidSink.pid;
    },

    /**
     * Phase 999.75 Part B (B1/B5) — read the live context-window token
     * usage for the current epoch.
     *
     * Delegates to the SDK `Query.getContextUsage()` control request and
     * projects the response down to `{ totalTokens }`. Resolves the binding
     * through the `q` closure at call time so a post-`swap()` epoch is
     * measured correctly. Rejects when the SDK control request fails — the
     * compaction handler wraps the call and fails open.
     */
    async getContextUsage(): Promise<{ totalTokens: number }> {
      const usage = await q.getContextUsage();
      return { totalTokens: usage.totalTokens };
    },

    /**
     * Live claude.ai plan usage (the data behind `/usage`), read from
     * Anthropic via the SDK's experimental control request. Null when this
     * SDK build lacks the method; rejects when the control request fails.
     */
    async getPlanUsage(): Promise<SdkPlanUsage | null> {
      const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof fn !== "function") return null;
      return fn.call(q, { skipBehaviors: true });
    },

    /**
     * Phase 85 Plan 01 TOOL-01 — read the per-handle MCP state mirror.
     *
     * Always returns the latest map set via `setMcpState`. Returns the
     * default empty map before the first warm-path population.
     */
    getMcpState(): ReadonlyMap<string, McpServerState> {
      return currentMcpState;
    },
    /**
     * Phase 85 Plan 01 TOOL-01 — update the per-handle MCP state mirror.
     *
     * Called by SessionManager (at warm-path gate) and by the
     * `mcp-reconnect` heartbeat check (every tick). Always stores a
     * defensive copy so external mutations of the passed-in map don't
     * leak into the handle's state.
     */
    setMcpState(state: ReadonlyMap<string, McpServerState>): void {
      currentMcpState = new Map(state);
    },

    /**
     * Phase 96 Plan 01 D-CONTEXT — read the per-handle filesystem capability
     * snapshot mirror.
     *
     * Always returns a Map (empty when first probe hasn't yet run). Allows
     * callers (Plan 96-02 prompt-builder, Plan 96-03 clawcode_list_files,
     * Plan 96-04 share-file boundary check) to read unconditionally — the
     * empty-map default is the "no paths probed yet" signal.
     */
    getFsCapabilitySnapshot(): ReadonlyMap<string, FsCapabilitySnapshot> {
      return _fsCapabilitySnapshot ?? new Map();
    },

    /**
     * Phase 96 Plan 01 D-CONTEXT — update the per-handle filesystem
     * capability snapshot mirror.
     *
     * Called by:
     *   - SessionManager (at warm-path gate / boot probe)
     *   - heartbeat fs-probe check (every 60s tick — wired in 96-07)
     *   - on-demand /clawcode-probe-fs slash + clawcode probe-fs CLI (96-05)
     *
     * Always stores a defensive copy so external mutations of the passed-
     * in map don't leak into the handle's state. NEVER mutates the input.
     */
    setFsCapabilitySnapshot(next: ReadonlyMap<string, FsCapabilitySnapshot>): void {
      _fsCapabilitySnapshot = new Map(next);
    },

    /**
     * Phase 103 OBS-04 — read the per-handle RateLimitTracker mirror.
     *
     * Returns undefined until SessionManager calls setRateLimitTracker.
     * Downstream consumers (Plan 03 IPC list-rate-limit-snapshots, slash
     * commands /clawcode-usage and /clawcode-status) read via this accessor
     * routed through SessionManager.getRateLimitTrackerForAgent.
     */
    getRateLimitTracker(): RateLimitTracker | undefined {
      return _rateLimitTracker;
    },

    /**
     * Phase 103 OBS-04 — inject the per-handle RateLimitTracker mirror.
     *
     * Called by SessionManager AFTER handle construction (post-construction
     * DI mirror — Pitfall 8 best-effort race window: rate_limit_event
     * messages arriving in the gap between construction and injection are
     * dropped). The dispatch branch in iterateUntilResult reads
     * `_rateLimitTracker` via closure so a late injection is honored on the
     * very next message.
     */
    setRateLimitTracker(tracker: RateLimitTracker): void {
      _rateLimitTracker = tracker;
    },

    /**
     * Phase 94 Plan 02 TOOL-03 — accessor for the per-handle flap-history
     * Map consumed by `filterToolsByCapabilityProbe` in session-config.
     *
     * Map identity is stable across all calls for the lifetime of this
     * handle — the filter mutates it in-place per tick to count ready ↔
     * non-ready transitions for the D-12 5min flap-stability window.
     *
     * Production wiring: `buildSessionConfig` reads this via
     * `SessionConfigDeps.flapHistoryProvider(agentName)` and threads it
     * into the filter call. Tests can stub the provider directly without
     * needing a real handle.
     */
    getFlapHistory(): Map<string, FlapHistoryEntry> {
      return flapHistory;
    },

    /**
     * Phase 94 Plan 03 TOOL-04/05/06 — per-handle recovery-attempt history.
     *
     * Stable Map identity across the handle's lifetime so the registry's
     * bounded 3-attempts-per-hour budget counter accumulates correctly
     * across heartbeat ticks. The registry mutates the Map in-place by
     * replacing AttemptRecord arrays with `[...prev, new]` (immutability
     * preserved at the inner-array level — old entries retain reference
     * identity).
     */
    getRecoveryAttemptHistory(): Map<string, AttemptRecord[]> {
      return recoveryAttemptHistory;
    },

    /**
     * Phase 87 CMD-01 — enumerate the SDK-reported slash commands for this
     * agent session. First call invokes q.initializationResult() and caches
     * the resulting `commands` array; subsequent calls hit the cache.
     *
     * On SDK failure, the cache stays null so the NEXT call retries. This is
     * important because the SDK may not have completed its init handshake at
     * the exact moment of first query (e.g. warm-path ran too eagerly).
     *
     * Returned shape is the local SlashCommand projection — no-op if the
     * agent has zero native commands (empty array is valid + cached).
     */
    async getSupportedCommands(): Promise<readonly SlashCommand[]> {
      if (supportedCommandsCache !== null) return supportedCommandsCache;
      const result = await q.initializationResult();
      supportedCommandsCache = result.commands;
      return supportedCommandsCache;
    },

    /**
     * Phase 999.98 D7 — enumerate the SDK-reported entitled model set for this
     * agent session. First call invokes q.initializationResult() and caches the
     * resulting `models` array; subsequent calls hit the cache. The model
     * monitor cron reads this per running agent.
     *
     * On SDK failure, the cache stays null so the NEXT call retries (same
     * warm-path-race tolerance as getSupportedCommands). NOT reset on swap
     * (account-scoped — see the cache decl + swap() note).
     *
     * Phase 999.114 — an EMPTY result is no longer cached. This previously read
     * `supportedModelsCache = result.models ?? []`, documented as "valid +
     * cached", which permanently poisoned the handle: an init result that
     * arrived without a `models` field (a warm-path race, or any backend that
     * does not populate it — the v3 PTY and codex backends never do) cached `[]`
     * forever, and the 6-hourly model-monitor cron then re-read that empty cache
     * instead of the SDK for the life of the process. The agent became
     * permanently blind to newly released models, which is exactly the
     * discovery path `<family>@latest` depends on.
     *
     * Returning (without caching) is correct rather than merely conservative:
     * the entitled set is never legitimately empty for a live Anthropic
     * session, so an empty answer is always either a race or an unsupported
     * backend — both of which should be retried, not memoized.
     */
    async getSupportedModels(): Promise<readonly ModelInfo[]> {
      if (supportedModelsCache !== null) return supportedModelsCache;
      const result = await q.initializationResult();
      const models = result.models ?? [];
      if (models.length === 0) return models;
      supportedModelsCache = models;
      return supportedModelsCache;
    },
  };

  return handle;
}
