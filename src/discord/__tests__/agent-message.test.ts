import { describe, it, expect } from "vitest";
import { buildAgentMessageEmbed } from "../agent-message.js";

describe("buildAgentMessageEmbed", () => {
  it("sets author with [Agent] badge", () => {
    const embed = buildAgentMessageEmbed("bot-a", "Bot Alpha", "hello");
    const json = embed.toJSON();
    expect(json.author?.name).toBe("Bot Alpha [Agent]");
  });

  it("sets description to message content", () => {
    const embed = buildAgentMessageEmbed("bot-a", "Bot Alpha", "hello world");
    const json = embed.toJSON();
    expect(json.description).toBe("hello world");
  });

  it("sets color to Discord blurple (0x5865F2)", () => {
    const embed = buildAgentMessageEmbed("bot-a", "Bot Alpha", "hello");
    const json = embed.toJSON();
    expect(json.color).toBe(0x5865F2);
  });

  it("sets footer with sender machine name", () => {
    const embed = buildAgentMessageEmbed("bot-a", "Bot Alpha", "hello");
    const json = embed.toJSON();
    expect(json.footer?.text).toBe("Agent-to-agent message from bot-a");
  });

  it("sets timestamp", () => {
    const embed = buildAgentMessageEmbed("bot-a", "Bot Alpha", "hello");
    const json = embed.toJSON();
    expect(json.timestamp).toBeTruthy();
  });

  it("truncates content over 4096 chars with ellipsis", () => {
    const longContent = "x".repeat(5000);
    const embed = buildAgentMessageEmbed("bot-a", "Bot Alpha", longContent);
    const json = embed.toJSON();
    expect(json.description!.length).toBe(4096);
    expect(json.description!.endsWith("...")).toBe(true);
  });

  it("does not truncate content at exactly 4096 chars", () => {
    const exactContent = "y".repeat(4096);
    const embed = buildAgentMessageEmbed("bot-a", "Bot Alpha", exactContent);
    const json = embed.toJSON();
    expect(json.description).toBe(exactContent);
  });
});
