/**
 * Phase 69 Plan 03 Task 2 — Production OpenAiSessionDriver.
 * Phase 140 Plan 05 Task 1 — v3 re-point onto a transient masking-backed handle.
 *
 * Implements the `OpenAiSessionDriver` interface (src/openai/server.ts).
 *
 * ## v3 re-point (Phase 140 Plan 05)
 *
 * Under the v3 native-channels migration the live chat agent becomes a
 * `claude --channels` session with NO in-process `Query`, so the old path
 * (dispatch through the live agent's `TurnDispatcher.dispatchStream` seam)
 * would reach a session that cannot accept a programmatic turn. The native
 * driver is therefore re-pointed onto its OWN transient persistent SDK session
 * — the SAME pattern the OpenClaw template driver uses
 * (`src/openai/template-driver.ts`):
 *
 *   1. Build a `TransientSessionCache` key from the request identity
 *      `(keyHash, agentName, soulFp, tier)`. The `agentName` doubles as the
 *      template path's `callerSlug` slot.
 *   2. On cache MISS, drain an initial `sdk.query({ prompt: "Session
 *      initialized." })` to mint a real SDK-assigned session_id on disk, then
 *      `createPersistentSessionHandle` on the masking/SDK backend resumed
 *      against that id, and cache it.
 *   3. On cache HIT, REUSE the cached handle and bypass the drain entirely —
 *      this is LOAD-BEARING for `first_token`: a per-request cold spawn would
 *      dominate latency.
 *   4. Stream through `handle.sendAndStream` using the SAME callback bridge
 *      (`onChunk` → `content_block_delta` → terminal `result`) that this file
 *      already used for `dispatchStream`. SSE parity is preserved; the OpenAI
 *      endpoint is stateless (conversation arrives in `request.messages` each
 *      call) so stateless replay holds.
 *
 * This IS the masking route — masking stays as the OpenAI billing substrate
 * (subscription pool, no new cost; CONTEXT 140 "masking stays" LOCKED). The
 * driver NEVER reaches the live chat agent's `--channels` session, and the
 * `turnDispatcher` dependency is gone entirely — the type system now enforces
 * that the live seam is unreachable from the native driver.
 *
 * Threat mitigations (140-05 register):
 *   - T-140-05-01 (cwd disclosure): FIXED `CLAWCODE_TRANSIENT_CWD`, never
 *     caller-derived; clean env strips `ANTHROPIC_API_KEY` so the subprocess
 *     uses OAuth subscription auth (mirrors template-driver + session-adapter).
 *   - T-140-05-02 (unbounded handles): the injected `TransientSessionCache`
 *     enforces LRU + idle-TTL eviction (close() on evict).
 *
 * Binary pin (2026-09-23, made structural by 999.169): the transient session
 * spawns the fleet binary because every query leaving the SDK chokepoint is
 * pinned (`withPinnedClaudeBinary`). Before 2026-09-23 it silently ran the
 * SDK-bundled 2.1.140, which Anthropic rejects for Opus 5.5, so every
 * completion on an `opus` agent failed with a 500.
 *
 * ## Retained architecture (Phase 69/73)
 *
 *   - **SdkStreamEvent synthesis.** The handle's `sendAndStream` callback is
 *     `(accumulated: string) => void` — no raw SDK events. The driver
 *     translates each callback into a `content_block_delta` `text_delta`
 *     carrying only the NEW delta since the last call, terminated by a
 *     synthetic `result` event carrying `handle.sessionId`.
 *   - **Bounded queue + promise resolver** bridges the callback-style stream
 *     into a pull-style async iterable (verbatim from the prior cut).
 *   - **Caller-owned Turn + `openai.chat_completion` span** via the agent's
 *     TraceCollector — observability is orthogonal to the re-point and stays.
 *   - **Session recording** via `ApiKeySessionIndex` happens AFTER the stream
 *     resolves, keyed on `handle.sessionId`.
 */

import { nanoid } from "nanoid";
import path from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";

import type { SessionManager } from "../manager/session-manager.js";
import type { TraceCollector, Span, Turn } from "../performance/trace-collector.js";
import type { TurnLossMonitor } from "../manager/turn-loss-monitor.js";
import { makeRootOriginWithTurnId } from "../manager/turn-origin.js";
import { createPersistentSessionHandle } from "../manager/persistent-session-handle.js";
import {
  type SessionHandle,
  type UsageCallback,
} from "../manager/session-adapter.js";
import type { SdkModule, SdkQuery, SdkQueryOptions } from "../manager/sdk-types.js";
// Phase 999.87 — single source of truth for child-spawn env credential
// handling. The helper strips ANTHROPIC_API_KEY and the SDK-backed
// subprocess uses OAuth subscription auth via the inherited Claude Code config.
import { buildAnthropicSafeEnv } from "../manager/spawn-env.js";

