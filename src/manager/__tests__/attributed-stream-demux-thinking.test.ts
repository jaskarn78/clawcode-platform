/**
 * 999.171 — AttributedStreamDemux thinking tap (`system/thinking_tokens`).
 *
 * The demux is the sole reader of the CLI stream, so it is where live
 * thinking progress is observed. Pinned here:
 *   - every frame is REPORTED to `onThinkingTokens` with the open turn kind
 *     (daemon / orphan / null when idle), and still FORWARDED to the daemon
 *     queue exactly as before (stream parity);
 *   - an abandoned daemon turn reports "orphan" after its conversion;
 *   - a malformed token count is never reported, but the frame still flows;
 *   - a throwing consumer never stops the pump.
 *
 * Frame factories and the raw-stream harness are local copies of the ones
 * in attributed-stream-demux.test.ts (kept private to that suite).
 */
import { describe, it, expect } from "vitest";
import {
  AttributedStreamDemux,
  type OrphanTurnOutput,
} from "../attributed-stream-demux.js";
import type { SdkStreamMessage } from "../sdk-types.js";

// ---------------------------------------------------------------------------
// Frame factories (structural — the demux inspects shape, not the local type)
// ---------------------------------------------------------------------------

const notification = () =>
  ({ type: "system", subtype: "task_notification", task_id: "t1" }) as unknown as SdkStreamMessage;
const assistant = (text: string) =>
  ({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  }) as unknown as SdkStreamMessage;
const streamEvent = () => ({ type: "stream_event", event: {} }) as unknown as SdkStreamMessage;
const result = (text: string, opts: { origin?: string } = {}) =>
  ({
    type: "result",
    subtype: "success",
    result: text,
    is_error: false,
    ...(opts.origin ? { origin: { kind: opts.origin } } : {}),
  }) as unknown as SdkStreamMessage;
/** Probe-verified shape (CLI 2.1.280): estimated_tokens is the running block total. */
const thinking = (estimated: unknown) =>
  ({
    type: "system",
    subtype: "thinking_tokens",
    estimated_tokens: estimated,
    estimated_tokens_delta: 10,
  }) as unknown as SdkStreamMessage;
const thinkingWithoutCount = () =>
  ({ type: "system", subtype: "thinking_tokens", estimated_tokens_delta: 10 }) as unknown as SdkStreamMessage;

/** Controllable raw iterator: frames are released one by one via feed(). */
function makeRawStream() {
  const queue: SdkStreamMessage[] = [];
  let waiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  let done = false;
  const iter: AsyncIterator<SdkStreamMessage> = {
    next: () =>
      new Promise((resolve) => {
        const item = queue.shift();
        if (item !== undefined) return resolve({ value: item, done: false });
        if (done) return resolve({ value: undefined as never, done: true });
        waiter = resolve;
      }),
    return: () => {
      done = true;
      if (waiter) {
        waiter({ value: undefined as never, done: true });
        waiter = null;
      }
      return Promise.resolve({ value: undefined as never, done: true });
    },
  };
  return {
    iter,
    feed(...frames: SdkStreamMessage[]) {
      for (const f of frames) {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w({ value: f, done: false });
        } else {
          queue.push(f);
        }
      }
    },
  };
}

