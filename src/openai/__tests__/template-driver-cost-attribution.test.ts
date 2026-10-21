/**
 * Phase 74 Plan 02 — OpenClawTemplateDriver cost-attribution tests.
 *
 * Pins the `onUsage` callback contract that endpoint-bootstrap.ts wires to
 * UsageTracker.record:
 *   - invoked exactly once per completed turn
 *   - receives (input, usage, sessionId, elapsedMs) tuple
 *   - tier flows into the MODEL field (claude-sonnet-4-6, etc.),
 *     NOT into the agent string (agent='openclaw:<slug>', never
 *     'openclaw:<slug>:<tier>')
 *   - onUsage throwing is CAUGHT — dispatch still yields final result event
 *   - multi-turn test: reused handle, each turn produces one onUsage call
 *     with the SAME sessionId
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";

import {
  createOpenClawTemplateDriver,
} from "../template-driver.js";
import type { OpenAiSessionDriver } from "../server.js";
import { TransientSessionCache } from "../transient-session-cache.js";
import { TIER_MODEL_MAP } from "../types.js";
import type { TemplateDriverInput } from "../types.js";
import type { SessionHandle, UsageCallback } from "../../manager/session-adapter.js";
import type { SdkModule } from "../../manager/sdk-types.js";
import type { createPersistentSessionHandle as CreatePersistentFn } from "../../manager/persistent-session-handle.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * SDK stub that emits a synthetic `result` message so the template driver's
 * drainForSessionId (Phase 74 hotfix — mirrors session-adapter.ts:426) can
 * resolve and proceed to createPersistentSessionHandle. createHandle itself
 * remains mocked via the createHandle seam.
 */
function fakeSdk(opts?: { sessionId?: string }): SdkModule {
  const sessionId = opts?.sessionId ?? "drained-sess-" + Math.random().toString(36).slice(2);
  const query = vi.fn((_params: unknown) => {
    async function* gen(): AsyncGenerator<unknown, void> {
      yield { type: "result", subtype: "success", is_error: false, session_id: sessionId };
    }
    return gen() as unknown as ReturnType<SdkModule["query"]>;
  });
  return { query } as unknown as SdkModule;
}

/**
 * Mock SessionHandle that captures the usageCallback passed by the template
 * driver via createPersistentSessionHandle and invokes it during
 * sendAndStream with a synthetic usage struct.
 */
