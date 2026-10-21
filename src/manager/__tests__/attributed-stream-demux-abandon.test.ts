/**
 * 999.99-F2 — abandoned-daemon-read recovery (the 2026-07-23 fin-client
 * incident class, seeded 2026-07-22 11:59:09 by "Aborted: interrupt
 * deadline exceeded").
 *
 * Family F2: a daemon dispatch rejects (abort-deadline / AbortSignal /
 * force-release) while the CLI later still emits that turn's frames +
 * result. Pre-fix, those landed in the FrameQueue unconsumed and the NEXT
 * dispatch popped the stale result as its reply (off-by-one conveyor:
 * scheduler turns "answered" in 2-3ms all evening; Client A's 22:16 question
 * got a stale 1221-char buffered reply in 2ms).
 *
 * Pins for abandonDaemonTurn():
 *   1. INCIDENT REGRESSION — open daemon turn abandoned mid-stream: late
 *      frames + result deliver via the orphan sink ("abandoned-daemon");
 *      the next dispatch receives ITS OWN result, never the stale one.
 *   2. Abandon BEFORE the turn opened — expectation retracted; the
 *      not-yet-started turn classifies as an orphan.
 *   3. Result already queued unconsumed — purge captures it and delivers
 *      late; the queue is clean for the next consumer.
 *   4. Dangling raced next() — void-resolved (done:true), never rejected,
 *      and it cannot eat the next turn's first frame.
 *   5. Heal guard — a converted abandoned turn must NOT heal back to
 *      daemon even when a new daemon send is already registered.
 *   6. Idempotence — double abandon no-ops.
 *
 * Frame factories + harness mirror attributed-stream-demux.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  AttributedStreamDemux,
  type OrphanTurnOutput,
} from "../attributed-stream-demux.js";
import type { SdkStreamMessage } from "../sdk-types.js";

const init = () => ({ type: "system", subtype: "init" }) as unknown as SdkStreamMessage;
const assistant = (text: string) =>
  ({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  }) as unknown as SdkStreamMessage;
const result = (text: string, opts: { origin?: string } = {}) =>
  ({
    type: "result",
    subtype: "success",
    result: text,
    is_error: false,
    ...(opts.origin ? { origin: { kind: opts.origin } } : {}),
  }) as unknown as SdkStreamMessage;

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

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function harness() {
  const raw = makeRawStream();
  const orphans: OrphanTurnOutput[] = [];
  const demux = new AttributedStreamDemux({
    raw: raw.iter,
    onOrphanOutput: (o) => orphans.push(o),
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
  return { raw, demux, turnIter, orphans, take };
}

describe("999.99-F2 — abandonDaemonTurn", () => {
  it("INCIDENT REGRESSION: abandoned mid-stream turn delivers late via sink; next dispatch gets ITS OWN result", async () => {
    const { raw, demux, turnIter, orphans, take } = harness();

    // Dispatch A: registered + turn opens; consumer reads init+assistant.
    const tokenA = demux.registerDaemonSend();
    raw.feed(init(), assistant("working on A..."));
    await settle();
    const consumed = await take(2);
    expect(consumed).toHaveLength(2);

    // The raced next() that the abort deadline will orphan:
    const dangling = turnIter.next();

    // Abort deadline fires — consumer walks away (the send's catch calls this).
    demux.abandonDaemonTurn(tokenA, "Aborted: interrupt deadline exceeded");

    // The dangling raced next() resolves harmlessly (done:true, no reject).
    await expect(dangling).resolves.toEqual(
      expect.objectContaining({ done: true }),
    );

    // A's late frames + result now arrive (the CLI finished the turn anyway).
    raw.feed(assistant("late partial for A"), result("STALE ANSWER A"));
    await settle();

    // A's output delivered via the sink, classified abandoned-daemon.
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      text: "STALE ANSWER A",
      classification: "abandoned-daemon",
    });

    // Dispatch B: must receive ONLY its own frames and its own result.
    demux.registerDaemonSend();
    raw.feed(init(), assistant("working on B"), result("FRESH ANSWER B"));
    await settle();
    const bFrames = await take(3);
    const bResult = bFrames.find(
      (f) => (f as { type?: string }).type === "result",
    ) as { result?: string } | undefined;
    expect(bResult?.result).toBe("FRESH ANSWER B");
    // No stale frame leaked into B's consumption.
    const texts = bFrames
      .map((f) => JSON.stringify(f))
      .filter((s) => s.includes("STALE") || s.includes("late partial"));
    expect(texts).toHaveLength(0);
  });

  it("abandon BEFORE the turn opened retracts the expectation — turn classifies as orphan", async () => {
    const { raw, demux, orphans, take } = harness();

    const tokenA = demux.registerDaemonSend();
    // No frames yet — abort fires before the CLI started the turn.
    demux.abandonDaemonTurn(tokenA, "Aborted: interrupt deadline exceeded");

    // The turn eventually runs; with the expectation retracted it opens as
    // an unsignaled orphan and delivers via the sink.
    raw.feed(init(), assistant("late work"), result("LATE OUTPUT"));
    await settle();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      text: "LATE OUTPUT",
      classification: "orphan-unsignaled",
    });

    // The NEXT daemon dispatch pairs correctly.
    demux.registerDaemonSend();
    raw.feed(init(), result("MINE"));
    await settle();
    const frames = await take(2);
    const r = frames.find((f) => (f as { type?: string }).type === "result") as
      | { result?: string }
      | undefined;
    expect(r?.result).toBe("MINE");
  });

  it("purge path: result already queued unconsumed is delivered late and cannot poison the queue", async () => {
    const { raw, demux, orphans, take } = harness();

    // Dispatch A: whole turn arrives while the consumer never reads
    // (abort raced ahead of any next()).
    const tokenA = demux.registerDaemonSend();
    raw.feed(init(), assistant("A text"), result("A RESULT"));
    await settle();
    demux.abandonDaemonTurn(tokenA, "Aborted: interrupt deadline exceeded");

    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      text: "A RESULT",
      classification: "abandoned-daemon",
    });

    // Dispatch B is clean.
    demux.registerDaemonSend();
    raw.feed(init(), result("B RESULT"));
    await settle();
    const frames = await take(2);
    const r = frames.find((f) => (f as { type?: string }).type === "result") as
      | { result?: string }
      | undefined;
    expect(r?.result).toBe("B RESULT");
  });

  it("heal guard: converted abandoned turn does NOT heal to daemon even with a new send registered", async () => {
    const { raw, demux, orphans, take } = harness();

    // Dispatch A opens; consumer abandons mid-turn.
    const tokenA = demux.registerDaemonSend();
    raw.feed(init(), assistant("A work"));
    await settle();
    await take(2);
    demux.abandonDaemonTurn(tokenA, "Aborted: interrupt deadline exceeded");

    // Dispatch B registers BEFORE A's origin-less result lands — the exact
    // shape where the orphan→daemon heal would fire without the guard.
    demux.registerDaemonSend();
    raw.feed(result("A LATE RESULT")); // closes converted turn A, no origin
    await settle();

    // A's late result went to the SINK, not to B's queue.
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      text: "A LATE RESULT",
      classification: "abandoned-daemon",
    });

    // B's turn now runs and pairs with B.
    raw.feed(init(), result("B RESULT"));
    await settle();
    const frames = await take(2);
    const r = frames.find((f) => (f as { type?: string }).type === "result") as
      | { result?: string }
      | undefined;
    expect(r?.result).toBe("B RESULT");
  });

  it("double abandon is a no-op", async () => {
    const { raw, demux, orphans } = harness();
    const tokenA = demux.registerDaemonSend();
    raw.feed(init(), assistant("x"), result("X"));
    await settle();
    demux.abandonDaemonTurn(tokenA, "first");
    demux.abandonDaemonTurn(tokenA, "second");
    await settle();
    // Exactly one delivery (from the first abandon's purge), no crash.
    expect(orphans).toHaveLength(1);
  });

  it("partial assistant text is preserved when the abandoned turn ends with an empty result", async () => {
    const { raw, demux, orphans } = harness();

    const tokenA = demux.registerDaemonSend();
    raw.feed(init(), assistant("half-finished analysis"));
    await settle();
    // Consumer never read anything; abandon purges the buffered frames.
    demux.abandonDaemonTurn(tokenA, "Aborted: interrupt deadline exceeded");
    // Converted turn closes with an EMPTY result → falls back to the
    // accumulated assistant text seeded from the purge.
    raw.feed(result(""));
    await settle();

    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      text: "half-finished analysis",
      classification: "abandoned-daemon",
    });
  });
});
