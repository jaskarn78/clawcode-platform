/**
 * Phase 140 Stage 1.5 — ClawCode channel protocol semantics.
 *
 * Proves the push / ack / inbox / ordering / drop contract against an
 * in-process mock transport: the daemon-side `AgentChannelBridge` and the
 * agent-side `ClawcodeChannelServerCore` are linked directly (no PTY, no real
 * claude, no MCP/socket). This is the highest-leverage de-risk — the protocol
 * is the part most likely to be subtly wrong.
 */

import { describe, it, expect, vi } from "vitest";

import {
  ClawcodeChannelServerCore,
  toChannelNotification,
  type ChannelNotification,
  type DaemonChannelMessage,
} from "../clawcode-channel-server.js";
import {
  AgentChannelBridge,
  ChannelReplyTimeoutError,
} from "../../manager/agent-channel-bridge.js";

/** Wire a bridge + server core through an in-process mock transport. */
function makeLinkedPair() {
  const notifications: ChannelNotification[] = [];
  let core!: ClawcodeChannelServerCore;
  // Daemon → agent: the bridge's send sink delivers straight into the core,
  // which emits an MCP notification captured by the array below.
  const bridge = new AgentChannelBridge("personal", (msg) =>
    core.onDaemonMessage(msg),
  );
  core = new ClawcodeChannelServerCore(
    (n) => notifications.push(n),
    bridge,
  );
  return { bridge, core, notifications };
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

describe("toChannelNotification", () => {
  it("flattens type + message_id + meta into the <channel> envelope shape", () => {
    const n = toChannelNotification(
      a2a("msg_1", "hello", {
        source_agent: "research",
        priority: "high",
        reply_correlation_id: "req_1",
      }),
    );
    expect(n.method).toBe("notifications/claude/channel");
    expect(n.params.content).toBe("hello");
    expect(n.params.meta).toEqual({
      type: "a2a",
      message_id: "msg_1",
      source_agent: "research",
      priority: "high",
      reply_correlation_id: "req_1",
    });
  });
});

describe("push delivery", () => {
  it("delivers a pushed event to the agent as a single notification", () => {
    const { bridge, notifications } = makeLinkedPair();
    bridge.push(a2a("msg_1", "ping", { source_agent: "research" }));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.params.meta.message_id).toBe("msg_1");
    expect(notifications[0]?.params.content).toBe("ping");
  });

  it("carries priority through to the notification meta", () => {
    const { bridge, notifications } = makeLinkedPair();
    bridge.push(a2a("msg_p", "urgent", { priority: "high" }));
    expect(notifications[0]?.params.meta.priority).toBe("high");
  });
});

