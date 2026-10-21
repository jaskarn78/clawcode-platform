/**
 * Phase 74 Plan 01 — OpenClaw template driver.
 *
 * Implements the `OpenAiSessionDriver` contract (src/openai/server.ts) for the
 * NAMESPACE-PREFIXED path (`body.model="openclaw:<slug>[:<tier>]"`). Completely
 * separate code path from the Phase 69 ClawCode-native driver — literal
 * agent-name traffic continues to flow through createOpenAiSessionDriver
 * unchanged.
 *
 * Design (74-CONTEXT D-01/D-02/D-03 + 74-RESEARCH Pattern 2 + Pitfall 2/4):
 *
 *   1. Per-caller persistent SDK session — reuses Phase 73's
 *      createPersistentSessionHandle VERBATIM so the SDK subprocess + prompt
 *      cache survive across turns for the same (bearer, callerSlug, soulFp,
 *      tier) tuple. Sub-2s TTFB SLO preserved.
 *
 *   2. Cache-key components (D-03):
 *        - bearer key hash
 *        - caller slug
 *        - sha256(SOUL).slice(0,16)
 *        - tier (sonnet|opus|haiku)
 *      A change in ANY of the four forces a fresh handle. The stale handle
 *      eventually ages out via LRU or 30-min idle TTL (wired in bootstrap).
 *
 *   3. systemPrompt MUST be the STRING form of the caller's SOUL — NEVER the
 *      preset object form (Pitfall 2 — `{preset: "claude_code", append}` would
 *      inject the Claude Code kernel prompt into OpenClaw's turn and burn
 *      tokens). The STRING form REPLACES the SDK's default prompt entirely;
 *      the SOUL IS the whole instruction surface for transient agents.
 *
 *   4. cwd is a FIXED module-scope constant — NEVER caller-derived
 *      (Pitfall 4). The driver never reads body.workspace / body.cwd /
 *      body.metadata.workspace — grep-enforced.
 *
 *   5. mcpServers:{} + settingSources:[] + tools:[] — OpenClaw-side tools
 *      travel as OpenAI tool_calls round-trips via Phase 69's translator, not
 *      as ClawCode MCP mounts. The SDK's built-in tools are explicitly off.
 *
 *   6. Event bridging — createPersistentSessionHandle's sendAndStream uses a
 *      `(accumulated: string) => void` callback. This module converts that
 *      into `AsyncIterable<SdkStreamEvent>` via a bounded queue + pending
 *      resolver (same pattern as src/openai/driver.ts uses to bridge
 *      TurnDispatcher.dispatchStream into the server's stream contract).
 */

import path from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";

import type { OpenAiSessionDriver } from "./server.js";
import type { SdkStreamEvent, TemplateDriverInput } from "./types.js";
import { TIER_MODEL_MAP } from "./types.js";
import {
  type SessionHandle,
  type UsageCallback,
} from "../manager/session-adapter.js";
import type { SdkModule, SdkQueryOptions, SdkQuery } from "../manager/sdk-types.js";
import { createPersistentSessionHandle } from "../manager/persistent-session-handle.js";
// Phase 999.87 — single source of truth for child-spawn env credential
// handling. The helper strips ANTHROPIC_API_KEY so the SDK subprocess
// uses OAuth subscription auth.
import { buildAnthropicSafeEnv } from "../manager/spawn-env.js";
import {
  TransientSessionCache,
  makeTransientCacheKey,
} from "./transient-session-cache.js";
import { upstreamTurnErrorFromResult, type SdkResultFields } from "./upstream-error.js";

/**
 * Fixed cwd for every transient handle. Never caller-derived (Pitfall 4).
 * Created lazily by the template driver via ensureCwd (default: mkdirSync
 * with recursive). The daemon bootstrap is free to precreate it — idempotent.
 */
export const CLAWCODE_TRANSIENT_CWD = path.join(
  homedir(),
  ".clawcode",
  "manager",
  "transient",
);

/** Dependency bag for createOpenClawTemplateDriver. */
export interface TemplateDriverDeps {
  /** Same SdkModule handle the native driver / SdkSessionAdapter uses. */
  readonly sdk: SdkModule;
  /** LRU+TTL cache owning the per-caller persistent handles. */
  readonly cache: TransientSessionCache;
  /** Structured logger (pino). */
  readonly log: Logger;
  /**
   * Optional per-turn usage hook — Plan 02 will thread the real UsageTracker
   * here so `openclaw:<slug>` rows land in the costs DB. Plan 01 leaves it a
   * no-op (undefined).
   */
  readonly onUsage?: (
    input: TemplateDriverInput,
    usage: Parameters<UsageCallback>[0],
    sessionId: string,
    elapsedMs: number,
  ) => void;
  /**
   * Test seam — default: createPersistentSessionHandle.
   * Tests inject a factory that returns a mocked SessionHandle without booting
   * the real SDK.
   */
  readonly createHandle?: typeof createPersistentSessionHandle;
  /**
   * Test seam — default: no-op (tests that assert cwd creation inject this;
   * production bootstrap precreates CLAWCODE_TRANSIENT_CWD at daemon boot).
   */
  readonly ensureCwd?: (absPath: string) => void;
}

