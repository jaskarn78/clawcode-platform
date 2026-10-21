import { describe, it, expect } from "vitest";
import { splitMessage, buildWebhookIdentities } from "./webhook-manager.js";
import type { WebhookIdentity } from "./webhook-types.js";

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    const result = splitMessage("hello", 2000);
    expect(result).toEqual(["hello"]);
  });

  it("returns single chunk for exactly max length", () => {
    const text = "a".repeat(2000);
    const result = splitMessage(text, 2000);
    expect(result).toEqual([text]);
  });

  it("splits long messages at newlines", () => {
    const line1 = "a".repeat(1500);
    const line2 = "b".repeat(1500);
    const text = `${line1}\n${line2}`;
    const result = splitMessage(text, 2000);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(line1);
    expect(result[1]).toBe(line2);
  });

  it("splits long messages at spaces when no newlines", () => {
    const word = "word ";
    const text = word.repeat(500); // 2500 chars
    const result = splitMessage(text, 2000);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("hard splits when no whitespace", () => {
    const text = "a".repeat(5000);
    const result = splitMessage(text, 2000);
    expect(result.length).toBe(3);
    expect(result[0].length).toBe(2000);
    expect(result[1].length).toBe(2000);
    expect(result[2].length).toBe(1000);
  });

  it("returns empty array content for empty string", () => {
    const result = splitMessage("", 2000);
    expect(result).toEqual([""]);
  });
});

describe("buildWebhookIdentities", () => {
  it("builds map from agents with webhook config", () => {
    const agents = [
      {
        name: "agent-a",
        webhook: {
          displayName: "Agent A",
          avatarUrl: "https://example.com/a.png",
          webhookUrl: "https://discord.com/api/webhooks/123/abc",
        },
      },
      {
        name: "agent-b",
        webhook: {
          displayName: "Agent B",
          webhookUrl: "https://discord.com/api/webhooks/456/def",
        },
      },
    ];

    const identities = buildWebhookIdentities(agents);
    expect(identities.size).toBe(2);

    const a = identities.get("agent-a") as WebhookIdentity;
    expect(a.displayName).toBe("Agent A");
    expect(a.avatarUrl).toBe("https://example.com/a.png");
    expect(a.webhookUrl).toBe("https://discord.com/api/webhooks/123/abc");

    const b = identities.get("agent-b") as WebhookIdentity;
    expect(b.displayName).toBe("Agent B");
    expect(b.avatarUrl).toBeUndefined();
  });

  it("skips agents without webhookUrl", () => {
    const agents = [
      {
        name: "agent-no-url",
        webhook: {
          displayName: "Agent No URL",
        },
      },
      {
        name: "agent-no-webhook",
      },
    ];

    const identities = buildWebhookIdentities(agents);
    expect(identities.size).toBe(0);
  });

  it("returns empty map for empty agents array", () => {
    const identities = buildWebhookIdentities([]);
    expect(identities.size).toBe(0);
  });
});
