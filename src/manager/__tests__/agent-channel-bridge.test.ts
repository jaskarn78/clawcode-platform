/**
 * Phase 140 Stage 2 (Plan 03) — the 3 reviewed PR-#11 protocol findings.
 *
 * These exercise `AgentChannelBridge` directly (the daemon-side authority).
 * The wider push/ack/inbox/ordering/drop contract is already proven against
 * an in-process mock transport in
 * `src/channels/__tests__/clawcode-channel-server.test.ts`; this file pins the
 * three correctness fixes folded in from the PR-#11 review:
 *
 *   (a) MEMORY LEAK — `tracked` is evicted on ack so a long-lived agent's map
 *       does not grow unbounded. `isAcked` still reports true post-eviction
 *       (backed by a bounded remembered-id set).
 *   (b) MISSED ACK — `rependInFlight` flips in-flight inbox rows back to
 *       pending so a missed ack is redelivered on the next `notifyInbox`
 *       (spec failure-mode: "agent didn't ack within N seconds → retry via inbox").
 *   (c) ACK-BEFORE-REGISTER RACE — `awaitReply` resolves immediately when the
 *       correlation id was already acked before `awaitReply` was called.
 */

import { describe, it, expect, vi } from "vitest";

import {
  AgentChannelBridge,
  V3_CHANNEL_REPLY_TIMEOUT_MS,
} from "../agent-channel-bridge.js";
import { DEFAULT_MAX_TURN_DURATION_MS } from "../stream-stall-tracker.js";
import type { DaemonChannelMessage } from "../../channels/clawcode-channel-server.js";

/** A bridge whose send sink is a spy (no transport — these are bridge-only). */
function makeBridge() {
  const sent: DaemonChannelMessage[] = [];
  const bridge = new AgentChannelBridge("personal", (msg) => {
    sent.push(msg);
  });
  return { bridge, sent };
}

const a2a = (
  id: string,
  content: string,
  meta?: DaemonChannelMessage["meta"],
): DaemonChannelMessage => ({
  type: "a2a",
  message_id: id,
  content,
  meta,
});

describe("finding (a): tracked eviction on ack (no unbounded growth)", () => {
  it("evicts each tracked message after it is acked — trackedSize returns to 0", () => {
    const { bridge } = makeBridge();
    const N = 50;
    for (let i = 0; i < N; i++) bridge.push(a2a(`m${i}`, `content ${i}`));
    expect(bridge.trackedSize()).toBe(N);

    for (let i = 0; i < N; i++) {
      bridge.handleAck({ message_id: `m${i}`, status: "processed" });
    }
    // The live tracked map is drained — no growth across a long-lived agent.
    expect(bridge.trackedSize()).toBe(0);
  });

  it("isAcked stays true after the tracked entry is evicted", () => {
    const { bridge } = makeBridge();
    bridge.push(a2a("m1", "ping"));
    expect(bridge.isAcked("m1")).toBe(false);
    bridge.handleAck({ message_id: "m1", status: "processed" });
    // Evicted from `tracked` but remembered as acked.
    expect(bridge.trackedSize()).toBe(0);
    expect(bridge.isAcked("m1")).toBe(true);
  });

  it("an ack for an already-evicted id is a silent no-op", () => {
    const { bridge } = makeBridge();
    bridge.push(a2a("m1", "ping"));
    bridge.handleAck({ message_id: "m1", status: "processed" });
    expect(() =>
      bridge.handleAck({ message_id: "m1", status: "processed" }),
    ).not.toThrow();
    expect(bridge.isAcked("m1")).toBe(true);
  });

  it("the remembered-acked set is bounded (does not grow unbounded either)", () => {
    const { bridge } = makeBridge();
    // Push + ack far more than the bound; isAcked for the most-recent id holds,
    // the oldest id is forgotten (bounded FIFO, drop-is-silent for the rest).
    const total = 1100; // > the 1024 cap
    for (let i = 0; i < total; i++) {
      bridge.push(a2a(`k${i}`, "x"));
      bridge.handleAck({ message_id: `k${i}`, status: "processed" });
    }
    expect(bridge.trackedSize()).toBe(0);
    expect(bridge.ackedRememberedSize()).toBeLessThanOrEqual(1024);
    expect(bridge.isAcked(`k${total - 1}`)).toBe(true);
    // Oldest is evicted from the bounded set → reported false (already-collected).
    expect(bridge.isAcked("k0")).toBe(false);
  });
});

