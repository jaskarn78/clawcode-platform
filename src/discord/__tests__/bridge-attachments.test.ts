import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Message, Collection, Attachment } from "discord.js";
import type { DownloadResult, AttachmentInfo } from "../attachment-types.js";

/**
 * We test the bridge's attachment integration by importing the updated
 * formatDiscordMessage (now exported for testing) and verifying handleMessage
 * behavior via a minimal DiscordBridge construction with mocked dependencies.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAttachmentInfo(overrides: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return {
    name: "photo.png",
    url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
    contentType: "image/png",
    size: 12345,
    proxyUrl: "https://media.discordapp.net/attachments/1/2/photo.png",
    ...overrides,
  };
}

function makeDownloadResult(overrides: Partial<DownloadResult> = {}): DownloadResult {
  return {
    success: true,
    path: "/workspace/inbox/attachments/1234-photo.png",
    error: null,
    attachmentInfo: makeAttachmentInfo(),
    ...overrides,
  };
}

/** Build a minimal discord.js Message-like object. */
function makeMessage(overrides: {
  content?: string;
  attachments?: Array<{ id: string; name: string; contentType: string | null; size: number; url: string; proxyURL: string }>;
  channelId?: string;
  messageId?: string;
  username?: string;
} = {}): Message {
  const attMap = new Map<string, Attachment>();
  for (const a of overrides.attachments ?? []) {
    attMap.set(a.id, a as Attachment);
  }

  // Mimic discord.js Collection with .map and .values
  const collection = {
    size: attMap.size,
    values: () => attMap.values(),
    [Symbol.iterator]: () => attMap.values(),
    map: <T>(fn: (att: Attachment) => T): T[] => {
      const result: T[] = [];
      for (const v of attMap.values()) {
        result.push(fn(v));
      }
      return result;
    },
  } as unknown as Collection<string, Attachment>;

  return {
    content: overrides.content ?? "hello",
    channelId: overrides.channelId ?? "chan-1",
    id: overrides.messageId ?? "msg-1",
    author: { username: overrides.username ?? "testuser", bot: false },
    createdAt: new Date("2026-04-09T12:00:00Z"),
    attachments: collection,
    reference: null,
    channel: { sendTyping: vi.fn(), send: vi.fn().mockResolvedValue({ edit: vi.fn() }) },
  } as unknown as Message;
}

// ── Mock attachment module ──────────────────────────────────────────────────

const mockExtractAttachments = vi.fn();
const mockDownloadAllAttachments = vi.fn();
const mockFormatAttachmentMetadata = vi.fn();
const mockIsImageAttachment = vi.fn();
// P1-VISIONKEY — capture the auto-ingest IPC dispatch to assert vision keying.
const mockSendIpcRequest = vi.fn();
vi.mock("../../ipc/client.js", () => ({
  sendIpcRequest: (...args: unknown[]) => mockSendIpcRequest(...args),
}));

vi.mock("../attachments.js", () => ({
  extractAttachments: (...args: unknown[]) => mockExtractAttachments(...args),
  downloadAllAttachments: (...args: unknown[]) => mockDownloadAllAttachments(...args),
  formatAttachmentMetadata: (...args: unknown[]) => mockFormatAttachmentMetadata(...args),
  isImageAttachment: (...args: unknown[]) => mockIsImageAttachment(...args),
  // Shared inbox-dir helper (P1 robust auto-ingest) — mirror the real impl:
  // join(memoryPath ?? "/tmp", "inbox", "attachments").
  attachmentInboxDir: (memoryPath?: string) =>
    `${memoryPath ?? "/tmp"}/inbox/attachments`,
}));

// ── Tests ───────────────────────────────────────────────────────────────────

