/**
 * Phase 140 Plan 05 Task 1 — OpenAiSessionDriver re-point tests.
 *
 * Under v3 the live chat agent becomes a `claude --channels` session with no
 * in-process Query, so the OpenAI native driver can no longer reach the live
 * `TurnDispatcher.dispatchStream` seam. This suite validates the re-pointed
 * driver, which now materializes (or reuses from a `TransientSessionCache`) its
 * OWN persistent masking-backed `SessionHandle` per (keyHash, agent, soul, tier)
 * — exactly the `template-driver.ts` pattern (subscription pool, masking stays,
 * no new cost). The driver:
 *
 *   1. Resolves the agent's base options (soul prompt, model/tier, soul fp) via
 *      the injected `getAgentBaseOptions` getter (the native-path analog of the
 *      template path's `extractCallerIdentity`).
 *   2. On cache MISS, drains an initial SDK query for the session_id then calls
 *      `createPersistentSessionHandle` on the masking/SDK backend and caches it.
 *   3. On cache HIT, REUSES the cached handle and bypasses the drain entirely
 *      (load-bearing for first_token — a per-request cold spawn would dominate
 *      latency).
 *   4. Streams through `handle.sendAndStream` (the existing onChunk→
 *      content_block_delta bridge is preserved verbatim) and synthesizes a
 *      terminal `result` event from `handle.sessionId`. SSE parity intact.
 *   5. Records / touches the bearer-key → session mapping via ApiKeySessionIndex.
 *   6. Honors AbortSignal (handle.sendAndStream races the SDK interrupt).
 *
 * There is NO `turnDispatcher` dependency anymore — the type system enforces
 * that the driver cannot reach the live chat agent's seam (acceptance #2).
 */

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  API_KEY_SESSIONS_MIGRATION_SQL,
  API_KEY_SESSIONS_MIGRATION_V2_SQL,
  ApiKeySessionIndex,
} from "../session-index.js";
import { createOpenAiSessionDriver } from "../driver.js";
import type { OpenAiSessionDriverDeps } from "../driver.js";
import type { SdkStreamEvent } from "../types.js";
import { TransientSessionCache } from "../transient-session-cache.js";
import type { SessionHandle } from "../../manager/session-adapter.js";
import type { SdkModule } from "../../manager/sdk-types.js";
import { isUpstreamTurnError } from "../upstream-error.js";

/** Span recorder — captures startSpan name/metadata + setMetadata + end count. */
type SpanEntry = {
  readonly name: string;
  readonly metadata: Record<string, unknown>;
  readonly setMetadataCalls: Record<string, unknown>[];
  endCalled: number;
};

/**
 * A fake SDK `query()` that yields a single terminal `result` carrying the
 * supplied session_id. Used by the drain step (`drainForSessionId`) on a cache
 * MISS so the unit test never boots a real SDK subprocess.
 */
function makeFakeSdk(sessionId: string): {
  sdk: SdkModule;
  queryCalls: number;
} {
  const counter = { n: 0 };
  const sdk = {
    query: vi.fn(() => {
      counter.n += 1;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "result", session_id: sessionId } as never;
        },
      };
    }),
  } as unknown as SdkModule;
  return {
    sdk,
    get queryCalls() {
      return counter.n;
    },
  };
}

/**
 * A fake `SessionHandle` that emits two accumulated-text chunks via onChunk
 * then resolves — the masking-backed handle stand-in. `sendCalls` records each
 * streamed message; `closed` flips on close().
 */
function makeFakeHandle(sessionId: string): {
  handle: SessionHandle;
  sendCalls: string[];
  closed: { value: boolean };
} {
  const sendCalls: string[] = [];
  const closed = { value: false };
  const handle = {
    sessionId,
    send: vi.fn(async () => {}),
    sendAndCollect: vi.fn(async () => "Hello, world"),
    sendAndStream: vi.fn(
      async (
        message: string,
        onChunk: (accumulated: string) => void,
        _turn?: unknown,
        _options?: { signal?: AbortSignal },
      ) => {
        sendCalls.push(message);
        onChunk("Hello");
        onChunk("Hello, world");
        return "Hello, world";
      },
    ),
    close: vi.fn(async () => {
      closed.value = true;
    }),
    onError: vi.fn(),
    onEnd: vi.fn(),
    setEffort: vi.fn(),
    getEffort: vi.fn(() => "low" as const),
    setModel: vi.fn(),
    getModel: vi.fn(() => "claude-sonnet-4-6"),
    setPermissionMode: vi.fn(),
    getPermissionMode: vi.fn(() => "default" as const),
  } as unknown as SessionHandle;
  return { handle, sendCalls, closed };
}

