/**
 * Phase 999.154 WS-2 — bridge integration: images reach the agent's own turn
 * as native blocks (no Haiku pre-pass), and a multi-message upload is
 * answered once.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Attachment, Collection, Message } from "discord.js";
import type { DownloadResult } from "../attachment-types.js";

const mockDownloadAllAttachments = vi.fn();
const mockSendIpcRequest = vi.fn();
const mockRunVisionPrePass = vi.fn();
const mockBuildTurnImages = vi.fn();

vi.mock("../../ipc/client.js", () => ({
  sendIpcRequest: (...args: unknown[]) => mockSendIpcRequest(...args),
}));
vi.mock("../attachments.js", () => ({
  extractAttachments: (atts: { values: () => Iterable<{ name: string }> }) =>
    [...atts.values()].map((a) => ({ name: a.name })),
  downloadAllAttachments: (...args: unknown[]) => mockDownloadAllAttachments(...args),
  formatAttachmentMetadata: () => "<attachments />",
  isImageAttachment: (ct: string | null) => typeof ct === "string" && ct.startsWith("image/"),
  attachmentInboxDir: (memoryPath?: string) => `${memoryPath ?? "/tmp"}/inbox/attachments`,
}));
vi.mock("../vision-pre-pass.js", () => ({
  runVisionPrePass: (...args: unknown[]) => mockRunVisionPrePass(...args),
  MAX_EAGER_IMAGES: 3,
}));
vi.mock("../../vision/turn-images.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../vision/turn-images.js")>();
  return { ...actual, buildTurnImages: (...args: unknown[]) => mockBuildTurnImages(...args) };
});

type Att = { id: string; name: string; contentType: string | null; size: number; url: string; proxyURL: string };

function makeMessage(o: { id: string; content: string; attachments: Att[] }): Message {
  const map = new Map<string, Attachment>();
  for (const a of o.attachments) map.set(a.id, a as unknown as Attachment);
  const collection = {
    size: map.size,
    values: () => map.values(),
    [Symbol.iterator]: () => map.values(),
    map: <T>(fn: (a: Attachment) => T) => [...map.values()].map(fn),
  } as unknown as Collection<string, Attachment>;
  return {
    content: o.content,
    channelId: "chan-1",
    id: o.id,
    author: { id: "user-client-a", username: "client-a-user", bot: false },
    createdAt: new Date("2026-09-22T12:00:00Z"),
    attachments: collection,
    reference: null,
    react: vi.fn().mockResolvedValue(undefined),
    channel: { sendTyping: vi.fn(), send: vi.fn().mockResolvedValue({ edit: vi.fn() }) },
  } as unknown as Message;
}

const img = (n: number): Att => ({
  id: `a${n}`,
  name: `IMG_${n}.jpg`,
  contentType: "image/jpeg",
  size: 1000,
  url: "u",
  proxyURL: "p",
});

function downloads(msg: Message): DownloadResult[] {
  return [...(msg.attachments as unknown as { values: () => Iterable<Att> }).values()].map((a) => ({
    success: true,
    path: `/mem/inbox/attachments/${a.name}`,
    error: null,
    attachmentInfo: { name: a.name, url: a.url, contentType: a.contentType, size: a.size, proxyUrl: a.proxyURL },
  })) as unknown as DownloadResult[];
}

describe("bridge — native turn images", () => {
  const mockStreamFromAgent = vi.fn();
  const mockGetAgentConfig = vi.fn();
  let DiscordBridge: new (opts: Record<string, unknown>) => unknown;

  const makeBridge = () =>
    new DiscordBridge({
      routingTableRef: {
        current: {
          channelToAgent: new Map([["chan-1", "client-a-personal"]]),
          agentToChannels: new Map([["client-a-personal", ["chan-1"]]]),
        },
      },
      sessionManager: {
        streamFromAgent: mockStreamFromAgent,
        getAgentConfig: mockGetAgentConfig,
        advisorEvents: { on: vi.fn(), off: vi.fn() },
        hasActiveTurn: () => false,
      },
      botToken: "t",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStreamFromAgent.mockResolvedValue("ok");
    mockSendIpcRequest.mockResolvedValue({ queued: true, queueDepth: 1 });
    mockDownloadAllAttachments.mockImplementation(async () => []);
    mockBuildTurnImages.mockImplementation(async (sources: Array<{ filename: string }>) => ({
      images: sources.map(() => ({ mediaType: "image/jpeg", data: "AAAA" })),
      manifest: `<attachment-images total="${sources.length}">${sources.map((s) => s.filename).join(",")}</attachment-images>`,
      plan: [],
      stats: { total: sources.length, full: sources.length, onSheets: 0, pathOnly: 0, estimatedTokens: 1 },
    }));
    mockGetAgentConfig.mockReturnValue({
      memoryPath: "/mem",
      vision: { enabled: true, preserveImage: false, burst: { quietMs: 60, maxWaitMs: 400 } },
    });
    DiscordBridge = (await import("../bridge.js")).DiscordBridge as never;
  });

  it("sends images as native blocks with a manifest — no Haiku pre-pass", async () => {
    const msg = makeMessage({ id: "m1", content: "which gear is this?", attachments: [img(1), img(2)] });
    mockDownloadAllAttachments.mockResolvedValueOnce(downloads(msg));
    await (makeBridge() as { handleMessage: (m: Message) => Promise<void> }).handleMessage(msg);

    expect(mockRunVisionPrePass).not.toHaveBeenCalled();
    expect(mockStreamFromAgent).toHaveBeenCalledTimes(1);
    const [, text, , , opts] = mockStreamFromAgent.mock.calls[0]!;
    expect(text).toContain("which gear is this?");
    expect(text).toContain('<attachment-images total="2">IMG_1.jpg,IMG_2.jpg');
    expect(text).not.toContain("<screenshot-analysis>");
    expect(opts).toEqual({ images: [{ mediaType: "image/jpeg", data: "AAAA" }, { mediaType: "image/jpeg", data: "AAAA" }] });
  });

  it("a 3-message upload burst is answered ONCE with every image", async () => {
    const lead = makeMessage({ id: "m1", content: "", attachments: [img(1), img(2)] });
    const second = makeMessage({ id: "m2", content: "", attachments: [img(3)] });
    const third = makeMessage({ id: "m3", content: "what do you think?", attachments: [] });
    mockDownloadAllAttachments.mockImplementation(async (infos: Array<{ name: string }>) =>
      infos.map((i) => ({
        success: true,
        path: `/mem/inbox/attachments/${i.name}`,
        error: null,
        attachmentInfo: { name: i.name, url: "u", contentType: "image/jpeg", size: 1, proxyUrl: "p" },
      })),
    );
    const bridge = makeBridge() as { handleMessage: (m: Message) => Promise<void> };
    await Promise.all([bridge.handleMessage(lead), bridge.handleMessage(second), bridge.handleMessage(third)]);

    expect(mockStreamFromAgent).toHaveBeenCalledTimes(1);
    const [, text, , , opts] = mockStreamFromAgent.mock.calls[0]!;
    expect(text).toContain("what do you think?");
    expect(text).toContain("IMG_1.jpg,IMG_2.jpg,IMG_3.jpg");
    expect((opts as { images: unknown[] }).images).toHaveLength(3);
    expect(second.react).toHaveBeenCalledWith("🧩");
    expect(third.react).toHaveBeenCalledWith("🧩");
  });

  it("vision.mode prepass keeps the legacy path (rollback)", async () => {
    mockGetAgentConfig.mockReturnValue({
      memoryPath: "/mem",
      vision: { enabled: true, preserveImage: false, mode: "prepass" },
    });
    mockRunVisionPrePass.mockResolvedValue(new Map());
    const msg = makeMessage({ id: "m1", content: "x", attachments: [img(1)] });
    mockDownloadAllAttachments.mockResolvedValueOnce(downloads(msg));
    await (makeBridge() as { handleMessage: (m: Message) => Promise<void> }).handleMessage(msg);
    expect(mockRunVisionPrePass).toHaveBeenCalledTimes(1);
    expect(mockBuildTurnImages).not.toHaveBeenCalled();
    const [, , , , opts] = mockStreamFromAgent.mock.calls[0]!;
    expect(opts).toBeUndefined();
  });
});
