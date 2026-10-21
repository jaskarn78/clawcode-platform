/** WebhookManager.editMessageComponents — swaps button rows, touches nothing else. */
import { describe, it, expect, vi } from "vitest";
import { WebhookManager } from "../webhook-manager.js";

function makeManager() {
  const editMessage = vi.fn(async (_id: string, _payload: unknown) => ({ id: "m1" }));
  const wm = new WebhookManager({
    identities: new Map([["fin", { webhookUrl: "https://discord.com/api/webhooks/1/x", displayName: "client-a", avatarUrl: null }]]),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never);
  (wm as unknown as { clients: Map<string, unknown> }).clients.set("fin", { editMessage });
  return { wm, editMessage };
}

describe("WebhookManager.editMessageComponents", () => {
  it("hands the client exactly { components } — no content, no flags", async () => {
    const { wm, editMessage } = makeManager();
    const components = [{ type: 1, components: [{ type: 2, style: 2, label: "🧾 Sources", custom_id: "ledger:t1" }] }];
    await wm.editMessageComponents("fin", "msg-1", components);
    expect(editMessage).toHaveBeenCalledTimes(1);
    const [id, payload] = editMessage.mock.calls[0]!;
    expect(id).toBe("msg-1");
    expect(payload).toEqual({ components });
    expect(Object.keys(payload as object)).toEqual(["components"]);
    expect("content" in (payload as object)).toBe(false);
    expect("flags" in (payload as object)).toBe(false);
  });

  it("an empty array clears the rows (still { components } only)", async () => {
    const { wm, editMessage } = makeManager();
    await wm.editMessageComponents("fin", "msg-2", []);
    expect(editMessage).toHaveBeenCalledWith("msg-2", { components: [] });
  });

  it("throws when the agent has no webhook identity", async () => {
    const { wm, editMessage } = makeManager();
    await expect(wm.editMessageComponents("nobody", "msg-3", [])).rejects.toThrow(/No webhook identity/);
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("propagates a Discord-side edit failure to the caller", async () => {
    const { wm, editMessage } = makeManager();
    editMessage.mockRejectedValueOnce(new Error("Discord API error 404"));
    await expect(wm.editMessageComponents("fin", "gone", [])).rejects.toThrow(/404/);
  });
});
