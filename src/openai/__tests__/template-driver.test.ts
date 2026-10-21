/**
 * Phase 74 Plan 01 — OpenClawTemplateDriver unit tests.
 *
 * All SDK + handle interactions are mocked. Pins the invariants that keep
 * the template path safe + isolated:
 *   - systemPrompt passed as STRING (Pitfall 2)
 *   - cwd === CLAWCODE_TRANSIENT_CWD (Pitfall 4)
 *   - mcpServers:{}, settingSources:[] — caller cannot mount ClawCode MCPs
 *   - handle reuse on identical (bearer, slug, soulFp, tier)
 *   - handle re-creation on ANY of the four-component key change
 *   - AbortSignal flows through to handle.sendAndStream unchanged
 *   - createHandle throwing → iterator rejects on first next()
 *   - driver shape satisfies OpenAiSessionDriver at compile-time
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";

import {
  createOpenClawTemplateDriver,
  CLAWCODE_TRANSIENT_CWD,
} from "../template-driver.js";
import type { OpenAiSessionDriver } from "../server.js";
import { TransientSessionCache } from "../transient-session-cache.js";
import { TIER_MODEL_MAP, type TemplateDriverInput } from "../types.js";
import { isUpstreamTurnError } from "../upstream-error.js";
import type { SessionHandle, UsageCallback } from "../../manager/session-adapter.js";
import type { SdkModule, SdkQueryOptions } from "../../manager/sdk-types.js";
import type { createPersistentSessionHandle as CreatePersistentFn } from "../../manager/persistent-session-handle.js";

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

/**
 * Minimal SDK module stub. Phase 74 hotfix — the template driver NOW calls
 * `sdk.query({ prompt: "Session initialized.", options })` as an initial
 * drain step to obtain a real SDK-assigned session_id before handing off to
 * createPersistentSessionHandle (mirrors session-adapter.ts:426 pattern).
 * Without this the persistent handle's `resume: <bogus-uuid>` crashes the
 * Claude CLI subprocess with `error_during_execution`.
 *
 * Tests that go through createHandle must therefore provide a query() stub
 * that yields a `result` message with a session_id so drainForSessionId can
 * resolve. createHandle itself is still mocked; the drain query is the only
 * real sdk.query() path the driver exercises.
 *
 * `queryResult` lets tests pin a specific session_id (for assertions on
 * sessionId propagation). `throwOnQuery` lets tests exercise the drain
 * failure path.
 */
function fakeSdk(opts?: {
  sessionId?: string;
  throwOnQuery?: Error;
  emitNoSessionId?: boolean;
}): SdkModule {
  const sessionId = opts?.sessionId ?? "drained-sess-" + Math.random().toString(36).slice(2);
  const query = vi.fn((_params: unknown) => {
    if (opts?.throwOnQuery) throw opts.throwOnQuery;
    async function* gen(): AsyncGenerator<unknown, void> {
      // Emit a single result message so drainForSessionId can extract the id.
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: opts?.emitNoSessionId ? undefined : sessionId,
      };
    }
    const g = gen();
    // drainForSessionId only iterates — .interrupt/.close/etc are not called
    // on the drain query. Return the plain generator; cast so it satisfies
    // SdkQuery's extra method shape without implementing them.
    return g as unknown as ReturnType<SdkModule["query"]>;
  });
  return { query } as unknown as SdkModule;
}

/**
 * Mock SessionHandle whose sendAndStream emits one text delta + resolves.
 * The delta is pushed synchronously via the onChunk callback so event
 * ordering is deterministic.
 */