import type { OpenAiSessionDriver } from "./server.js";
import type { ApiKeySessionIndex } from "./session-index.js";
import type { SdkStreamEvent } from "./types.js";
import {
  TransientSessionCache,
  makeTransientCacheKey,
} from "./transient-session-cache.js";
import { upstreamTurnErrorFromResult, type SdkResultFields } from "./upstream-error.js";
import {
  CLIENT_TOOL_WAIT_MS,
  ClientToolBridge,
  clientToolsFingerprint,
  usableClientTools,
  type ParkedCall,
} from "./client-tool-bridge.js";
import type { ClaudeToolDef, ClaudeToolResultBlock } from "./types.js";

/**
 * Fixed cwd for every transient native-driver handle. Never caller-derived
 * (T-140-05-01). Shares the template driver's transient root — both are
 * masking-backed transient sessions with no caller-workspace coupling.
 */
export const CLAWCODE_TRANSIENT_CWD = path.join(
  homedir(),
  ".clawcode",
  "manager",
  "transient",
);

/**
 * Per-agent base options the native driver needs to materialize a masking-backed
 * transient handle. The native-path analog of the template path's
 * `extractCallerIdentity` — resolved SERVER-SIDE by agent name (production wires
 * this from `SessionManager.getAgentConfig`), not parsed from the request body.
 */
export interface AgentBaseOptions {
  /** The agent's soul/system prompt (STRING form — replaces the SDK kernel prompt). */
  readonly soulPrompt: string;
  /**
   * The concrete SDK model id (e.g. `claude-opus-5-5`), resolved server-side
   * from the agent's configured model — `<family>@latest` and pinned aliases
   * included. Passed to the SDK verbatim and part of the cache key.
   */
  readonly model: string;
  /** sha256(soulPrompt).slice(0,16) — a soul edit forces a fresh handle. */
  readonly soulFp: string;
}

/** Dependency bag for `createOpenAiSessionDriver`. */
export interface OpenAiSessionDriverDeps {
  /**
   * SessionManager — retained for the post-stream conversation-store session_id
   * fallback (`getActiveConversationSessionId`). The re-pointed driver prefers
   * `handle.sessionId`; this is the legacy fallback for the rare case where the
   * handle id is unavailable. Tests mock just this method.
   */
  readonly sessionManager: Pick<
    SessionManager,
    "getActiveConversationSessionId"
  >;

  /** SDK module handle — same one SdkSessionAdapter / template driver use. */
  readonly sdk: SdkModule;

  /**
   * LRU+TTL cache owning the per-(keyHash, agent, soul, tier) persistent
   * handles. Production passes a DEDICATED instance (not shared with the
   * template-driver cache) so the two workloads cannot evict each other's hot
   * handles. The cache HIT bypassing the drain is load-bearing for first_token.
   */
  readonly transientCache: TransientSessionCache;

  /**
   * Resolve the per-agent base options (soul prompt, model id, soul fp) by
   * agent name. Production wires this from `SessionManager.getAgentConfig`
   * via `agentBaseOptionsFromConfig` (endpoint-bootstrap.ts), which reads the
   * agent's SOUL file — hence async.
   */
  readonly getAgentBaseOptions: (agentName: string) => Promise<AgentBaseOptions>;

  /**
   * Factory that returns the per-agent `ApiKeySessionIndex`. Production wiring
   * builds this from `sessionManager.getMemoryStore(agent).getDatabase()`.
   * Tests pass an in-memory `:memory:` DB.
   */
  readonly sessionIndexFor: (agentName: string) => ApiKeySessionIndex;

  /**
   * Factory that returns the per-agent `TraceCollector`. Returns `null` /
   * `undefined` when none is wired — driver degrades gracefully (no Turn
   * lifecycle, but dispatch still proceeds).
   */
  readonly traceCollectorFor: (agentName: string) => TraceCollector | undefined | null;

  /**
   * Phase 140 Plan 05 — per-turn usage hook. The pre-re-point native path
   * dispatched through the agent's MAIN session handle (whose `usageCallback`
   * is wired by SessionManager), so native OpenAI turns landed in the agent's
   * cost DB. The transient handle has no such ambient callback, so without this
   * hook native OpenAI cost rows would silently disappear. Production wires this
   * from `SessionManager.getUsageTracker(agentName)` — mirrors the template
   * driver's `onUsage`. Absent in tests (no-op).
   */
  readonly onUsage?: (
    agentName: string,
    usage: Parameters<UsageCallback>[0],
    sessionId: string,
    elapsedMs: number,
  ) => void;