function makeMockDeps(overrides: Partial<OpenAiSessionDriverDeps> = {}): {
  deps: OpenAiSessionDriverDeps;
  db: Database.Database;
  events: {
    createHandleCalls: Array<{ sessionId: string }>;
    turnStartCalls: Array<{ rootTurnId: string; agentName: string }>;
    turnEndCalls: Array<"success" | "error">;
    spanCalls: SpanEntry[];
    agentBaseOptionsCalls: string[];
    sdkQueryCount: () => number;
    // Phase 140 Plan 06 Task 11 — TurnLossMonitor wire-up recorder.
    monitorStartCalls: Array<{ turnId: string; agent: string }>;
    monitorEndCalls: string[];
  };
  handleRef: { current: SessionHandle | null };
  usageCbRef: { current: ((u: unknown) => void) | null };
} {
  const db = new Database(":memory:");
  db.exec(API_KEY_SESSIONS_MIGRATION_SQL);
  db.exec(API_KEY_SESSIONS_MIGRATION_V2_SQL);

  const events = {
    createHandleCalls: [] as Array<{ sessionId: string }>,
    turnStartCalls: [] as Array<{ rootTurnId: string; agentName: string }>,
    turnEndCalls: [] as Array<"success" | "error">,
    spanCalls: [] as SpanEntry[],
    agentBaseOptionsCalls: [] as string[],
    sdkQueryCount: () => 0,
    monitorStartCalls: [] as Array<{ turnId: string; agent: string }>,
    monitorEndCalls: [] as string[],
  };

  const makeTurn = () => ({
    id: "mock-turn",
    recordOrigin: vi.fn(),
    end: vi.fn((outcome: "success" | "error") => {
      events.turnEndCalls.push(outcome);
    }),
    startSpan: vi.fn((name: string, metadata: Record<string, unknown> = {}) => {
      const entry: SpanEntry = {
        name,
        metadata: { ...metadata },
        setMetadataCalls: [],
        endCalled: 0,
      };
      events.spanCalls.push(entry);
      return {
        setMetadata: (extra: Record<string, unknown>) => {
          entry.setMetadataCalls.push({ ...extra });
        },
        end: () => {
          entry.endCalled += 1;
        },
      };
    }),
  });

  const traceCollector = {
    startTurn: vi.fn(
      (rootTurnId: string, agentName: string, _channelId: string | null) => {
        events.turnStartCalls.push({ rootTurnId, agentName });
        return makeTurn();
      },
    ),
  };

  let activeSessionId: string | undefined = "sess-generated-by-sdk";
  const sessionManager = {
    getActiveConversationSessionId: vi.fn(() => activeSessionId),
  };

  const fakeSdk = makeFakeSdk("sess-generated-by-sdk");
  events.sdkQueryCount = () => fakeSdk.queryCalls;

  const handleRef: { current: SessionHandle | null } = { current: null };
  const usageCbRef: { current: ((u: unknown) => void) | null } = {
    current: null,
  };

  const sessionIndex = new ApiKeySessionIndex(db);

  const cache = new TransientSessionCache({ maxSize: 8, ttlMs: 0 });

  const deps: OpenAiSessionDriverDeps = {
    sessionManager:
      sessionManager as unknown as OpenAiSessionDriverDeps["sessionManager"],
    sessionIndexFor: () => sessionIndex,
    traceCollectorFor: () =>
      traceCollector as unknown as ReturnType<
        OpenAiSessionDriverDeps["traceCollectorFor"]
      >,
    sdk: fakeSdk.sdk,
    transientCache: cache,
    getAgentBaseOptions: async (agentName: string) => {
      events.agentBaseOptionsCalls.push(agentName);
      return {
        soulPrompt: `SOUL for ${agentName}`,
        model: "claude-sonnet-5",
        soulFp: "deadbeefcafef00d",
      };
    },
    // Test seam — default would be createPersistentSessionHandle (real SDK).
    // Capture the injected usage callback (4th arg) so a test can invoke it and
    // assert the deps.onUsage routing.
    createHandle: ((
      _sdk: SdkModule,
      _baseOptions: unknown,
      sessionId: string,
      usageCb?: (u: unknown) => void,
    ) => {
      events.createHandleCalls.push({ sessionId });
      usageCbRef.current = usageCb ?? null;
      const { handle } = makeFakeHandle(sessionId);
      handleRef.current = handle;
      return handle;
    }) as unknown as OpenAiSessionDriverDeps["createHandle"],
    ensureCwd: vi.fn(),
    // Phase 140 Plan 06 Task 11 — fake TurnLossMonitor (onTurnStart/onTurnEnd
    // recorder). The driver arms the watchdog on the daemon-initiated
    // `openai-api:` turn and cancels it when the turn reaches end_to_end.
    turnLossMonitor: {
      onTurnStart: (turnId: string, agent: string) => {
        events.monitorStartCalls.push({ turnId, agent });
      },
      onTurnEnd: (turnId: string) => {
        events.monitorEndCalls.push(turnId);
      },
    } as unknown as OpenAiSessionDriverDeps["turnLossMonitor"],
    ...overrides,
  };

  return { deps, db, events, handleRef, usageCbRef };
}

