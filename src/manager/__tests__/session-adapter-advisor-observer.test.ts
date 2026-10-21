/**
 * Plan 117-04 T08 — native advisor observer integration tests.
 *
 * Drives the legacy test-only `iterateWithTracing` path (via
 * `createTracedSessionHandle`) with mocked `SdkStreamMessage` sequences
 * that include `server_tool_use{name:"advisor"}`, `advisor_tool_result`,
 * and `usage.iterations[]` carrying `advisor_message` entries. Asserts
 * the observer wiring fires the documented events + budget calls.
 *
 * The PRODUCTION path (createPersistentSessionHandle) implements the
 * same observer contract — same code shape, same try/catch invariants,
 * same event names. Both paths import the same `AdvisorObserverConfig`
 * type and call into the same `EventEmitter` + `AdvisorBudget`
 * instances, so a test against either path provides the same regression
 * value. The traced-handle path was chosen here because it composes
 * cleanly with vitest's mocked SDK iterator pattern that already exists
 * for the session-adapter tracing tests (see `session-adapter.test.ts`
 * for the precedent we mirror).
 *
 * Coverage (per Plan 117-04 §Tasks T08 + RESEARCH §5 / §13.1–§13.4):
 *   A. `advisor:invoked` emitted exactly once with `{agent, turnId,
 *      toolUseId: "su_01"}` on `server_tool_use{name:"advisor"}`.
 *      NO `questionPreview` (RESEARCH §13.1 — `server_tool_use.input`
 *      is always empty `{}`; we deliberately do NOT extract a
 *      `question` field).
 *   B. `advisor:resulted` emitted exactly once with
 *      `kind: "advisor_result"`, `text: "Refactor first..."`,
 *      `toolUseId: "su_01"` for the success variant.
 *   C. Variant `advisor_redacted_result` → `:resulted` emitted with
 *      `kind: "advisor_redacted_result"`, `text: undefined`,
 *      `errorCode: undefined` (the opaque `encrypted_content` blob
 *      is NOT decoded — RESEARCH §13.4 mandate).
 *   D. Variant `advisor_tool_result_error` → `:resulted` emitted with
 *      `kind: "advisor_tool_result_error"`,
 *      `errorCode: "max_uses_exceeded"`, `text: undefined`.
 *   E. Non-advisor `server_tool_use` (`name: "web_search"`) → NO
 *      advisor events emitted (no false positives).
 *   F. Terminal `result.usage.iterations` parser → `recordCall`
 *      invoked N times where N = count of `type: "advisor_message"`
 *      entries. Covers: 1 entry → 1 call; 2 entries → 2 calls;
 *      mixed `message` + `advisor_message` → only advisor counted;
 *      `iterations: null` / missing → 0 calls.
 *   G. Listener that throws does NOT propagate / break the message
 *      path (the emit is wrapped in try/catch; the SDK iteration
 *      continues and `sendAndStream` resolves normally).
 *
 * Fixture pattern derived from RESEARCH §5 Plan 117-04. The mocked
 * `SdkStreamMessage` shapes intentionally use the SAME field names
 * the production code reads (per RESEARCH §13.3 — both
 * `server_tool_use` and `advisor_tool_result` arrive in the SAME
 * assistant message's `content[]`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { createTracedSessionHandle } from "../session-adapter.js";
import type {
  AdvisorInvokedEvent,
  AdvisorResultedEvent,
} from "../../advisor/types.js";

function makeSdkStream(messages: ReadonlyArray<unknown>) {
  async function* gen() {
    for (const m of messages) {
      yield m;
    }
  }
  const query: { [k: string]: unknown } = gen() as unknown as {
    [k: string]: unknown;
  };
  query.interrupt = vi.fn();
  query.close = vi.fn();
  query.streamInput = vi.fn();
  query.mcpServerStatus = vi.fn();
  query.setMcpServers = vi.fn();
  return query as unknown as ReturnType<
    typeof Object.assign
  >;
}

/** Build a minimal AdvisorBudget-like mock with vi.fn spies. */
function makeMockBudget() {
  return {
    canCall: vi.fn().mockReturnValue(true),
    recordCall: vi.fn(),
    getRemaining: vi.fn().mockReturnValue(9),
  };
}