describe("formatDiscordMessage (with attachment support)", () => {
  // Import after mocks are registered
  let formatDiscordMessage: (
    message: Message,
    downloadResults?: readonly DownloadResult[],
    referencedMessage?: Message,
    agentTz?: string,
    visionAnalyses?: ReadonlyMap<string, string>,
  ) => string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../bridge.js");
    formatDiscordMessage = mod.formatDiscordMessage;
  });

  it("returns same format as before when no downloadResults are provided (backward compatible)", () => {
    const msg = makeMessage({ content: "hello world" });
    const output = formatDiscordMessage(msg);

    expect(output).toContain("hello world");
    expect(output).toContain('source="discord"');
    expect(output).toContain('user="testuser"');
    expect(output).not.toContain("<attachments>");
  });

  it("includes structured attachment metadata when downloadResults are provided", () => {
    mockFormatAttachmentMetadata.mockReturnValue(
      '<attachments>\n  <attachment name="photo.png" type="image/png" size="12345" local_path="/tmp/photo.png" />\n</attachments>',
    );

    const results = [makeDownloadResult()];
    const msg = makeMessage({ content: "check this" });
    const output = formatDiscordMessage(msg, results);

    expect(mockFormatAttachmentMetadata).toHaveBeenCalledWith(results);
    expect(output).toContain("<attachments>");
    expect(output).toContain('local_path="/tmp/photo.png"');
  });

  it("includes local_path for successfully downloaded attachments", () => {
    mockFormatAttachmentMetadata.mockReturnValue(
      '<attachments>\n  <attachment name="doc.pdf" type="application/pdf" size="5000" local_path="/workspace/inbox/attachments/1234-doc.pdf" />\n</attachments>',
    );

    const results = [
      makeDownloadResult({
        path: "/workspace/inbox/attachments/1234-doc.pdf",
        attachmentInfo: makeAttachmentInfo({ name: "doc.pdf", contentType: "application/pdf" }),
      }),
    ];
    const msg = makeMessage({ content: "file" });
    const output = formatDiscordMessage(msg, results);

    expect(output).toContain("local_path");
    expect(output).toContain("1234-doc.pdf");
  });

  it("includes multimodal reading hint for successfully downloaded image attachments", () => {
    mockFormatAttachmentMetadata.mockReturnValue(
      '<attachments>\n  <attachment name="photo.png" type="image/png" size="12345" local_path="/tmp/1234-photo.png" />\n</attachments>',
    );
    mockIsImageAttachment.mockReturnValue(true);

    const results = [
      makeDownloadResult({
        path: "/tmp/1234-photo.png",
        attachmentInfo: makeAttachmentInfo({ name: "photo.png", contentType: "image/png" }),
      }),
    ];
    const msg = makeMessage({ content: "look at this" });
    const output = formatDiscordMessage(msg, results);

    expect(output).toContain("Image downloaded");
    expect(output).toContain("/tmp/1234-photo.png");
    expect(output).toContain("read the file");
  });

  it("does NOT include multimodal hint for non-image attachments", () => {
    mockFormatAttachmentMetadata.mockReturnValue(
      '<attachments>\n  <attachment name="doc.pdf" type="application/pdf" size="5000" local_path="/tmp/1234-doc.pdf" />\n</attachments>',
    );
    mockIsImageAttachment.mockReturnValue(false);

    const results = [
      makeDownloadResult({
        path: "/tmp/1234-doc.pdf",
        attachmentInfo: makeAttachmentInfo({ name: "doc.pdf", contentType: "application/pdf" }),
      }),
    ];
    const msg = makeMessage({ content: "check this" });
    const output = formatDiscordMessage(msg, results);

    expect(output).not.toContain("Image downloaded");
  });

  it("P1-EAGERCAP: 12 images, map has 3 → exactly 3 analyses + a truthful deferred stub for 9 (never claims 'ingested')", () => {
    mockFormatAttachmentMetadata.mockReturnValue("");
    mockIsImageAttachment.mockReturnValue(true);

    const results = Array.from({ length: 12 }, (_, i) =>
      makeDownloadResult({
        path: `/inbox/img-${i}.png`,
        attachmentInfo: makeAttachmentInfo({
          name: `img-${i}.png`,
          contentType: "image/png",
        }),
      }),
    );
    // Mirror P1-EAGERCAP: only the first 3 images get an eager analysis.
    const vision = new Map<string, string>([
      ["/inbox/img-0.png", "ANALYSIS ZERO"],
      ["/inbox/img-1.png", "ANALYSIS ONE"],
      ["/inbox/img-2.png", "ANALYSIS TWO"],
    ]);

    const out = formatDiscordMessage(
      makeMessage({ content: "12-image burst" }),
      results,
      undefined,
      undefined,
      vision,
    );

    expect((out.match(/<screenshot-analysis>/g) ?? []).length).toBe(3);
    expect(out).toContain("ANALYSIS ZERO");
    expect(out).toContain("ANALYSIS TWO");
    // Single truthful deferred stub for the 9 tail images.
    expect(out).toContain(
      "[vision deferred — 9 more image(s) received this turn, not analyzed — read each one at its local_path above to see it]",
    );
    // RIA truthful-stub invariant — at format time ingest is only QUEUED.
    expect(out.toLowerCase()).not.toContain("ingested");
    // Tail images do not each emit a "read the file" hint (bounded context),
    // and all 3 eager images had analysis, so no download hint at all.
    expect(out).not.toContain("Image downloaded");
  });

  it("P1-TOKENCAP: injected vision is bounded to 6000 chars; overflow collapses into one <vision-summary>", () => {
    mockFormatAttachmentMetadata.mockReturnValue("");
    mockIsImageAttachment.mockReturnValue(true);

    const big = "X".repeat(5000);
    const results = Array.from({ length: 3 }, (_, i) =>
      makeDownloadResult({
        path: `/inbox/big-${i}.png`,
        attachmentInfo: makeAttachmentInfo({
          name: `big-${i}.png`,
          contentType: "image/png",
        }),
      }),
    );
    const vision = new Map<string, string>([
      ["/inbox/big-0.png", big],
      ["/inbox/big-1.png", big],
      ["/inbox/big-2.png", big],
    ]);

    const out = formatDiscordMessage(
      makeMessage(),
      results,
      undefined,
      undefined,
      vision,
    );

    // 6000-char budget: only big-0 (5000) fits; big-1/big-2 overflow.
    expect((out.match(/<screenshot-analysis>/g) ?? []).length).toBe(1);
    expect(out).toContain("<vision-summary>");
    expect(out).toContain("2 additional image");
  });
});