async function collect(
  iter: AsyncIterable<SdkStreamEvent>,
): Promise<SdkStreamEvent[]> {
  const out: SdkStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const baseInput = (over: Record<string, unknown> = {}) => ({
  agentName: "clawdy",
  keyHash: "a".repeat(64),
  lastUserMessage: "Hi",
  clientSystemAppend: null,
  tools: null,
  toolChoice: null,
  toolResults: [],
  signal: new AbortController().signal,
  xRequestId: "req-1",
  ...over,
});

describe("createOpenAiSessionDriver (v3 re-point — transient masking-backed handle)", () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
  });

  it("streams content_block_delta events then a terminal result (SSE parity)", async () => {
    const { deps, db: d } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    const out = await collect(driver.dispatch(baseInput()));

    const textDeltas = out.filter(
      (e) =>
        e.type === "stream_event" && e.event.type === "content_block_delta",
    );
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);

    let combined = "";
    for (const e of out) {
      if (e.type === "stream_event" && e.event.type === "content_block_delta") {
        if (e.event.delta.type === "text_delta") combined += e.event.delta.text;
      }
    }
    expect(combined).toBe("Hello, world");

    const last = out[out.length - 1];
    expect(last?.type).toBe("result");
    if (last?.type === "result") {
      expect(last.session_id).toBe("sess-generated-by-sdk");
    }
  });

  it("materializes its OWN masking-backed handle on a cache MISS (drain → createHandle)", async () => {
    const { deps, db: d, events } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    await collect(driver.dispatch(baseInput()));

    // Drain query fired exactly once to mint the SDK session id.
    expect(events.sdkQueryCount()).toBe(1);
    // The persistent handle was constructed once with the drained session id.
    expect(events.createHandleCalls).toHaveLength(1);
    expect(events.createHandleCalls[0]?.sessionId).toBe("sess-generated-by-sdk");
    // The agent's base options were resolved (the native-path soul/tier getter).
    expect(events.agentBaseOptionsCalls).toContain("clawdy");
  });

  it("REUSES the cached handle on a second same-identity request (cache is load-bearing)", async () => {
    const { deps, db: d, events } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);

    await collect(driver.dispatch(baseInput({ xRequestId: "req-a" })));
    await collect(driver.dispatch(baseInput({ xRequestId: "req-b" })));

    // Handle factory called ONCE across the two dispatches — second is a hit.
    expect(events.createHandleCalls).toHaveLength(1);
    // Drain (cold spawn) happened only once — bypassed on the hit.
    expect(events.sdkQueryCount()).toBe(1);
  });

  it("different (keyHash, agent, soul, tier) identities get distinct handles", async () => {
    const { deps, db: d, events } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);

    await collect(driver.dispatch(baseInput({ keyHash: "b".repeat(64) })));
    await collect(driver.dispatch(baseInput({ keyHash: "c".repeat(64) })));

    expect(events.createHandleCalls).toHaveLength(2);
  });

  it("records the bearer-key → session mapping on first result, touches on reuse", async () => {
    const { deps, db: d } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    const keyHash = "d".repeat(64);

    await collect(driver.dispatch(baseInput({ keyHash, xRequestId: "r1" })));
    const idx = deps.sessionIndexFor("clawdy");
    const found = idx.lookup(keyHash, "clawdy");
    expect(found?.session_id).toBe("sess-generated-by-sdk");
    expect(found?.agent_name).toBe("clawdy");
  });

  it("wires a usage callback that routes per-turn usage to deps.onUsage with the agent name", async () => {
    const onUsageCalls: Array<{
      agentName: string;
      usage: unknown;
      sessionId: string;
      elapsedMs: number;
    }> = [];
    const { deps, db: d, usageCbRef } = makeMockDeps({
      onUsage: (agentName, usage, sessionId, elapsedMs) => {
        onUsageCalls.push({ agentName, usage, sessionId, elapsedMs });
      },
    });
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    await collect(driver.dispatch(baseInput()));

    // The handle was constructed with a usage callback (the 4th arg).
    expect(usageCbRef.current).not.toBeNull();
    // Simulate the SDK reporting usage for a completed turn.
    usageCbRef.current!({
      tokens_in: 100,
      tokens_out: 50,
      cost_usd: 0.001,
      turns: 1,
      model: "claude-sonnet-4-6",
      duration_ms: 1200,
    });

    expect(onUsageCalls).toHaveLength(1);
    expect(onUsageCalls[0]?.agentName).toBe("clawdy");
    expect(onUsageCalls[0]?.sessionId).toBe("sess-generated-by-sdk");
    expect(typeof onUsageCalls[0]?.elapsedMs).toBe("number");
  });

  it("no usage callback is wired when deps.onUsage is absent (no-op)", async () => {
    const { deps, db: d, usageCbRef } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    await collect(driver.dispatch(baseInput()));
    // mkHandle received undefined for the usage callback → nothing to route.
    expect(usageCbRef.current ?? null).toBeNull();
  });

  it("opens a caller-owned Turn with origin.source.kind === 'openai-api'", async () => {
    const { deps, db: d, events } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    const keyHash =
      "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    await collect(driver.dispatch(baseInput({ keyHash })));

    expect(events.turnStartCalls).toHaveLength(1);
    expect(events.turnStartCalls[0]?.agentName).toBe("clawdy");
    expect(events.turnStartCalls[0]?.rootTurnId).toMatch(/^openai-api:/);
  });

  it("ends the caller-owned Turn with 'success' on clean completion", async () => {
    const { deps, db: d, events } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    await collect(driver.dispatch(baseInput()));
    expect(events.turnEndCalls).toEqual(["success"]);
  });

  it("ends the caller-owned Turn with 'error' when the handle stream rejects", async () => {
    const { deps, db: d, events, handleRef } = makeMockDeps();
    db = d;
    // Override createHandle to return a handle whose sendAndStream rejects.
    (deps as { createHandle: unknown }).createHandle = ((
      _sdk: SdkModule,
      _baseOptions: unknown,
      sessionId: string,
    ) => {
      const h = {
        sessionId,
        send: vi.fn(async () => {}),
        sendAndCollect: vi.fn(async () => ""),
        sendAndStream: vi.fn(async () => {
          throw new Error("boom");
        }),
        close: vi.fn(async () => {}),
        onError: vi.fn(),
        onEnd: vi.fn(),
        setEffort: vi.fn(),
        getEffort: vi.fn(() => "low" as const),
        setModel: vi.fn(),
        getModel: vi.fn(() => "claude-sonnet-4-6"),
        setPermissionMode: vi.fn(),
        getPermissionMode: vi.fn(() => "default" as const),
      } as unknown as SessionHandle;
      handleRef.current = h;
      return h;
    }) as unknown as OpenAiSessionDriverDeps["createHandle"];

    const driver = createOpenAiSessionDriver(deps);
    await expect(collect(driver.dispatch(baseInput()))).rejects.toThrow("boom");
    expect(events.turnEndCalls).toEqual(["error"]);
  });

  it("abort signal aborts mid-dispatch and ends the turn with 'error'", async () => {
    const { deps, db: d, events, handleRef } = makeMockDeps();
    db = d;
    (deps as { createHandle: unknown }).createHandle = ((
      _sdk: SdkModule,
      _baseOptions: unknown,
      sessionId: string,
    ) => {
      const h = {
        sessionId,
        send: vi.fn(async () => {}),
        sendAndCollect: vi.fn(async () => ""),
        sendAndStream: vi.fn(
          async (
            _message: string,
            _onChunk: (accumulated: string) => void,
            _turn?: unknown,
            options?: { signal?: AbortSignal },
          ) => {
            return new Promise<string>((_resolve, reject) => {
              const s = options?.signal;
              if (!s) return reject(new Error("no signal"));
              s.addEventListener("abort", () => reject(new Error("aborted")));
            });
          },
        ),
        close: vi.fn(async () => {}),
        onError: vi.fn(),
        onEnd: vi.fn(),
        setEffort: vi.fn(),
        getEffort: vi.fn(() => "low" as const),
        setModel: vi.fn(),
        getModel: vi.fn(() => "claude-sonnet-4-6"),
        setPermissionMode: vi.fn(),
        getPermissionMode: vi.fn(() => "default" as const),
      } as unknown as SessionHandle;
      handleRef.current = h;
      return h;
    }) as unknown as OpenAiSessionDriverDeps["createHandle"];

    const driver = createOpenAiSessionDriver(deps);
    const ac = new AbortController();
    const iterable = driver.dispatch(baseInput({ signal: ac.signal }));
    const iter = iterable[Symbol.asyncIterator]();
    setTimeout(() => ac.abort(), 5);
    await expect(iter.next()).rejects.toThrow();
    expect(events.turnEndCalls).toEqual(["error"]);
  });

  // ── Phase 140 Plan 06 Task 11 — TurnLossMonitor wire-up ──────────────────
  // The native OpenAI driver is a v3 daemon-initiated turn (its own transient
  // masking-backed session post-140-05). The daemon fully observes this turn's
  // lifecycle here, so it arms the TurnLossMonitor watchdog on the synthesized
  // `openai-api:` turn id and cancels it when the turn reaches end_to_end. A
  // started-but-never-ended turn (mid-turn abort → coarse PTY restart) then
  // surfaces via the monitor's `phase140-turn-loss` alert instead of silently
  // losing the user's response.

  it("arms the TurnLossMonitor on the synthesized openai-api: turn id", async () => {
    const { deps, db: d, events } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    await collect(driver.dispatch(baseInput()));

    expect(events.monitorStartCalls).toHaveLength(1);
    expect(events.monitorStartCalls[0]?.agent).toBe("clawdy");
    expect(events.monitorStartCalls[0]?.turnId).toMatch(/^openai-api:/);
    // The armed id must MATCH the Turn's rootTurnId (so onTurnEnd cancels it).
    expect(events.monitorStartCalls[0]?.turnId).toBe(
      events.turnStartCalls[0]?.rootTurnId,
    );
  });

  it("cancels the watchdog (onTurnEnd) on clean completion — matching the armed id", async () => {
    const { deps, db: d, events } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    await collect(driver.dispatch(baseInput()));

    expect(events.monitorEndCalls).toHaveLength(1);
    expect(events.monitorEndCalls[0]).toBe(events.monitorStartCalls[0]?.turnId);
  });

  it("cancels the watchdog (onTurnEnd) when the handle stream rejects (error path)", async () => {
    const { deps, db: d, events, handleRef } = makeMockDeps();
    db = d;
    (deps as { createHandle: unknown }).createHandle = ((
      _sdk: SdkModule,
      _baseOptions: unknown,
      sessionId: string,
    ) => {
      const h = {
        sessionId,
        send: vi.fn(async () => {}),
        sendAndCollect: vi.fn(async () => ""),
        sendAndStream: vi.fn(async () => {
          throw new Error("boom");
        }),
        close: vi.fn(async () => {}),
        onError: vi.fn(),
        onEnd: vi.fn(),
        setEffort: vi.fn(),
        getEffort: vi.fn(() => "low" as const),
        setModel: vi.fn(),
        getModel: vi.fn(() => "claude-sonnet-4-6"),
        setPermissionMode: vi.fn(),
        getPermissionMode: vi.fn(() => "default" as const),
      } as unknown as SessionHandle;
      handleRef.current = h;
      return h;
    }) as unknown as OpenAiSessionDriverDeps["createHandle"];

    const driver = createOpenAiSessionDriver(deps);
    await expect(collect(driver.dispatch(baseInput()))).rejects.toThrow("boom");

    expect(events.monitorStartCalls).toHaveLength(1);
    // onTurnEnd MUST fire on the error path too (no false turn-loss alert for
    // a turn that errored cleanly — only a SILENT never-ending turn alerts).
    expect(events.monitorEndCalls).toEqual([events.monitorStartCalls[0]?.turnId]);
  });

  it("cancels the watchdog (onTurnEnd) on abort (abort path)", async () => {
    const { deps, db: d, events, handleRef } = makeMockDeps();
    db = d;
    (deps as { createHandle: unknown }).createHandle = ((
      _sdk: SdkModule,
      _baseOptions: unknown,
      sessionId: string,
    ) => {
      const h = {
        sessionId,
        send: vi.fn(async () => {}),
        sendAndCollect: vi.fn(async () => ""),
        sendAndStream: vi.fn(
          async (
            _message: string,
            _onChunk: (accumulated: string) => void,
            _turn?: unknown,
            options?: { signal?: AbortSignal },
          ) => {
            return new Promise<string>((_resolve, reject) => {
              const s = options?.signal;
              if (!s) return reject(new Error("no signal"));
              s.addEventListener("abort", () => reject(new Error("aborted")));
            });
          },
        ),
        close: vi.fn(async () => {}),
        onError: vi.fn(),
        onEnd: vi.fn(),
        setEffort: vi.fn(),
        getEffort: vi.fn(() => "low" as const),
        setModel: vi.fn(),
        getModel: vi.fn(() => "claude-sonnet-4-6"),
        setPermissionMode: vi.fn(),
        getPermissionMode: vi.fn(() => "default" as const),
      } as unknown as SessionHandle;
      handleRef.current = h;
      return h;
    }) as unknown as OpenAiSessionDriverDeps["createHandle"];

    const driver = createOpenAiSessionDriver(deps);
    const ac = new AbortController();
    const iter = driver.dispatch(baseInput({ signal: ac.signal }))[
      Symbol.asyncIterator
    ]();
    setTimeout(() => ac.abort(), 5);
    await expect(iter.next()).rejects.toThrow();

    expect(events.monitorEndCalls).toEqual([events.monitorStartCalls[0]?.turnId]);
  });

  it("does NOT arm the monitor when no TraceCollector Turn was opened (paired lifecycle)", async () => {
    // No Turn → no armed watchdog. The monitor's onTurnStart/onTurnEnd must be
    // paired with the Turn lifecycle so an unpaired arm can never leak.
    const { deps, db: d, events } = makeMockDeps({
      traceCollectorFor: () => null,
    });
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    await collect(driver.dispatch(baseInput()));

    expect(events.turnStartCalls).toHaveLength(0);
    expect(events.monitorStartCalls).toHaveLength(0);
    expect(events.monitorEndCalls).toHaveLength(0);
  });

  it("is a no-op when deps.turnLossMonitor is absent (optional seam)", async () => {
    const { deps, db: d } = makeMockDeps({ turnLossMonitor: undefined });
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    // Must dispatch cleanly with no monitor wired (back-compat).
    await expect(collect(driver.dispatch(baseInput()))).resolves.toBeDefined();
  });

  it("clientSystemAppend is appended to the streamed message (NEVER overrides — Pitfall 8)", async () => {
    const { deps, db: d, handleRef } = makeMockDeps();
    db = d;
    const driver = createOpenAiSessionDriver(deps);
    await collect(
      driver.dispatch(
        baseInput({
          lastUserMessage: "Write haiku",
          clientSystemAppend: "Be brief.",
        }),
      ),
    );
    // The fake handle records each streamed message; assert the append landed.
    const sent = (
      handleRef.current as unknown as {
        sendAndStream: { mock: { calls: unknown[][] } };
      }
    ).sendAndStream.mock.calls[0]?.[0] as string;
    expect(sent).toContain("Write haiku");
    expect(sent).toContain("Be brief.");
  });

  describe("openai.chat_completion span (LAT-03 preserved)", () => {
    it("successful dispatch produces span with ttfb_ms + total_turn_ms", async () => {
      const { deps, db: d, events } = makeMockDeps();
      db = d;
      const driver = createOpenAiSessionDriver(deps);
      await collect(
        driver.dispatch(
          baseInput({
            tools: [
              {
                name: "echo",
                description: "echo",
                input_schema: { type: "object", properties: {} },
              },
            ],
          }),
        ),
      );

      const chatSpans = events.spanCalls.filter(
        (s) => s.name === "openai.chat_completion",
      );
      expect(chatSpans).toHaveLength(1);
      const span = chatSpans[0]!;
      expect(span.metadata.agent).toBe("clawdy");
      expect(span.metadata.stream).toBe(true);
      expect(span.setMetadataCalls).toHaveLength(1);
      const delta = span.setMetadataCalls[0]!;
      expect(typeof delta.ttfb_ms).toBe("number");
      expect(typeof delta.total_turn_ms).toBe("number");
      expect(delta.error).toBeUndefined();
      expect(span.endCalled).toBe(1);
    });

    it("no span opened when traceCollectorFor returns null", async () => {
      const { deps, db: d, events } = makeMockDeps({
        traceCollectorFor: () => null,
      });
      db = d;
      const driver = createOpenAiSessionDriver(deps);
      const out = await collect(driver.dispatch(baseInput()));
      expect(out.length).toBeGreaterThan(0);
      expect(events.spanCalls).toHaveLength(0);
      expect(events.turnStartCalls).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Quick task 260419-p51 — OpenAI ↔ Discord parity for subagent-thread skill
// (P51-SPAWN-SUBAGENT-UX). Retained — static assertion against session-config.
// ---------------------------------------------------------------------------

describe("driver × subagent-thread parity", () => {
  it("session-config.ts injects subagent-thread guidance regardless of turn origin", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dirname, "..", "..", "manager", "session-config.ts"),
      "utf8",
    );

    expect(source).toContain(`includes("subagent-thread")`);
    expect(source).toContain("spawn_subagent_thread");

    const guardPattern = /origin[^=]*===\s*"(discord|openai-api)"/;
    const subagentSection = source.slice(
      source.indexOf("subagent-thread"),
      source.indexOf("subagent-thread") + 800,
    );
    expect(subagentSection).not.toMatch(guardPattern);
  });
});

// ---------------------------------------------------------------------------
// Binary pin + upstream errors (2026-09-23 endpoint outage).
//
// The driver used to spawn the SDK-BUNDLED Claude Code 2.1.140 (no
// `pathToClaudeCodeExecutable`), which Anthropic rejects for Opus 5.5, and it
// threw away the API error text — so every completion was an opaque 500.
// ---------------------------------------------------------------------------

describe("createOpenAiSessionDriver — Claude binary pin + upstream errors", () => {
  const PINNED_BIN = "/opt/clawcode/claude-pin/claude";
  let db: Database.Database | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (db) {
      db.close();
      db = null;
    }
  });

  /** Deps whose drain query + handle factory record the options they got. */
  function makeRecordingDeps(
    drainResult: Record<string, unknown> = { type: "result", session_id: "sess-pin" },
  ) {
    const queryOptions: Array<Record<string, unknown>> = [];
    const handleOptions: Array<Record<string, unknown>> = [];
    const sdk = {
      query: vi.fn((params: { options?: Record<string, unknown> }) => {
        queryOptions.push(params.options ?? {});
        return {
          async *[Symbol.asyncIterator]() {
            yield drainResult as never;
          },
        };
      }),
    } as unknown as SdkModule;
    const createHandle = ((
      _sdk: SdkModule,
      baseOptions: Record<string, unknown>,
      sessionId: string,
    ) => {
      handleOptions.push(baseOptions);
      return makeFakeHandle(sessionId).handle;
    }) as unknown as OpenAiSessionDriverDeps["createHandle"];
    const { deps, db: d } = makeMockDeps({ sdk, createHandle });
    db = d;
    return { deps, queryOptions, handleOptions };
  }

  // 999.169 — the pin is applied by the SDK chokepoint the driver's `sdk` comes
  // from (loadSdkModule → withPinnedClaudeBinary; SC-2 test). The driver itself
  // must not hand-roll one, even with the override set.
  it("leaves the pin to the SDK chokepoint on the drain AND the persistent handle", async () => {
    vi.stubEnv("CLAWCODE_CLAUDE_BIN", PINNED_BIN);
    const { deps, queryOptions, handleOptions } = makeRecordingDeps();

    await collect(createOpenAiSessionDriver(deps).dispatch(baseInput()));

    expect(queryOptions).toHaveLength(1);
    expect(queryOptions[0]).not.toHaveProperty("pathToClaudeCodeExecutable");
    expect(handleOptions).toHaveLength(1);
    expect(handleOptions[0]).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  it("omits the option when CLAWCODE_CLAUDE_BIN is unset (rollback = SDK default)", async () => {
    vi.stubEnv("CLAWCODE_CLAUDE_BIN", "");
    const { deps, queryOptions, handleOptions } = makeRecordingDeps();

    await collect(createOpenAiSessionDriver(deps).dispatch(baseInput()));

    expect(queryOptions[0]).not.toHaveProperty("pathToClaudeCodeExecutable");
    expect(handleOptions[0]).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  it("passes the agent's resolved model id to the SDK verbatim", async () => {
    const { deps, queryOptions, handleOptions } = makeRecordingDeps();
    const withOpus: OpenAiSessionDriverDeps = {
      ...deps,
      getAgentBaseOptions: async () => ({
        soulPrompt: "SOUL",
        model: "claude-opus-5-5",
        soulFp: "0123456789abcdef",
      }),
    };

    await collect(createOpenAiSessionDriver(withOpus).dispatch(baseInput()));

    expect(queryOptions[0]?.model).toBe("claude-opus-5-5");
    expect(handleOptions[0]?.model).toBe("claude-opus-5-5");
  });

  it("a failed drain rejects with UpstreamTurnError carrying the API error text", async () => {
    const apiError =
      "API Error: 400 Claude Code 2.1.140 does not support this model; " +
      "version 2.1.280 or newer is required.";
    // The CLI's shape for "turn completed, model call failed": is_error with
    // subtype "success" and the error text in `result`.
    const { deps, handleOptions } = makeRecordingDeps({
      type: "result",
      subtype: "success",
      is_error: true,
      result: apiError,
      session_id: "sess-failed",
    });

    const err = await collect(createOpenAiSessionDriver(deps).dispatch(baseInput())).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isUpstreamTurnError(err)).toBe(true);
    if (!isUpstreamTurnError(err)) return;
    expect(err.upstreamMessage).toBe(apiError);
    expect(err.subtype).toBe("success");
    expect(err.message).toContain("2.1.280 or newer is required");
    // The failed session is never handed to a persistent handle.
    expect(handleOptions).toHaveLength(0);
  });
});