describe("ack", () => {
  it("clears the tracked message and is observable via isAcked", () => {
    const { bridge, core } = makeLinkedPair();
    bridge.push(a2a("msg_1", "ping"));
    expect(bridge.isAcked("msg_1")).toBe(false);
    core.onAckTool({ message_id: "msg_1", status: "processed" });
    expect(bridge.isAcked("msg_1")).toBe(true);
  });

  it("resolves awaitReply when the message carried reply_correlation_id", async () => {
    const { bridge, core } = makeLinkedPair();
    bridge.push(a2a("msg_1", "question", { reply_correlation_id: "req_1" }));
    const replyP = bridge.awaitReply("req_1", 1_000);
    core.onAckTool({
      message_id: "msg_1",
      status: "processed",
      result: "the answer is 42",
    });
    await expect(replyP).resolves.toMatchObject({
      message_id: "msg_1",
      status: "processed",
      result: "the answer is 42",
    });
  });

  it("awaitReply rejects after the timeout when no ack arrives", async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = makeLinkedPair();
      bridge.push(a2a("msg_1", "q", { reply_correlation_id: "req_x" }));
      const replyP = bridge.awaitReply("req_x", 50);
      const assertion = expect(replyP).rejects.toBeInstanceOf(
        ChannelReplyTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("inbox drain", () => {
  it("drains up to max_count in insertion order and marks them in-flight", () => {
    const { bridge, core } = makeLinkedPair();
    bridge.enqueueInbox(a2a("m1", "one"));
    bridge.enqueueInbox(a2a("m2", "two"));
    bridge.enqueueInbox(a2a("m3", "three"));
    expect(bridge.pendingCount()).toBe(3);

    const first = core.onInboxReadTool({ max_count: 2 });
    expect(first.map((e) => e.message_id)).toEqual(["m1", "m2"]);
    expect(bridge.inFlightCount()).toBe(2);
    expect(bridge.pendingCount()).toBe(1);

    // A second read does not re-drain in-flight rows.
    const second = core.onInboxReadTool({ max_count: 10 });
    expect(second.map((e) => e.message_id)).toEqual(["m3"]);
  });

  it("requires a per-envelope ack — ack clears the inbox row", () => {
    const { bridge, core } = makeLinkedPair();
    bridge.enqueueInbox(a2a("m1", "one"));
    bridge.enqueueInbox(a2a("m2", "two"));
    core.onInboxReadTool({ max_count: 10 });
    expect(bridge.inFlightCount()).toBe(2);

    core.onAckTool({ message_id: "m1", status: "processed" });
    expect(bridge.inFlightCount()).toBe(1);
    core.onAckTool({ message_id: "m2", status: "processed" });
    expect(bridge.inFlightCount()).toBe(0);
  });

  it("filters by filter_type when set", () => {
    const { bridge, core } = makeLinkedPair();
    bridge.enqueueInbox(a2a("m1", "chat"));
    bridge.enqueueInbox({ type: "memory", message_id: "m2", content: "fact" });
    bridge.enqueueInbox(a2a("m3", "chat2"));

    const drained = core.onInboxReadTool({ filter_type: "memory" });
    expect(drained.map((e) => e.message_id)).toEqual(["m2"]);
    expect(bridge.pendingCount()).toBe(2);
  });

  it("notifyInbox announces the pending count + drain tool, and no-ops when empty", () => {
    const { bridge, notifications } = makeLinkedPair();
    bridge.enqueueInbox(a2a("m1", "one"));
    bridge.enqueueInbox(a2a("m2", "two"));
    bridge.notifyInbox("inbox_evt_1");

    expect(notifications).toHaveLength(1);
    const meta = notifications[0]?.params.meta as Record<string, unknown>;
    expect(meta.type).toBe("inbox");
    expect(meta.message_count).toBe(2);
    expect(meta.drain_via).toBe("clawcode_inbox_read");

    // Drain + ack everything, then a second announce is a no-op.
    core_drainAndAck(bridge, notifications);
  });
});

function core_drainAndAck(
  bridge: AgentChannelBridge,
  notifications: ChannelNotification[],
): void {
  const before = notifications.length;
  // Empty inbox → notifyInbox is a no-op (no extra notification).
  bridge.handleInboxRead({ max_count: 100 }).forEach((e) =>
    bridge.handleAck({ message_id: e.message_id, status: "processed" }),
  );
  bridge.notifyInbox("inbox_evt_2");
  expect(notifications.length).toBe(before);
}

describe("drop-is-silent (ack is the only delivery truth)", () => {
  it("a dropped notification leaves the inbox row pending and never throws", () => {
    const { bridge } = makeLinkedPair();
    // Enqueue but simulate the notification being dropped: we never deliver an
    // ack. The row must stay pending; nothing throws.
    bridge.enqueueInbox(a2a("m1", "one"));
    expect(bridge.pendingCount()).toBe(1);
    expect(bridge.isAcked("m1")).toBe(false);
  });

  it("an ack for an unknown message_id is a silent no-op", () => {
    const { bridge, core } = makeLinkedPair();
    expect(() =>
      core.onAckTool({ message_id: "never_seen", status: "processed" }),
    ).not.toThrow();
    expect(bridge.isAcked("never_seen")).toBe(false);
  });
});

describe("status relay", () => {
  it("records the agent's last reported status", () => {
    const { bridge, core } = makeLinkedPair();
    expect(bridge.getLastStatus()).toBeNull();
    core.onStatusTool({ state: "working", context_pct: 42 });
    expect(bridge.getLastStatus()).toMatchObject({
      state: "working",
      context_pct: 42,
    });
  });
});