describe("handleMessage attachment integration", () => {
  let DiscordBridge: typeof import("../bridge.js").DiscordBridge;

  const mockStreamFromAgent = vi.fn();
  const mockGetAgentConfig = vi.fn();

  // Plan 117-09 — `sessionManager.advisorEvents` (added in 117-04) is now
  // consumed by the bridge. Supply a real EventEmitter so the listener
  // registration in streamAndPostResponse does not throw.
  const fakeAdvisorEvents = new EventEmitter();

  const fakeSessionManager = {
    streamFromAgent: mockStreamFromAgent,
    getAgentConfig: mockGetAgentConfig,
    advisorEvents: fakeAdvisorEvents,
  };

  const fakeRoutingTable = {
    channelToAgent: new Map([["chan-1", "test-agent"]]),
    agentToChannels: new Map([["test-agent", ["chan-1"]]]),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Phase 75 SHARED-01 — attachment download uses memoryPath (not workspace).
    // For dedicated-workspace agents memoryPath === workspace, mirroring the
    // loader.ts fallback behavior.
    mockGetAgentConfig.mockReturnValue({ workspace: "/workspace/test-agent", memoryPath: "/workspace/test-agent" });
    mockStreamFromAgent.mockResolvedValue("agent response");
    mockExtractAttachments.mockReturnValue([makeAttachmentInfo()]);
    mockDownloadAllAttachments.mockResolvedValue([makeDownloadResult()]);
    mockFormatAttachmentMetadata.mockReturnValue(
      '<attachments>\n  <attachment name="photo.png" type="image/png" size="12345" local_path="/workspace/test-agent/inbox/attachments/1234-photo.png" />\n</attachments>',
    );
    mockIsImageAttachment.mockReturnValue(true);
    // Dispatch fires sendIpcRequest(...).catch(...) — return a Promise so .catch exists.
    mockSendIpcRequest.mockResolvedValue({ queued: true, queueDepth: 1 });

    const mod = await import("../bridge.js");
    DiscordBridge = mod.DiscordBridge;
  });

  it("resolves agent workspace and downloads attachments to {workspace}/inbox/attachments/", async () => {
    const bridge = new DiscordBridge({
      routingTableRef: { current: fakeRoutingTable },
      sessionManager: fakeSessionManager as any,
      botToken: "fake-token",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    });

    const msg = makeMessage({
      content: "look at this",
      attachments: [
        { id: "att-1", name: "photo.png", contentType: "image/png", size: 12345, url: "https://cdn.example.com/photo.png", proxyURL: "https://proxy.example.com/photo.png" },
      ],
    });

    // Call handleMessage directly (it's private, so we use bracket notation)
    await (bridge as any).handleMessage(msg);

    expect(mockGetAgentConfig).toHaveBeenCalledWith("test-agent");
    expect(mockExtractAttachments).toHaveBeenCalledWith(msg.attachments);
    expect(mockDownloadAllAttachments).toHaveBeenCalledWith(
      [makeAttachmentInfo()],
      "/workspace/test-agent/inbox/attachments",
      expect.anything(), // logger
    );
  });

  it("P1-VISIONKEY: dispatch resolves vision_analysis by result.path (not info.name)", () => {
    const bridge = new DiscordBridge({
      routingTableRef: { current: fakeRoutingTable },
      sessionManager: fakeSessionManager as any,
      botToken: "fake-token",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    });

    // Map keyed by PATH (as runVisionPrePass produces). The Discord filename
    // (info.name) deliberately DIFFERS from the path so the old info.name lookup
    // would resolve to null — this test locks the result.path keying.
    const downloadResults = [
      makeDownloadResult({
        path: "/workspace/test-agent/inbox/attachments/1234-client.png",
        attachmentInfo: makeAttachmentInfo({
          name: "client.png",
          contentType: "image/png",
        }),
      }),
    ];
    const vision = new Map<string, string>([
      ["/workspace/test-agent/inbox/attachments/1234-client.png", "REAL VISION"],
    ]);

    const msg = makeMessage({ content: "x" });
    // dispatchAutoIngestAttachments is private — invoke via bracket notation.
    (bridge as any).dispatchAutoIngestAttachments(
      "test-agent",
      downloadResults,
      vision,
      msg,
    );

    expect(mockSendIpcRequest).toHaveBeenCalledWith(
      expect.anything(),
      "auto-ingest-attachment",
      expect.objectContaining({
        file_path: "/workspace/test-agent/inbox/attachments/1234-client.png",
        vision_analysis: "REAL VISION", // non-null — the bug fixed
      }),
    );
  });

  it("does NOT call attachment module when message has no attachments", async () => {
    const bridge = new DiscordBridge({
      routingTableRef: { current: fakeRoutingTable },
      sessionManager: fakeSessionManager as any,
      botToken: "fake-token",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    });

    const msg = makeMessage({ content: "just text" });

    await (bridge as any).handleMessage(msg);

    expect(mockExtractAttachments).not.toHaveBeenCalled();
    expect(mockDownloadAllAttachments).not.toHaveBeenCalled();
    expect(mockStreamFromAgent).toHaveBeenCalled();
  });

  function imageResults(n: number): DownloadResult[] {
    return Array.from({ length: n }, (_, i) =>
      makeDownloadResult({
        path: `/workspace/test-agent/inbox/attachments/${i}.png`,
        attachmentInfo: makeAttachmentInfo({
          name: `${i}.png`,
          contentType: "image/png",
        }),
      }),
    );
  }
  function makeBridge() {
    return new DiscordBridge({
      routingTableRef: { current: fakeRoutingTable },
      sessionManager: fakeSessionManager as any,
      botToken: "fake-token",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    });
  }

  it("P2-PROGRESS: seeds a progress batch for >=2 attachments on an ingest-enabled agent", () => {
    mockGetAgentConfig.mockReturnValue({
      workspace: "/workspace/test-agent",
      memoryPath: "/workspace/test-agent",
      autoIngestAttachments: true,
    });
    const bridge = makeBridge();
    const seedSpy = vi
      .spyOn((bridge as any).ingestProgress, "seedBatch")
      .mockImplementation(() => {});
    const msg = makeMessage({ content: "burst" });
    (bridge as any).dispatchAutoIngestAttachments(
      "test-agent",
      imageResults(3),
      new Map(),
      msg,
    );
    expect(seedSpy).toHaveBeenCalledWith(
      msg.channelId,
      msg.id,
      3,
      expect.anything(),
    );
  });

  it("P2-PROGRESS: does NOT seed for a single attachment (<2)", () => {
    mockGetAgentConfig.mockReturnValue({
      workspace: "/w",
      memoryPath: "/w",
      autoIngestAttachments: true,
    });
    const bridge = makeBridge();
    const seedSpy = vi
      .spyOn((bridge as any).ingestProgress, "seedBatch")
      .mockImplementation(() => {});
    (bridge as any).dispatchAutoIngestAttachments(
      "test-agent",
      imageResults(1),
      new Map(),
      makeMessage(),
    );
    expect(seedSpy).not.toHaveBeenCalled();
  });

  it("P2-PROGRESS: does NOT seed for an agent without autoIngestAttachments", () => {
    mockGetAgentConfig.mockReturnValue({ workspace: "/w", memoryPath: "/w" });
    const bridge = makeBridge();
    const seedSpy = vi
      .spyOn((bridge as any).ingestProgress, "seedBatch")
      .mockImplementation(() => {});
    (bridge as any).dispatchAutoIngestAttachments(
      "test-agent",
      imageResults(3),
      new Map(),
      makeMessage(),
    );
    expect(seedSpy).not.toHaveBeenCalled();
  });
});