/**
 * OpenClawTemplateDriver is a drop-in OpenAiSessionDriver. The server
 * passes a `TemplateDriverInput` (superset of OpenAiSessionDriver.dispatch's
 * native input — the extra fields callerSlug/tier/soulPrompt/soulFp carry
 * the template identity).
 *
 * The shape is declared as OpenAiSessionDriver directly so OpenAiServerConfig
 * can accept either driver interchangeably — the template driver simply
 * reads additional fields off the input object that the native driver
 * ignores.
 */
export type OpenClawTemplateDriver = OpenAiSessionDriver;

export function createOpenClawTemplateDriver(
  deps: TemplateDriverDeps,
): OpenClawTemplateDriver {
  const mkHandle = deps.createHandle ?? createPersistentSessionHandle;
  return {
    dispatch(input) {
      // Template path — server.ts guarantees TemplateDriverInput shape on
      // the openclaw-template branch.
      return dispatchTemplate(
        input as unknown as TemplateDriverInput,
        deps,
        mkHandle,
      );
    },
  };
}

/**
 * Core dispatch: materialize (or reuse) the per-caller handle, then bridge
 * its callback-based sendAndStream into an AsyncIterable<SdkStreamEvent>.
 */
function dispatchTemplate(
  input: TemplateDriverInput,
  deps: TemplateDriverDeps,
  mkHandle: typeof createPersistentSessionHandle,
): AsyncIterable<SdkStreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      return runTemplateDispatch(input, deps, mkHandle);
    },
  };
}

type QueueItem =
  | { kind: "event"; event: SdkStreamEvent }
  | { kind: "end"; sessionId: string }
  | { kind: "error"; error: Error };