describe("finding (b): re-pend in-flight rows on missed ack", () => {
  it("rependInFlight flips in-flight rows back to pending so they redeliver", () => {
    const { bridge } = makeBridge();
    bridge.enqueueInbox(a2a("m1", "one"));
    bridge.enqueueInbox(a2a("m2", "two"));
    const pendingBefore = bridge.pendingCount();
    expect(pendingBefore).toBe(2);

    // Agent drained but never acked (missed ack): rows go in-flight.
    bridge.handleInboxRead({ max_count: 10 });
    expect(bridge.inFlightCount()).toBe(2);
    expect(bridge.pendingCount()).toBe(0);

    // The spec's missed-ack retry: re-pend so notifyInbox re-announces them.
    const repended = bridge.rependInFlight();
    expect(repended).toBe(2);
    expect(bridge.inFlightCount()).toBe(0);
    expect(bridge.pendingCount()).toBe(pendingBefore);
  });

  it("rependInFlight re-announces via the next notifyInbox", () => {
    const { bridge, sent } = makeBridge();
    bridge.enqueueInbox(a2a("m1", "one"));
    bridge.handleInboxRead({ max_count: 10 });
    expect(bridge.pendingCount()).toBe(0);

    // No pending rows → notifyInbox is a no-op.
    bridge.notifyInbox("evt_1");
    expect(sent).toHaveLength(0);

    bridge.rependInFlight();
    bridge.notifyInbox("evt_2");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("inbox");
    expect(sent[0]?.meta?.message_count).toBe(1);
  });

  it("rependInFlight honours an optional filter_type", () => {
    const { bridge } = makeBridge();
    bridge.enqueueInbox(a2a("m1", "chat"));
    bridge.enqueueInbox({ type: "memory", message_id: "m2", content: "fact" });
    bridge.handleInboxRead({ max_count: 10 });
    expect(bridge.inFlightCount()).toBe(2);

    const repended = bridge.rependInFlight("memory");
    expect(repended).toBe(1);
    expect(bridge.pendingCount()).toBe(1);
    expect(bridge.inFlightCount()).toBe(1);
  });
});

describe("Phase 141: ack message_id is tolerant of the discord- prefix drift", () => {
  it("resolves awaitReply when the agent acks with the prefix STRIPPED (envelope discord-<id> → ack <id>)", async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = makeBridge();
      // The bridge pushes with message_id = correlationId = "discord-<snowflake>".
      bridge.push(
        a2a("discord-000000000000000116", "What day/time is it?", {
          reply_correlation_id: "discord-000000000000000116",
        }),
      );
      const replyP = bridge.awaitReply("discord-000000000000000116", 30_000);
      // The model dropped the "discord-" prefix when copying the id (observed live).
      bridge.handleAck({
        message_id: "000000000000000116",
        status: "processed",
        result: "It's Saturday, May 30, 2026 — 20:45 UTC.",
      });
      const reply = await replyP;
      expect(reply.result).toBe("It's Saturday, May 30, 2026 — 20:45 UTC.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves when the agent ADDS a discord- prefix the envelope didn't have", async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = makeBridge();
      bridge.push(a2a("m1", "ping", { reply_correlation_id: "req_1" }));
      const replyP = bridge.awaitReply("req_1", 30_000);
      bridge.handleAck({ message_id: "discord-m1", status: "processed", result: "ok" });
      expect((await replyP).result).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a genuinely unknown id is still a silent no-op (does not resolve)", () => {
    const { bridge } = makeBridge();
    bridge.push(a2a("discord-m1", "ping", { reply_correlation_id: "req_1" }));
    // unrelated id — must NOT match via prefix toggling.
    expect(() =>
      bridge.handleAck({ message_id: "totally-other", status: "processed" }),
    ).not.toThrow();
    expect(bridge.isAcked("discord-m1")).toBe(false);
  });
});

