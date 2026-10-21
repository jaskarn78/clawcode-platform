/**
 * Phase 124 Plan 01 T-02 — `compact-session` IPC handler (pure-DI).
 *
 * Mirrors `daemon-ask-agent-ipc.ts` shape: pure dependency injection so the
 * v2 sync-reply contract can be exercised without spawning the full daemon.
 *
 * Behavior contract (per Plan 124-01 + CONTEXT D-12 hybrid flow):
 *   1. Reject when daemon-not-ready → {ok:false, error:"DAEMON_NOT_READY"}.
 *   2. Reject when agent has no live session handle →
 *      {ok:false, error:"AGENT_NOT_RUNNING"}.
 *   3. Reject when the agent has no CompactionManager wired (memory init
 *      skipped) → {ok:false, error:"AGENT_NOT_INITIALIZED"} (Rule 3 addition;
 *      mirrors the throw at session-manager.ts:2210).
 *   4. Reject when a turn has been in-flight longer than `maxTurnAgeMs`
 *      (default 10 min) → {ok:false, error:"ERR_TURN_TOO_LONG"}.
 *
 * Phase 999.75 Part B (Layer 2) — live-context reduction via native /compact.
 *
 * Today's behaviour (pre-999.75) ran Layer 1 (`compactForAgent` → memory.db +
 * daily log) then `sdkForkSession` + `handle.swap()`. That fork was a FULL
 * COPY — `forkSession({upToMessageId})` is prefix-keep / suffix-drop (the
 * wrong direction for compaction), and there is no `query.compact()`. The net
 * effect was that the live context window never shrank.
 *
 * Layer 2 replaces the fork+swap step with the SDK's OWN native `/compact`
 * command, dispatched on the prompt channel through the handle's serial turn
 * queue. The SDK summarizes the old region itself, writes a
 * `compact_boundary` record into the transcript, and the running `Query`
 * rebuilds its prompt from the relinked transcript on the next turn — the
 * live window genuinely shrinks IN PLACE. No fork, no `swap()`, no session-id
 * rotation. Operator-chosen mechanism (999.75 plan, Option B).
 *
 * Flow:
 *   1. `compactForAgent()` — Layer 1, unchanged (memory.db + daily log).
 *   2. `getContextUsage()` → `tokens_before` (the real token count).
 *   3. Pre-flight go/no-go (Section 3 of the Layer-2 plan): skip `/compact`
 *      when the conversation is too small to be worth compacting.
 *   4. `sendCompactCommand("/compact")` through the serial turn queue.
 *   5. `getContextUsage()` → `tokens_after`; assert `tokens_after <
 *      tokens_before`.
 *
 * Fail-open: ANY failure (no DI seam wired, dispatch throws, the window did
 * not shrink) degrades to today's behaviour — Layer 1 already ran, memory.db
 * still grew, NO data is lost — and the result carries `live_reduced:false`
 * plus a `skip_reason`. The live session is untouched on every failure path.
 *
 * Wire result shape (success path):
 *   {
 *     ok: true,
 *     tokens_before: number | null,   // real SDK token count, or null
 *     tokens_after: number | null,    // real SDK token count, or null
 *     summary_written: boolean,       // driven by Layer-1 summary length
 *     forked_to: string | null,       // null on the native path (no fork)
 *     memories_created: number,
 *     live_reduced: boolean,          // true => the live window shrank
 *     skip_reason?: string,           // present when live_reduced:false
 *   }
 */
import type {
  ConversationTurn,
  ContextFillProvider,
} from "../memory/compaction.js";
import type { CompactionResult } from "../memory/compaction.js";
import type { SdkContextUsage } from "./sdk-types.js";

/** Minimal pino-like logger surface — matches daemon-ask-agent-ipc.ts. */
export type CompactLogger = Readonly<{
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}>;

/**
 * Minimal session-handle surface read by the handler.
 *
 * Phase 999.75 Part B — `swap` is retained on the type for backward compat
 * (the `@deprecated` `sdkForkSession`+`swap` fork path is no longer driven
 * by the handler — see the FORK+SWAP CLEANUP note below) but is no longer
 * called on any path. `sessionId` + `hasActiveTurn` stay load-bearing.
 */
