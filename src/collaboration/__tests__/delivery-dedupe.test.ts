/**
 * Phase 999.117 WS-2 — cross-path delivery dedupe tests.
 *
 * The behaviour that matters: ONE logical message reaching an agent through
 * several paths produces exactly one turn. Before this, `post_to_agent` wrote
 * an inbox record AND posted a webhook embed; the inbox watcher turned the
 * file into a turn and the Discord relay turned the embed into a second,
 * differently-formatted turn. That is why enabling the webhook rung made the
 * reported loop worse rather than better.
 */

import { describe, it, expect } from "vitest";
import { DeliveryDedupe } from "../delivery-dedupe.js";
import { parseAgentMessageFooter, buildAgentMessageEmbed } from "../../discord/agent-message.js";

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("DeliveryDedupe", () => {
  it("first claimant wins; every later path is suppressed", () => {
    const d = new DeliveryDedupe();
    expect(d.claim("del-1")).toBe(true);
    // inbox watcher, heartbeat sweep, webhook relay, v3 push — same message.
    expect(d.claim("del-1")).toBe(false);
    expect(d.claim("del-1")).toBe(false);
    expect(d.claim("del-1")).toBe(false);
  });

  it("different messages are independent", () => {
    const d = new DeliveryDedupe();
    expect(d.claim("a")).toBe(true);
    expect(d.claim("b")).toBe(true);
  });

  it("always claimable when the id is absent", () => {
    // Legacy on-disk messages predate the envelope. Refusing to deliver them
    // would be a worse failure than an occasional duplicate.
    const d = new DeliveryDedupe();
    expect(d.claim(undefined)).toBe(true);
    expect(d.claim(undefined)).toBe(true);
    expect(d.claim("")).toBe(true);
  });

  it("expires after the TTL so an id cannot suppress forever", () => {
    const clock = makeClock();
    const d = new DeliveryDedupe({ ttlMs: 1000, now: clock.now });
    expect(d.claim("x")).toBe(true);
    expect(d.claim("x")).toBe(false);
    clock.advance(1001);
    expect(d.claim("x")).toBe(true);
  });

  it("is bounded — a long-lived daemon cannot leak", () => {
    const d = new DeliveryDedupe({ cap: 100 });
    for (let i = 0; i < 5000; i++) d.claim(`id-${i}`);
    expect(d.size()).toBeLessThanOrEqual(101);
  });
});

describe("A2A embed footer — the key that makes cross-path dedupe possible", () => {
  it("round-trips sender and delivery id", () => {
    const embed = buildAgentMessageEmbed("admin-clawdy", "Admin Clawdy", "hi", "del-9");
    const parsed = parseAgentMessageFooter(embed.data.footer?.text);
    expect(parsed).toEqual({ senderName: "admin-clawdy", deliveryId: "del-9" });
  });

  it("round-trips an agent name containing spaces", () => {
    // Production has an agent literally named "Admin Clawdy".
    const embed = buildAgentMessageEmbed("Admin Clawdy", "Admin Clawdy", "hi", "del-3");
    const parsed = parseAgentMessageFooter(embed.data.footer?.text);
    expect(parsed).toEqual({ senderName: "Admin Clawdy", deliveryId: "del-3" });
  });

  it("still parses a footer written by an older build (no id)", () => {
    // Append-only contract: the relay must keep recognising in-flight embeds
    // posted before this change, or the webhook rung becomes a black hole.
    const parsed = parseAgentMessageFooter("Agent-to-agent message from projects");
    expect(parsed).toEqual({ senderName: "projects" });
  });

  it("ignores a non-A2A footer", () => {
    expect(parseAgentMessageFooter("some other embed")).toBeUndefined();
    expect(parseAgentMessageFooter(undefined)).toBeUndefined();
  });

  it("end to end: the embed's id collapses to the same claim as the inbox copy", () => {
    // The scenario that used to double-deliver: post_to_agent writes an inbox
    // record with messageId, and posts an embed carrying the SAME id.
    const d = new DeliveryDedupe();
    const messageId = "inbox-msg-1";
    const embed = buildAgentMessageEmbed("a", "A", "hello", messageId);

    // Inbox watcher gets there first.
    expect(d.claim(messageId)).toBe(true);
    // Webhook relay parses the embed and finds it already delivered.
    const parsed = parseAgentMessageFooter(embed.data.footer?.text);
    expect(d.claim(parsed?.deliveryId)).toBe(false);
  });
});
