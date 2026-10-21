import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  provisionWebhooks,
  verifyAgentWebhookIdentity,
  type ProvisionConfig,
} from "./webhook-provisioner.js";
import type { WebhookIdentity } from "./webhook-types.js";
import type { Logger } from "pino";

/**
 * Create a mock Discord.js Client with the required interface.
 */
function makeMockClient(botUserId = "bot-123") {
  return {
    user: { id: botUserId },
    channels: {
      fetch: vi.fn(),
    },
  } as unknown as ProvisionConfig["client"];
}

/**
 * Create a mock text channel with fetchWebhooks and createWebhook.
 */
function makeMockChannel(webhooks: Array<{ owner?: { id: string }; url: string }> = []) {
  const collection = new Map(webhooks.map((w, i) => [String(i), w]));
  return {
    fetchWebhooks: vi.fn().mockResolvedValue(collection),
    createWebhook: vi.fn().mockResolvedValue({ url: "https://discord.com/api/webhooks/new/token" }),
  };
}

/** Silent logger for tests. */
const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe("provisionWebhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves manual webhook identities without overwriting", async () => {
    const client = makeMockClient();
    const manualIdentities = new Map<string, WebhookIdentity>([
      ["agent-a", { displayName: "Agent A", avatarUrl: undefined, webhookUrl: "https://manual.url" }],
    ]);

    const result = await provisionWebhooks({
      client,
      agents: [
        { name: "agent-a", channels: ["ch-1"], webhook: { displayName: "Agent A", webhookUrl: "https://manual.url" } },
      ],
      manualIdentities,
      log: silentLog,
    });

    expect(result.get("agent-a")?.webhookUrl).toBe("https://manual.url");
    // Should NOT have tried to fetch channels for manual agents
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  // Phase 999.117 WS-7 — this test previously asserted that an agent with no
  // `webhook:` block was SKIPPED. That skip is exactly why the webhook rung
  // was 100% dead in production: none of the nine live agents declared the
  // block, so the WebhookManager booted with zero identities on every restart
  // and every A2A message fell through to bot-direct — which the recipient's
  // own bridge drops. Provisioning only ever needed a display name, and the
  // agent's own name is a fine one.
  it("provisions an agent with no webhook block, defaulting displayName to its name", async () => {
    const channel = makeMockChannel([]);
    const client = makeMockClient("bot-123");
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    const result = await provisionWebhooks({
      client,
      agents: [{ name: "agent-no-webhook", channels: ["ch-1"] }],
      manualIdentities: new Map(),
      log: silentLog,
    });

    expect(result.size).toBe(1);
    expect(result.get("agent-no-webhook")?.displayName).toBe("agent-no-webhook");
    expect(client.channels.fetch).toHaveBeenCalledWith("ch-1");
  });

  it("an explicit displayName still wins over the agent name", async () => {
    const channel = makeMockChannel([]);
    const client = makeMockClient("bot-123");
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    const result = await provisionWebhooks({
      client,
      agents: [
        { name: "admin-clawdy", channels: ["ch-1"], webhook: { displayName: "Admin Clawdy" } },
      ],
      manualIdentities: new Map(),
      log: silentLog,
    });

    expect(result.get("admin-clawdy")?.displayName).toBe("Admin Clawdy");
  });

  it("skips agents with no bound channels", async () => {
    const client = makeMockClient();

    const result = await provisionWebhooks({
      client,
      agents: [
        { name: "agent-no-channels", channels: [], webhook: { displayName: "No Channels" } },
      ],
      manualIdentities: new Map(),
      log: silentLog,
    });

    expect(result.size).toBe(0);
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it("reuses existing bot-owned webhook (no createWebhook called)", async () => {
    const channel = makeMockChannel([
      { owner: { id: "bot-123" }, url: "https://discord.com/api/webhooks/existing/token" },
    ]);
    const client = makeMockClient("bot-123");
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    const result = await provisionWebhooks({
      client,
      agents: [
        { name: "agent-b", channels: ["ch-2"], webhook: { displayName: "Agent B", avatarUrl: "https://avatar.url" } },
      ],
      manualIdentities: new Map(),
      log: silentLog,
    });

    expect(result.get("agent-b")?.webhookUrl).toBe("https://discord.com/api/webhooks/existing/token");
    expect(result.get("agent-b")?.displayName).toBe("Agent B");
    expect(channel.createWebhook).not.toHaveBeenCalled();
  });

  it("creates new webhook when no bot-owned webhook exists", async () => {
    const channel = makeMockChannel([
      { owner: { id: "other-user" }, url: "https://other.webhook" },
    ]);
    const client = makeMockClient("bot-123");
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    const result = await provisionWebhooks({
      client,
      agents: [
        { name: "agent-c", channels: ["ch-3"], webhook: { displayName: "Agent C" } },
      ],
      manualIdentities: new Map(),
      log: silentLog,
    });

    expect(result.get("agent-c")?.webhookUrl).toBe("https://discord.com/api/webhooks/new/token");
    expect(channel.createWebhook).toHaveBeenCalledWith({
      name: "Agent C",
      avatar: null,
    });
  });

  it("catches channel fetch errors and continues (non-fatal)", async () => {
    const client = makeMockClient();
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Unknown channel"));

    const result = await provisionWebhooks({
      client,
      agents: [
        { name: "agent-err", channels: ["bad-ch"], webhook: { displayName: "Error Agent" } },
      ],
      manualIdentities: new Map(),
      log: silentLog,
    });

    // Should not throw, should return empty map
    expect(result.size).toBe(0);
    expect(silentLog.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 90 Plan 07 WIRE-05 — verifyAgentWebhookIdentity tests (WH-V1..V3)
// Thin per-agent wrapper over provisionWebhooks that returns a three-state
// status ({verified|provisioned|missing}) for daemon-boot identity probing.
// ---------------------------------------------------------------------------

describe("verifyAgentWebhookIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("WH-V1: returns 'verified' when an existing bot-owned webhook is present", async () => {
    const channel = makeMockChannel([
      { owner: { id: "bot-123" }, url: "https://discord.com/api/webhooks/existing/token" },
    ]);
    const client = makeMockClient("bot-123");
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    const result = await verifyAgentWebhookIdentity({
      client,
      agentName: "fin-client",
      channelId: "000000000000000024",
      displayName: "Finance Clawdy",
      avatarUrl: "https://acme.example/avatar.png",
      log: silentLog,
    });

    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.webhookUrl).toBe(
        "https://discord.com/api/webhooks/existing/token",
      );
      expect(result.displayName).toBe("Finance Clawdy");
    }
    // Reuses existing webhook — createWebhook never fires.
    expect(channel.createWebhook).not.toHaveBeenCalled();
  });

  it("WH-V2: returns 'provisioned' when no bot-owned webhook exists (auto-creates one)", async () => {
    const channel = makeMockChannel([
      { owner: { id: "some-other-user" }, url: "https://other.webhook" },
    ]);
    const client = makeMockClient("bot-123");
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    const result = await verifyAgentWebhookIdentity({
      client,
      agentName: "fin-client",
      channelId: "000000000000000024",
      displayName: "Finance Clawdy",
      log: silentLog,
    });

    expect(result.status).toBe("provisioned");
    if (result.status === "provisioned") {
      expect(result.webhookUrl).toBe(
        "https://discord.com/api/webhooks/new/token",
      );
      expect(result.displayName).toBe("Finance Clawdy");
    }
    expect(channel.createWebhook).toHaveBeenCalledWith({
      name: "Finance Clawdy",
      avatar: null,
    });
  });

  it("WH-V3: returns 'missing' when channelId is undefined (no binding)", async () => {
    const client = makeMockClient();

    const result = await verifyAgentWebhookIdentity({
      client,
      agentName: "no-channel-agent",
      channelId: undefined,
      displayName: "Nobody",
      log: silentLog,
    });

    expect(result.status).toBe("missing");
    // No Discord API calls should fire when channelId is absent.
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2026-09-03 — auto-provisioned identities are A2A-ONLY.
//
// Regression seen live: WS-7 provisioned webhooks for all nine agents, and
// `hasWebhook` gates ORDINARY delivery in four places in bridge.ts. So every
// agent's replies to a person started arriving from a webhook named after the
// agent with a default Discord avatar, instead of from the ClawdyV2 bot. The
// identity must exist (A2A embeds want the sender's face) without taking over
// conversation.
// ---------------------------------------------------------------------------

describe("auto-provisioned identities are A2A-only", () => {
  it("marks an identity a2aOnly when the agent declared no webhook block", async () => {
    const channel = makeMockChannel([]);
    const client = makeMockClient("bot-123");
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    const result = await provisionWebhooks({
      client,
      agents: [{ name: "personal", channels: ["ch-1"] }],
      manualIdentities: new Map(),
      log: silentLog,
    });

    expect(result.get("personal")?.a2aOnly).toBe(true);
  });

  it("does NOT mark one the operator configured explicitly", async () => {
    const channel = makeMockChannel([]);
    const client = makeMockClient("bot-123");
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    const result = await provisionWebhooks({
      client,
      agents: [
        { name: "admin-clawdy", channels: ["ch-1"], webhook: { displayName: "Admin Clawdy" } },
      ],
      manualIdentities: new Map(),
      log: silentLog,
    });

    expect(result.get("admin-clawdy")?.a2aOnly).toBeUndefined();
  });
});