export type CompactSessionHandleLike = Readonly<{
  readonly sessionId: string;
  hasActiveTurn: () => boolean;
  /**
   * @deprecated Phase 999.75 Part B — native `/compact` shrinks the window
   * in-place; the fork+swap full-copy path is no longer driven by the
   * compaction handler. Retained on the type only so legacy fixtures still
   * type-check. Never invoked by `handleCompactSession`.
   */
  swap?: (newSessionId: string) => Promise<void>;
}>;

/**
 * Minimal SessionManager surface — pure DI. The production daemon passes the
 * real SessionManager; tests construct a minimal fixture.
 */
export type CompactManagerLike = Readonly<{
  /** Live session handle lookup. Undefined → AGENT_NOT_RUNNING. */
  getSessionHandle: (name: string) => CompactSessionHandleLike | undefined;
  /** Conversation turns for compactForAgent input. */
  getConversationTurns: (name: string) => readonly ConversationTurn[];
  /** Returns the per-agent CharacterCountFillProvider (or undefined). */
  getContextFillProvider: (name: string) => ContextFillProvider | undefined;
  /** Canonical compactForAgent entry point (session-manager.ts:2203). */
  compactForAgent: (
    name: string,
    conversation: readonly ConversationTurn[],
    extractMemories: (text: string) => Promise<readonly string[]>,
  ) => Promise<CompactionResult>;
  /** True when the agent has a CompactionManager registered. */
  hasCompactionManager: (name: string) => boolean;
}>;

/**
 * @deprecated Phase 999.75 Part B — SDK forkSession call surface.
 *
 * `forkSession({upToMessageId})` is prefix-keep / suffix-drop — the WRONG
 * direction for compaction (it keeps the OLD prefix and discards the RECENT
 * tail). Native `/compact` (the `sendCompactCommand` DI seam) replaced it as
 * the live-reduction mechanism. The type is retained only so external test
 * fixtures that still construct `CompactSessionDeps` keep type-checking;
 * `handleCompactSession` never calls it.
 */
export type SdkForkSessionFn = (
  sessionId: string,
  options?: { upToMessageId?: string },
) => Promise<{ sessionId: string }>;

/** Memory extractor — MVP. Phase 125 replaces with tiered extraction. */
export type ExtractMemoriesFn = (text: string) => Promise<readonly string[]>;

/**
 * Phase 999.75 Part B (B6) — dispatch the native `/compact` slash command.
 *
 * Production wires this from the live SessionHandle's `sendAndCollect` — the
 * SDK treats `/compact` as a local command, runs its compaction turn, and
 * the call resolves on the turn `result` (verification signal B4). Tests
 * inject a fake. The handler awaits this; a throw / timeout fails open.
 */
export type SendCompactCommandFn = (command: string) => Promise<string>;

/**
 * Phase 999.75 Part B (B6) — read the live context-window token count.
 *
 * Production wires this from the live SessionHandle's `getContextUsage`
 * (handle-backed → SDK `Query.getContextUsage()`). Tests inject a fake
 * returning a controlled before/after pair. `undefined` (legacy handle /
 * minimal fixture) → Layer 2 fails open to today's behaviour.
 */
export type GetContextUsageFn = () => Promise<SdkContextUsage>;

/** Per-agent archive slot for the old session id (audit retention). */
export type ArchiveSessionFn = (
  agent: string,
  oldSessionId: string,
  newSessionId: string,
) => void;

