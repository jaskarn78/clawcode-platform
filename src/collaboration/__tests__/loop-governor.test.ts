/**
 * Phase 999.117 WS-3 — loop governor tests.
 *
 * The headline test is `terminates an unbounded A↔B ping-pong`: before this
 * module that exchange ran forever, because the system had no bound of any
 * kind on a genuine two-agent conversation. Everything else here exists to
 * pin the individual bounds so a future tweak cannot silently disable one.
 */

import { describe, it, expect, vi } from "vitest";
import {
  LoopGovernor,
  DEFAULT_LOOP_GOVERNOR_CONFIG,
  type LoopGovernorConfig,
  type LoopGovernorInput,
  type BreakerOpenEvent,
} from "../loop-governor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function makeGovernor(
  overrides: Partial<LoopGovernorConfig> = {},
  onBreakerOpen?: (e: BreakerOpenEvent) => void,
) {
  const clock = makeClock();
  const governor = new LoopGovernor({
    config: { ...DEFAULT_LOOP_GOVERNOR_CONFIG, ...overrides },
    now: clock.now,
    onBreakerOpen,
  });
  return { governor, clock };
}

/** Input with NO envelope - exactly what production supplies. */
function msgNoEnvelope(): LoopGovernorInput {
  return { from: "admin-clawdy", to: "projects", kind: "message", autoSubmitted: false };
}

