/** WebhookManager.sendWithFiles — files ride the chunk that carries their placeholder. */
import { describe, it, expect, vi } from "vitest";
import { WebhookManager } from "../webhook-manager.js";

function makeManager() {
  const send = vi.fn(async (payload: { content: string; files?: unknown[] }) => ({ id: `m${send.mock.calls.length}` }));
  const wm = new WebhookManager({
    identities: new Map([["fin", { webhookUrl: "https://discord.com/api/webhooks/1/x", displayName: "client-a", avatarUrl: null }]]),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never);
  (wm as unknown as { clients: Map<string, unknown> }).clients.set("fin", { send });
  return { wm, send };
}

describe("WebhookManager.sendWithFiles", () => {
  it("attaches each file to the chunk containing its anchor", async () => {
    const { wm, send } = makeManager();
    const anchor = "-# 📊 Plan · 3 rows × 5 columns · image below";
    const chunk1 = "a".repeat(1990); // + newline + anchor > 2000 → splits at the newline
    const content = `${chunk1}\n${anchor}\ntail`;
    const png = Buffer.from("png");
    const result = await wm.sendWithFiles("fin", content, [{ attachment: png, name: "table-1.png", description: "alt", anchor }]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].files).toBeUndefined();
    expect(send.mock.calls[1]![0].content).toContain(anchor);
    expect(send.mock.calls[1]![0].files).toEqual([{ attachment: png, name: "table-1.png", description: "alt" }]);
    expect((send.mock.calls[1]![0] as { flags?: number }).flags).toBe(4); // SUPPRESS_EMBEDS
    expect(result.messageIds).toEqual(["m1", "m2"]);
  });
  it("send() keeps its legacy shape (no files key)", async () => {
    const { wm, send } = makeManager();
    await wm.send("fin", "| A | B |\n|---|---|\n| 1 | 2 |");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].content).toBe("**1:** 2"); // 1-char headers → no caption
    expect("files" in send.mock.calls[0]![0]).toBe(false);
  });
});
