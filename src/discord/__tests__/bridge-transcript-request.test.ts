/**
 * 999.156 — the bridge records the request that came with an audio file, and
 * runs the transcript follow-up as a turn REPLYING to that message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Collection, Message } from "discord.js";

const mockDownloadAllAttachments = vi.fn();
vi.mock("../../ipc/client.js", () => ({ sendIpcRequest: vi.fn().mockResolvedValue({ queued: true }) }));
vi.mock("../attachments.js", () => ({
  extractAttachments: (atts: { values: () => Iterable<{ name: string }> }) => [...atts.values()].map((a) => ({ name: a.name })),
  downloadAllAttachments: (...args: unknown[]) => mockDownloadAllAttachments(...args),
  formatAttachmentMetadata: () => "<attachments />",
  isImageAttachment: (ct: string | null) => typeof ct === "string" && ct.startsWith("image/"),
  attachmentInboxDir: (memoryPath?: string) => `${memoryPath ?? "/tmp"}/inbox/attachments`,
}));

function audioMessage(id: string, content: string): Message {
  const att = { id: "a1", name: "Daily_92226.m4a", contentType: "audio/x-m4a", size: 1000, url: "u", proxyURL: "p" };
  const map = new Map([["a1", att as unknown as Attachment]]);
  return {
    id,
    content,
    channelId: "chan-sc",
    author: { id: "u-client-a", username: "client-a-user", bot: false },
    createdAt: new Date("2026-09-22T16:48:06Z"),
    attachments: {
      size: 1,
      values: () => map.values(),
      [Symbol.iterator]: () => map.values(),
      map: <T>(fn: (a: Attachment) => T) => [...map.values()].map(fn),
    } as unknown as Collection<string, Attachment>,
    reference: null,
    react: vi.fn().mockResolvedValue(undefined),
    channel: { sendTyping: vi.fn(), send: vi.fn().mockResolvedValue({ edit: vi.fn(), id: "r" }) },
  } as unknown as Message;
}

describe("bridge — transcript request + follow-up turn", () => {
  const streamFromAgent = vi.fn();
  let mem: string;
  let DiscordBridge: new (opts: Record<string, unknown>) => Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mem = await mkdtemp(join(tmpdir(), "bridge-treq-"));
    streamFromAgent.mockResolvedValue("done");
    DiscordBridge = (await import("../bridge.js")).DiscordBridge as never;
  });

  const make = () =>
    new DiscordBridge({
      routingTableRef: {
        current: {
          channelToAgent: new Map([["chan-sc", "state-contract"]]),
          agentToChannels: new Map([["state-contract", ["chan-sc"]]]),
        },
      },
      sessionManager: {
        streamFromAgent,
        getAgentConfig: () => ({ memoryPath: mem }),
        advisorEvents: { on: vi.fn(), off: vi.fn() },
        hasActiveTurn: () => false,
      },
      botToken: "t",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

  it("records who sent the audio and what they asked, keyed by the inbox stem", async () => {
    const msg = audioMessage("msg-audio", "Pull out every deadline and draft the email to Qasem");
    mockDownloadAllAttachments.mockResolvedValueOnce([
      {
        success: true,
        path: `${mem}/inbox/attachments/1790095686604-Daily_92226.m4a`,
        error: null,
        attachmentInfo: { name: "Daily_92226.m4a", url: "u", contentType: "audio/x-m4a", size: 1000, proxyUrl: "p" },
      },
    ]);
    await (make() as { handleMessage(m: Message): Promise<void> }).handleMessage(msg);
    await new Promise((r) => setTimeout(r, 20));
    const meta = JSON.parse(await readFile(join(mem, "inbox", "attachment-meta", "1790095686604-Daily_92226.json"), "utf8"));
    expect(meta).toMatchObject({
      messageId: "msg-audio",
      channelId: "chan-sc",
      authorName: "client-a-user",
      request: "Pull out every deadline and draft the email to Qasem",
    });
  });

  it("runFollowUpTurn replies to the original message through the normal turn path", async () => {
    const bridge = make();
    const original = audioMessage("msg-audio", "draft the email");
    (bridge.client as { channels: unknown }).channels = {
      fetch: vi.fn().mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue(original) } }),
    };
    const ok = await (bridge.runFollowUpTurn as (a: Record<string, string>) => Promise<boolean>).call(bridge, {
      agent: "state-contract",
      channelId: "chan-sc",
      messageId: "msg-audio",
      prompt: "The Unraid transcription pipeline finished …",
      label: "transcript",
    });
    expect(ok).toBe(true);
    expect(streamFromAgent).toHaveBeenCalledTimes(1);
    expect(streamFromAgent.mock.calls[0]![1]).toContain("transcription pipeline finished");
    expect((original.channel as unknown as { sendTyping: ReturnType<typeof vi.fn> }).sendTyping).toHaveBeenCalled();
    expect((bridge.turnIdOverrides as Map<string, string>).size).toBe(0);
  });

  it("runFollowUpTurn returns false when the original message is gone", async () => {
    const bridge = make();
    (bridge.client as { channels: unknown }).channels = { fetch: vi.fn().mockRejectedValue(new Error("Unknown Message")) };
    const ok = await (bridge.runFollowUpTurn as (a: Record<string, string>) => Promise<boolean>).call(bridge, {
      agent: "state-contract",
      channelId: "chan-sc",
      messageId: "gone",
      prompt: "p",
      label: "transcript",
    });
    expect(ok).toBe(false);
    expect(streamFromAgent).not.toHaveBeenCalled();
  });
});