function makeMockHandle(opts?: {
  sessionId?: string;
  streamText?: string;
  rejectWith?: Error;
  perChunkAbortCheck?: boolean;
}): SessionHandle & { readonly sendAndStreamMock: ReturnType<typeof vi.fn> } {
  const sessionId = opts?.sessionId ?? "sess-" + Math.random().toString(36).slice(2);
  const streamText = opts?.streamText ?? "hello world";

  const sendAndStreamMock = vi.fn(async (_message: string, onChunk: (acc: string) => void, _turn?: unknown, options?: { signal?: AbortSignal }) => {
    if (opts?.rejectWith) throw opts.rejectWith;
    // Emit the text in a single callback for simplicity. Tests that care
    // about per-chunk streaming can override sendAndStream.
    if (options?.signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    onChunk(streamText);
    return streamText;
  });

  const h: SessionHandle & { sendAndStreamMock: ReturnType<typeof vi.fn> } = {
    sessionId,
    send: vi.fn().mockResolvedValue(undefined),
    sendAndCollect: vi.fn().mockResolvedValue(""),
    sendAndStream: sendAndStreamMock as unknown as SessionHandle["sendAndStream"],
    close: vi.fn().mockResolvedValue(undefined) as unknown as SessionHandle["close"],
    onError: vi.fn(),
    onEnd: vi.fn(),
    setEffort: vi.fn(),
    getEffort: vi.fn().mockReturnValue("low") as unknown as SessionHandle["getEffort"],
    // Phase 86 MODEL-03 — required by SessionHandle surface.
    setModel: vi.fn(),
    getModel: vi.fn().mockReturnValue(undefined) as unknown as SessionHandle["getModel"],
    // Phase 87 CMD-02 — required by SessionHandle surface.
    setPermissionMode: vi.fn(),
    getPermissionMode: vi.fn().mockReturnValue("default") as unknown as SessionHandle["getPermissionMode"],
    interrupt: vi.fn(),
    hasActiveTurn: vi.fn().mockReturnValue(false) as unknown as SessionHandle["hasActiveTurn"],
    // Phase 85 TOOL-01 — required by SessionHandle surface.
    getMcpState: vi.fn().mockReturnValue(new Map()) as unknown as SessionHandle["getMcpState"],
    setMcpState: vi.fn(),
    // Phase 96 D-CONTEXT — required by SessionHandle surface.
    getFsCapabilitySnapshot: vi.fn().mockReturnValue(new Map()) as unknown as SessionHandle["getFsCapabilitySnapshot"],
    setFsCapabilitySnapshot: vi.fn(),
    // Phase 103 OBS-04 — required by SessionHandle surface.
    getRateLimitTracker: vi.fn().mockReturnValue(undefined) as unknown as SessionHandle["getRateLimitTracker"],
    setRateLimitTracker: vi.fn(),
    // Phase 94 Plan 02 TOOL-03 — required by SessionHandle surface.
    getFlapHistory: vi.fn().mockReturnValue(new Map()) as unknown as SessionHandle["getFlapHistory"],
    // Phase 94 Plan 03 — required by SessionHandle surface.
    getRecoveryAttemptHistory: vi.fn().mockReturnValue(new Map()) as unknown as SessionHandle["getRecoveryAttemptHistory"],
    // Phase 87 CMD-01 — required by SessionHandle surface (empty default).
    getSupportedCommands: vi.fn().mockResolvedValue([]) as unknown as SessionHandle["getSupportedCommands"],
    getSupportedModels: vi.fn().mockResolvedValue([]) as unknown as SessionHandle["getSupportedModels"],
    sendAndStreamMock,
  };
  return h;
}

function baseInput(overrides?: Partial<TemplateDriverInput>): TemplateDriverInput {
  return {
    agentName: "openclaw:fin-test",
    keyHash: "K1".padEnd(64, "0"),
    callerSlug: "fin-test",
    tier: "sonnet",
    soulPrompt: "SOUL",
    soulFp: "abc",
    lastUserMessage: "hi",
    clientSystemAppend: null,
    tools: null,
    toolChoice: null,
    toolResults: [],
    signal: new AbortController().signal,
    xRequestId: "x",
    ...overrides,
  };
}

async function consume<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenClawTemplateDriver", () => {
  let cache: TransientSessionCache;
  const log = pino({ level: "silent" });

  beforeEach(() => {
    cache = new TransientSessionCache({ maxSize: 8, ttlMs: 60_000 });
  });

  it("Test 10: driver shape satisfies OpenAiSessionDriver at compile + runtime", () => {
    const handle = makeMockHandle();
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    const _assert: OpenAiSessionDriver = driver; // compile-time check
    void _assert;
    expect(typeof driver.dispatch).toBe("function");
  });

  it("Test 1: first dispatch creates a persistent handle with STRING systemPrompt + fixed cwd + sonnet model", async () => {
    const handle = makeMockHandle();
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });

    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    expect(createHandle).toHaveBeenCalledTimes(1);
    const createArgs = (createHandle as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [SdkModule, SdkQueryOptions, string, UsageCallback | undefined];
    const baseOptions = createArgs[1];
    expect(typeof baseOptions.systemPrompt).toBe("string");
    expect(baseOptions.systemPrompt).toBe("SOUL");
    expect(baseOptions.cwd).toBe(CLAWCODE_TRANSIENT_CWD);
    expect(baseOptions.model).toBe("claude-sonnet-5");
    expect(baseOptions.permissionMode).toBe("bypassPermissions");
    expect(baseOptions.mcpServers).toEqual({});
    expect(baseOptions.settingSources).toEqual(["project"]);
  });

  it("Test 2: second dispatch with same cache key reuses the handle (createHandle called once)", async () => {
    const handle = makeMockHandle();
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    expect(createHandle).toHaveBeenCalledTimes(1);
    expect(handle.sendAndStreamMock).toHaveBeenCalledTimes(2);
  });

  it("Test 3: different soulFp triggers a NEW persistent handle", async () => {
    const h1 = makeMockHandle({ sessionId: "s1" });
    const h2 = makeMockHandle({ sessionId: "s2" });
    const createHandle = vi
      .fn()
      .mockImplementationOnce(() => h1)
      .mockImplementationOnce(() => h2) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    await consume(driver.dispatch(baseInput({ soulFp: "abc" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    await consume(driver.dispatch(baseInput({ soulFp: "xyz" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    expect(createHandle).toHaveBeenCalledTimes(2);
  });

  it("Test 4: different tier triggers new handle and maps to the correct model", async () => {
    const h1 = makeMockHandle();
    const h2 = makeMockHandle();
    const createHandle = vi
      .fn()
      .mockImplementationOnce(() => h1)
      .mockImplementationOnce(() => h2) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    await consume(driver.dispatch(baseInput({ tier: "sonnet" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    await consume(driver.dispatch(baseInput({ tier: "opus" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    expect(createHandle).toHaveBeenCalledTimes(2);
    const firstOpts = ((createHandle as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [SdkModule, SdkQueryOptions])[1];
    const secondOpts = ((createHandle as unknown as ReturnType<typeof vi.fn>).mock.calls[1] as unknown as [SdkModule, SdkQueryOptions])[1];
    // Track the catalog rather than a literal id — the literal went stale at
    // the Opus 5.5 repin (it still said claude-opus-5).
    expect(firstOpts.model).toBe(TIER_MODEL_MAP.sonnet);
    expect(secondOpts.model).toBe(TIER_MODEL_MAP.opus);
  });

  it("different bearer key hash triggers new handle (isolation across tenants)", async () => {
    const h1 = makeMockHandle();
    const h2 = makeMockHandle();
    const createHandle = vi
      .fn()
      .mockImplementationOnce(() => h1)
      .mockImplementationOnce(() => h2) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    await consume(driver.dispatch(baseInput({ keyHash: "A".padEnd(64, "0") }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    await consume(driver.dispatch(baseInput({ keyHash: "B".padEnd(64, "0") }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    expect(createHandle).toHaveBeenCalledTimes(2);
  });

  it("different callerSlug triggers new handle", async () => {
    const h1 = makeMockHandle();
    const h2 = makeMockHandle();
    const createHandle = vi
      .fn()
      .mockImplementationOnce(() => h1)
      .mockImplementationOnce(() => h2) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    await consume(driver.dispatch(baseInput({ callerSlug: "fin-test" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    await consume(driver.dispatch(baseInput({ callerSlug: "other" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    expect(createHandle).toHaveBeenCalledTimes(2);
  });

  it("Test 5: dispatch yields a content_block_delta followed by a result event", async () => {
    const handle = makeMockHandle({ streamText: "hello", sessionId: "s-1" });
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    const events = await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    // Expect: content_block_start, content_block_delta(text="hello"), result
    expect(events.length).toBeGreaterThanOrEqual(2);
    const last = events[events.length - 1]!;
    expect(last.type).toBe("result");
    if (last.type === "result") {
      expect(last.session_id).toBe("s-1");
    }
    const hasDelta = events.some((e) => {
      return (
        e.type === "stream_event" &&
        e.event.type === "content_block_delta" &&
        e.event.delta.type === "text_delta" &&
        e.event.delta.text === "hello"
      );
    });
    expect(hasDelta).toBe(true);
  });

  it("Test 6: AbortSignal is passed through to handle.sendAndStream unchanged", async () => {
    const handle = makeMockHandle();
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    const ac = new AbortController();
    await consume(driver.dispatch(baseInput({ signal: ac.signal }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    expect(handle.sendAndStreamMock).toHaveBeenCalledTimes(1);
    const callArgs = handle.sendAndStreamMock.mock.calls[0] as unknown as [string, unknown, unknown, { signal?: AbortSignal }];
    expect(callArgs[0]).toBe("hi"); // lastUserMessage
    const opts = callArgs[3];
    expect(opts?.signal).toBe(ac.signal);
  });

  it("Test 7: aborting before dispatch propagates an AbortError through the iterator", async () => {
    const handle = makeMockHandle();
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      consume(driver.dispatch(baseInput({ signal: ac.signal }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0])),
    ).rejects.toThrow(/abort/i);
  });

  it("Test 8: handle.sendAndStream rejecting with a non-abort error propagates via iterator error channel", async () => {
    const handle = makeMockHandle({ rejectWith: new Error("boom") });
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    await expect(
      consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0])),
    ).rejects.toThrow("boom");
  });

  it("Test 9: createHandle throwing synchronously propagates on first next()", async () => {
    const createHandle = vi.fn().mockImplementation(() => {
      throw new Error("sdk-init-failed");
    }) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    await expect(
      consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0])),
    ).rejects.toThrow("sdk-init-failed");
    // Cache must NOT retain a failed entry.
    expect(cache.size()).toBe(0);
  });

  it("haiku tier maps to claude-haiku-4-5-20251001", async () => {
    const handle = makeMockHandle();
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    await consume(driver.dispatch(baseInput({ tier: "haiku" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    const opts = ((createHandle as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [SdkModule, SdkQueryOptions])[1];
    expect(opts.model).toBe("claude-haiku-4-5-20251001");
  });

  it("ensureCwd is called with CLAWCODE_TRANSIENT_CWD on first handle materialization, not on reuse", async () => {
    const ensureCwd = vi.fn();
    const handle = makeMockHandle();
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
      ensureCwd,
    });
    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    expect(ensureCwd).toHaveBeenCalledTimes(1);
    expect(ensureCwd).toHaveBeenCalledWith(CLAWCODE_TRANSIENT_CWD);
  });

  it("baseOptions.systemPrompt is NEVER wrapped as a preset object form", async () => {
    const handle = makeMockHandle();
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    await consume(driver.dispatch(baseInput({ soulPrompt: "CALLER SOUL PROMPT" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    const opts = ((createHandle as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [SdkModule, SdkQueryOptions])[1];
    // Pitfall 2 guard — must be a plain string, NOT an object.
    expect(typeof opts.systemPrompt).toBe("string");
    expect(opts.systemPrompt).toBe("CALLER SOUL PROMPT");
    // Belt-and-suspenders: the preset object form would have `type` + `preset` keys.
    expect((opts.systemPrompt as unknown as { type?: unknown }).type).toBeUndefined();
    expect((opts.systemPrompt as unknown as { preset?: unknown }).preset).toBeUndefined();
  });

  it("empty SOUL prompt is still passed through (empty string, not object)", async () => {
    const handle = makeMockHandle();
    const createHandle = vi.fn().mockReturnValue(handle) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle,
    });
    await consume(driver.dispatch(baseInput({ soulPrompt: "" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    const opts = ((createHandle as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [SdkModule, SdkQueryOptions])[1];
    expect(opts.systemPrompt).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Binary pin + upstream errors (2026-09-23 endpoint outage) — the template
// driver had the same two holes as the native driver: it spawned the
// SDK-bundled Claude Code 2.1.140 and discarded the API error text.
// ---------------------------------------------------------------------------

describe("OpenClawTemplateDriver — Claude binary pin + upstream errors", () => {
  const PINNED_BIN = "/opt/clawcode/claude-pin/claude";
  const log = pino({ level: "silent" });
  const asDispatchInput = (i: TemplateDriverInput) =>
    i as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** SDK stub whose drain yields `result` and records the options it got. */
  function recordingSdk(result: Record<string, unknown>) {
    const queryOptions: Array<Record<string, unknown>> = [];
    const query = vi.fn((params: { options?: Record<string, unknown> }) => {
      queryOptions.push(params.options ?? {});
      async function* gen(): AsyncGenerator<unknown, void> {
        yield result;
      }
      return gen() as unknown as ReturnType<SdkModule["query"]>;
    });
    return { sdk: { query } as unknown as SdkModule, queryOptions };
  }

  // 999.169 — the SDK chokepoint pins every query; the driver must not.
  it("leaves the pin to the SDK chokepoint on the drain AND the persistent handle", async () => {
    vi.stubEnv("CLAWCODE_CLAUDE_BIN", PINNED_BIN);
    const { sdk, queryOptions } = recordingSdk({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sess-pin",
    });
    const createHandle = vi.fn().mockReturnValue(makeMockHandle()) as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk,
      cache: new TransientSessionCache({ maxSize: 8, ttlMs: 60_000 }),
      log,
      createHandle,
    });

    await consume(driver.dispatch(asDispatchInput(baseInput())));

    expect(queryOptions[0]).not.toHaveProperty("pathToClaudeCodeExecutable");
    const handleOpts = ((createHandle as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [SdkModule, SdkQueryOptions])[1];
    expect(handleOpts).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  it("a failed drain rejects with UpstreamTurnError carrying the API error text", async () => {
    const apiError =
      "API Error: 400 Claude Code 2.1.140 does not support this model; " +
      "version 2.1.280 or newer is required.";
    const { sdk } = recordingSdk({
      type: "result",
      subtype: "success",
      is_error: true,
      result: apiError,
      session_id: "sess-failed",
    });
    const createHandle = vi.fn() as unknown as typeof CreatePersistentFn;
    const driver = createOpenClawTemplateDriver({
      sdk,
      cache: new TransientSessionCache({ maxSize: 8, ttlMs: 60_000 }),
      log,
      createHandle,
    });

    const err = await consume(driver.dispatch(asDispatchInput(baseInput()))).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isUpstreamTurnError(err)).toBe(true);
    if (!isUpstreamTurnError(err)) return;
    expect(err.upstreamMessage).toBe(apiError);
    expect(err.message).toContain("template-driver: initial drain query failed (success)");
    expect(createHandle).not.toHaveBeenCalled();
  });
});
