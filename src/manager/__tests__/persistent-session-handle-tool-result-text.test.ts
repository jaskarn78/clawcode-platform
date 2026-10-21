/**
 * Phase 115 Plan 08 T01 — production-path producer-call integration test.
 *
 * Closes the loop on the silent-path-bifurcation regression (DEFERRED.md):
 * Phase 115-08 wired producers into `session-adapter.ts:iterateWithTracing`
 * (test-only path) but NOT into `persistent-session-handle.ts:iterateUntilResult`
 * (production path), so the `tool_execution_ms`, `tool_roundtrip_ms`, and
 * `parallel_tool_call_count` columns in traces.db stayed NULL fleet-wide.
 *
 * Quick task 260512 ported the producer call sites into the production path.
 * This test exercises the real `iterateUntilResult` via `createPersistentSessionHandle`
 * with a synthetic SDK iterator that emits a tool_use → tool_result → result
 * sequence, and asserts the TurnRecord persisted by TraceStore.writeTurn
 * carries non-zero values on all three split-latency fields.
 *
 * Anti-pattern guard (paired with producer-call-sites-sentinel.test.ts):
 *   - Static-grep sentinel pins the call-site presence in source.
 *   - This integration test pins the BEHAVIOR end-to-end.
 *
 * Pair-with reference:
 *   src/performance/__tests__/trace-collector-split-latency.test.ts
 *   src/manager/__tests__/persistent-session-handle.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery, SdkStreamMessage } from "../sdk-types.js";
import { TraceCollector, type Turn } from "../../performance/trace-collector.js";
import type { TraceStore } from "../../performance/trace-store.js";
import type { TurnRecord } from "../../performance/types.js";

// ---------------------------------------------------------------------------
// Mirror the harness shape from persistent-session-handle.test.ts (minimal).
// ---------------------------------------------------------------------------

interface FakeQueryController {
  query: SdkQuery;
  pushMessage: (msg: SdkStreamMessage) => void;
  endStream: () => void;
}

function createFakeQuery(promptIterable: AsyncIterable<unknown>): FakeQueryController {
  const pending: SdkStreamMessage[] = [];
  let msgWaiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  let streamEnded = false;

  // Drain the prompt iterable in the background — same as the production
  // SDK does — so the handle's inputQueue.push doesn't deadlock.
  (async () => {
    try {
      for await (const _ of promptIterable) {
        // discard; we only need to keep the iterable alive.
      }
    } catch {
      // ignore
    }
  })();

  const pushMessage = (msg: SdkStreamMessage): void => {
    if (msgWaiter) {
      const w = msgWaiter;
      msgWaiter = null;
      w({ value: msg, done: false });
      return;
    }
    pending.push(msg);
  };

  const endStream = (): void => {
    streamEnded = true;
    if (msgWaiter) {
      const w = msgWaiter;
      msgWaiter = null;
      w({ value: undefined as unknown as SdkStreamMessage, done: true });
    }
  };

  const next = (): Promise<IteratorResult<SdkStreamMessage>> =>
    new Promise((resolve) => {
      if (pending.length > 0) {
        resolve({ value: pending.shift()!, done: false });
        return;
      }
      if (streamEnded) {
        resolve({ value: undefined as unknown as SdkStreamMessage, done: true });
        return;
      }
      msgWaiter = resolve;
    });

  const query = {
    [Symbol.asyncIterator]() {
      return { next };
    },
    next,
    return: async () => ({ value: undefined, done: true as const }),
    throw: async (err: unknown) => {
      throw err;
    },
    interrupt: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => undefined),
    streamInput: vi.fn(() => Promise.resolve()),
    mcpServerStatus: vi.fn(() => Promise.resolve([])),
    setMcpServers: vi.fn(() => Promise.resolve(undefined)),
    setMaxThinkingTokens: vi.fn(() => Promise.resolve(undefined)),
    setModel: vi.fn(() => Promise.resolve(undefined)),
    setPermissionMode: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as SdkQuery;

  return { query, pushMessage, endStream };
}

function buildHarness(): {
  sdkMock: { query: ReturnType<typeof vi.fn> };
  getController: () => FakeQueryController;
} {
  let controller: FakeQueryController | null = null;
  const query = vi.fn((params: { prompt: unknown }) => {
    const iterable = params.prompt as AsyncIterable<unknown>;
    controller = createFakeQuery(iterable);
    return controller.query;
  });
  return {
    sdkMock: { query },
    getController: () => {
      if (!controller) throw new Error("FakeQuery not yet created");
      return controller;
    },
  };
}

function createMockStore(): {
  store: TraceStore;
  writeTurn: ReturnType<typeof vi.fn>;
} {
  const writeTurn = vi.fn();
  const store = {
    writeTurn,
    pruneOlderThan: vi.fn().mockReturnValue(0),
    close: vi.fn(),
    getPercentiles: vi.fn().mockReturnValue([]),
  } as unknown as TraceStore;
  return { store, writeTurn };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 2026-08-27 — PR-0: the tool_result TEXT producer must live on the PRODUCTION
// path (iterateUntilResult via createPersistentSessionHandle). The first cut
// (7ef998a8) sat in the dead wrapSdkQuery, so figureProvenance could never
// fire in prod. Harness above is copied verbatim from
// persistent-session-handle-producer-port.test.ts.
// ---------------------------------------------------------------------------
import { toolResultBlocksFromMessage } from "../persistent-session-handle.js";

async function runToolTurn(userMsg: unknown): Promise<string> {
  const { sdkMock, getController } = buildHarness();
  const { store } = createMockStore();
  const collector = new TraceCollector(store, createMockLogger());
  const turn: Turn = collector.startTurn("msg-trt-1", "alpha", null);
  const handle = createPersistentSessionHandle(sdkMock as unknown as SdkModule, {}, "sess-trt-1");
  const p = handle.sendAndCollect("trigger tool", turn);
  await Promise.resolve();
  await Promise.resolve();
  const ctrl = getController();
  ctrl.pushMessage({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: "toolu_a", name: "WebSearch", input: { query: "q" } }] },
  } as unknown as SdkStreamMessage);
  await new Promise((r) => setTimeout(r, 10));
  ctrl.pushMessage(userMsg as SdkStreamMessage);
  await new Promise((r) => setTimeout(r, 10));
  const text = collector.getActiveTurnToolResultText("alpha");
  ctrl.pushMessage({ type: "result", subtype: "success", result: "done", session_id: "sess-trt-1" } as unknown as SdkStreamMessage);
  ctrl.endStream();
  await p.catch(() => undefined);
  return text;
}

describe("PR-0 — production tool_result text producer", () => {
  it("string tool_result content reaches the Turn", async () => {
    const text = await runToolTurn({
      type: "user",
      parent_tool_use_id: "toolu_a",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_a", content: 'Web search results\n\nLinks: [{"title":"RMD FAQs","url":"https://www.irs.gov/x"}]' }] },
    });
    expect(text).toContain("irs.gov/x");
  });

  it("text-part array content reaches the Turn", async () => {
    const text = await runToolTurn({
      type: "user",
      parent_tool_use_id: "toolu_a",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text: "Total $1,977,109" }, { type: "text", text: "84% bonds" }] }] },
    });
    expect(text).toContain("$1,977,109");
    expect(text).toContain("84% bonds");
  });

  it("a parallel batch records every result; non-tool_result blocks are ignored", async () => {
    const text = await runToolTurn({
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "first" },
          { type: "text", text: "ignored narration" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "second" },
        ],
      },
    });
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).not.toContain("ignored narration");
  });

  it("toolResultBlocksFromMessage is total on malformed shapes", () => {
    expect(toolResultBlocksFromMessage(null)).toEqual([]);
    expect(toolResultBlocksFromMessage({ message: { content: "nope" } })).toEqual([]);
    expect(toolResultBlocksFromMessage({ message: { content: [{ type: "tool_result", content: "" }] } })).toEqual([]);
  });
});

describe("PR-1 — evidence ledger producers on the production path", () => {
  it("WebFetch input → read; WebSearch result Links → found; child-lane tool_use → document", async () => {
    const { sdkMock, getController } = buildHarness();
    const { store } = createMockStore();
    const collector = new TraceCollector(store, createMockLogger());
    const turn: Turn = collector.startTurn("msg-ev-1", "alpha", null);
    const handle = createPersistentSessionHandle(sdkMock as unknown as SdkModule, {}, "sess-ev-1");
    const p = handle.sendAndCollect("trigger", turn);
    await Promise.resolve();
    await Promise.resolve();
    const ctrl = getController();
    ctrl.pushMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [
        { type: "tool_use", id: "u_fetch", name: "WebFetch", input: { url: "https://www.irs.gov/retirement-plans/rmd-faqs", prompt: "x" } },
        { type: "tool_use", id: "u_search", name: "WebSearch", input: { query: "rmd age" } },
      ] },
    } as unknown as SdkStreamMessage);
    await new Promise((r) => setTimeout(r, 10));
    ctrl.pushMessage({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [
        { type: "tool_result", tool_use_id: "u_fetch", content: "page summary" },
        { type: "tool_result", tool_use_id: "u_search", content: 'Web search results for query: "rmd age"\n\nLinks: [{"title":"RMD FAQs","url":"https://www.irs.gov/x"},{"title":"SSA","url":"https://www.ssa.gov/y"}]' },
      ] },
    } as unknown as SdkStreamMessage);
    await new Promise((r) => setTimeout(r, 10));
    // child-lane (subagent) tool_use: evidence-only
    ctrl.pushMessage({
      type: "assistant",
      parent_tool_use_id: "u_task_parent",
      message: { content: [{ type: "tool_use", id: "u_child", name: "Read", input: { file_path: "/w/clients/vallejos/statement-2026-04-30.pdf" } }] },
    } as unknown as SdkStreamMessage);
    await new Promise((r) => setTimeout(r, 10));
    const ev = collector.getActiveTurnEvidence("alpha");
    ctrl.pushMessage({ type: "result", subtype: "success", result: "done", session_id: "sess-ev-1" } as unknown as SdkStreamMessage);
    ctrl.endStream();
    await p.catch(() => undefined);
    const kinds = ev.map((e) => `${e.kind}:${e.url ?? e.file}`);
    expect(kinds).toContain("read:https://irs.gov/retirement-plans/rmd-faqs");
    expect(kinds).toContain("found:https://irs.gov/x");
    expect(kinds).toContain("found:https://ssa.gov/y");
    expect(kinds).toContain("document:statement-2026-04-30.pdf");
    expect(ev.find((e) => e.kind === "read")?.tier).toBe("primary");
  });
});
