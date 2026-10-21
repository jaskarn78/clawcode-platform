import { describe, it, expect, vi } from "vitest";
import { deliverAgentText, MAX_MESSAGE_LENGTH } from "../agent-text-delivery.js";

const log = () => ({ info: vi.fn(), warn: vi.fn() });

function sinks(over: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const base = {
    webhookManager: () => undefined,
    botDirectSend: () => async (_c: string, content: string) => {
      sent.push(content);
    },
    channelId: () => "chan-1",
    ...over,
  };
  return { sinks: base as never, sent };
}

describe("deliverAgentText", () => {
  it("posts through the webhook when the agent has one", async () => {
    const send = vi.fn(async () => {});
    const { sinks: s } = sinks({
      webhookManager: () => ({ hasWebhook: () => true, send }) as never,
    });
    const res = await deliverAgentText({ agentName: "a", text: "hello", sinks: s, log: log(), reason: "t" });
    expect(res).toEqual({ ok: true, via: "webhook", chunks: 1 });
    expect(send).toHaveBeenCalledWith("a", "hello");
  });

  it("falls back to bot-direct when there is no webhook", async () => {
    const { sinks: s, sent } = sinks();
    const res = await deliverAgentText({ agentName: "a", text: "hello", sinks: s, log: log(), reason: "t" });
    expect(res.ok).toBe(true);
    expect(sent).toEqual(["hello"]);
  });

  /**
   * The whole point. `sendText` issues ONE channel.send and Discord rejects
   * anything past 2000 with BASE_TYPE_MAX_LENGTH, so an unchunked long summary
   * is not truncated — it is DROPPED. A standup summary is routinely this long.
   */
  it("splits a long reply instead of letting Discord reject it", async () => {
    const { sinks: s, sent } = sinks();
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} of the summary`).join("\n");
    expect(long.length).toBeGreaterThan(MAX_MESSAGE_LENGTH);
    const res = await deliverAgentText({ agentName: "a", text: long, sinks: s, log: log(), reason: "t" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.chunks).toBeGreaterThan(1);
    expect(sent.length).toBeGreaterThan(1);
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  it("sends chunks in order, never concurrently", async () => {
    const order: number[] = [];
    let n = 0;
    const { sinks: s } = sinks({
      botDirectSend: () => async () => {
        const mine = ++n;
        await new Promise((r) => setTimeout(r, mine === 1 ? 20 : 0));
        order.push(mine);
      },
    });
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} of the summary`).join("\n");
    await deliverAgentText({ agentName: "a", text: long, sinks: s, log: log(), reason: "t" });
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("treats an empty reply as nothing to say, not a failure", async () => {
    const { sinks: s, sent } = sinks();
    for (const text of ["", "   ", "\n\n"]) {
      const res = await deliverAgentText({ agentName: "a", text, sinks: s, log: log(), reason: "t" });
      expect(res).toEqual({ ok: false, reason: "empty" });
    }
    expect(sent).toEqual([]);
  });

  it("reports a drop rather than throwing when there is no sink at all", async () => {
    const l = log();
    const res = await deliverAgentText({
      agentName: "a",
      text: "hi",
      sinks: { webhookManager: () => undefined, botDirectSend: () => undefined, channelId: () => undefined } as never,
      log: l,
      reason: "t",
    });
    expect(res).toEqual({ ok: false, reason: "no-sink" });
    expect(l.warn).toHaveBeenCalled();
  });

  it("never throws when Discord does — the caller's pipeline must not wedge", async () => {
    const l = log();
    const { sinks: s } = sinks({
      botDirectSend: () => async () => {
        throw new Error("503 Service Unavailable");
      },
    });
    const res = await deliverAgentText({ agentName: "a", text: "hi", sinks: s, log: l, reason: "t" });
    expect(res).toEqual({ ok: false, reason: "send-failed" });
    expect(l.warn).toHaveBeenCalled();
  });

  it("resolves its sinks at delivery time, not at construction", async () => {
    let sender: ((c: string, t: string) => Promise<void>) | undefined;
    const sent: string[] = [];
    const s = {
      webhookManager: () => undefined,
      botDirectSend: () => sender,
      channelId: () => "chan-1",
    } as never;
    // Boot window: the bot is not wired yet.
    expect((await deliverAgentText({ agentName: "a", text: "hi", sinks: s, log: log(), reason: "t" })).ok).toBe(false);
    sender = async (_c, t) => {
      sent.push(t);
    };
    expect((await deliverAgentText({ agentName: "a", text: "hi", sinks: s, log: log(), reason: "t" })).ok).toBe(true);
    expect(sent).toEqual(["hi"]);
  });
});