/** Drain the microtask queue so pump routing settles deterministically. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

type ThinkingCall = { estimatedTokens: number; openKind: "daemon" | "orphan" | null };

function harness(onThinking?: (ev: ThinkingCall) => void) {
  const raw = makeRawStream();
  const orphans: OrphanTurnOutput[] = [];
  const calls: ThinkingCall[] = [];
  const noop = () => undefined;
  const demux = new AttributedStreamDemux({
    raw: raw.iter,
    onOrphanOutput: (o) => orphans.push(o),
    onThinkingTokens: (ev) => {
      calls.push({ estimatedTokens: ev.estimatedTokens, openKind: ev.openKind });
      onThinking?.(ev);
    },
    log: { info: noop, warn: noop, error: noop },
  });
  const turnIter = demux.turnIterator();
  async function take(n: number): Promise<SdkStreamMessage[]> {
    const out: SdkStreamMessage[] = [];
    for (let i = 0; i < n; i++) {
      const step = await turnIter.next();
      if (step.done) break;
      out.push(step.value);
    }
    return out;
  }
  return { raw, demux, orphans, calls, take };
}

const typeOf = (f: SdkStreamMessage) => (f as { type?: string }).type;
const subtypeOf = (f: SdkStreamMessage) => (f as { subtype?: string }).subtype;

describe("AttributedStreamDemux — thinking tap (999.171)", () => {
  it("daemon turn: reports the count with openKind daemon AND forwards the frame in stream order (parity)", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    const thinkingFrame = thinking(185);
    h.raw.feed(streamEvent(), thinkingFrame, assistant("hi"), result("hi"));
    await settle();

    expect(h.calls).toEqual([{ estimatedTokens: 185, openKind: "daemon" }]);
    const frames = await h.take(4);
    expect(frames.map(typeOf)).toEqual(["stream_event", "system", "assistant", "result"]);
    // The very same frame object reaches the daemon consumer — nothing is
    // swallowed, rewritten or reordered by the tap.
    expect(frames[1]).toBe(thinkingFrame);
    expect((frames[3] as { result?: string }).result).toBe("hi");
  });

  it("orphan (self-fired) turn: reports openKind orphan, and the frame stays ambient", async () => {
    const h = harness();
    const thinkingFrame = thinking(50);
    h.raw.feed(
      notification(),
      streamEvent(),
      thinkingFrame,
      result("", { origin: "task-notification" }),
    );
    await settle();

    expect(h.calls).toEqual([{ estimatedTokens: 50, openKind: "orphan" }]);
    // Ambient forwarding is unchanged: the signal and the thinking frame reach
    // the daemon queue; the orphan turn's own content does not.
    const frames = await h.take(2);
    expect(subtypeOf(frames[0]!)).toBe("task_notification");
    expect(frames[1]).toBe(thinkingFrame);
  });

  it("idle: a frame with no turn open reports openKind null and is still forwarded", async () => {
    const h = harness();
    const thinkingFrame = thinking(42);
    h.raw.feed(thinkingFrame);
    await settle();

    expect(h.calls).toEqual([{ estimatedTokens: 42, openKind: null }]);
    const frames = await h.take(1);
    expect(frames[0]).toBe(thinkingFrame);
  });

  it("abandoned daemon turn: after the conversion, frames report openKind orphan", async () => {
    const h = harness();
    const token = h.demux.registerDaemonSend();
    h.raw.feed(streamEvent());
    await settle();
    h.demux.abandonDaemonTurn(token, "test");
    h.raw.feed(thinking(900));
    await settle();

    expect(h.calls).toEqual([{ estimatedTokens: 900, openKind: "orphan" }]);
  });

  it("malformed counts (missing, string, negative, NaN, Infinity) are never reported but every frame is forwarded", async () => {
    const h = harness();
    const frames = [
      thinkingWithoutCount(),
      thinking("185"),
      thinking(-5),
      thinking(Number.NaN),
      thinking(Number.POSITIVE_INFINITY),
    ];
    h.raw.feed(...frames);
    await settle();

    expect(h.calls).toEqual([]);
    const forwarded = await h.take(frames.length);
    expect(forwarded).toHaveLength(frames.length);
    forwarded.forEach((f, i) => expect(f).toBe(frames[i]));
  });

  it("a throwing consumer never stops the pump: the daemon turn still resolves and later turns still flow", async () => {
    const h = harness(() => {
      throw new Error("renderer exploded");
    });
    h.demux.registerDaemonSend();
    h.raw.feed(streamEvent(), thinking(10), assistant("ok"), result("ok"));
    await settle();

    expect(h.calls).toEqual([{ estimatedTokens: 10, openKind: "daemon" }]);
    const first = await h.take(4);
    expect((first[3] as { result?: string }).result).toBe("ok");

    h.demux.registerDaemonSend();
    h.raw.feed(streamEvent(), thinking(20), assistant("again"), result("again"));
    await settle();
    const second = await h.take(4);
    expect((second[3] as { result?: string }).result).toBe("again");
    expect(h.calls.map((c) => c.estimatedTokens)).toEqual([10, 20]);
  });

  it("documented residual: a daemon-tentative turn healed to orphan at result reported its frames as daemon (same attribution as its draft text)", async () => {
    const h = harness();
    h.demux.registerDaemonSend();
    h.raw.feed(streamEvent(), thinking(77), result("bg", { origin: "task-notification" }));
    await settle();

    // At tap time the turn was daemon-tentative; the origin cross-check only
    // heals it at the result. Its draft chunks streamed to the same consumer
    // in that window, so this is the text stream's attribution, not a new leak.
    expect(h.calls).toEqual([{ estimatedTokens: 77, openKind: "daemon" }]);
  });
});
