/**
 * 999.99 adversarial-review fixes — demux-level pins.
 *
 *  1. Converted abandoned turn liveness bound: a system:init frame (a new
 *     turn opening) force-closes the abandoned turn instead of leaving the
 *     demux wedged in state='orphan' for the epoch.
 *  2. Ambient frames (rate_limit_event) stay ambient MID-orphan-turn —
 *     forwarded to the daemon queue for the legacy loop's rate-limit
 *     tracker, never buried in the orphan buffer.
 *  3. stop() mid-orphan-turn flushes the accumulated text through the sink
 *     (epoch teardown must not silently vanish a self-fired turn's output).
 *  4. onTurnUsage fires for orphan closes and abandoned purges (telemetry
 *     blackout fix) — self-fired turns keep charging usage accounting.
 *  5. Heal-no-unshift: a surplus orphan expectation costs ONE degraded
 *     (healed) daemon turn, then the FIFO self-corrects — the next daemon
 *     turn classifies daemon directly.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AttributedStreamDemux,
  type OrphanTurnOutput,
} from "../attributed-stream-demux.js";
import type { SdkStreamMessage } from "../sdk-types.js";

const init = () => ({ type: "system", subtype: "init" }) as unknown as SdkStreamMessage;
const notification = () =>
  ({ type: "system", subtype: "task_notification", task_id: "t" }) as unknown as SdkStreamMessage;
const rateLimit = () => ({ type: "rate_limit_event" }) as unknown as SdkStreamMessage;
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
  const usage = vi.fn();
  const warns: string[] = [];
  const demux = new AttributedStreamDemux({
    raw: raw.iter,
    onOrphanOutput: (o) => orphans.push(o),
    onTurnUsage: usage,
    log: {
      info: () => undefined,
      warn: (_o: unknown, m?: unknown) => warns.push(String(m ?? _o)),
      error: () => undefined,
    },
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
  return { raw, demux, turnIter, orphans, usage, warns, take };
}

describe("999.99 review fixes — demux", () => {
  it("init frame force-closes a converted abandoned turn (no epoch-wide orphan wedge)", async () => {
    const { raw, demux, orphans, take } = harness();

    // Turn A opens and streams; the consumer abandons mid-turn WITHOUT
    // draining (the abort raced ahead), so the buffered assistant text is
    // captured into the converted turn's accumulator. A's result NEVER
    // arrives (interrupt killed it CLI-side).
    const tokenA = demux.registerDaemonSend();
    raw.feed(init(), assistant("A partial work"));
    await settle();
    demux.abandonDaemonTurn(tokenA, "Aborted: interrupt deadline exceeded");
    expect(demux.isOrphanTurnOpen()).toBe(true);

    // Turn B starts (init proves A is dead): A force-closes delivering its
    // accumulated text; B pairs with its own expectation + result.
    demux.registerDaemonSend();
    raw.feed(init(), result("B RESULT"));
    await settle();

    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      text: "A partial work",
      classification: "abandoned-daemon",
    });
    expect(demux.isOrphanTurnOpen()).toBe(false);

    // B's frames (its init was the trigger + its result) reach the consumer.
    const frames = await take(2);
    const r = frames.find((f) => (f as { type?: string }).type === "result") as
      | { result?: string }
      | undefined;
    expect(r?.result).toBe("B RESULT");
  });

  it("rate_limit_event stays ambient mid-orphan-turn (forwarded, not buried)", async () => {
    const { raw, demux, take } = harness();

    raw.feed(notification(), init(), assistant("orphan work"));
    await settle();
    expect(demux.isOrphanTurnOpen()).toBe(true);

    raw.feed(rateLimit());
    await settle();

    // The daemon consumer sees the notification (ambient parity) AND the
    // rate_limit_event even though an orphan turn is open.
    const frames = await take(2);
    const types = frames.map((f) => (f as { type?: string }).type);
    expect(types).toContain("rate_limit_event");
  });

  it("stop() mid-orphan-turn flushes accumulated text through the sink", async () => {
    const { raw, demux, orphans } = harness();

    raw.feed(notification(), init(), assistant("800 chars of orphan progress"));
    await settle();
    expect(demux.isOrphanTurnOpen()).toBe(true);

    demux.stop();

    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      text: "800 chars of orphan progress",
      classification: "orphan-signaled",
    });
    expect(demux.isOrphanTurnOpen()).toBe(false);
  });

  it("onTurnUsage fires for orphan closes and abandoned purges", async () => {
    const { raw, demux, usage } = harness();

    // Orphan turn close.
    raw.feed(notification(), init(), assistant("x"), result("orphan out", { origin: "task-notification" }));
    await settle();
    expect(usage).toHaveBeenCalledTimes(1);

    // Abandoned purge path (result queued unconsumed).
    const token = demux.registerDaemonSend();
    raw.feed(init(), result("late out"));
    await settle();
    demux.abandonDaemonTurn(token, "abort");
    expect(usage).toHaveBeenCalledTimes(2);
  });

  it("heal-no-unshift: a surplus orphan expectation degrades exactly ONE turn, then self-corrects", async () => {
    const { raw, demux, orphans, warns, take } = harness();

    // Two notifications, but the CLI coalesces them into ONE wake turn →
    // FIFO gets a SURPLUS orphan expectation.
    raw.feed(notification(), notification());
    await settle();
    raw.feed(init(), assistant("wake"), result("wake out", { origin: "task-notification" }));
    await settle();
    expect(orphans).toHaveLength(1); // the wake turn delivered
    // Drain the two ambient notification frames forwarded for legacy parity.
    await take(2);

    // Daemon turn 1: opens orphan-tentative against the surplus expectation,
    // HEALS at its (origin-less) result — buffered frames flush together.
    // Degraded but correct.
    demux.registerDaemonSend();
    raw.feed(init(), assistant("d1"), result("D1 RESULT"));
    await settle();
    const t1 = await take(3); // init, assistant, result (flushed at heal)
    expect(
      (t1.find((f) => (f as { type?: string }).type === "result") as { result?: string })
        ?.result,
    ).toBe("D1 RESULT");

    // Daemon turn 2: the heal did NOT restore the orphan expectation, so
    // this turn classifies daemon DIRECTLY (no heal). Its frames stream
    // live — available BEFORE its result exists.
    demux.registerDaemonSend();
    raw.feed(init(), assistant("d2"));
    await settle();
    const live = await take(2); // resolves without a result frame present
    expect(live).toHaveLength(2);
    raw.feed(result("D2 RESULT"));
    await settle();
    expect(((await take(1))[0] as { result?: string }).result).toBe("D2 RESULT");

    // Exactly ONE heal fired across both daemon turns (the surplus consumed
    // once; had it been restored, turn 2 would have healed too).
    const healWarns = warns.filter((w) => w.includes("reclassified to daemon"));
    expect(healWarns).toHaveLength(1);
  });
});