/** DI surface — production daemon constructs full deps at the case body. */
export type CompactSessionDeps = Readonly<{
  manager: CompactManagerLike;
  /**
   * @deprecated Phase 999.75 Part B — never invoked by the handler. See
   * `SdkForkSessionFn`. Optional so production / tests omit it.
   */
  sdkForkSession?: SdkForkSessionFn;
  extractMemories: ExtractMemoriesFn;
  log: CompactLogger;
  /**
   * Phase 999.75 Part B (B6) — dispatch native `/compact`. When undefined
   * (legacy handle / minimal fixture) Layer 2 fails open: Layer 1 still
   * runs, the live window is left unchanged, `live_reduced:false`.
   */
  sendCompactCommand?: SendCompactCommandFn;
  /**
   * Phase 999.75 Part B (B6) — read the live token count. When undefined
   * Layer 2 fails open (cannot measure → cannot dispatch). Both seams must
   * be wired for native `/compact` to run.
   */
  getContextUsage?: GetContextUsageFn;
  /**
   * @deprecated Phase 999.75 Part B — archive callback for the swapped-out
   * session id. The native path performs no swap, so no session id is
   * archived; retained on the type only for backward compat. Never invoked.
   */
  archiveSession?: ArchiveSessionFn;
  /** When false, fail fast with DAEMON_NOT_READY (boot-window guard). */
  daemonReady: boolean;
  /**
   * Mid-turn safety budget — when a turn has been in-flight longer than this,
   * exit ERR_TURN_TOO_LONG rather than block on the SerialTurnQueue. Default
   * 10 min per CONTEXT D-03. Tests inject a fixture clock + small budget.
   */
  maxTurnAgeMs?: number;
  /** Injectable clock — production uses Date.now. */
  now?: () => number;
  /** Per-agent active-turn-start timestamps (ms epoch). */
  turnStartedAt?: ReadonlyMap<string, number>;
  /**
   * Phase 999.75 Part B (B2) — pre-flight floor: skip native `/compact`
   * when the conversation has fewer than this many turns (too small to be
   * worth an LLM compaction call). Default 12.
   */
  minMessagesToCompact?: number;
  /**
   * Phase 999.75 Part B — backstop timeout (ms) for the native `/compact`
   * dispatch. When `sendCompactCommand` does not resolve within this
   * window the handler fails open (`dispatch_failed:timeout`) rather than
   * hanging the IPC reply. Default 5 min. Tests inject a small value.
   */
  compactDispatchTimeoutMs?: number;
  /**
   * @deprecated Phase 999.75 Part B — `forkSession({upToMessageId})` is
   * prefix-keep / suffix-drop, the wrong direction for compaction (it keeps
   * the OLD prefix and discards the RECENT tail). Native `/compact` is
   * suffix-preserving and picks its own boundary; this slice is never the
   * right cut-point. Retained for one release as a no-op DI field; a
   * supplied value triggers a warn-log and is otherwise ignored. Delete in
   * a follow-up.
   */
  upToMessageId?: string;
}>;

/** Wire param shape. */
export type CompactSessionParams = Readonly<{ agent: string }>;

/** Error result shape — matches Phase 117 / Phase 999.2 error contract. */
export type CompactSessionError = Readonly<{
  ok: false;
  error:
    | "DAEMON_NOT_READY"
    | "AGENT_NOT_RUNNING"
    | "AGENT_NOT_INITIALIZED"
    | "ERR_TURN_TOO_LONG"
    | "UNKNOWN";
  message?: string;
}>;