describe("session-adapter advisor observer (T03 + T04)", () => {
  let mockSdk: { query: ReturnType<typeof vi.fn> };
  let advisorEvents: EventEmitter;
  let budget: ReturnType<typeof makeMockBudget>;
  let invokedEvents: AdvisorInvokedEvent[];
  let resultedEvents: AdvisorResultedEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSdk = { query: vi.fn() };
    advisorEvents = new EventEmitter();
    budget = makeMockBudget();
    invokedEvents = [];
    resultedEvents = [];
    advisorEvents.on("advisor:invoked", (e: AdvisorInvokedEvent) => {
      invokedEvents.push(e);
    });
    advisorEvents.on("advisor:resulted", (e: AdvisorResultedEvent) => {
      resultedEvents.push(e);
    });
  });

  function makeHandle() {
    return (createTracedSessionHandle as unknown as (opts: unknown) => {
      sendAndStream(
        msg: string,
        onChunk: (s: string) => void,
      ): Promise<string>;
    })({
      sdk: mockSdk,
      baseOptions: {},
      sessionId: "sess-1",
      advisorObserver: {
        agentName: "test-agent",
        advisorEvents,
        // The mock duck-types AdvisorBudget — only `recordCall` is
        // actually invoked from the observer. canCall / getRemaining
        // exist so the structural type matches; canCall is consulted
        // only by the session-config gate (T05), not by the observer.
        advisorBudget: budget as unknown as import("../../usage/advisor-budget.js").AdvisorBudget,
      },
    });
  }

  it("A: emits advisor:invoked on server_tool_use{name:'advisor'} with toolUseId only", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "assistant",
          parent_tool_use_id: null,
          uuid: "msg-uuid-1",
          message: {
            content: [
              { type: "text", text: "Let me think." },
              {
                type: "server_tool_use",
                id: "su_01",
                name: "advisor",
                input: {},
              },
              {
                type: "advisor_tool_result",
                tool_use_id: "su_01",
                content: {
                  type: "advisor_result",
                  text: "Refactor first — the surface change is small.",
                },
              },
              { type: "text", text: "Per advisor, I'll refactor first." },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: { iterations: [] },
        },
      ]),
    );

    const handle = makeHandle();
    await handle.sendAndStream("prompt", () => undefined);

    expect(invokedEvents).toHaveLength(1);
    expect(invokedEvents[0]).toEqual({
      agent: "test-agent",
      turnId: "msg-uuid-1",
      toolUseId: "su_01",
    });
    // RESEARCH §13.1 — the executor's input is always empty {}. We
    // deliberately must NOT extract a questionPreview field.
    expect(invokedEvents[0]).not.toHaveProperty("questionPreview");
  });

  it("B: emits advisor:resulted with kind='advisor_result' and text on success", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "assistant",
          parent_tool_use_id: null,
          uuid: "msg-uuid-1",
          message: {
            content: [
              {
                type: "server_tool_use",
                id: "su_01",
                name: "advisor",
                input: {},
              },
              {
                type: "advisor_tool_result",
                tool_use_id: "su_01",
                content: {
                  type: "advisor_result",
                  text: "Refactor first — the surface change is small.",
                },
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: { iterations: [] },
        },
      ]),
    );

    const handle = makeHandle();
    await handle.sendAndStream("prompt", () => undefined);

    expect(resultedEvents).toHaveLength(1);
    expect(resultedEvents[0]).toEqual({
      agent: "test-agent",
      turnId: "msg-uuid-1",
      toolUseId: "su_01",
      kind: "advisor_result",
      text: "Refactor first — the surface change is small.",
      errorCode: undefined,
    });
  });

  it("C: advisor_redacted_result → kind set; text/errorCode undefined", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "assistant",
          parent_tool_use_id: null,
          uuid: "msg-uuid-2",
          message: {
            content: [
              {
                type: "server_tool_use",
                id: "su_02",
                name: "advisor",
                input: {},
              },
              {
                type: "advisor_tool_result",
                tool_use_id: "su_02",
                content: {
                  type: "advisor_redacted_result",
                  encrypted_content: "<opaque-blob>",
                },
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: { iterations: [] },
        },
      ]),
    );

    const handle = makeHandle();
    await handle.sendAndStream("prompt", () => undefined);

    expect(resultedEvents).toHaveLength(1);
    expect(resultedEvents[0]!.kind).toBe("advisor_redacted_result");
    expect(resultedEvents[0]!.text).toBeUndefined();
    expect(resultedEvents[0]!.errorCode).toBeUndefined();
  });

  it("D: advisor_tool_result_error → kind + errorCode propagated", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "assistant",
          parent_tool_use_id: null,
          uuid: "msg-uuid-3",
          message: {
            content: [
              {
                type: "server_tool_use",
                id: "su_03",
                name: "advisor",
                input: {},
              },
              {
                type: "advisor_tool_result",
                tool_use_id: "su_03",
                content: {
                  type: "advisor_tool_result_error",
                  error_code: "max_uses_exceeded",
                },
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: { iterations: [] },
        },
      ]),
    );

    const handle = makeHandle();
    await handle.sendAndStream("prompt", () => undefined);

    expect(resultedEvents).toHaveLength(1);
    expect(resultedEvents[0]!.kind).toBe("advisor_tool_result_error");
    expect(resultedEvents[0]!.errorCode).toBe("max_uses_exceeded");
    expect(resultedEvents[0]!.text).toBeUndefined();
  });

  it("E: non-advisor server_tool_use (web_search) emits no advisor events", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "assistant",
          parent_tool_use_id: null,
          uuid: "msg-uuid-4",
          message: {
            content: [
              {
                type: "server_tool_use",
                id: "su_other",
                name: "web_search",
                input: { query: "anthropic advisor" },
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: { iterations: [] },
        },
      ]),
    );

    const handle = makeHandle();
    await handle.sendAndStream("prompt", () => undefined);

    expect(invokedEvents).toHaveLength(0);
    expect(resultedEvents).toHaveLength(0);
  });

  it("F1: usage.iterations [advisor_message] → recordCall invoked once", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: {
            iterations: [
              {
                type: "advisor_message",
                input_tokens: 100,
                output_tokens: 50,
              },
            ],
          },
        },
      ]),
    );

    const handle = makeHandle();
    await handle.sendAndStream("prompt", () => undefined);

    expect(budget.recordCall).toHaveBeenCalledTimes(1);
    expect(budget.recordCall).toHaveBeenCalledWith("test-agent");
  });

  it("F2: two advisor_message iterations → recordCall invoked twice", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: {
            iterations: [
              { type: "advisor_message", input_tokens: 100, output_tokens: 50 },
              { type: "advisor_message", input_tokens: 80, output_tokens: 40 },
            ],
          },
        },
      ]),
    );

    const handle = makeHandle();
    await handle.sendAndStream("prompt", () => undefined);

    expect(budget.recordCall).toHaveBeenCalledTimes(2);
  });

  it("F3: mixed iterations — only advisor_message counted", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: {
            iterations: [
              { type: "message", input_tokens: 1500, output_tokens: 50 },
              { type: "advisor_message", input_tokens: 800, output_tokens: 100 },
              { type: "message", input_tokens: 1700, output_tokens: 150 },
            ],
          },
        },
      ]),
    );

    const handle = makeHandle();
    await handle.sendAndStream("prompt", () => undefined);

    expect(budget.recordCall).toHaveBeenCalledTimes(1);
  });

  it("F4: iterations:null → recordCall NOT invoked (graceful degradation)", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: { iterations: null },
        },
      ]),
    );

    const handle = makeHandle();
    await handle.sendAndStream("prompt", () => undefined);

    expect(budget.recordCall).not.toHaveBeenCalled();
  });

  it("F5: usage.iterations missing entirely → recordCall NOT invoked", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: {},
        },
      ]),
    );

    const handle = makeHandle();
    await handle.sendAndStream("prompt", () => undefined);

    expect(budget.recordCall).not.toHaveBeenCalled();
  });

  it("G: listener that throws does NOT break the message path", async () => {
    // Replace the harmless capturing listener with one that throws.
    advisorEvents.removeAllListeners("advisor:invoked");
    advisorEvents.on("advisor:invoked", () => {
      throw new Error("listener boom");
    });

    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "assistant",
          parent_tool_use_id: null,
          uuid: "msg-uuid-G",
          message: {
            content: [
              {
                type: "server_tool_use",
                id: "su_G",
                name: "advisor",
                input: {},
              },
              {
                type: "advisor_tool_result",
                tool_use_id: "su_G",
                content: {
                  type: "advisor_result",
                  text: "answer text",
                },
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: { iterations: [] },
        },
      ]),
    );

    const handle = makeHandle();
    // The whole point of try/catch around emit() is that the SDK
    // stream iteration completes normally even if a listener throws.
    await expect(
      handle.sendAndStream("prompt", () => undefined),
    ).resolves.toBeDefined();
    // The `:resulted` listener (still attached) saw its event, proving
    // iteration continued past the `:invoked` throw.
    expect(resultedEvents).toHaveLength(1);
  });

  it("H: no advisor observer wired → no events, no budget calls (back-compat)", async () => {
    mockSdk.query.mockReturnValueOnce(
      makeSdkStream([
        {
          type: "assistant",
          parent_tool_use_id: null,
          uuid: "msg-uuid-H",
          message: {
            content: [
              {
                type: "server_tool_use",
                id: "su_H",
                name: "advisor",
                input: {},
              },
              {
                type: "advisor_tool_result",
                tool_use_id: "su_H",
                content: { type: "advisor_result", text: "answer" },
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: {
            iterations: [
              { type: "advisor_message", input_tokens: 100, output_tokens: 50 },
            ],
          },
        },
      ]),
    );

    // Construct a handle WITHOUT advisorObserver (test paths /
    // fork-backend agents). The two events MUST NOT fire and the
    // budget MUST NOT be called.
    const handle = (createTracedSessionHandle as unknown as (
      opts: unknown,
    ) => {
      sendAndStream(
        msg: string,
        onChunk: (s: string) => void,
      ): Promise<string>;
    })({
      sdk: mockSdk,
      baseOptions: {},
      sessionId: "sess-1",
      // advisorObserver intentionally omitted
    });

    await handle.sendAndStream("prompt", () => undefined);
    expect(invokedEvents).toHaveLength(0);
    expect(resultedEvents).toHaveLength(0);
    expect(budget.recordCall).not.toHaveBeenCalled();
  });
});