  /**
   * Phase 140 Plan 06 Task 11 — v3 turn-loss watchdog.
   *
   * The native OpenAI driver is a DAEMON-INITIATED v3 turn: post-140-05 it
   * runs on its OWN transient masking-backed session (the `turnDispatcher`
   * seam was removed entirely), and the daemon fully observes this turn's
   * lifecycle right here. So this is the natural place to arm the
   * `TurnLossMonitor`: `onTurnStart` when the caller-owned Turn opens, and
   * `onTurnEnd` when it reaches end_to_end (success / error / abort). A turn
   * that starts but never ends (e.g. a mid-turn abort that degrades to a
   * coarse PTY restart under v3) then surfaces as a `phase140-turn-loss`
   * alert instead of silently losing the user's response.
   *
   * The monitor is OBSERVE-ONLY (never blocks/interrupts) and arms only when
   * a Turn was opened, so the arm/cancel are paired with the Turn lifecycle.
   * It does NOT touch the v2/SDK live-chat-agent turn path (that path keeps
   * its Phase-127 stall tracker). Optional + narrow (`onTurnStart` /
   * `onTurnEnd` only) so tests inject a fake and absent → no-op. Production
   * wires the daemon's single `TurnLossMonitor` via `endpoint-bootstrap.ts`.
   */
  readonly turnLossMonitor?: Pick<
    TurnLossMonitor,
    "onTurnStart" | "onTurnEnd"
  >;

  /**
   * Test seam — default `createPersistentSessionHandle`. Tests inject a factory
   * that returns a mocked SessionHandle without booting the real SDK.
   */
  readonly createHandle?: typeof createPersistentSessionHandle;

  /**
   * Test seam — default: no-op (production bootstrap precreates
   * CLAWCODE_TRANSIENT_CWD at daemon boot). Tests that assert cwd creation
   * inject this.
   */
  readonly ensureCwd?: (absPath: string) => void;

  /** Optional logger for structured diagnostics. */
  readonly log?: Logger;
}

/** Input shape for `driver.dispatch` — mirrors `OpenAiSessionDriver.dispatch`. */
type DispatchInput = Parameters<OpenAiSessionDriver["dispatch"]>[0];

/**
 * Build the production OpenAiSessionDriver. The returned object satisfies the
 * `OpenAiSessionDriver` interface; `startOpenAiServer` consumes it via its
 * `driver` config field.
 */
export function createOpenAiSessionDriver(
  deps: OpenAiSessionDriverDeps,
): OpenAiSessionDriver {
  const mkHandle = deps.createHandle ?? createPersistentSessionHandle;
  // 999.175 — per-handle client-tool state; entries die with their handle.
  const toolSessions = new WeakMap<SessionHandle, ToolSession>();
  return {
    dispatch(input) {
      return dispatchAsyncIterable(deps, mkHandle, input, toolSessions);
    },
  };
}

/**
 * 999.175 — where one HTTP request receives a client-tool turn's output. A
 * turn outlives the request that started it (it parks on a tool call), so its
 * output target is swapped when the continuation request arrives.
 */
interface TurnSink {
  /** Cumulative turn text; the sink emits only what it has not sent yet. */
  text(accumulated: string): void;
  /** End this response with `tool_calls` (the turn stays suspended). */
  toolCalls(calls: readonly ParkedCall[], sessionId: string): void;
  finish(sessionId: string): void;
  fail(err: Error): void;
  /** Text length already covered when this sink attached. */
  emitted: number;
}

interface ActiveToolTurn {
  /** Turn-owned — the request signal also fires when a response ends normally. */
  readonly controller: AbortController;
  sink: TurnSink | null;
  accumulated: string;
  done: Promise<void>;
  /** Every tool-call id this turn has sent to the client. */
  readonly issued: Set<string>;
  /** Text length when the latest continuation attached (a retry replays from here). */
  resumedAt: number;
}

interface ToolSession {
  readonly bridge: ClientToolBridge;
  readonly sessionId: () => string;
  active: ActiveToolTurn | null;
  /** Serializes the resume / supersede / start decision across concurrent requests. */
  lock: Promise<void>;
}