/** Success result shape. */
export type CompactSessionSuccess = Readonly<{
  ok: true;
  /**
   * Phase 999.75 Part B — real SDK context-window token count BEFORE
   * `/compact`. Null when the `getContextUsage` DI seam is not wired
   * (legacy handle / minimal fixture) — Layer 2 then fails open.
   */
  tokens_before: number | null;
  /**
   * Phase 999.75 Part B — real SDK token count AFTER `/compact`. Null when
   * the seam is unwired OR `/compact` was skipped/failed (no measurement).
   */
  tokens_after: number | null;
  summary_written: boolean;
  /**
   * @deprecated Phase 999.75 Part B — the native `/compact` path performs
   * NO fork (it shrinks the window in-place), so this is always `null`.
   * Retained for backward compat with the CLI / Discord renderers that
   * parse the IPC payload. Removed in a follow-up.
   */
  forked_to: string | null;
  memories_created: number;
  /**
   * Phase 999.75 Part B (B5) — true when native `/compact` ran AND the live
   * context window measurably shrank (`tokens_after < tokens_before`).
   * False on every fail-open path: missing DI seam, pre-flight skip,
   * dispatch failure, or no observed reduction.
   */
  live_reduced: boolean;
  /**
   * Phase 999.75 Part B (B5) — present when `live_reduced` is false; carries
   * the structured fail-open sentinel:
   *   - "seam_not_wired"        — sendCompactCommand/getContextUsage absent.
   *   - "too_short"             — conversation below `minMessagesToCompact`.
   *   - "tokens_unavailable"    — getContextUsage returned/threw before /compact.
   *   - "dispatch_failed:<msg>" — sendCompactCommand threw / timed out.
   *   - "no_reduction"          — /compact ran but tokens_after >= tokens_before.
   */
  skip_reason?: string;
}>;

export type CompactSessionResult = CompactSessionSuccess | CompactSessionError;

const DEFAULT_MAX_TURN_AGE_MS = 10 * 60 * 1000;
/**
 * Phase 999.75 Part B (B2) — default pre-flight floor. A conversation with
 * fewer than this many turns is too small to be worth an LLM `/compact`
 * call; Layer 2 skips and fails open. Conservative default; operator-tunable
 * via `deps.minMessagesToCompact`.
 */
const DEFAULT_MIN_MESSAGES_TO_COMPACT = 12;
/**
 * Rough char→token proxy retained ONLY as the fallback for the IPC
 * `tokens_before/after` fields when the real `getContextUsage` SDK seam is
 * not wired (legacy handle / minimal test fixture). The native `/compact`
 * path uses the real SDK token count; this proxy never gates `live_reduced`.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Best-effort token estimate from the per-agent CharacterCountFillProvider.
 * Returns null when no provider is wired (e.g., minimal test fixtures).
 *
 * Phase 999.75 Part B — this is now ONLY a display fallback. When the real
 * `getContextUsage` SDK seam is wired the handler reports the real token
 * count instead; the char proxy is never used to decide `live_reduced`.
 */
function estimateTokens(provider: ContextFillProvider | undefined): number | null {
  if (!provider) return null;
  const ratio = provider.getContextFillPercentage();
  return Math.round((ratio * 200_000) / CHARS_PER_TOKEN);
}

/**
 * Phase 999.75 Part B — the `/compact` slash command string. Built once via
 * the canonical `buildNativePromptString` so the format matches every other
 * native-CC dispatch site (no leading clawcode- prefix, bare `/compact`).
 */
const COMPACT_COMMAND = "/compact";

/**
 * Phase 999.75 Part B — dispatch-timeout backstop for native `/compact`.
 *
 * `sendCompactCommand` resolves on the turn `result`; under normal operation
 * `/compact` is a fast local SDK command. But a wedged SDK / dead handle
 * could leave the `await` hanging forever — the heartbeat closure's
 * try/catch catches THROWS, not HANGS. The handler races the dispatch
 * against this timeout so a hang surfaces as a `dispatch_failed:` fail-open
 * (no live reduction, no data loss) instead of stalling the IPC reply.
 * Operator-tunable via `deps.compactDispatchTimeoutMs`.
 */
const DEFAULT_COMPACT_DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Handle a `compact-session` IPC request. See module docstring for the full
 * behavior contract. Errors return as `{ok: false, error}` — caller renders
 * them as recognizable exit codes (see src/cli/commands/session-compact.ts).
 */
