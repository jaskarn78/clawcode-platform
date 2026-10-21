import { describe, it, expect, vi } from "vitest";
import { Routes } from "discord.js";
import { deliverCv2Ephemeral, editCv2Message, postCv2WithFiles, type RestLike } from "../cv2-post.js";
import { buildCv2Payload, type Cv2Spec } from "../cv2-renderer.js";
import type { OutboundFile } from "../table-delivery.js";

const log = { warn: vi.fn(), info: vi.fn() };
const spec: Cv2Spec = { accentColor: 0x1, blocks: [{ type: "text", content: "# Card" }, { type: "media", items: [{ filename: "c.png" }] }] };
const files: OutboundFile[] = [{ attachment: Buffer.from("png"), name: "c.png", description: "chart" }];

function fakeRest(overrides: Partial<RestLike> = {}): RestLike & { post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> } {
  return {
    post: vi.fn(async () => ({ id: "msg-123" })),
    patch: vi.fn(async () => ({ id: "msg-123" })),
    ...overrides,
  } as RestLike & { post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };
}

describe("postCv2WithFiles (bot identity)", () => {
  it("posts the exact CV2 body + files to channelMessages, no attachments field", async () => {
    const rest = fakeRest();
    const res = await postCv2WithFiles({ rest, channelId: "chan1", spec, files, log });
    expect(res).toEqual({ ok: true, messageId: "msg-123", identity: "bot" });
    expect(rest.post).toHaveBeenCalledTimes(1);
    const [route, opts] = rest.post.mock.calls[0];
    expect(route).toBe(Routes.channelMessages("chan1"));
    expect(opts.body).toEqual(buildCv2Payload(spec)); // no extra fields, no attachments:[]
    expect(opts.files).toEqual([{ name: "c.png", data: files[0].attachment }]);
  });

  it("adds a message_reference when replying to the relay", async () => {
    const rest = fakeRest();
    await postCv2WithFiles({ rest, channelId: "c", spec, files, replyToMessageId: "relay-9", log });
    const body = rest.post.mock.calls[0][1].body as { message_reference?: { message_id: string } };
    expect(body.message_reference).toEqual({ message_id: "relay-9", fail_if_not_exists: false });
  });

  it("fails closed when a referenced attachment has no file", async () => {
    const rest = fakeRest();
    const res = await postCv2WithFiles({ rest, channelId: "c", spec, files: [], log });
    expect(res).toEqual({ ok: false, reason: "missing attachment: c.png" });
    expect(rest.post).not.toHaveBeenCalled();
  });

  it("returns ok:false when the REST response carries no id", async () => {
    const rest = fakeRest({ post: vi.fn(async () => ({})) });
    const res = await postCv2WithFiles({ rest, channelId: "c", spec, files, log });
    expect(res).toEqual({ ok: false, reason: "bot post returned no message id" });
  });
});

describe("postCv2WithFiles (agent identity)", () => {
  it("uses the webhook when it succeeds", async () => {
    const rest = fakeRest();
    const webhook = { send: vi.fn(async () => ({ id: "wh-1" })) };
    const res = await postCv2WithFiles({ rest, channelId: "c", spec, files, identity: "agent", webhook, log });
    expect(res).toEqual({ ok: true, messageId: "wh-1", identity: "agent" });
    expect(rest.post).not.toHaveBeenCalled();
  });

  it("falls back to a bot post when the webhook throws", async () => {
    const rest = fakeRest();
    const webhook = { send: vi.fn(async () => { throw new Error("400 files[n]"); }) };
    const res = await postCv2WithFiles({ rest, channelId: "c", spec, files, identity: "agent", webhook, log });
    expect(res).toEqual({ ok: true, messageId: "msg-123", identity: "bot" });
    expect(webhook.send).toHaveBeenCalledTimes(1);
    expect(rest.post).toHaveBeenCalledTimes(1);
  });
});

describe("deliverCv2Ephemeral (layered fallback)", () => {
  const interaction = () => ({ applicationId: "app", token: "tok", followUp: vi.fn(async (_opts?: unknown): Promise<unknown> => undefined) });

  it("hop (a): edits @original when the raw REST patch succeeds", async () => {
    const rest = fakeRest();
    const i = interaction();
    await deliverCv2Ephemeral({ rest, interaction: i, spec, files, log });
    expect(rest.patch).toHaveBeenCalledTimes(1);
    expect(rest.patch.mock.calls[0][0]).toBe(Routes.webhookMessage("app", "tok", "@original"));
    const body = rest.patch.mock.calls[0][1].body as { flags: number; attachments: unknown[] };
    expect(body.flags).toBe(1 << 15); // IsComponentsV2 set on the EDIT, per Discord docs
    // Discord edit semantics: `attachments` = the complete list to KEEP. Listing
    // the fresh uploads by multipart index binds attachment:// refs and drops
    // prior files; an empty array discarded the uploads (prod 400, 2026-09-06).
    expect(body.attachments).toEqual([expect.objectContaining({ id: 0, filename: "c.png" })]);
    expect(i.followUp).not.toHaveBeenCalled();
  });

  it("hop (b): falls to a discord.js CV2 followUp when @original 4xx", async () => {
    const rest = fakeRest({ patch: vi.fn(async () => { throw Object.assign(new Error("bad request"), { status: 400 }); }) });
    const i = interaction();
    await deliverCv2Ephemeral({ rest, interaction: i, spec, files, log });
    expect(i.followUp).toHaveBeenCalledTimes(1);
    const payload = i.followUp.mock.calls[0][0] as { flags: number; components: unknown };
    expect(payload.flags).toBe((1 << 15) | 64); // CV2 | Ephemeral
    expect(payload.components).toBeDefined();
  });

  it("hop (c): falls to a plain-text followUp when the CV2 followUp also fails", async () => {
    const rest = fakeRest({ patch: vi.fn(async () => { throw Object.assign(new Error("400"), { status: 400 }); }) });
    const followUp = vi.fn().mockRejectedValueOnce(new Error("cv2 followUp rejected")).mockResolvedValue(undefined);
    const i = { applicationId: "app", token: "tok", followUp };
    await deliverCv2Ephemeral({ rest, interaction: i, spec, files, log });
    expect(followUp).toHaveBeenCalledTimes(2);
    const plain = followUp.mock.calls[1][0] as { content: string; flags: number };
    expect(typeof plain.content).toBe("string");
    expect(plain.flags).toBe(64); // Ephemeral, no CV2
  });
});

describe("editCv2Message", () => {
  it("patches with attachments listing the fresh uploads (image-swap) + files", async () => {
    const rest = fakeRest();
    const res = await editCv2Message({ rest, channelId: "c", messageId: "m9", spec, files, log });
    expect(res).toEqual({ ok: true });
    const [route, opts] = rest.patch.mock.calls[0];
    expect(route).toBe(Routes.channelMessage("c", "m9"));
    expect((opts.body as { attachments: unknown[] }).attachments).toEqual([
      expect.objectContaining({ id: 0, filename: "c.png" }),
    ]);
    expect(opts.files).toEqual([{ name: "c.png", data: files[0].attachment }]);
  });

  it("fails closed on a missing attachment", async () => {
    const rest = fakeRest();
    const res = await editCv2Message({ rest, channelId: "c", messageId: "m", spec, files: [], log });
    expect(res.ok).toBe(false);
    expect(rest.patch).not.toHaveBeenCalled();
  });
});