function msg(overrides: Partial<LoopGovernorInput> = {}): LoopGovernorInput {
  return {
    from: "admin-clawdy",
    to: "projects",
    conversationId: "conv-1",
    hops: 1,
    kind: "message",
    autoSubmitted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The behaviour that motivated the module
// ---------------------------------------------------------------------------

describe("LoopGovernor — the endless loop", () => {
  it("terminates an unbounded A↔B ping-pong", () => {
    // Simulate exactly the reported failure: two agents alternating replies,
    // each one a legitimate response to the last, forever. Alternating means
    // the consecutive-run bound never fires — this is the case that needs
    // the hop ceiling.
    const { governor } = makeGovernor();
    const pair = ["admin-clawdy", "projects"] as const;

    let delivered = 0;
    let stoppedAt: number | undefined;

    for (let hop = 1; hop <= 100; hop++) {
      const from = pair[(hop - 1) % 2];
      const to = pair[hop % 2];
      const verdict = governor.evaluate(
        msg({ from, to, conversationId: "runaway", hops: hop }),
      );
      if (!verdict.allow) {
        stoppedAt = hop;
        break;
      }
      delivered++;
    }

    // It stops, and it stops early — not after 100 turns of billing.
    expect(stoppedAt).toBeDefined();
    expect(delivered).toBeLessThanOrEqual(DEFAULT_LOOP_GOVERNOR_CONFIG.maxHops);
  });

  it("does not interfere with a normal short exchange", () => {
    // A three-hop question → answer → thanks must pass untouched. A guard
    // that cuts off legitimate collaboration is worse than no guard, because
    // it gets switched off.
    const { governor } = makeGovernor();
    const pair = ["admin-clawdy", "projects"] as const;

    for (let hop = 1; hop <= 3; hop++) {
      const verdict = governor.evaluate(
        msg({
          from: pair[(hop - 1) % 2],
          to: pair[hop % 2],
          conversationId: "normal",
          hops: hop,
        }),
      );
      expect(verdict.allow).toBe(true);
      expect(verdict.tripped).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Each bound, pinned independently
// ---------------------------------------------------------------------------

describe("LoopGovernor — bounds", () => {
  it("max-hops: trips past the hop ceiling", () => {
    const { governor } = makeGovernor({ maxHops: 3, maxConsecutiveAutoReplies: 99 });
    const pair = ["a", "b"] as const;
    const verdicts = [1, 2, 3, 4].map((hop) =>
      governor.evaluate(
        msg({ from: pair[(hop - 1) % 2], to: pair[hop % 2], hops: hop }),
      ),
    );
    expect(verdicts.slice(0, 3).every((v) => v.allow)).toBe(true);
    expect(verdicts[3].allow).toBe(false);
    expect(verdicts[3].rule).toBe("max-hops");
  });

  it("consecutive-auto-replies: trips on a one-sided run", () => {
    // One agent messaging the same target repeatedly with nobody replying.
    const { governor } = makeGovernor({ maxConsecutiveAutoReplies: 2 });
    const results = [1, 2, 3].map((hop) => governor.evaluate(msg({ hops: hop })));
    expect(results[0].allow).toBe(true);
    expect(results[1].allow).toBe(true);
    expect(results[2].allow).toBe(false);
    expect(results[2].rule).toBe("consecutive-auto-replies");
  });

  it("pair-rate: trips on a burst inside the window", () => {
    const { governor } = makeGovernor({
      pairWindowMax: 3,
      maxConsecutiveAutoReplies: 99,
      maxHops: 99,
    });
    const pair = ["a", "b"] as const;
    const verdicts = [1, 2, 3, 4].map((hop) =>
      governor.evaluate(
        msg({ from: pair[(hop - 1) % 2], to: pair[hop % 2], hops: hop }),
      ),
    );
    // a→b is hops 1 and 3; b→a is 2 and 4. Each pair budget is separate, so
    // nothing trips at 4 messages total with a per-pair limit of 3.
    expect(verdicts.every((v) => v.allow)).toBe(true);
  });

  it("pair-rate: window slides, so a paced sender is never blocked", () => {
    const { governor, clock } = makeGovernor({
      pairWindowMax: 2,
      pairWindowMs: 1000,
      maxConsecutiveAutoReplies: 99,
      maxHops: 99,
      conversationCap: 99,
    });
    expect(governor.evaluate(msg({ hops: 1 })).allow).toBe(true);
    expect(governor.evaluate(msg({ hops: 2 })).allow).toBe(true);
    clock.advance(2000); // window fully expires
    expect(governor.evaluate(msg({ hops: 3 })).allow).toBe(true);
  });

  it("conversation-cap: the unconditional kill switch still fires", () => {
    // Every structural bound disabled — only the raw count remains. This is
    // the bound that cannot be gamed by alternating senders or resetting
    // hop counts, and it must never be removed.
    const { governor } = makeGovernor({
      maxHops: 9999,
      maxConsecutiveAutoReplies: 9999,
      pairWindowMax: 9999,
      conversationCap: 4,
    });
    const pair = ["a", "b"] as const;
    const verdicts = Array.from({ length: 5 }, (_, i) => i + 1).map((hop) =>
      governor.evaluate(
        msg({ from: pair[(hop - 1) % 2], to: pair[hop % 2], hops: hop }),
      ),
    );
    expect(verdicts.slice(0, 4).every((v) => v.allow)).toBe(true);
    expect(verdicts[4].allow).toBe(false);
    expect(verdicts[4].rule).toBe("conversation-cap");
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("LoopGovernor — circuit breaker", () => {
  it("alerts ONCE on open, not once per suppressed message", () => {
    // The operator gets told about a wedged pair; they do not get buried.
    const onBreakerOpen = vi.fn();
    const { governor } = makeGovernor({ maxConsecutiveAutoReplies: 1 }, onBreakerOpen);

    governor.evaluate(msg({ hops: 1 }));
    for (let i = 2; i <= 10; i++) governor.evaluate(msg({ hops: i }));

    expect(onBreakerOpen).toHaveBeenCalledTimes(1);
    const event = onBreakerOpen.mock.calls[0][0] as BreakerOpenEvent;
    expect(event.rule).toBe("consecutive-auto-replies");
    expect(event.reopensAt).toBeGreaterThan(event.openedAt);
  });

  it("suppresses further traffic on the pair while open", () => {
    const { governor } = makeGovernor({ maxConsecutiveAutoReplies: 1 });
    governor.evaluate(msg({ hops: 1 }));
    governor.evaluate(msg({ hops: 2 })); // trips
    const after = governor.evaluate(
      msg({ hops: 3, conversationId: "a-totally-different-conversation" }),
    );
    // A fresh conversation id must NOT be an escape hatch — the breaker is
    // on the PAIR, precisely so an agent cannot reset its way out.
    expect(after.allow).toBe(false);
    expect(after.rule).toBe("breaker-open");
  });

  it("reopens after the cooldown", () => {
    const { governor, clock } = makeGovernor({
      maxConsecutiveAutoReplies: 1,
      breakerCooldownMs: 1000,
    });
    governor.evaluate(msg({ hops: 1 }));
    expect(governor.evaluate(msg({ hops: 2 })).allow).toBe(false);
    clock.advance(1001);
    expect(governor.evaluate(msg({ hops: 1, conversationId: "fresh" })).allow).toBe(true);
  });

  it("does not block the reverse direction", () => {
    // A→B wedging must not silence B→A; they are separate budgets.
    const { governor } = makeGovernor({ maxConsecutiveAutoReplies: 1 });
    governor.evaluate(msg({ from: "a", to: "b", hops: 1 }));
    expect(governor.evaluate(msg({ from: "a", to: "b", hops: 2 })).allow).toBe(false);
    expect(
      governor.evaluate(
        msg({ from: "b", to: "a", conversationId: "other", hops: 1 }),
      ).allow,
    ).toBe(true);
  });

  it("reset() clears a wedged pair", () => {
    const { governor } = makeGovernor({ maxConsecutiveAutoReplies: 1 });
    governor.evaluate(msg({ hops: 1 }));
    governor.evaluate(msg({ hops: 2 }));
    expect(governor.isBreakerOpen("admin-clawdy", "projects")).toBe(true);
    governor.reset("admin-clawdy", "projects");
    expect(governor.isBreakerOpen("admin-clawdy", "projects")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Derived conversations - the bit that makes the bounds real in production
// ---------------------------------------------------------------------------

describe("LoopGovernor - derived conversations", () => {
  it("groups a live A<->B exchange into ONE conversation with rising hops", () => {
    // Callers supply no conversation id (the tool schemas have no field for
    // one, and the recipient never sees an id to thread back), so the
    // governor must derive it or every message looks like hop 1 forever.
    const { governor } = makeGovernor({ mode: "shadow" });
    const pair = ["a", "b"] as const;
    const verdicts = [0, 1, 2, 3].map((i) =>
      governor.evaluate({
        from: pair[i % 2],
        to: pair[(i + 1) % 2],
        kind: "message",
        autoSubmitted: false,
      }),
    );
    expect(new Set(verdicts.map((v) => v.conversationId)).size).toBe(1);
    expect(verdicts.map((v) => v.hops)).toEqual([1, 2, 3, 4]);
  });

  it("opens a NEW conversation after conversationIdleMs of silence", () => {
    const { governor, clock } = makeGovernor({ conversationIdleMs: 1000 });
    const first = governor.evaluate(msgNoEnvelope());
    clock.advance(5000);
    const second = governor.evaluate(msgNoEnvelope());
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(second.hops).toBe(1);
  });

  it("an explicit conversationId still wins", () => {
    const { governor } = makeGovernor({ mode: "shadow" });
    const v = governor.evaluate({ ...msgNoEnvelope(), conversationId: "explicit" });
    expect(v.conversationId).toBe("explicit");
  });

  it("agent names containing spaces cannot collide in the key", () => {
    // Production has an agent literally named "Admin Clawdy". With a
    // printable separator, ("a", "b c") and ("a b", "c") would share a
    // budget; the separator is NUL precisely so they cannot.
    const { governor } = makeGovernor({ mode: "shadow" });
    const one = governor.evaluate({
      from: "a",
      to: "b c",
      kind: "message",
      autoSubmitted: false,
    });
    const two = governor.evaluate({
      from: "a b",
      to: "c",
      kind: "message",
      autoSubmitted: false,
    });
    expect(one.conversationId).not.toBe(two.conversationId);
  });
});

// ---------------------------------------------------------------------------
// RFC 3834 - auto-submitted traffic
// ---------------------------------------------------------------------------

describe("LoopGovernor - acks do not consume the rate budget", () => {
  it("exempts autoSubmitted traffic from the pair rate window", () => {
    // Every genuine message generates a reverse-direction ack. Charging acks
    // against the window would let a brisk but perfectly legitimate exchange
    // trip on its own receipts - and under `enforce` that false block would
    // be the operator's first experience of the feature. RFC 3834's rule is
    // that auto-submitted mail must not TRIGGER a response, not that it
    // consumes the budget.
    const { governor } = makeGovernor({
      pairWindowMax: 2,
      maxConsecutiveAutoReplies: 99,
      maxHops: 99,
      conversationCap: 99,
    });
    for (let i = 0; i < 10; i++) {
      const v = governor.evaluate({
        from: "b",
        to: "a",
        kind: "ack",
        autoSubmitted: true,
      });
      expect(v.allow).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe("LoopGovernor — modes", () => {
  it("shadow: reports the trip but always allows", () => {
    const { governor } = makeGovernor({ mode: "shadow", maxConsecutiveAutoReplies: 1 });
    governor.evaluate(msg({ hops: 1 }));
    const verdict = governor.evaluate(msg({ hops: 2 }));
    // The gap between `tripped` and `allow` IS shadow mode — it is how a
    // threshold gets measured against real traffic before being enforced.
    expect(verdict.tripped).toBe(true);
    expect(verdict.rule).toBe("consecutive-auto-replies");
    expect(verdict.allow).toBe(true);
  });

  it("off: no evaluation at all", () => {
    const { governor } = makeGovernor({ mode: "off", maxConsecutiveAutoReplies: 1 });
    for (let i = 1; i <= 50; i++) {
      const v = governor.evaluate(msg({ hops: i }));
      expect(v.allow).toBe(true);
      expect(v.tripped).toBe(false);
    }
    expect(governor.trackedConversations()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Memory safety
// ---------------------------------------------------------------------------

describe("LoopGovernor — bounded state", () => {
  it("caps tracked conversations so a long-lived daemon cannot leak", () => {
    const { governor } = makeGovernor({ maxConsecutiveAutoReplies: 9999 });
    for (let i = 0; i < 5000; i++) {
      governor.evaluate(msg({ conversationId: `c-${i}`, hops: 1 }));
    }
    expect(governor.trackedConversations()).toBeLessThanOrEqual(2049);
  });
});
