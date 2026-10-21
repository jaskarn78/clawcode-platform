/**
 * Phase 103 OBS-05 — rate_limit_event capture tests.
 *
 * Pins three contracts:
 *   1) When the SDK emits rate_limit_event mid-turn AND a tracker is injected,
 *      the snapshot reaches RateLimitTracker.record().
 *   2) When NO tracker is injected (Pitfall 8 race window), the message is
 *      silently dropped — never throws out of the message loop.
 *   3) result still terminates the turn even when rate_limit_event precedes
 *      it (the new branch must NOT swallow the result).
 *
 * Helper: this file inlines the same buildFakeSdk pattern from
 * persistent-session-cache.test.ts (drives prompt iterable in background, pulls
 * the next per-turn batch on each user message). Plus a `buildHandleWithFakeSdk`
 * helper that constructs a real persistent-session-handle against the fake.
 */

import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";

import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type {
  SdkModule,
  SdkQuery,
  SdkStreamMessage,
} from "../sdk-types.js";
import type { SessionHandle } from "../session-adapter.js";
import { RateLimitTracker } from "../../usage/rate-limit-tracker.js";

function buildFakeSdk(turnOutputs: SdkStreamMessage[][]): {
  fakeSdk: { query: ReturnType<typeof vi.fn> };
} {
  let turnIndex = 0;
  const pending: SdkStreamMessage[] = [];
  let waiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  let ended = false;

  const pushMessage = (msg: SdkStreamMessage): void => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: msg, done: false });
      return;
    }
    pending.push(msg);
  };

  const next = (): Promise<IteratorResult<SdkStreamMessage>> =>
    new Promise<IteratorResult<SdkStreamMessage>>((resolve) => {
      const m = pending.shift();
      if (m !== undefined) {
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

  return { fakeSdk: { query } };
}

function buildHandleWithFakeSdk(fakeSdk: {
  query: ReturnType<typeof vi.fn>;
}): SessionHandle {
  return createPersistentSessionHandle(
    fakeSdk as unknown as SdkModule,
    { model: "claude-sonnet-4" },
    "sess-1",
  );
}

describe("rate_limit_event capture (OBS-05)", () => {
  it("dispatches SDK rate_limit_event to the injected RateLimitTracker", async () => {
    const tracker = new RateLimitTracker(new Database(":memory:"));
    const recordSpy = vi.spyOn(tracker, "record");

    const turnOutputs: SdkStreamMessage[][] = [
      [
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.87,
            resetsAt: Date.now() + 3_600_000,
          },
          uuid: "evt-1",
          session_id: "sess-1",
        } as unknown as SdkStreamMessage,
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as SdkStreamMessage,
      ],
    ];

    const { fakeSdk } = buildFakeSdk(turnOutputs);
    const handle = buildHandleWithFakeSdk(fakeSdk);
    handle.setRateLimitTracker(tracker);

    // Drive one turn — iterateUntilResult consumes both rate_limit_event
    // AND result; result terminates the turn.
    const r = await handle.sendAndCollect("hello");
    expect(r).toBe("ok");

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0]![0]).toMatchObject({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.87,
    });
    expect(tracker.getLatest("five_hour")?.utilization).toBe(0.87);

    await handle.close();
  });

  it("silently drops rate_limit_event when no tracker injected (Pitfall 8)", async () => {
    const turnOutputs: SdkStreamMessage[][] = [
      [
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
          uuid: "evt-1",
          session_id: "sess-1",
        } as unknown as SdkStreamMessage,
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "sess-1",
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as SdkStreamMessage,
      ],
    ];
    const { fakeSdk } = buildFakeSdk(turnOutputs);
    const handle = buildHandleWithFakeSdk(fakeSdk);
    // No setRateLimitTracker call — observational path must hold.
    await expect(handle.sendAndCollect("hello")).resolves.toBe("ok");
    await handle.close();
  });

  it("never breaks the result-terminates-turn invariant when rate_limit_event precedes result", async () => {
    const tracker = new RateLimitTracker(new Database(":memory:"));
    const turnOutputs: SdkStreamMessage[][] = [
      [
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", rateLimitType: "seven_day" },
          uuid: "evt-1",
          session_id: "sess-1",
        } as unknown as SdkStreamMessage,
        {
          type: "result",
          subtype: "success",
          result: "final-text",
          session_id: "sess-1",
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as SdkStreamMessage,
      ],
    ];
    const { fakeSdk } = buildFakeSdk(turnOutputs);
    const handle = buildHandleWithFakeSdk(fakeSdk);
    handle.setRateLimitTracker(tracker);

    const result = await handle.sendAndCollect("hello");
    expect(result).toBe("final-text");
    expect(tracker.getLatest("seven_day")).toBeDefined();

    await handle.close();
  });
});
