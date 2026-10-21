/**
 * Phase 119 A2A-03 / D-04 — queue-state icon state machine.
 *
 * Pins the typed state machine semantics: per-channel mutex serialization,
 * 200ms debounce collapse, ≤3-attempt retry budget on Discord rate-limit
 * errors, sticky terminal states (DELIVERED/FAILED), and idempotent
 * same-state transitions.
 *
 * 999.178 R1 — the reactions now render through the `cc_*` registry; the
 * transition resolves each state to a `cc_name:id` identifier through an
 * injected resolver and skips entirely when the icon is not loaded (no
 * Unicode fallback). Discord-side visual verification (no double-emoji
 * moment, transition order on a real channel) is captured post-deploy via
 * operator screenshot.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  QUEUE_STATE_ICON,
  reactionCacheKey,
  type DiscordChannelHandle,
  type QueueState,
  _resetQueueStateMemory,
  transitionQueueState,
} from "../queue-state-icon.js";

describe("reactionCacheKey — remove-by-id (999.178 R1)", () => {
  it("returns the id for a custom-emoji identifier", () => {
    expect(reactionCacheKey("cc_hourglass:123")).toBe("123");
    expect(reactionCacheKey("cc_circle_check:000000000000000001")).toBe("000000000000000001");
  });
  it("passes a Unicode glyph through unchanged", () => {
    expect(reactionCacheKey("⏳")).toBe("⏳");
    expect(reactionCacheKey("✅")).toBe("✅");
  });
});

/** A loaded set: each queue-state icon has an id. */
const TEST_ICON_ID: Record<string, string> = {
  hourglass: "10",
  loader: "20",
  circle_check: "30",
  circle_x: "40",
};

/** Mirrors `icons.reaction(QUEUE_STATE_ICON[state])`. */
const resolve = (state: QueueState): string | undefined => {
  const name = QUEUE_STATE_ICON[state];
  const id = TEST_ICON_ID[name];
  return id ? `${name}:${id}` : undefined;
};
const emojiFor = (state: QueueState): string => resolve(state)!;

function makeHandle(): {
  handle: DiscordChannelHandle;
  addCalls: Array<[string, string, string]>;
  removeCalls: Array<[string, string, string]>;
  addImpl: { current: (emoji: string) => Promise<void> };
  removeImpl: { current: (emoji: string) => Promise<void> };
} {
  const addCalls: Array<[string, string, string]> = [];
  const removeCalls: Array<[string, string, string]> = [];
  const addImpl = { current: async (_emoji: string) => undefined };
  const removeImpl = { current: async (_emoji: string) => undefined };
  return {
    handle: {
      addReaction: async (c, m, e) => {
        addCalls.push([c, m, e]);
        await addImpl.current(e);
      },
      removeReaction: async (c, m, e) => {
        removeCalls.push([c, m, e]);
        await removeImpl.current(e);
      },
    },
    addCalls,
    removeCalls,
    addImpl,
    removeImpl,
  };
}

