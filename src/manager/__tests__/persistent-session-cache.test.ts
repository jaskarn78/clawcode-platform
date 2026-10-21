/**
 * Phase 73 Plan 03 — LAT-05 prompt-cache non-regression test.
 *
 * Proves that the persistent session handle (Plan 01) propagates the SDK's
 * cache-usage telemetry on every turn. A long-lived session SHOULD see
 * cache_read_input_tokens > 0 from turn 2 onward because the stable
 * system prefix stays warm in Anthropic's cache.
 *
 * The test does NOT measure real Anthropic cache behavior — that is covered
 * in v1.7's existing test suite. This test pins the CONTRACT that the
 * persistent handle does not swallow or mangle the cache fields coming off
 * the SDK stream. A regression here would mean Plan 01's refactor broke the
 * v1.7 telemetry pipeline.
 */

import { describe, it, expect, vi } from "vitest";

import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type {
  SdkModule,
  SdkQuery,
  SdkStreamMessage,
} from "../sdk-types.js";
import type { UsageCallback } from "../session-adapter.js";

/**
 * Build a FakeQuery whose AsyncIterator yields the per-turn canned messages
 * in sequence. The prompt iterable is drained in the background; each time
 * a user message arrives, the next turn's message sequence is scheduled for
 * emission. `yielded` records every message the handle observed.
 */
function buildFakeSdk(turnOutputs: SdkStreamMessage[][]): {
  fakeSdk: { query: ReturnType<typeof vi.fn> };
  getYielded: () => SdkStreamMessage[];
} {
  const yielded: SdkStreamMessage[] = [];
  let turnIndex = 0;
  const pending: SdkStreamMessage[] = [];
  let waiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  let ended = false;

  const pushMessage = (msg: SdkStreamMessage): void => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      yielded.push(msg);
      w({ value: msg, done: false });
      return;
    }
    pending.push(msg);
  };

  const next = (): Promise<IteratorResult<SdkStreamMessage>> =>
    new Promise<IteratorResult<SdkStreamMessage>>((resolve) => {
      const m = pending.shift();
      if (m !== undefined) {
        yielded.push(m);
        resolve({ value: m, done: false });
        return;
      }
      if (ended) {
        resolve({
          value: undefined as unknown as SdkStreamMessage,
          done: true,
        });
        return;
      }
      waiter = resolve;
    });

  const query = vi.fn((params: { prompt: unknown; options?: unknown }) => {
    const iterable = params.prompt as AsyncIterable<unknown>;
    // Drive the prompt iterable in the background — each user message pulls the
    // next turn's canned output sequence into the pending buffer.
    void (async () => {
      try {
        for await (const _user of iterable) {
          const batch = turnOutputs[turnIndex];
          turnIndex += 1;
          if (!batch) break;
          for (const m of batch) pushMessage(m);
        }
        ended = true;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({
            value: undefined as unknown as SdkStreamMessage,
            done: true,
          });
        }
      } catch {
        /* prompt iterable closed abnormally */
      }
    })();

    const asyncIter = {
      [Symbol.asyncIterator]() {
        return { next };
      },
      next,
      return: async () =>
        ({ value: undefined, done: true as const }) as IteratorResult<
          SdkStreamMessage,
          void
        >,
      throw: async (err: unknown) => {
        throw err;
      },
      interrupt: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => undefined),
      streamInput: vi.fn(() => Promise.resolve()),
      mcpServerStatus: vi.fn(() => Promise.resolve([])),
      setMcpServers: vi.fn(() => Promise.resolve(undefined)),
    };
    return asyncIter as unknown as SdkQuery;
  });

  return {
    fakeSdk: { query },
    getYielded: () => yielded,
  };
}

describe("persistent session cache telemetry (LAT-05)", () => {
  it("turn 2 result carries cache_read_input_tokens from the SDK", async () => {
    // Fake SDK that emits a 2-turn stream. Turn 1 builds the cache
    // (cache_creation_input_tokens=80); Turn 2 reads from cache
    // (cache_read_input_tokens=80) — the expected long-lived-session pattern.
    const outputs: SdkStreamMessage[][] = [
      // turn 1: cache creation (first turn builds the cache)
      [
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "Hello turn 1" }] },
        } as unknown as SdkStreamMessage,
        {
          type: "result",
          subtype: "success",
          session_id: "sess-1",
          result: "Hello turn 1",
          total_cost_usd: 0.002,
          num_turns: 1,
          duration_ms: 120,
          model: "claude-sonnet-4",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 80,
          },
        } as unknown as SdkStreamMessage,
      ],
      // turn 2: cache hit (stable prefix warm in Anthropic's cache)
      [
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "Hello turn 2" }] },
        } as unknown as SdkStreamMessage,
        {
          type: "result",
          subtype: "success",
          session_id: "sess-1",
          result: "Hello turn 2",
          total_cost_usd: 0.001,
          num_turns: 1,
          duration_ms: 80,
          model: "claude-sonnet-4",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 0,
          },
        } as unknown as SdkStreamMessage,
      ],
    ];

    const { fakeSdk, getYielded } = buildFakeSdk(outputs);

    const usageCalls: Parameters<UsageCallback>[0][] = [];
    const usageCallback: UsageCallback = (data) => usageCalls.push(data);

    const handle = createPersistentSessionHandle(
      fakeSdk as unknown as SdkModule,
      { model: "claude-sonnet-4" },
      "sess-1",
      usageCallback,
    );

    const r1 = await handle.sendAndStream("turn 1", () => undefined);
    expect(r1).toBe("Hello turn 1");

    const r2 = await handle.sendAndStream("turn 2", () => undefined);
    expect(r2).toBe("Hello turn 2");

    // Contract 1: usageCallback fired once per turn.
    expect(usageCalls).toHaveLength(2);
    expect(usageCalls[0]!.tokens_in).toBe(100);
    expect(usageCalls[1]!.tokens_in).toBe(100);

    // Contract 2: persistent handle — exactly ONE sdk.query invocation across
    // both turns (LAT-01 regression proof).
    expect(fakeSdk.query).toHaveBeenCalledTimes(1);

    // Contract 3: result messages flowed through the handle unchanged —
    // cache fields intact from the SDK stream. The yielded buffer captures
    // every message as the handle observed it.
    const results = getYielded().filter(
      (m) => (m as { type?: string }).type === "result",
    ) as Array<{
      usage: {
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
      };
    }>;
    expect(results).toHaveLength(2);
    expect(results[0]!.usage.cache_read_input_tokens).toBe(0);
    expect(results[0]!.usage.cache_creation_input_tokens).toBe(80);
    // LAT-05 LOAD-BEARING ASSERTION: turn 2 sees cache reads > 0.
    expect(results[1]!.usage.cache_read_input_tokens).toBe(80);
    expect(results[1]!.usage.cache_creation_input_tokens).toBe(0);
    expect(results[1]!.usage.cache_read_input_tokens).toBeGreaterThan(0);

    await handle.close();
  });
});