function runTemplateDispatch(
  input: TemplateDriverInput,
  deps: TemplateDriverDeps,
  mkHandle: typeof createPersistentSessionHandle,
): AsyncIterator<SdkStreamEvent> {
  const cacheKey = makeTransientCacheKey({
    keyHash: input.keyHash,
    callerSlug: input.callerSlug,
    soulFp: input.soulFp,
    tier: input.tier,
  });

  // Fast-path cache hit — handle already materialized (prior request). Bypass
  // the drain entirely. Cache miss takes the async materialization branch
  // inside kickoff() below.
  let handle: SessionHandle | undefined = deps.cache.get(cacheKey);
  const startedAt = Date.now();

  /**
   * Phase 74 hotfix — match the native path's two-step handle materialization
   * (session-adapter.ts:422-436):
   *
   *   1. Drain `sdk.query({ prompt: "Session initialized.", options })` to
   *      establish a real SDK-assigned session_id on disk.
   *   2. Hand that session_id to createPersistentSessionHandle so the single
   *      long-lived query can `resume:` it successfully.
   *
   * Without the drain, the persistent handle's `resume: randomUUID()` tries
   * to load conversation history from a session the SDK never created,
   * causing the Claude CLI subprocess to emit `error_during_execution` after
   * ~1.5s. See `sdk.d.ts:1310-1312` — `resume` REQUIRES an existing session;
   * use of a fresh UUID is undefined behavior that surfaces as CLI crash.
   *
   * The drain is async (awaits the SDK subprocess's first result message),
   * so this helper lives inside the async kickoff below — kept off the
   * synchronous iterator-construction path so that test-only fakes (which
   * never call sdk.query) still work.
   */
  async function materializeHandle(): Promise<SessionHandle> {
    if (deps.ensureCwd) deps.ensureCwd(CLAWCODE_TRANSIENT_CWD);
    const modelId = TIER_MODEL_MAP[input.tier];
    // Build baseOptions — Pitfall 2 (string systemPrompt) + Pitfall 4 (fixed
    // cwd) + isolation (mcpServers:{}, tools:[]). settingSources:["project"]
    // matches the native agent path; empty settingSources makes the CLI
    // subprocess crash with `error_during_execution`. The "project" source
    // is required for the Claude Code kernel to bootstrap; we still isolate
    // from caller workspace by using a fixed CLAWCODE_TRANSIENT_CWD.
    //
    // Phase 999.87 — env inherits process.env (minus ANTHROPIC_API_KEY)
    // via the single source of truth helper so the subprocess uses
    // OAuth subscription auth instead of a potentially-stale external
    // API key.
    const cleanEnv = buildAnthropicSafeEnv();
    const baseOptions = {
      systemPrompt: input.soulPrompt, // STRING — REPLACES kernel prompt.
      model: modelId,
      cwd: CLAWCODE_TRANSIENT_CWD,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      mcpServers: {},
      settingSources: ["project"] as ReadonlyArray<string>,
      env: cleanEnv,
    } satisfies SdkQueryOptions;

    // Step 1 — drain initial query to get the SDK-assigned session_id. The
    // CLI subprocess exits after emitting the `result` message; the session
    // JSONL persists on disk and the persistent handle resumes it below.
    const initialQuery: SdkQuery = deps.sdk.query({
      prompt: "Session initialized.",
      options: baseOptions as SdkQueryOptions,
    });
    const sessionId = await drainForSessionId(initialQuery);

    // Bind a usage callback that reports back via deps.onUsage — Plan 02
    // hooks UsageTracker here so `openclaw:<slug>` rows land in the DB.
    // Declared before mkHandle so the closure over `newHandle` is visible.
    let newHandle: SessionHandle | undefined;
    const usageCb: UsageCallback | undefined = deps.onUsage
      ? (u) => {
          try {
            if (newHandle) {
              deps.onUsage!(input, u, newHandle.sessionId, Date.now() - startedAt);
            }
          } catch (err) {
            deps.log.warn({ err }, "transient usage callback threw (non-fatal)");
          }
        }
      : undefined;

    // Step 2 — hand the SDK-assigned sessionId to the persistent handle.
    newHandle = mkHandle(
      deps.sdk,
      baseOptions as SdkQueryOptions,
      sessionId,
      usageCb,
    );
    deps.cache.set(cacheKey, newHandle);
    return newHandle;
  }

  // --- Bridge handle.sendAndStream (callback) → AsyncIterable<SdkStreamEvent> ---
  const queue: QueueItem[] = [];
  let pendingResolve: ((v: IteratorResult<SdkStreamEvent>) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;
  let done = false;
  let accumulatedSoFar = "";
  let emittedTextBlockStart = false;

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
      done = true;
      const finalEvent: SdkStreamEvent = {
        type: "result",
        session_id: item.sessionId,
      };
      resolve({ value: finalEvent, done: false });
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

  // Kick off the turn. The SDK emits chunks via onChunk(accumulated); we
  // convert each delta into a content_block_delta event.
  const onChunk = (accumulated: string): void => {
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

  // Async kickoff: (a) resolve handle from cache OR materialize async via
  // drain-then-mkHandle, (b) run sendAndStream, (c) push end/error. Any
  // throw from materializeHandle (including synchronous throws from
  // mkHandle in tests — wrapped in the async boundary) becomes a rejection
  // on the pushError channel, matching the pre-fix sync-throw semantics
  // from the iterator consumer's perspective.
  //
  // Abort plumbing — handle.sendAndStream already honors options.signal
  // (SendOptions.signal races the SDK's interrupt deadline). Nothing else
  // to wire here — the .catch path below translates AbortError into the
  // iterator's error channel.
  void (async () => {
    try {
      const liveHandle = handle ?? (await materializeHandle());
      // eslint-disable-next-line require-atomic-updates
      handle = liveHandle;
      await liveHandle.sendAndStream(input.lastUserMessage, onChunk, undefined, {
        signal: input.signal,
        // CAM-01/02 — inline vision attachments (empty/undefined → text-only).
        images: input.lastUserImages,
      });
      // handle.sessionId is stable for the life of the handle (Phase 73).
      pushEnd(liveHandle.sessionId);
    } catch (err) {
      pushError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

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
 * Drain an initial SDK query until its `result` message arrives and return
 * the SDK-assigned session_id.
 *
 * Mirrors `drainInitialQuery` in session-adapter.ts but throws instead of
 * falling back to a pending-timestamp id. The template driver has no prior
 * session on disk — if the drain fails we CANNOT safely proceed: passing a
 * bogus id to `resume:` inside createPersistentSessionHandle is exactly
 * what produced the `error_during_execution` symptom this fix addresses.
 * Surfacing the drain failure to the iterator's error channel lets the
 * server return a 502 upstream_error carrying the upstream text.
 */
async function drainForSessionId(query: SdkQuery): Promise<string> {
  for await (const msg of query) {
    if (msg.type === "result") {
      const resultMsg = msg as SdkResultFields;
      // If the drain itself errored (e.g., auth failure, CLI crash, missing
      // model, unsupported settings), do NOT feed the SDK-minted session_id
      // forward — even though the session exists on disk, the underlying
      // failure will recur on the persistent handle's first turn. Surface
      // the error NOW with the SDK's subtype and upstream text so server.ts
      // returns a meaningful 502 body instead of the downstream `resume:` hang.
      if (resultMsg.is_error) {
        throw upstreamTurnErrorFromResult(
          "template-driver: initial drain query",
          resultMsg,
        );
      }
      // SDK always populates session_id on result messages (sdk.d.ts:2581 +
      // 2604). Defensive narrow keeps strictNullChecks happy.
      if (typeof resultMsg.session_id === "string" && resultMsg.session_id.length > 0) {
        return resultMsg.session_id;
      }
      // Result without session_id is malformed — fall through to post-loop throw.
      break;
    }
  }
  throw new Error(
    "template-driver: initial drain query produced no session_id result; cannot establish transient session",
  );
}