describe("transitionQueueState — state machine semantics", () => {
  beforeEach(() => {
    _resetQueueStateMemory();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) QUEUED → IN_FLIGHT → DELIVERED — exact remove+add pairs in order", async () => {
    const { handle, addCalls, removeCalls } = makeHandle();
    const p1 = transitionQueueState("chan-1", "msg-1", "QUEUED", handle, resolve);
    await vi.advanceTimersByTimeAsync(250);
    await p1;
    const p2 = transitionQueueState("chan-1", "msg-1", "IN_FLIGHT", handle, resolve);
    await vi.advanceTimersByTimeAsync(250);
    await p2;
    const p3 = transitionQueueState("chan-1", "msg-1", "DELIVERED", handle, resolve);
    await vi.advanceTimersByTimeAsync(250);
    await p3;

    // QUEUED: no prior → addReaction only.
    // IN_FLIGHT: remove hourglass then add loader.
    // DELIVERED: remove loader then add circle_check.
    expect(removeCalls.map((c) => c[2])).toEqual([
      emojiFor("QUEUED"),
      emojiFor("IN_FLIGHT"),
    ]);
    expect(addCalls.map((c) => c[2])).toEqual([
      emojiFor("QUEUED"),
      emojiFor("IN_FLIGHT"),
      emojiFor("DELIVERED"),
    ]);
  });

  it("(a2) missing icon (set not loaded) → NO reaction, NO Unicode fallback", async () => {
    const { handle, addCalls, removeCalls } = makeHandle();
    const noneLoaded = (): string | undefined => undefined;
    const p1 = transitionQueueState("chan-1", "msg-1", "QUEUED", handle, noneLoaded);
    await vi.advanceTimersByTimeAsync(250);
    await p1;
    const p2 = transitionQueueState("chan-1", "msg-1", "IN_FLIGHT", handle, noneLoaded);
    await vi.advanceTimersByTimeAsync(250);
    await p2;
    expect(addCalls.length).toBe(0);
    expect(removeCalls.length).toBe(0);
  });

  it("(b) concurrent calls on same channel serialize — no interleaving", async () => {
    const { handle, addCalls, removeCalls, addImpl } = makeHandle();
    // Slow down addReaction so we can observe serialization.
    const callOrder: string[] = [];
    addImpl.current = async (emoji) => {
      callOrder.push(`add:${emoji}:start`);
      await new Promise((r) => setTimeout(r, 50));
      callOrder.push(`add:${emoji}:end`);
    };
    // Fire 3 transitions without awaiting between them. With the 200ms
    // debounce, only the LATEST target survives the debounce window.
    const p1 = transitionQueueState("chan-1", "msg-1", "QUEUED", handle, resolve);
    const p2 = transitionQueueState("chan-1", "msg-1", "IN_FLIGHT", handle, resolve);
    const p3 = transitionQueueState("chan-1", "msg-1", "DELIVERED", handle, resolve);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([p1, p2, p3]);

    // Only ONE add survives — the latest target (DELIVERED). The other
    // two should no-op out at the debounce gate. Serialization is also
    // visible: no add:X:start appears before the previous add:Y:end.
    expect(addCalls.length).toBe(1);
    expect(addCalls[0][2]).toBe(emojiFor("DELIVERED"));
    // No prior state recorded → no remove call.
    expect(removeCalls.length).toBe(0);

    // Interleaving check — every start must be followed by its end before
    // the next start.
    for (let i = 0; i < callOrder.length; i += 2) {
      expect(callOrder[i]).toMatch(/:start$/);
      expect(callOrder[i + 1]).toMatch(/:end$/);
    }
  });

  it("(c) debounce — fire QUEUED then IN_FLIGHT within 50ms; IN_FLIGHT wins, one transition executed", async () => {
    const { handle, addCalls } = makeHandle();
    const p1 = transitionQueueState("chan-1", "msg-1", "QUEUED", handle, resolve);
    // Advance 50ms then fire IN_FLIGHT — still inside the 200ms window.
    await vi.advanceTimersByTimeAsync(50);
    const p2 = transitionQueueState("chan-1", "msg-1", "IN_FLIGHT", handle, resolve);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([p1, p2]);

    expect(addCalls.length).toBe(1);
    expect(addCalls[0][2]).toBe(emojiFor("IN_FLIGHT"));
  });

  it("(d) rate-limit retry — addReaction throws 429 twice then succeeds; 3 attempts total", async () => {
    const { handle, addCalls, addImpl } = makeHandle();
    let attempts = 0;
    addImpl.current = async () => {
      attempts += 1;
      if (attempts <= 2) {
        // discord.js v14 rate-limit error shape.
        const err = new Error("Too Many Requests") as Error & {
          httpStatus: number;
          status: number;
        };
        err.httpStatus = 429;
        err.status = 429;
        throw err;
      }
    };
    const p = transitionQueueState("chan-1", "msg-1", "QUEUED", handle, resolve);
    // Advance generously to cover debounce + 200ms + 500ms backoff.
    await vi.advanceTimersByTimeAsync(3000);
    await p;

    expect(addCalls.length).toBe(3); // three attempts of the same emoji
    expect(addCalls.every((c) => c[2] === emojiFor("QUEUED"))).toBe(true);
  });

  it("(e) rate-limit budget exceeded — 4 consecutive 429s → 3 attempts, give-up, state NOT updated", async () => {
    const { handle, addCalls, addImpl } = makeHandle();
    addImpl.current = async () => {
      const err = new Error("Too Many Requests") as Error & {
        httpStatus: number;
      };
      err.httpStatus = 429;
      throw err;
    };
    const p = transitionQueueState("chan-1", "msg-1", "QUEUED", handle, resolve);
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    expect(addCalls.length).toBe(3);

    // After give-up, the next transition should attempt remove of NOTHING
    // (state never landed on QUEUED) → no remove call, just a new add.
    const { handle: handle2, addCalls: add2, removeCalls: rm2 } = makeHandle();
    // Re-wire the new handle into the second transition. State memory
    // persists across handles (it's per-channel, not per-handle).
    const p2 = transitionQueueState("chan-1", "msg-1", "IN_FLIGHT", handle2, resolve);
    await vi.advanceTimersByTimeAsync(1000);
    await p2;

    expect(rm2.length).toBe(0); // no prior emoji to remove
    expect(add2.length).toBe(1);
    expect(add2[0][2]).toBe(emojiFor("IN_FLIGHT"));
  });

  it("(f) terminal sticky — DELIVERED state refuses further transitions", async () => {
    const { handle } = makeHandle();
    const p1 = transitionQueueState("chan-1", "msg-1", "DELIVERED", handle, resolve);
    await vi.advanceTimersByTimeAsync(500);
    await p1;

    const { handle: handle2, addCalls: add2, removeCalls: rm2 } = makeHandle();
    const p2 = transitionQueueState("chan-1", "msg-1", "IN_FLIGHT", handle2, resolve);
    await vi.advanceTimersByTimeAsync(500);
    await p2;

    expect(add2.length).toBe(0);
    expect(rm2.length).toBe(0);
  });

  it("(g) idempotent — same-state transition is a no-op", async () => {
    const { handle } = makeHandle();
    const p1 = transitionQueueState("chan-1", "msg-1", "QUEUED", handle, resolve);
    await vi.advanceTimersByTimeAsync(500);
    await p1;

    const { handle: handle2, addCalls: add2, removeCalls: rm2 } = makeHandle();
    const p2 = transitionQueueState("chan-1", "msg-1", "QUEUED", handle2, resolve);
    await vi.advanceTimersByTimeAsync(500);
    await p2;

    expect(add2.length).toBe(0);
    expect(rm2.length).toBe(0);
  });

  it("(h) different channels run in parallel — no cross-channel blocking", async () => {
    const { handle, addCalls, addImpl } = makeHandle();
    const startOrder: string[] = [];
    addImpl.current = async (emoji) => {
      startOrder.push(`${emoji}:start`);
      await new Promise((r) => setTimeout(r, 100));
      startOrder.push(`${emoji}:end`);
    };

    const pA = transitionQueueState("chan-A", "msg-1", "QUEUED", handle, resolve);
    const pB = transitionQueueState("chan-B", "msg-2", "IN_FLIGHT", handle, resolve);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([pA, pB]);

    expect(addCalls.length).toBe(2);
    // Both add calls' :start should appear before either :end —
    // confirming parallel execution across channels.
    const startsBeforeAnyEnd = startOrder.filter((s) =>
      s.endsWith(":start"),
    ).length;
    const firstEndIdx = startOrder.findIndex((s) => s.endsWith(":end"));
    expect(firstEndIdx).toBeGreaterThanOrEqual(2);
    expect(startsBeforeAnyEnd).toBe(2);
  });
});