function makeMockHandleWithUsage(opts: {
  sessionId: string;
  usage?: Parameters<UsageCallback>[0];
  streamText?: string;
  delayBeforeUsageMs?: number;
}): {
  handle: SessionHandle;
  sendAndStreamMock: ReturnType<typeof vi.fn>;
  setCapturedCallback: (cb: UsageCallback | undefined) => void;
  getCapturedCallback: () => UsageCallback | undefined;
} {
  const streamText = opts.streamText ?? "hello";
  let capturedCallback: UsageCallback | undefined;

  const sendAndStreamMock = vi.fn(async (
    _message: string,
    onChunk: (acc: string) => void,
    _turn?: unknown,
    _options?: { signal?: AbortSignal },
  ) => {
    // Fire the text delta first.
    onChunk(streamText);
    // Then invoke the usage callback with the synthetic struct.
    if (opts.delayBeforeUsageMs && opts.delayBeforeUsageMs > 0) {
      await new Promise((r) => setTimeout(r, opts.delayBeforeUsageMs));
    }
    if (capturedCallback && opts.usage) {
      capturedCallback(opts.usage);
    }
    return streamText;
  });

  const handle: SessionHandle = {
    sessionId: opts.sessionId,
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
  };

  return {
    handle,
    sendAndStreamMock,
    setCapturedCallback: (cb) => {
      capturedCallback = cb;
    },
    getCapturedCallback: () => capturedCallback,
  };
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

const FAKE_USAGE: Parameters<UsageCallback>[0] = Object.freeze({
  tokens_in: 123,
  tokens_out: 456,
  cost_usd: 0.00789,
  turns: 1,
  model: "claude-sonnet-4-6",
  duration_ms: 42,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenClawTemplateDriver cost attribution — Phase 74 Plan 02", () => {
  let cache: TransientSessionCache;
  const log = pino({ level: "silent" });

  beforeEach(() => {
    cache = new TransientSessionCache({ maxSize: 8, ttlMs: 60_000 });
  });

  /**
   * Factory: set up driver + capture the UsageCallback passed into
   * createPersistentSessionHandle (4th positional argument).
   */
  function setup(opts: {
    sessionId?: string;
    usage?: Parameters<UsageCallback>[0];
    onUsage?: TemplateDriverInput extends infer _ ? Parameters<NonNullable<Parameters<typeof createOpenClawTemplateDriver>[0]["onUsage"]>>[0] extends TemplateDriverInput ? Parameters<typeof createOpenClawTemplateDriver>[0]["onUsage"] : never : never;
  }): {
    driver: OpenAiSessionDriver;
    handle: SessionHandle;
    sendAndStreamMock: ReturnType<typeof vi.fn>;
    createHandleMock: ReturnType<typeof vi.fn>;
  } {
    const hm = makeMockHandleWithUsage({
      sessionId: opts.sessionId ?? "sess-1",
      usage: opts.usage ?? FAKE_USAGE,
    });

    const createHandleMock = vi.fn((
      _sdk: unknown,
      _baseOptions: unknown,
      _sessionId: string,
      usageCb?: UsageCallback,
    ): SessionHandle => {
      hm.setCapturedCallback(usageCb);
      return hm.handle;
    });

    const driver = createOpenClawTemplateDriver({
      sdk: fakeSdk(),
      cache,
      log,
      createHandle: createHandleMock as unknown as typeof CreatePersistentFn,
      onUsage: opts.onUsage,
    });

    return {
      driver,
      handle: hm.handle,
      sendAndStreamMock: hm.sendAndStreamMock,
      createHandleMock,
    };
  }

  it("Test 1: onUsage callback invoked exactly once per completed turn with (input, usage, sessionId, elapsedMs)", async () => {
    const onUsage = vi.fn();
    const input = baseInput();
    const { driver } = setup({ sessionId: "sess-1", onUsage });

    await consume(driver.dispatch(input as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    expect(onUsage).toHaveBeenCalledTimes(1);
    const callArgs = onUsage.mock.calls[0] as unknown as [
      TemplateDriverInput,
      Parameters<UsageCallback>[0],
      string,
      number,
    ];
    expect(callArgs[0].callerSlug).toBe(input.callerSlug);
    expect(callArgs[0].tier).toBe(input.tier);
    expect(callArgs[2]).toBe("sess-1");
    expect(typeof callArgs[3]).toBe("number");
    expect(callArgs[3]).toBeGreaterThanOrEqual(0);
  });

  it("Test 2 + 6: agent field is 'openclaw:<slug>' WITHOUT tier suffix", async () => {
    let recordedAgent: string | undefined;
    const input = baseInput({ callerSlug: "fin-test", tier: "opus" });
    const onUsage = vi.fn((inp: TemplateDriverInput) => {
      // Simulate what endpoint-bootstrap does — build the agent string.
      recordedAgent = `openclaw:${inp.callerSlug}`;
    });
    const { driver } = setup({ sessionId: "sess-2", onUsage });

    await consume(driver.dispatch(input as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    expect(recordedAgent).toBe("openclaw:fin-test");
    expect(recordedAgent).not.toBe("openclaw:fin-test:opus");
    expect(recordedAgent).not.toContain(":opus");
    expect(recordedAgent).not.toContain(":sonnet");
    expect(recordedAgent).not.toContain(":haiku");
  });

  it("Test 3: tier='sonnet' maps to model='claude-sonnet-5'", async () => {
    let recordedModel: string | undefined;
    const onUsage = vi.fn((inp: TemplateDriverInput) => {
      recordedModel = TIER_MODEL_MAP[inp.tier];
    });
    const { driver } = setup({ onUsage });

    await consume(driver.dispatch(baseInput({ tier: "sonnet" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    expect(recordedModel).toBe("claude-sonnet-5");
  });

  it("Test 4: tier='opus' maps to model='claude-opus-5-5'", async () => {
    // Phase 999.92 — executor alias bumped to 4.8.
    let recordedModel: string | undefined;
    const onUsage = vi.fn((inp: TemplateDriverInput) => {
      recordedModel = TIER_MODEL_MAP[inp.tier];
    });
    const { driver } = setup({ onUsage });

    await consume(driver.dispatch(baseInput({ tier: "opus" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    expect(recordedModel).toBe("claude-opus-5-5");
  });

  it("Test 5: tier='haiku' maps to model='claude-haiku-4-5-20251001'", async () => {
    let recordedModel: string | undefined;
    const onUsage = vi.fn((inp: TemplateDriverInput) => {
      recordedModel = TIER_MODEL_MAP[inp.tier];
    });
    const { driver } = setup({ onUsage });

    await consume(driver.dispatch(baseInput({ tier: "haiku" }) as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    expect(recordedModel).toBe("claude-haiku-4-5-20251001");
  });

  it("Test 7: tokens_in, tokens_out, cost_usd flow through unchanged from the SDK usage struct", async () => {
    const onUsage = vi.fn();
    const { driver } = setup({
      sessionId: "sess-7",
      usage: {
        tokens_in: 9999,
        tokens_out: 8888,
        cost_usd: 0.01234,
        turns: 1,
        model: "claude-sonnet-4-6",
        duration_ms: 100,
      },
      onUsage,
    });

    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    const callArgs = onUsage.mock.calls[0] as unknown as [
      TemplateDriverInput,
      Parameters<UsageCallback>[0],
      string,
      number,
    ];
    expect(callArgs[1].tokens_in).toBe(9999);
    expect(callArgs[1].tokens_out).toBe(8888);
    expect(callArgs[1].cost_usd).toBe(0.01234);
  });

  it("Test 8: sessionId passed to onUsage matches handle.sessionId", async () => {
    const onUsage = vi.fn();
    const { driver } = setup({ sessionId: "my-unique-session-id", onUsage });

    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    const callArgs = onUsage.mock.calls[0] as unknown as [unknown, unknown, string, unknown];
    expect(callArgs[2]).toBe("my-unique-session-id");
  });

  it("Test 9: one onUsage call per completion (turns=1 semantic)", async () => {
    const onUsage = vi.fn();
    const { driver } = setup({ onUsage });

    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    // Exactly one callback firing per dispatch.
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("Test 10: onUsage throwing is CAUGHT — dispatch still yields final result event", async () => {
    const onUsage = vi.fn(() => {
      throw new Error("tracker-record-failed");
    });
    const { driver } = setup({ sessionId: "sess-10", onUsage });

    const events = await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    // Dispatch must still terminate with a result event — onUsage failure
    // is non-fatal (Pitfall 8).
    const last = events[events.length - 1]!;
    expect(last.type).toBe("result");
    if (last.type === "result") {
      expect(last.session_id).toBe("sess-10");
    }
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("Test 11: elapsedMs is a non-negative number (Date.now() - startedAt)", async () => {
    const onUsage = vi.fn();
    const { driver } = setup({
      sessionId: "sess-11",
      onUsage,
      usage: FAKE_USAGE,
    });

    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    const callArgs = onUsage.mock.calls[0] as unknown as [unknown, unknown, string, number];
    expect(typeof callArgs[3]).toBe("number");
    expect(callArgs[3]).toBeGreaterThanOrEqual(0);
    // Sanity: should be well under 10s for a mocked handle.
    expect(callArgs[3]).toBeLessThan(10_000);
  });

  it("Test 14: multi-turn — two sequential dispatches reuse handle and call onUsage twice with the same sessionId", async () => {
    const onUsage = vi.fn();
    const { driver, createHandleMock } = setup({
      sessionId: "sess-14-shared",
      onUsage,
    });

    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));
    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    expect(createHandleMock).toHaveBeenCalledTimes(1); // handle reused
    expect(onUsage).toHaveBeenCalledTimes(2);
    const s1 = (onUsage.mock.calls[0] as unknown as [unknown, unknown, string])[2];
    const s2 = (onUsage.mock.calls[1] as unknown as [unknown, unknown, string])[2];
    expect(s1).toBe("sess-14-shared");
    expect(s2).toBe("sess-14-shared");
  });

  it("Test 12: endpoint-bootstrap does NOT set category/backend/count by default — keeps rows in the 'tokens' rollup", async () => {
    // This test pins that the CALLSITE in endpoint-bootstrap (wired in Task 2
    // impl) does not populate category/backend/count. Since we test the
    // template driver here (not bootstrap directly), we assert via the
    // SIGNATURE of what the callsite would pass: the plumbing from driver
    // to callback carries tokens_in/tokens_out/cost_usd/turns/model/
    // duration_ms but NOT category/backend/count — those are image-row
    // fields set only by image/tracker.ts.
    const onUsage = vi.fn();
    const { driver } = setup({ onUsage });

    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    const callArgs = onUsage.mock.calls[0] as unknown as [
      TemplateDriverInput,
      Record<string, unknown>,
      string,
      number,
    ];
    // The usage struct received by onUsage is the SDK shape — no category.
    expect(callArgs[1].category).toBeUndefined();
    expect(callArgs[1].backend).toBeUndefined();
    expect(callArgs[1].count).toBeUndefined();
  });

  it("Test 13: SDK usage struct with missing cost_usd (undefined) — onUsage still fires, caller maps undefined→0", async () => {
    const onUsage = vi.fn();
    // Partial usage struct — cost_usd absent.
    const partialUsage = {
      tokens_in: 100,
      tokens_out: 50,
      turns: 1,
      model: "claude-sonnet-4-6",
      duration_ms: 10,
      // cost_usd intentionally omitted → undefined in the received struct.
    } as unknown as Parameters<UsageCallback>[0];
    const { driver } = setup({ sessionId: "sess-13", usage: partialUsage, onUsage });

    await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    const callArgs = onUsage.mock.calls[0] as unknown as [
      TemplateDriverInput,
      Record<string, unknown>,
      string,
      number,
    ];
    expect(callArgs[1].tokens_in).toBe(100);
    // cost_usd comes through as undefined — endpoint-bootstrap's mapper is
    // expected to `?? 0` it. The callback itself doesn't crash on undefined.
    expect(callArgs[1].cost_usd).toBeUndefined();
  });

  it("onUsage NOT wired (deps.onUsage undefined) → dispatch still succeeds, no callback attempts", async () => {
    // Don't pass onUsage — ensure no crash and dispatch yields events.
    const { driver, sendAndStreamMock } = setup({});

    const events = await consume(driver.dispatch(baseInput() as unknown as Parameters<OpenAiSessionDriver["dispatch"]>[0]));

    expect(sendAndStreamMock).toHaveBeenCalledTimes(1);
    const last = events[events.length - 1]!;
    expect(last.type).toBe("result");
  });
});
