/**
 * 2026-09-03 — `hasWebhook` must hide A2A-only identities.
 *
 * It gates ordinary reply delivery in bridge.ts (x4). An unqualified identity
 * there silently re-routes every conversational reply through a webhook named
 * after the agent — which is exactly what went wrong live.
 */
import { describe, it, expect } from "vitest";
import { WebhookManager } from "../webhook-manager.js";

const url = "https://discord.com/api/webhooks/1/tok";

describe("WebhookManager — A2A-only identities", () => {
  it("hides an a2aOnly identity from ordinary delivery, exposes it to A2A", () => {
    const m = new WebhookManager({
      identities: new Map([
        ["personal", { displayName: "personal", avatarUrl: undefined, webhookUrl: url, a2aOnly: true }],
      ]),
    });
    expect(m.hasWebhook("personal")).toBe(false);
    expect(m.hasA2aWebhook("personal")).toBe(true);
  });

  it("an operator-configured identity is visible to both", () => {
    const m = new WebhookManager({
      identities: new Map([
        ["fin-client", { displayName: "Fin", avatarUrl: undefined, webhookUrl: url }],
      ]),
    });
    expect(m.hasWebhook("fin-client")).toBe(true);
    expect(m.hasA2aWebhook("fin-client")).toBe(true);
  });

  it("an unknown agent has neither", () => {
    const m = new WebhookManager({ identities: new Map() });
    expect(m.hasWebhook("nobody")).toBe(false);
    expect(m.hasA2aWebhook("nobody")).toBe(false);
  });
});