export async function handleCompactSession(
  params: CompactSessionParams,
  deps: CompactSessionDeps,
): Promise<CompactSessionResult> {
  const { agent } = params;

  if (!deps.daemonReady) {
    return { ok: false, error: "DAEMON_NOT_READY" };
  }

  const handle = deps.manager.getSessionHandle(agent);
  if (!handle) {
    return { ok: false, error: "AGENT_NOT_RUNNING" };
  }

  if (!deps.manager.hasCompactionManager(agent)) {
    return { ok: false, error: "AGENT_NOT_INITIALIZED" };
  }

  // Phase 999.75 Part B — `upToMessageId` is a deprecated no-op DI field.
  // `forkSession({upToMessageId})` is prefix-keep / suffix-drop (the wrong
  // direction for compaction). A supplied value is ignored; warn so a stale
  // caller is surfaced before the field is deleted in a follow-up.
  if (deps.upToMessageId !== undefined) {
    deps.log.warn(
      { agent, upToMessageId: deps.upToMessageId },
      "[compact-session] deps.upToMessageId is deprecated and ignored — " +
        "native /compact is suffix-preserving and picks its own boundary",
    );
  }

  // Mid-turn safety budget — D-03. The SerialTurnQueue handles enqueueing
  // for us when we eventually pass through send/sendAndCollect, but the
  // budget check fires BEFORE we attempt to compact so an in-flight slow
  // turn doesn't block the IPC reply for >10 min.
  if (handle.hasActiveTurn()) {
    const now = (deps.now ?? Date.now)();
    const startedAt = deps.turnStartedAt?.get(agent);
    const maxAge = deps.maxTurnAgeMs ?? DEFAULT_MAX_TURN_AGE_MS;
    if (startedAt !== undefined && now - startedAt > maxAge) {
      return {
        ok: false,
        error: "ERR_TURN_TOO_LONG",
        message: `Turn has been in-flight for ${Math.round((now - startedAt) / 1000)}s (budget ${Math.round(maxAge / 1000)}s).`,
      };
    }
    // Within budget — `/compact` is dispatched through the handle's serial
    // turn queue (SerialTurnQueue, depth-1), so it enqueues safely behind
    // any in-flight turn rather than interleaving with it.
    deps.log.info(
      { agent, turnAgeMs: startedAt ? now - startedAt : null },
      "[compact-session] proceeding mid-turn (within budget)",
    );
  }

  const provider = deps.manager.getContextFillProvider(agent);

  // ---- Layer 1: memory.db + daily log (compactForAgent), unchanged. ----
  let compactionResult: CompactionResult;
  let conversation: readonly ConversationTurn[];
  try {
    conversation = deps.manager.getConversationTurns(agent);
    compactionResult = await deps.manager.compactForAgent(
      agent,
      conversation,
      deps.extractMemories,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log.error({ agent, err: msg }, "[compact-session] compactForAgent failed");
    return { ok: false, error: "UNKNOWN", message: msg };
  }

  // ---- Layer 2: live-context reduction via native /compact. ----
  // Every failure below FAILS OPEN: Layer 1 already ran, memory.db grew,
  // no data is lost. The live session is untouched on every skip path.
  const summaryWritten = compactionResult.summary.length > 0;
  const memoriesCreated = compactionResult.memoriesCreated;

  /** Build a fail-open success payload (Layer 2 skipped / failed). */
  const failOpen = (
    skipReason: string,
    tokensBefore: number | null,
  ): CompactSessionSuccess => ({
    ok: true,
    tokens_before: tokensBefore,
    tokens_after: null,
    summary_written: summaryWritten,
    forked_to: null,
    memories_created: memoriesCreated,
    live_reduced: false,
    skip_reason: skipReason,
  });

  // B6 — both DI seams must be wired for native /compact to run. A legacy
  // handle / minimal fixture omits them → fail open (today's behaviour).
  if (deps.sendCompactCommand === undefined || deps.getContextUsage === undefined) {
    deps.log.info(
      { agent },
      "[compact-session] sendCompactCommand/getContextUsage not wired — " +
        "skipping native /compact (fail-open, no live reduction)",
    );
    return failOpen("seam_not_wired", estimateTokens(provider));
  }

  // B2 — pre-flight go/no-go. Skip native /compact when the conversation is
  // too small to be worth an LLM compaction call. Under Option B the SDK
  // picks its own boundary — only a boolean go/no-go is computed here, NOT
  // a cut-point UUID.
  const minMessages = deps.minMessagesToCompact ?? DEFAULT_MIN_MESSAGES_TO_COMPACT;
  if (conversation.length < minMessages) {
    deps.log.info(
      { agent, conversationLength: conversation.length, minMessages },
      "[compact-session] conversation too short for native /compact — " +
        "skipping (fail-open, Layer 1 still ran)",
    );
    return failOpen("too_short", estimateTokens(provider));
  }

  // B1 — read the real token count BEFORE /compact. A throw here means we
  // cannot measure the reduction → fail open (do NOT dispatch blind).
  let tokensBefore: number;
  try {
    const usageBefore = await deps.getContextUsage();
    tokensBefore = usageBefore.totalTokens;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      { agent, err: msg },
      "[compact-session] getContextUsage (before) failed — " +
        "skipping native /compact (fail-open)",
    );
    return failOpen("tokens_unavailable", estimateTokens(provider));
  }

  // B3/B4 — dispatch /compact through the serial turn queue and wait for
  // the turn to resolve (the SDK runs /compact as a normal local command;
  // `sendAndCollect` resolves on the turn `result`). The dispatch is raced
  // against a backstop timeout: a wedged SDK / dead handle would otherwise
  // leave this `await` hanging forever (the heartbeat closure's try/catch
  // catches throws, NOT hangs) — the timeout converts a hang into a
  // `dispatch_failed:` fail-open.
  const dispatchTimeoutMs =
    deps.compactDispatchTimeoutMs ?? DEFAULT_COMPACT_DISPATCH_TIMEOUT_MS;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      deps.sendCompactCommand(COMPACT_COMMAND),
      new Promise<never>((_resolve, reject) => {
        dispatchTimer = setTimeout(() => {
          reject(
            new Error(
              `timeout after ${Math.round(dispatchTimeoutMs / 1000)}s`,
            ),
          );
        }, dispatchTimeoutMs);
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      { agent, err: msg, tokens_before: tokensBefore },
      "[compact-session] native /compact dispatch failed — " +
        "fail-open, live session untouched",
    );
    return failOpen(`dispatch_failed:${msg}`, tokensBefore);
  } finally {
    if (dispatchTimer !== undefined) clearTimeout(dispatchTimer);
  }

  // B5 — read the token count AGAIN and confirm the window actually shrank.
  let tokensAfter: number;
  try {
    const usageAfter = await deps.getContextUsage();
    tokensAfter = usageAfter.totalTokens;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // /compact ran but we cannot confirm the reduction. The SDK's compaction
    // is non-destructive (the preserved tail is intact), so the agent is no
    // worse off — fail open and surface tokens_before for the operator.
    deps.log.warn(
      { agent, err: msg, tokens_before: tokensBefore },
      "[compact-session] getContextUsage (after) failed — " +
        "cannot confirm reduction (fail-open)",
    );
    return failOpen("tokens_unavailable", tokensBefore);
  }

  if (tokensAfter >= tokensBefore) {
    // Structurally /compact resolved, but the window did not shrink. The
    // SDK's compaction never deletes the preserved tail, so this is a soft
    // failure — log loudly so the operator knows compaction underperformed.
    deps.log.warn(
      { agent, tokens_before: tokensBefore, tokens_after: tokensAfter },
      "[compact-session] native /compact ran but the live window did not " +
        "shrink — fail-open (no data lost)",
    );
    return {
      ok: true,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      summary_written: summaryWritten,
      forked_to: null,
      memories_created: memoriesCreated,
      live_reduced: false,
      skip_reason: "no_reduction",
    };
  }

  // Success — the live context window measurably shrank.
  deps.log.info(
    {
      agent,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      tokens_reduced: tokensBefore - tokensAfter,
      memoriesCreated,
    },
    "[compact-session] native /compact complete — live window reduced",
  );

  return {
    ok: true,
    tokens_before: tokensBefore,
    tokens_after: tokensAfter,
    summary_written: summaryWritten,
    forked_to: null,
    memories_created: memoriesCreated,
    live_reduced: true,
  };
}