/** Run `fn` after every earlier decision on this session has settled. */
function withSessionLock(session: ToolSession, fn: () => Promise<void>): Promise<void> {
  const run = session.lock.then(fn, fn);
  session.lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Client tools this request actually exposes (`tool_choice: "none"` hides them). */
function exposedClientTools(input: DispatchInput): ClaudeToolDef[] {
  if (!input.tools || input.tools.length === 0 || input.toolChoice?.type === "none") return [];
  return usableClientTools(input.tools);
}

/** Tool results with no parked call to resume (restart, timeout) go in as text. */
function toolResultsAsText(results: readonly ClaudeToolResultBlock[]): string {
  return [
    "(Results of tool calls from an earlier turn that can no longer be resumed:)",
    ...results.map((r) => `[${r.tool_use_id}] ${r.content}`),
  ].join("\n");
}

/** Abandon a suspended turn: interrupt it and fail its parked calls. */
function abandonToolTurn(session: ToolSession, reason: string): void {
  const active = session.active;
  if (!active) return;
  // End whatever request is still attached; a silently detached sink leaves
  // that HTTP response open until its client gives up.
  const sink = active.sink;
  active.sink = null;
  sink?.fail(new Error(reason));
  active.controller.abort();
  session.bridge.abandon(reason);
}

/**
 * Kick off a dispatch and return an `AsyncIterable<SdkStreamEvent>`. The
 * iterable is a thin wrapper around an async iterator so the consumer can
 * control iteration cadence (stop early, race against timeouts, etc.).
 */
function dispatchAsyncIterable(
  deps: OpenAiSessionDriverDeps,
  mkHandle: typeof createPersistentSessionHandle,
  input: DispatchInput,
  toolSessions: WeakMap<SessionHandle, ToolSession>,
): AsyncIterable<SdkStreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      return runDispatch(deps, mkHandle, input, toolSessions);
    },
  };
}

/** Item queued by the stream callback, pulled by the iterator. */
type QueueItem =
  | { kind: "event"; event: SdkStreamEvent }
  | { kind: "end"; sessionId: string }
  | { kind: "error"; error: Error };

/**
 * The core driver loop — materializes (or reuses) the masking-backed handle,
 * then bridges its callback-based `sendAndStream` into a pull-style async
 * iterator. Written as a hand-rolled iterator (rather than `async function*`)
 * so the abort path can reject any pending `next()` call immediately without
 * waiting for `sendAndStream` to resolve.
 */
