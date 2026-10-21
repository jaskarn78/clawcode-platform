import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture all WebhookClient.send calls across instances.
const sendMock = vi.fn().mockResolvedValue({ id: "msg-id" });
const destroyMock = vi.fn();

vi.mock("discord.js", () => {
  class MockWebhookClient {
    constructor(_opts: { url: string }) {}
    send = sendMock;
    destroy = destroyMock;
  }
  return { WebhookClient: MockWebhookClient };
});

// Import AFTER vi.mock so the WebhookManager picks up the mocked WebhookClient.
import { WebhookManager } from "../webhook-manager.js";
import type { WebhookIdentity } from "../webhook-types.js";

const TEST_IDENTITY: WebhookIdentity = {
  displayName: "TestBot",
  avatarUrl: "https://example.com/avatar.png",
  webhookUrl: "https://discord.com/api/webhooks/0/abc",
};

function makeManager(): WebhookManager {
  const identities = new Map<string, WebhookIdentity>([
    ["test-agent", TEST_IDENTITY],
  ]);
  return new WebhookManager({ identities });
}

describe("WebhookManager.sendAsAgent — 401/404 invalidate + reprovision retry (Phase 119 A2A-02)", () => {
  beforeEach(() => {
    sendMock.mockClear();
    destroyMock.mockClear();
  });

  function makeEmbed() {
    return { toJSON: () => ({}) } as unknown as import("discord.js").EmbedBuilder;
  }

  function makeDiscordError(status: 401 | 404): Error {
    const err = new Error(`Discord API error ${status}`) as Error & {
      status: number;
      code: number;
    };
    err.status = status;
    err.code = status;
    return err;
  }

  it("WHM-RECOVER-1: 401-then-200 — invalidates cache, reprovisions, retries once, succeeds", async () => {
    sendMock.mockReset();
    sendMock
      .mockRejectedValueOnce(makeDiscordError(401))
      .mockResolvedValueOnce({ id: "msg-after-reprovision" });

    const reprovisionWebhook = vi.fn().mockResolvedValue({
      displayName: "TestBot",
      avatarUrl: "https://example.com/avatar.png",
      webhookUrl: "https://discord.com/api/webhooks/0/NEW",
    });

    const identities = new Map<string, WebhookIdentity>([
      ["test-agent", TEST_IDENTITY],
    ]);
    const manager = new WebhookManager({ identities, reprovisionWebhook });

    const result = await manager.sendAsAgent(
      "test-agent",
      "Sender",
      undefined,
      makeEmbed(),
    );

    expect(result).toBe("msg-after-reprovision");
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(reprovisionWebhook).toHaveBeenCalledTimes(1);
    expect(reprovisionWebhook).toHaveBeenCalledWith("test-agent");
    // Cache is repopulated with the NEW identity
    expect(manager.getIdentity("test-agent")?.webhookUrl).toBe(
      "https://discord.com/api/webhooks/0/NEW",
    );
  });

  it("WHM-RECOVER-2: 404-then-200 — same shape as 401 recovery", async () => {
    sendMock.mockReset();
    sendMock
      .mockRejectedValueOnce(makeDiscordError(404))
      .mockResolvedValueOnce({ id: "msg-after-reprovision" });

    const reprovisionWebhook = vi.fn().mockResolvedValue({
      displayName: "TestBot",
      avatarUrl: "https://example.com/avatar.png",
      webhookUrl: "https://discord.com/api/webhooks/0/NEW404",
    });

    const identities = new Map<string, WebhookIdentity>([
      ["test-agent", TEST_IDENTITY],
    ]);
    const manager = new WebhookManager({ identities, reprovisionWebhook });

    await manager.sendAsAgent(
      "test-agent",
      "Sender",
      undefined,
      makeEmbed(),
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(reprovisionWebhook).toHaveBeenCalledTimes(1);
    expect(manager.getIdentity("test-agent")?.webhookUrl).toBe(
      "https://discord.com/api/webhooks/0/NEW404",
    );
  });

  it("WHM-RECOVER-3: 401-then-401 — exactly two attempts then throws (bounded retry)", async () => {
    sendMock.mockReset();
    sendMock
      .mockRejectedValueOnce(makeDiscordError(401))
      .mockRejectedValueOnce(makeDiscordError(401));

    const reprovisionWebhook = vi.fn().mockResolvedValue({
      displayName: "TestBot",
      avatarUrl: "https://example.com/avatar.png",
      webhookUrl: "https://discord.com/api/webhooks/0/NEW",
    });

    const identities = new Map<string, WebhookIdentity>([
      ["test-agent", TEST_IDENTITY],
    ]);
    const manager = new WebhookManager({ identities, reprovisionWebhook });

    await expect(
      manager.sendAsAgent("test-agent", "Sender", undefined, makeEmbed()),
    ).rejects.toThrow(/Discord API error 401/);

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(reprovisionWebhook).toHaveBeenCalledTimes(1);
  });

  it("WHM-RECOVER-4: non-401/404 error — single attempt, no reprovision, error propagates", async () => {
    sendMock.mockReset();
    const err = new Error("rate limited") as Error & { status: number };
    err.status = 429;
    sendMock.mockRejectedValueOnce(err);

    const reprovisionWebhook = vi.fn();

    const identities = new Map<string, WebhookIdentity>([
      ["test-agent", TEST_IDENTITY],
    ]);
    const manager = new WebhookManager({ identities, reprovisionWebhook });

    await expect(
      manager.sendAsAgent("test-agent", "Sender", undefined, makeEmbed()),
    ).rejects.toThrow(/rate limited/);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(reprovisionWebhook).not.toHaveBeenCalled();
  });

  it("WHM-RECOVER-5: reprovisioner unwired — single attempt, error propagates verbatim", async () => {
    sendMock.mockReset();
    sendMock.mockRejectedValueOnce(makeDiscordError(401));

    const identities = new Map<string, WebhookIdentity>([
      ["test-agent", TEST_IDENTITY],
    ]);
    const manager = new WebhookManager({ identities });

    await expect(
      manager.sendAsAgent("test-agent", "Sender", undefined, makeEmbed()),
    ).rejects.toThrow(/Discord API error 401/);

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("WHM-RECOVER-6: reprovisioner returns undefined — first failure surfaces verbatim, no retry", async () => {
    sendMock.mockReset();
    sendMock.mockRejectedValueOnce(makeDiscordError(404));

    const reprovisionWebhook = vi.fn().mockResolvedValue(undefined);

    const identities = new Map<string, WebhookIdentity>([
      ["test-agent", TEST_IDENTITY],
    ]);
    const manager = new WebhookManager({ identities, reprovisionWebhook });

    await expect(
      manager.sendAsAgent("test-agent", "Sender", undefined, makeEmbed()),
    ).rejects.toThrow(/Discord API error 404/);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(reprovisionWebhook).toHaveBeenCalledTimes(1);
  });
});

describe("WebhookManager.send — markdown table wrapping (regression for 100-fu webhook gap)", () => {
  beforeEach(() => {
    sendMock.mockClear();
    destroyMock.mockClear();
  });

  it("WHM-WRAP-1: renders markdown tables (aligned grid in a fence) before posting", async () => {
    const manager = makeManager();
    // 3-column narrow table → adaptive renders an aligned grid in a fence.
    const tableContent = [
      "| Col1 | Col2 | Col3 |",
      "| ---- | ---- | ---- |",
      "| A | B | E |",
      "| C | D | F |",
    ].join("\n");

    await manager.send("test-agent", tableContent);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.content).toContain("```text");
    // Content survives; re-padded grid drops the raw outer pipes.
    expect(payload.content).toContain("Col1 | Col2 | Col3");
    expect(payload.content).not.toContain("| Col1 | Col2 |");
    // Identity reaches the underlying WebhookClient
    expect(payload.username).toBe(TEST_IDENTITY.displayName);
    expect(payload.avatarURL).toBe(TEST_IDENTITY.avatarUrl);
  });

  it("WHM-WRAP-2: idempotent — already-fenced content is NOT double-wrapped", async () => {
    const manager = makeManager();
    const alreadyFenced = [
      "```text",
      "| Col1 | Col2 |",
      "| ---- | ---- |",
      "| A | B |",
      "```",
    ].join("\n");

    await manager.send("test-agent", alreadyFenced);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    // Exactly one pair of fences (opening + closing) — no nesting.
    const fenceMarkerCount = (payload.content.match(/```/g) ?? []).length;
    expect(fenceMarkerCount).toBe(2);
    // Original content preserved verbatim through the wrap step.
    expect(payload.content).toContain(alreadyFenced);
  });

  it("WHM-WRAP-3: pure prose (no tables) reaches WebhookClient unchanged byte-for-byte", async () => {
    const manager = makeManager();
    const prose = "Hello world.\n\nNo tables here.\nJust paragraphs.";

    await manager.send("test-agent", prose);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.content).toBe(prose);
  });

  it("WHM-WRAP-4: existing chunking + identity behavior preserved", async () => {
    const manager = makeManager();
    // Build content larger than 2000 chars to force chunking.
    const big = "line\n".repeat(500); // 5 chars * 500 = 2500 chars
    await manager.send("test-agent", big);

    expect(sendMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendMock.mock.calls) {
      expect(call[0].username).toBe(TEST_IDENTITY.displayName);
      expect(call[0].avatarURL).toBe(TEST_IDENTITY.avatarUrl);
      expect(call[0].content.length).toBeLessThanOrEqual(2000);
    }
  });

  it("WHM-WRAP-5: throws when agent has no webhook configured", async () => {
    const manager = makeManager();
    await expect(manager.send("nobody", "hi")).rejects.toThrow(
      /No webhook identity configured/,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// Phase 122 — sendAsAgent embed description must be table-wrapped at the
// chokepoint. Uses a stand-in object that mimics EmbedBuilder's data slot
// and setDescription mutator so we can assert the wrap without depending
// on discord.js's real EmbedBuilder.
describe("WebhookManager.sendAsAgent — embed description wrap (Phase 122)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ id: "msg-id" });
    destroyMock.mockClear();
  });

  function makeEmbedWithDescription(initial: string) {
    const state: { description: string } = { description: initial };
    const builder = {
      data: state,
      setDescription(next: string) {
        state.description = next;
        return this;
      },
    };
    return builder as unknown as import("discord.js").EmbedBuilder;
  }

  it("WHM-WRAP-EMBED-1: embed.description containing a markdown table is wrapped before send", async () => {
    const manager = makeManager();
    // 3-column narrow table → adaptive renders an aligned grid in a code
    // fence; proves the send path ran formatOutboundText. (A 2-column table
    // would render as key/value with no fence — see markdown-table-wrap.test.)
    const table = [
      "| Plan | Limit | Year |",
      "| ---- | ----- | ---- |",
      "| SIMPLE IRA | $16,500 | 2026 |",
      "| Solo 401(k) | $23,500 | 2026 |",
    ].join("\n");
    const embed = makeEmbedWithDescription(table);

    await manager.sendAsAgent("test-agent", "Sender", undefined, embed);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as { embeds: unknown[] };
    const dispatchedEmbed = payload.embeds[0] as { data: { description: string } };
    expect(dispatchedEmbed.data.description).toContain("```text");
    expect(dispatchedEmbed.data.description).toContain("SIMPLE IRA");
    // Re-padded grid drops the raw outer pipes.
    expect(dispatchedEmbed.data.description).not.toContain("| Plan | Limit |");
  });

  it("WHM-WRAP-EMBED-2: empty description is left alone (no setDescription call needed)", async () => {
    const manager = makeManager();
    const embed = makeEmbedWithDescription("");

    await manager.sendAsAgent("test-agent", "Sender", undefined, embed);

    const payload = sendMock.mock.calls[0][0] as { embeds: unknown[] };
    const dispatchedEmbed = payload.embeds[0] as { data: { description: string } };
    expect(dispatchedEmbed.data.description).toBe("");
  });

  it("WHM-WRAP-EMBED-3: pure-prose description passes through unchanged (idempotent)", async () => {
    const manager = makeManager();
    // Phase 999.79 — formatOutboundText strips em dashes, so test prose
    // uses a plain hyphen to keep the "passes through unchanged" semantic
    // (the em-dash strip is exercised in text-sanitization.test.ts).
    const prose = "Hello - no tables here. Just words.";
    const embed = makeEmbedWithDescription(prose);

    await manager.sendAsAgent("test-agent", "Sender", undefined, embed);

    const payload = sendMock.mock.calls[0][0] as { embeds: unknown[] };
    const dispatchedEmbed = payload.embeds[0] as { data: { description: string } };
    expect(dispatchedEmbed.data.description).toBe(prose);
  });
});