describe("finding (c): awaitReply resolves immediately for an already-acked id", () => {
  it("resolves synchronously when the correlated message was acked before awaitReply", async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = makeBridge();
      bridge.push(a2a("m1", "question", { reply_correlation_id: "req_1" }));
      // Ack arrives FIRST (before any caller registered an awaitReply).
      bridge.handleAck({
        message_id: "m1",
        status: "processed",
        result: "answer",
      });
      // Now a caller awaits — must resolve without advancing the fake timers.
      const reply = await bridge.awaitReply("req_1", 30_000);
      expect(reply).toMatchObject({
        message_id: "m1",
        status: "processed",
        result: "answer",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rejects on timeout when the correlation was never acked", async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = makeBridge();
      bridge.push(a2a("m1", "q", { reply_correlation_id: "req_x" }));
      const replyP = bridge.awaitReply("req_x", 50);
      const assertion = expect(replyP).rejects.toMatchObject({
        name: "ChannelReplyTimeoutError",
      });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("the live awaitReply path (register then ack) still resolves", async () => {
    const { bridge } = makeBridge();
    bridge.push(a2a("m1", "question", { reply_correlation_id: "req_live" }));
    const replyP = bridge.awaitReply("req_live", 1_000);
    bridge.handleAck({ message_id: "m1", status: "processed", result: "ok" });
    await expect(replyP).resolves.toMatchObject({ status: "processed" });
  });
});

describe("Stop-hook deterministic delivery fallback (handleTurnComplete)", () => {
  // BRANCH 1 — agent did NOT ack: the fallback resolves the pending reply with
  // the agent's final assistant message (the reliability guarantee).
  it("resolves a still-pending awaitReply with the final assistant message", async () => {
    const { bridge } = makeBridge();
    bridge.push(a2a("m1", "what's the weather?", { reply_correlation_id: "disc-1" }));
    const replyP = bridge.awaitReply("disc-1", 1_000);

    const resolved = bridge.handleTurnComplete("It's sunny, 72°F.");
    expect(resolved).toBe(1);
    await expect(replyP).resolves.toMatchObject({
      status: "processed",
      result: "It's sunny, 72°F.",
    });
  });

  // BRANCH 2 — agent DID ack (ack lands mid-turn, before the Stop hook): the
  // fallback finds nothing pending → no-op, NO double-delivery. The reply keeps
  // the ACK's result, not the hook's trailing "Replied to the user" note.
  it("is a no-op when the agent already acked (no double-post)", async () => {
    const { bridge } = makeBridge();
    bridge.push(a2a("m1", "what's the weather?", { reply_correlation_id: "disc-2" }));
    const replyP = bridge.awaitReply("disc-2", 1_000);

    bridge.handleAck({ message_id: "m1", status: "processed", result: "It's sunny, 72°F." });
    // Stop hook fires AFTER the ack with the agent's trailing meta-note.
    const resolved = bridge.handleTurnComplete("Replied to the user. 👋");

    expect(resolved).toBe(0); // nothing pending → fallback did not fire
    await expect(replyP).resolves.toMatchObject({ result: "It's sunny, 72°F." });
  });

  // BRANCH 3 — hook fires FIRST (race), then a late real ack: the late ack must
  // be a silent no-op (the tracked entry was evicted) — never a second resolve.
  it("a late ack after the fallback resolves is a silent no-op", async () => {
    const { bridge } = makeBridge();
    bridge.push(a2a("m1", "ping", { reply_correlation_id: "disc-3" }));
    const replyP = bridge.awaitReply("disc-3", 1_000);

    expect(bridge.handleTurnComplete("pong")).toBe(1);
    await expect(replyP).resolves.toMatchObject({ result: "pong" });

    // Late ack for the same message — must not throw, must not re-resolve.
    expect(() =>
      bridge.handleAck({ message_id: "m1", status: "processed", result: "late" }),
    ).not.toThrow();
    // A new awaitReply for the same correlation resolves from the remembered
    // fallback result (drop-is-silent: the late ack was ignored).
    await expect(bridge.awaitReply("disc-3", 50)).resolves.toMatchObject({
      result: "pong",
    });
  });

  it("returns 0 when there are no pending replies", () => {
    const { bridge } = makeBridge();
    expect(bridge.handleTurnComplete("nothing pending")).toBe(0);
  });

  // BRANCH 4 — Phase 141 A1 FAIL-CLOSED. With >1 pending reply (reachable
  // because the v3 push+awaitReply path is not daemon-serialized: ask-agent
  // IPC / slash skill-turns / Discord chat share this bridge), the Stop-hook
  // frame cannot correlate (no message_id), so it resolves NONE — leaving both
  // pending for a visible timeout rather than mis-delivering one turn's text to
  // the wrong caller.
  it("is fail-closed with >1 pending reply (no mis-delivery, both time out)", async () => {
    const { bridge } = makeBridge();
    bridge.push(a2a("m1", "first", { reply_correlation_id: "disc-A" }));
    bridge.push(a2a("m2", "second", { reply_correlation_id: "disc-B" }));
    const replyA = bridge.awaitReply("disc-A", 80);
    const replyB = bridge.awaitReply("disc-B", 80);

    // Two pending → ambiguous correlation → fallback bails, resolves neither.
    expect(bridge.handleTurnComplete("ambiguous final text")).toBe(0);

    // Neither is resolved with the ambiguous text; both reject on timeout.
    await expect(replyA).rejects.toThrow();
    await expect(replyB).rejects.toThrow();
  });
});

describe("cancelPendingReplies (Phase 141 1C — /clawcode-interrupt abort cleanup)", () => {
  it("rejects pending awaitReply(s), returns the count, evicts tracked (late ack is silent)", async () => {
    const { bridge } = makeBridge();
    bridge.push(a2a("m1", "long task", { reply_correlation_id: "corr-X" }));
    const replyP = bridge.awaitReply("corr-X", 5_000);

    expect(bridge.cancelPendingReplies("/clawcode-interrupt")).toBe(1);
    // The blocked caller throws AT ONCE instead of hanging to the 120s timeout.
    await expect(replyP).rejects.toThrow(/aborted/);

    // tracked was evicted → a late real ack for the aborted turn is a silent no-op.
    expect(() =>
      bridge.handleAck({ message_id: "m1", status: "processed", result: "late" }),
    ).not.toThrow();
    expect(bridge.trackedSize()).toBe(0);
  });

  it("is a no-op when nothing is pending", () => {
    const { bridge } = makeBridge();
    expect(bridge.cancelPendingReplies("noop")).toBe(0);
  });
});

describe("999.82: onProgress fanout (NEVER resolves awaitReply)", () => {
  /** Resolve a promise to a sentinel after `ms` to detect "still pending". */
  function settleOrPending<T>(p: Promise<T>, ms = 100): Promise<T | "PENDING"> {
    return Promise.race([
      p,
      new Promise<"PENDING">((res) => setTimeout(() => res("PENDING"), ms)),
    ]);
  }

  it("fans out accumulated text to a registered callback", () => {
    const { bridge } = makeBridge();
    const seen: string[] = [];
    bridge.registerProgressCallback((text) => seen.push(text));

    bridge.onProgress("step 1");
    bridge.onProgress("step 1 and 2");

    expect(seen).toEqual(["step 1", "step 1 and 2"]);
  });

  it("is a no-op with no callback registered", () => {
    const { bridge } = makeBridge();
    expect(() => bridge.onProgress("orphan")).not.toThrow();
  });

  it("clearProgressCallback stops further fanout", () => {
    const { bridge } = makeBridge();
    const seen: string[] = [];
    bridge.registerProgressCallback((text) => seen.push(text));
    bridge.onProgress("a");
    bridge.clearProgressCallback();
    bridge.onProgress("b");
    expect(seen).toEqual(["a"]);
  });

  it("does NOT resolve a concurrently-pending awaitReply (delivery truth stays with ack/turn_complete)", async () => {
    const { bridge } = makeBridge();
    // A push carrying a reply correlation, and a caller blocking on its ack.
    bridge.push(a2a("m1", "do work", { reply_correlation_id: "corr-1" }));
    const replyP = bridge.awaitReply("corr-1", 5_000);

    const seen: string[] = [];
    bridge.registerProgressCallback((text) => seen.push(text));

    // Fire progress repeatedly — it must touch ONLY the callback, never the
    // pendingReplies map.
    bridge.onProgress("partial 1");
    bridge.onProgress("partial 2");

    expect(seen).toEqual(["partial 1", "partial 2"]);
    // The pending reply is still alive — progress did not resolve it.
    await expect(settleOrPending(replyP)).resolves.toBe("PENDING");
    // The tracked entry was untouched by progress.
    expect(bridge.trackedSize()).toBe(1);

    // turn_complete is what actually resolves it (delivery truth).
    expect(bridge.handleTurnComplete("the real answer")).toBe(1);
    await expect(replyP).resolves.toMatchObject({ result: "the real answer" });
  });
});

/**
 * v3 channel reply timeout (2026-06-14 research-agent fix). The old hardcoded
 * 120s `awaitReply` cap rejected every real research turn before it could
 * finish (live: real turns died at totalMs ≈ 120001; only sub-second turns
 * succeeded). The fix raises both v3-chat call sites to
 * V3_CHANNEL_REPLY_TIMEOUT_MS, which MUST exceed the stall tracker's absolute
 * max-turn-duration ceiling so a long-but-healthy turn delivers on its own
 * completion (Stop hook) and a wedged turn is force-settled by the ceiling just
 * INSIDE this window.
 */
describe("V3_CHANNEL_REPLY_TIMEOUT_MS — v3 channel reply timeout invariant", () => {
  it("exceeds the stall tracker's max-turn-duration ceiling (turn completes before the reply times out)", () => {
    expect(V3_CHANNEL_REPLY_TIMEOUT_MS).toBeGreaterThan(
      DEFAULT_MAX_TURN_DURATION_MS,
    );
  });

  it("is far above the old 120s cap that rejected real research turns", () => {
    expect(V3_CHANNEL_REPLY_TIMEOUT_MS).toBeGreaterThan(120_000);
  });
});