function runDispatch(
  deps: OpenAiSessionDriverDeps,
  mkHandle: typeof createPersistentSessionHandle,
  input: DispatchInput,
  toolSessions: WeakMap<SessionHandle, ToolSession>,
): AsyncIterator<SdkStreamEvent> {
  const { agentName, keyHash, lastUserMessage, clientSystemAppend, signal, xRequestId } = input;
  const clientTools = exposedClientTools(input);
  if (clientTools.length === 0 && (input.tools?.length ?? 0) > 0 && input.toolChoice?.type !== "none") {
    deps.log?.warn(
      { agent: agentName, declared: input.tools?.map((t) => t.name) },
      "openai-driver: client declared tools but none are usable (names must match [a-zA-Z0-9_-], 56 chars max); text-only path",
    );
  }

  // 1. Build TurnOrigin — kind:"openai-api", source.id = first-8-hex(key_hash).
  const fingerprint = keyHash.slice(0, 8);
  // nanoid(12) produces a 12-char URL-safe string; TURN_ID_REGEX requires
  // ≥10 alphanumeric chars after the `openai-api:` prefix.
  const turnId = `openai-api:${nanoid(12)}`;
  const origin = makeRootOriginWithTurnId("openai-api", fingerprint, turnId);

  // 2. Open caller-owned Turn via the agent's TraceCollector (non-fatal if absent).
  const collector = deps.traceCollectorFor(agentName) ?? null;
  let turn: Turn | undefined;
  if (collector) {
    try {
      turn = collector.startTurn(origin.rootTurnId, agentName, null);
    } catch (err) {
      deps.log?.warn(
        { agent: agentName, err: (err as Error).message },
        "openai-driver: startTurn failed — continuing without trace",
      );
    }
  }

  // Phase 140 Plan 06 Task 11 — arm the v3 turn-loss watchdog on the
  // daemon-initiated turn. Paired with the Turn lifecycle: arm ONLY when a
  // Turn was opened (so `endTurnOnce` always has a matching cancel), keyed on
  // the SAME `openai-api:` turn id the Turn carries. Observe-only — never
  // blocks dispatch; a throwing monitor must not fault the turn.
  if (turn) {
    try {
      deps.turnLossMonitor?.onTurnStart(origin.rootTurnId, agentName);
    } catch {
      /* non-fatal — turn-loss telemetry is never fatal to the turn */
    }
  }

  // Phase 73 Plan 03 — openai.chat_completion span for TTFB + total-turn
  // latency (LAT-03). Retained verbatim across the v3 re-point.
  const dispatchStartMs = Date.now();
  let firstDeltaMs: number | undefined = undefined;
  let chatSpan: Span | undefined;
  if (turn) {
    try {
      chatSpan = turn.startSpan("openai.chat_completion", {
        agent: agentName,
        keyHashPrefix: fingerprint,
        xRequestId,
        stream: true,
        tools: input.tools?.length ?? 0,
      });
    } catch {
      /* non-fatal — trace write is best-effort */
    }
  }
  // Idempotent close — success, error, and abort paths may all call this.
  let chatSpanEnded = false;
  const endChatSpanOnce = (metadata: Record<string, unknown>): void => {
    if (chatSpanEnded) return;
    chatSpanEnded = true;
    try {
      chatSpan?.setMetadata(metadata);
      chatSpan?.end();
    } catch {
      /* non-fatal */
    }
  };

  // 3. Build the outgoing user message. clientSystemAppend — when present —
  //    is APPENDED after a visible delimiter so the agent's stable system
  //    prefix (prompt-cache preserved) stays intact (Pitfall 8). Tool
  //    definitions / results are stamped into a trailer for trace visibility.
  const messageParts: string[] = [lastUserMessage];
  if (clientSystemAppend && clientSystemAppend.length > 0) {
    messageParts.push("", "--- System context (appended) ---", clientSystemAppend);
  }
  if (clientTools.length > 0) {
    // 999.175 — the tools are real (mcp__c__*); results that cannot resume a
    // parked call are the only thing that still travels as text.
    if (input.toolResults.length > 0) messageParts.push("", toolResultsAsText(input.toolResults));
  } else {
    if (input.tools && input.tools.length > 0) {
      const names = input.tools.map((t) => t.name).join(", ");
      messageParts.push("", `(Client-declared tools: ${names})`);
    }
    if (input.toolResults.length > 0) {
      const ids = input.toolResults.map((t) => t.tool_use_id).join(", ");
      messageParts.push("", `(Client tool results for: ${ids})`);
    }
  }
  const outgoingMessage = messageParts.join("\n");

  // 4. Set up the bounded queue + pending waiter for the pull-style iterator.
  const queue: QueueItem[] = [];
  let pendingResolve: ((v: IteratorResult<SdkStreamEvent>) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;
  let accumulatedSoFar = "";
  let emittedTextBlockStart = false;
  let done = false;
  // Ensure turn.end() fires exactly once — the abort listener and the
  // sendAndStream promise-rejection path may both trigger.
  let turnEnded = false;
  const endTurnOnce = (outcome: "success" | "error"): void => {
    if (turnEnded) return;
    turnEnded = true;
    try {
      turn?.end(outcome);
    } catch {
      /* non-fatal — trace write is best-effort */
    }
    // Phase 140 Plan 06 Task 11 — cancel the turn-loss watchdog: the turn
    // reached end_to_end (success, error, OR abort all route through here).
    // Only a turn that NEVER calls this (silently lost) trips the alert.
    // Guarded by `turn` so the cancel is paired with the arm above.
    if (turn) {
      try {
        deps.turnLossMonitor?.onTurnEnd(turnId);
      } catch {
        /* non-fatal — turn-loss telemetry is never fatal to the turn */
      }
    }
  };

  const emitTerminal = (
    resolve: (v: IteratorResult<SdkStreamEvent>) => void,
    handleSessionId: string,
  ): void => {
    done = true;
    // Prefer the masking-backed handle's stable session id (Phase 140). Fall
    // back to the conversation-store id, then to a synthetic id so downstream
    // builders always have a non-empty string.
    let sessionId: string | undefined = handleSessionId;
    if (!sessionId) {
      try {
        sessionId = deps.sessionManager.getActiveConversationSessionId(agentName);
      } catch {
        sessionId = undefined;
      }
    }
    // Record / touch the bearer-key → session mapping (keyHash, agentName).
    if (sessionId) {
      try {
        const idx = deps.sessionIndexFor(agentName);
        idx.record(keyHash, agentName, sessionId);
        idx.touch(keyHash, agentName);
      } catch (err) {
        deps.log?.warn(
          { agent: agentName, err: (err as Error).message },
          "openai-driver: session-index record/touch failed (non-fatal)",
        );
      }
    }
    const event: SdkStreamEvent = {
      type: "result",
      session_id: sessionId ?? `openai-${xRequestId}`,
    };
    resolve({ value: event, done: false });
  };

  const flushNext = (): boolean => {
    if (!pendingResolve) return false;
    const item = queue.shift();
    if (!item) return false;
    const resolve = pendingResolve;
    const reject = pendingReject;
    pendingResolve = null;
    pendingReject = null;
    if (item.kind === "event") {
      resolve({ value: item.event, done: false });
      return true;
    }
    if (item.kind === "end") {
      emitTerminal(resolve, item.sessionId);
      return true;
    }
    // error
    if (reject) reject(item.error);
    else resolve({ value: undefined, done: true });
    return true;
  };

  const pushEvent = (event: SdkStreamEvent): void => {
    queue.push({ kind: "event", event });
    flushNext();
  };
  const pushEnd = (sessionId: string): void => {
    queue.push({ kind: "end", sessionId });
    flushNext();
  };
  const pushError = (err: Error): void => {
    queue.push({ kind: "error", error: err });
    flushNext();
  };

  // 5. onChunk bridge — translate each accumulated-text callback into a
  //    content_block_delta carrying only the NEW delta (verbatim from the
  //    prior dispatchStream cut; SSE parity preserved).
  const onChunk = (accumulated: string): void => {
    if (firstDeltaMs === undefined) {
      firstDeltaMs = Date.now();
    }
    if (!emittedTextBlockStart) {
      emittedTextBlockStart = true;
      pushEvent({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
      });
    }
    if (accumulated.length <= accumulatedSoFar.length) return;
    const delta = accumulated.slice(accumulatedSoFar.length);
    accumulatedSoFar = accumulated;
    if (delta.length === 0) return;
    pushEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta },
      },
    });
  };

  /**
   * Materialize (or reuse from cache) the masking-backed handle for this
   * request identity. Mirrors `template-driver.materializeHandle`:
   *   - cache HIT → return immediately (bypass the drain — load-bearing).
   *   - cache MISS → drain an initial query for the SDK session_id, then
   *     `createPersistentSessionHandle` resumed against it, then cache it.
   */
  async function materializeHandle(): Promise<SessionHandle> {
    const handleStartedAtMs = Date.now();
    const base = await deps.getAgentBaseOptions(agentName);

    // 999.175 — the client's tool set is fixed at spawn (in-process MCP
    // server), so it is part of the identity. Tool-less keys are unchanged.
    const toolsFp = clientTools.length > 0 ? clientToolsFingerprint(clientTools) : null;
    const cacheKey =
      makeTransientCacheKey({
        keyHash,
        callerSlug: agentName,
        soulFp: base.soulFp,
        tier: base.model,
      }) + (toolsFp ? `::tools:${toolsFp}` : "");

    const cached = deps.transientCache.get(cacheKey);
    if (cached) return cached;

    if (deps.ensureCwd) deps.ensureCwd(CLAWCODE_TRANSIENT_CWD);
    // Phase 999.87 — clean env strips ANTHROPIC_API_KEY via single
    // source of truth helper → OAuth subscription auth.
    const cleanEnv = buildAnthropicSafeEnv();
    const baseOptions = {
      systemPrompt: base.soulPrompt, // STRING — REPLACES kernel prompt.
      model: base.model,
      cwd: CLAWCODE_TRANSIENT_CWD,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      mcpServers: {},
      settingSources: ["project"] as ReadonlyArray<string>,
      env: cleanEnv,
      // 999.175 — a client that brings its own tools drives ITS machine: no
      // built-in Bash/Read/Edit on clawdy for that session. The CLI closes an
      // in-process MCP call after 60 s by default; a parked call waits for the
      // client's next request, so lift that past CLIENT_TOOL_WAIT_MS.
      ...(toolsFp
        ? {
            tools: [] as string[],
            env: { ...cleanEnv, CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(CLIENT_TOOL_WAIT_MS + 60_000) },
          }
        : {}),
    } satisfies SdkQueryOptions;

    // Step 1 — drain initial query to get the SDK-assigned session_id.
    const initialQuery: SdkQuery = deps.sdk.query({
      prompt: "Session initialized.",
      options: baseOptions as SdkQueryOptions,
    });
    const sessionId = await drainForSessionId(initialQuery);

    // Bind a per-turn usage callback so native OpenAI cost rows land in the
    // agent's tracker (restores the attribution the pre-re-point main-handle
    // path provided). Declared before mkHandle so the closure over `newHandle`
    // is visible. `agentName` is the cache-key identity — every request sharing
    // this handle shares the same agent, so per-agent attribution is correct.
    let newHandle: SessionHandle | undefined;
    const usageCb: UsageCallback | undefined = deps.onUsage
      ? (u) => {
          try {
            if (newHandle) {
              deps.onUsage!(agentName, u, newHandle.sessionId, Date.now() - handleStartedAtMs);
            }
          } catch (err) {
            deps.log?.warn(
              { agent: agentName, err: (err as Error).message },
              "openai-driver: transient usage callback threw (non-fatal)",
            );
          }
        }
      : undefined;

    // Step 2 — hand the SDK-assigned sessionId to the persistent handle.
    if (!toolsFp) {
      newHandle = mkHandle(deps.sdk, baseOptions as SdkQueryOptions, sessionId, usageCb);
      deps.transientCache.set(cacheKey, newHandle);
      return newHandle;
    }
    // 999.175 — the client server joins only the long-lived handle: an
    // McpServer instance takes ONE transport, and the drain above is done.
    const session: ToolSession = {
      bridge: new ClientToolBridge(clientTools, {
        onParked: (calls) => {
          const active = session.active;
          if (!active) return;
          for (const call of calls) active.issued.add(call.id);
          if (!active.sink) return; // client gone: a retry gets these, else they time out
          const sink = active.sink;
          active.sink = null;
          sink.toolCalls(calls, session.sessionId());
        },
      }),
      sessionId: () => newHandle?.sessionId ?? sessionId,
      active: null,
      lock: Promise.resolve(),
    };
    newHandle = mkHandle(
      deps.sdk,
      { ...baseOptions, mcpServers: { c: session.bridge.mcpConfig } } as SdkQueryOptions,
      sessionId,
      usageCb,
    );
    toolSessions.set(newHandle, session);
    deps.transientCache.set(cacheKey, newHandle);
    return newHandle;
  }

  // 6. Async kickoff: resolve handle (cache or materialize), stream through it,
  //    push end/error. Any throw becomes a rejection on the pushError channel.
  //    handle.sendAndStream honors options.signal (races the SDK interrupt
  //    deadline) so abort plumbing is inherent.
  const latency = (): { ttfb_ms: number | null; total_turn_ms: number } => ({
    ttfb_ms: firstDeltaMs !== undefined ? firstDeltaMs - dispatchStartMs : null,
    total_turn_ms: Date.now() - dispatchStartMs,
  });
  if (clientTools.length === 0) {
    void (async () => {
      try {
        const handle = await materializeHandle();
        // CAM-01/02 — thread inline vision attachments through SendOptions.images
        // (the persistent handle builds Anthropic `image` content blocks). Empty/
        // undefined → unchanged string-only turn.
        await handle.sendAndStream(outgoingMessage, onChunk, turn, {
          signal,
          images: input.lastUserImages,
        });
        endTurnOnce("success");
        endChatSpanOnce(latency());
        pushEnd(handle.sessionId);
      } catch (err) {
        endTurnOnce("error");
        endChatSpanOnce({ ...latency(), error: true });
        pushError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  } else {
    runClientToolTurn();
  }

  /**
   * 999.175 — a turn that can park on client tool calls. It runs on its own
   * AbortController (the request signal also fires when a response ENDS, which
   * would interrupt the parked turn), and its output goes to whichever
   * request's sink is attached: this one, then the continuation's.
   */
  function runClientToolTurn(): void {
    const sink: TurnSink = {
      emitted: 0,
      text(accumulated) {
        if (accumulated.length <= this.emitted) return;
        const delta = accumulated.slice(this.emitted);
        this.emitted = accumulated.length;
        if (firstDeltaMs === undefined) firstDeltaMs = Date.now();
        if (!emittedTextBlockStart) {
          emittedTextBlockStart = true;
          pushEvent({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } });
        }
        pushEvent({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } } });
      },
      toolCalls(calls, sessionId) {
        calls.forEach((call, i) => {
          const index = i + 1;
          pushEvent({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name } } });
          pushEvent({
            type: "stream_event",
            event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } },
          });
          pushEvent({ type: "stream_event", event: { type: "content_block_stop", index } });
        });
        endTurnOnce("success");
        endChatSpanOnce({ ...latency(), suspended_tool_calls: calls.length });
        pushEnd(sessionId);
      },
      finish(sessionId) {
        endTurnOnce("success");
        endChatSpanOnce(latency());
        pushEnd(sessionId);
      },
      fail(err) {
        endTurnOnce("error");
        endChatSpanOnce({ ...latency(), error: true });
        pushError(err);
      },
    };

    void (async () => {
      try {
        const handle = await materializeHandle();
        const session = toolSessions.get(handle);
        if (!session) throw new Error("openai-driver: cached handle has no client-tool session");
        await withSessionLock(session, () => startOrResume(handle, session));
      } catch (err) {
        sink.fail(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    async function startOrResume(handle: SessionHandle, session: ToolSession): Promise<void> {
      const active = session.active;
      const parked = new Set(session.bridge.pendingIds());
      const resumes = active !== null && input.toolResults.some((r) => parked.has(r.tool_use_id));
      // Same results again, for calls this turn already has: the client
      // retried a continuation whose response it never got.
      const retries =
        !resumes && active !== null && input.toolResults.length > 0 && input.toolResults.every((r) => active.issued.has(r.tool_use_id));

      if (active && (resumes || retries)) {
        const previous = active.sink;
        active.sink = null;
        previous?.fail(new Error("Replaced by a retried request."));
        if (resumes) active.resumedAt = active.accumulated.length;
        sink.emitted = active.resumedAt;
        active.sink = sink;
        signal.addEventListener("abort", () => {
          if (active.sink === sink) abandonToolTurn(session, "The client disconnected.");
        }, { once: true });
        sink.text(active.accumulated); // replay what the retried request missed
        if (resumes) {
          session.bridge.resolveResults(input.toolResults);
          return;
        }
        // The missed response may have ended with new tool calls: send them again.
        const waiting = session.bridge.pendingCalls();
        if (waiting.length > 0) {
          active.sink = null;
          sink.toolCalls(waiting, session.sessionId());
        }
        return;
      }

      // Anything else supersedes a suspended turn.
      if (active) {
        abandonToolTurn(session, "Superseded by a new request.");
        await active.done;
      }

      {
        const state: ActiveToolTurn = {
          controller: new AbortController(),
          sink,
          accumulated: "",
          done: Promise.resolve(),
          issued: new Set(),
          resumedAt: 0,
        };
        session.active = state;
        signal.addEventListener("abort", () => {
          if (state.sink === sink) abandonToolTurn(session, "The client disconnected.");
        }, { once: true });
        state.done = (async () => {
          try {
            // No caller Turn: a parked turn outlives the request that opened it.
            await handle.sendAndStream(
              outgoingMessage,
              (accumulated) => {
                state.accumulated = accumulated;
                state.sink?.text(accumulated);
              },
              undefined,
              { signal: state.controller.signal, images: input.lastUserImages },
            );
            state.sink?.finish(handle.sessionId);
          } catch (err) {
            state.sink?.fail(err instanceof Error ? err : new Error(String(err)));
          } finally {
            state.sink = null;
            if (session.active === state) session.active = null;
          }
        })();
      }
    }
  }

  // 7. Wire abort → synthesize an error into the queue so pending next() calls
  //    resolve promptly. handle.sendAndStream also honors the signal; this
  //    guarantees the iterator resolves even if the SDK is slow to notice.
  const onAbort = (): void => {
    if (done) return;
    endTurnOnce("error");
    endChatSpanOnce({
      ttfb_ms: firstDeltaMs !== undefined ? firstDeltaMs - dispatchStartMs : null,
      total_turn_ms: Date.now() - dispatchStartMs,
      error: true,
    });
    pushError(new Error("openai-driver: aborted"));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  // 8. Return the async iterator.
  const iterator: AsyncIterator<SdkStreamEvent> = {
    next(): Promise<IteratorResult<SdkStreamEvent>> {
      return new Promise<IteratorResult<SdkStreamEvent>>((resolve, reject) => {
        if (done && queue.length === 0) {
          resolve({ value: undefined, done: true });
          return;
        }
        pendingResolve = resolve;
        pendingReject = reject;
        flushNext();
      });
    },
    return(): Promise<IteratorResult<SdkStreamEvent>> {
      done = true;
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  return iterator;
}

/**
 * Drain an initial SDK query until its `result` message arrives and return the
 * SDK-assigned session_id. Mirrors `drainForSessionId` in template-driver.ts —
 * throws on drain failure rather than feeding a bogus id to `resume:` (which
 * would surface as the `error_during_execution` CLI crash). A failed result
 * throws `UpstreamTurnError` carrying the upstream text, which the server
 * answers as 502 `upstream_error`.
 */
async function drainForSessionId(query: SdkQuery): Promise<string> {
  for await (const msg of query) {
    if (msg.type === "result") {
      const resultMsg = msg as SdkResultFields;
      if (resultMsg.is_error) {
        throw upstreamTurnErrorFromResult(
          "openai-driver: initial drain query",
          resultMsg,
        );
      }
      if (
        typeof resultMsg.session_id === "string" &&
        resultMsg.session_id.length > 0
      ) {
        return resultMsg.session_id;
      }
      break;
    }
  }
  throw new Error(
    "openai-driver: initial drain query produced no session_id result; cannot establish transient session",
  );
}
