/**
 * postCv2ToAgentChannel with attachments (2026-09-10).
 *
 * Cards that reference `attachment://<name>` must ship the bytes in the SAME
 * REST call, via the bot-identity path
 * (`postCv2WithFiles`). The attachment-free path must stay byte-identical to
 * what bridge-cv2.test.ts pins — this suite asserts both sides of that line.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { Routes } from "discord-api-types/v10";
import { DiscordBridge } from "../bridge.js";
import { buildCv2Payload, type Cv2Spec } from "../cv2-renderer.js";
import type { OutboundFile } from "../table-delivery.js";

type RestPost = (route: string, opts: { body: unknown; files?: readonly { name: string; data: Buffer }[] }) => Promise<{ id: string }>;

const fakeRoutingTable = {
  channelToAgent: new Map([["chan-1", "client-a-personal"]]),
  agentToChannels: new Map([["client-a-personal", ["chan-1"]]]),
};
const fakeWebhookManager = { hasWebhook: vi.fn().mockReturnValue(false), send: vi.fn() };
const fakeLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const fakeSessionManager = {
  forwardToAgent: vi.fn(),
  streamFromAgent: vi.fn(),
  getAgentConfig: vi.fn(),
  getTraceCollector: vi.fn().mockReturnValue(undefined),
  advisorEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
};

function makeBridge(): DiscordBridge {
  return new DiscordBridge({
    routingTableRef: { current: fakeRoutingTable },
    sessionManager: fakeSessionManager as any,
    webhookManager: fakeWebhookManager as any,
    botToken: "fake-token",
    log: fakeLog as any,
  });
}

const FOUR_CHARTS: Cv2Spec = {
  accentColor: 0x5865f2,
  blocks: [1, 2, 3, 4].flatMap((n) => [
    { type: "text" as const, content: `## Chart ${n}` },
    { type: "media" as const, items: [{ filename: `chart${n}.png` }] },
  ]),
};
const FOUR_FILES: OutboundFile[] = [1, 2, 3, 4].map((n) => ({ attachment: Buffer.from(`png${n}`), name: `chart${n}.png` }));

describe("postCv2ToAgentChannel — with files", () => {
  let restPost: Mock<RestPost>;
  let bridge: DiscordBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = makeBridge();
    restPost = vi.fn<RestPost>(async () => ({ id: "msg-cv2-1" }));
    Object.defineProperty((bridge as any).client, "rest", { value: { post: restPost, patch: vi.fn() }, configurable: true });
  });

  it("four charts in-container: body === buildCv2Payload(spec), files ride the same call", async () => {
    const res = await bridge.postCv2ToAgentChannel("client-a-personal", FOUR_CHARTS, FOUR_FILES);

    expect(res).toEqual({ ok: true, messageId: "msg-cv2-1" });
    expect(restPost).toHaveBeenCalledTimes(1);
    const [route, opts] = restPost.mock.calls[0];
    expect(route).toBe(Routes.channelMessages("chan-1"));
    expect(opts.body).toEqual(buildCv2Payload(FOUR_CHARTS));
    expect(opts.files).toEqual(FOUR_FILES.map((f) => ({ name: f.name, data: f.attachment })));
    // Never `attachments: []` on a POST — that drops the uploads.
    expect(opts.body).not.toHaveProperty("attachments");
  });

  it("every attachment:// in the media gallery is bound to an uploaded file name", async () => {
    await bridge.postCv2ToAgentChannel("client-a-personal", FOUR_CHARTS, FOUR_FILES);
    const body = restPost.mock.calls[0][1].body as { components: { components: { type: number; items?: { media: { url: string } }[] }[] }[] };
    const urls = body.components[0].components.filter((c) => c.type === 12).flatMap((c) => c.items!.map((i) => i.media.url));
    expect(urls).toEqual(["attachment://chart1.png", "attachment://chart2.png", "attachment://chart3.png", "attachment://chart4.png"]);
  });

  it("fails closed when a referenced attachment has no file — nothing is sent", async () => {
    const res = await bridge.postCv2ToAgentChannel("client-a-personal", FOUR_CHARTS, FOUR_FILES.slice(0, 3));

    expect(res).toMatchObject({ ok: false, reason: "send-failed", detail: expect.stringContaining("missing attachment: chart4.png") });
    expect(restPost).not.toHaveBeenCalled();
  });

  it("a section thumbnail rides the same way", async () => {
    const spec: Cv2Spec = {
      blocks: [{ type: "section", text: ["**Fox Ranger** $64.95"], accessory: { kind: "thumb", filename: "fox.png" } }],
    };
    const res = await bridge.postCv2ToAgentChannel("client-a-personal", spec, [{ attachment: Buffer.from("f"), name: "fox.png" }]);
    expect(res.ok).toBe(true);
    expect(restPost.mock.calls[0][1].files).toEqual([{ name: "fox.png", data: Buffer.from("f") }]);
  });

  it("REST failure surfaces as send-failed with the error, not a throw", async () => {
    restPost.mockRejectedValueOnce(new Error("Invalid Form Body"));
    const res = await bridge.postCv2ToAgentChannel("client-a-personal", FOUR_CHARTS, FOUR_FILES);
    expect(res).toMatchObject({ ok: false, reason: "send-failed", detail: expect.stringContaining("Invalid Form Body") });
  });

  it("still returns no-binding before touching files or REST", async () => {
    const res = await bridge.postCv2ToAgentChannel("nobody", FOUR_CHARTS, FOUR_FILES);
    expect(res).toMatchObject({ ok: false, reason: "no-binding" });
    expect(restPost).not.toHaveBeenCalled();
  });
});

describe("postCv2ToAgentChannel — without files stays byte-identical", () => {
  it("no files → the legacy call shape: { body } only, no files key", async () => {
    const bridge = makeBridge();
    const restPost = vi.fn<RestPost>(async () => ({ id: "msg-legacy" }));
    Object.defineProperty((bridge as any).client, "rest", { value: { post: restPost }, configurable: true });
    const spec: Cv2Spec = { blocks: [{ type: "text", content: "# Board" }] };

    const res = await bridge.postCv2ToAgentChannel("client-a-personal", spec);

    expect(res).toEqual({ ok: true, messageId: "msg-legacy" });
    expect(restPost).toHaveBeenCalledWith(Routes.channelMessages("chan-1"), { body: buildCv2Payload(spec) });
    expect(restPost.mock.calls[0][1]).not.toHaveProperty("files");
  });
});
