/**
 * 999.173 — a research synthesis carries `replyTo`: it posts as a reply to the
 * message that asked (chunk 1 carries the reference), in that channel, with no
 * ⏱️ self-fired marker. Without a reply sender it degrades to plain posts.
 */
import { describe, expect, it, vi } from "vitest";
import { makeOrphanDeliveryCallback, ORPHAN_OUTPUT_PREFIX } from "../orphan-delivery-callback.js";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const REPLY_TO = { channelId: "chan-origin", messageId: "msg-1" };

function deps(opts: { withReply?: boolean } = {}) {
  const sent: { channelId: string; content: string }[] = [];
  const replies: { channelId: string; content: string; replyTo: string }[] = [];
  return {
    sent,
    replies,
    d: {
      agentName: "personal",
      webhookManagerProvider: () => undefined,
      botDirectSendProvider: () => async (channelId: string, content: string) => {
        sent.push({ channelId, content });
      },
      channelIdProvider: () => "chan-agent-default",
      ...(opts.withReply !== false
        ? {
            botDirectReplyProvider: () => async (channelId: string, content: string, replyTo: string) => {
              replies.push({ channelId, content, replyTo });
            },
          }
        : {}),
      log: { info: vi.fn(), warn: vi.fn() } as never,
    },
  };
}

describe("orphan delivery — research reply (999.173)", () => {
  it("posts the synthesis as a reply in the origin channel, without the ⏱️ prefix", async () => {
    const { d, sent, replies } = deps();
    const cb = makeOrphanDeliveryCallback(d);
    cb({ text: "The synthesis", originKind: "task-notification", isError: false, classification: "orphan-signaled", replyTo: REPLY_TO });
    await flush();
    expect(replies).toEqual([{ channelId: "chan-origin", content: "The synthesis", replyTo: "msg-1" }]);
    expect(sent).toEqual([]);
    expect(replies[0]!.content.startsWith(ORPHAN_OUTPUT_PREFIX)).toBe(false);
  });

  it("a long synthesis: chunk 1 is the reply, the rest follow in order in the same channel", async () => {
    const { d, sent, replies } = deps();
    const cb = makeOrphanDeliveryCallback(d);
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${"x".repeat(60)}`).join("\n\n");
    cb({ text: long, originKind: null, isError: false, classification: "orphan-signaled", replyTo: REPLY_TO });
    await flush();
    await flush();
    expect(replies).toHaveLength(1);
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(s.channelId).toBe("chan-origin");
    for (const c of [replies[0]!.content, ...sent.map((s) => s.content)]) expect(c.length).toBeLessThanOrEqual(2000);
  });

  it("without a reply sender it degrades to a plain post in the origin channel", async () => {
    const { d, sent } = deps({ withReply: false });
    const cb = makeOrphanDeliveryCallback(d);
    cb({ text: "The synthesis", originKind: null, isError: false, classification: "orphan-signaled", replyTo: REPLY_TO });
    await flush();
    expect(sent).toEqual([{ channelId: "chan-origin", content: "The synthesis" }]);
  });

  it("ordinary self-fired output is unchanged (prefix, agent channel)", async () => {
    const { d, sent, replies } = deps();
    const cb = makeOrphanDeliveryCallback(d);
    cb({ text: "bg", originKind: null, isError: false, classification: "orphan-signaled" });
    await flush();
    expect(replies).toEqual([]);
    expect(sent).toEqual([{ channelId: "chan-agent-default", content: `${ORPHAN_OUTPUT_PREFIX}bg` }]);
  });
});
