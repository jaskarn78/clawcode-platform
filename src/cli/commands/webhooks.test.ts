import { describe, it, expect } from "vitest";
import { formatWebhooksTable } from "./webhooks.js";

describe("formatWebhooksTable", () => {
  it("returns empty message when no webhooks configured", () => {
    const result = formatWebhooksTable({ webhooks: [] });
    expect(result).toBe("No webhook identities configured");
  });

  it("shows column headers AGENT, DISPLAY NAME, AVATAR, STATUS", () => {
    const result = formatWebhooksTable({
      webhooks: [
        { agent: "atlas", displayName: "Atlas AI", avatarUrl: "https://example.com/avatar.png", hasWebhookUrl: true },
      ],
    });
    expect(result).toContain("AGENT");
    expect(result).toContain("DISPLAY NAME");
    expect(result).toContain("AVATAR");
    expect(result).toContain("STATUS");
  });

  it("shows title 'Webhook Identities'", () => {
    const result = formatWebhooksTable({
      webhooks: [
        { agent: "atlas", displayName: "Atlas AI", hasWebhookUrl: true },
      ],
    });
    expect(result).toContain("Webhook Identities");
  });

  it("shows 'yes' in avatar column when avatarUrl is present", () => {
    const result = formatWebhooksTable({
      webhooks: [
        { agent: "atlas", displayName: "Atlas AI", avatarUrl: "https://example.com/avatar.png", hasWebhookUrl: true },
      ],
    });
    expect(result).toContain("yes");
  });

  it("shows 'no' in avatar column when avatarUrl is absent", () => {
    const result = formatWebhooksTable({
      webhooks: [
        { agent: "atlas", displayName: "Atlas AI", hasWebhookUrl: true },
      ],
    });
    const lines = result.split("\n");
    const dataRow = lines.find((l) => l.includes("atlas"));
    expect(dataRow).toContain("no");
  });

  it("shows 'active' status when hasWebhookUrl is true", () => {
    const result = formatWebhooksTable({
      webhooks: [
        { agent: "atlas", displayName: "Atlas AI", hasWebhookUrl: true },
      ],
    });
    expect(result).toContain("active");
  });

  it("shows 'no url' status when hasWebhookUrl is false", () => {
    const result = formatWebhooksTable({
      webhooks: [
        { agent: "luna", displayName: "Luna Bot", hasWebhookUrl: false },
      ],
    });
    expect(result).toContain("no url");
  });

  it("renders multiple webhooks in same table", () => {
    const result = formatWebhooksTable({
      webhooks: [
        { agent: "atlas", displayName: "Atlas AI", avatarUrl: "https://example.com/a.png", hasWebhookUrl: true },
        { agent: "luna", displayName: "Luna Bot", hasWebhookUrl: false },
        { agent: "claw", displayName: "Claw", avatarUrl: "https://example.com/c.png", hasWebhookUrl: true },
      ],
    });
    expect(result).toContain("atlas");
    expect(result).toContain("luna");
    expect(result).toContain("claw");
    expect(result).toContain("Atlas AI");
    expect(result).toContain("Luna Bot");
  });

  it("has separator line between header and data", () => {
    const result = formatWebhooksTable({
      webhooks: [
        { agent: "atlas", displayName: "Atlas AI", hasWebhookUrl: true },
      ],
    });
    const lines = result.split("\n");
    // Line 3 (index 3) should be the separator (after title, blank, header)
    expect(lines[3]).toMatch(/^-+$/);
  });
});
