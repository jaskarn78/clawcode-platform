import { describe, it, expect } from "vitest";
import { formatReactionEvent, type ReactionEvent } from "./reactions.js";

describe("formatReactionEvent", () => {
  it("formats an add reaction event", () => {
    const event: ReactionEvent = {
      type: "add",
      emoji: "thumbsup",
      userName: "alice",
      messageId: "msg-123",
      channelId: "chan-456",
    };

    const result = formatReactionEvent(event);
    expect(result).toContain('type="add"');
    expect(result).toContain('emoji="thumbsup"');
    expect(result).toContain('user="alice"');
    expect(result).toContain('message_id="msg-123"');
    expect(result).toContain('channel_id="chan-456"');
    expect(result).toContain("<reaction");
    expect(result).toContain("</reaction>");
  });

  it("formats a remove reaction event", () => {
    const event: ReactionEvent = {
      type: "remove",
      emoji: "fire",
      userName: "bob",
      messageId: "msg-789",
      channelId: "chan-101",
    };

    const result = formatReactionEvent(event);
    expect(result).toContain('type="remove"');
    expect(result).toContain('emoji="fire"');
  });

  it("includes original message content when provided", () => {
    const event: ReactionEvent = {
      type: "add",
      emoji: "heart",
      userName: "carol",
      messageId: "msg-111",
      channelId: "chan-222",
      messageContent: "Hello world!",
    };

    const result = formatReactionEvent(event);
    expect(result).toContain("Original message: Hello world!");
  });

  it("omits message content when not provided", () => {
    const event: ReactionEvent = {
      type: "add",
      emoji: "rocket",
      userName: "dave",
      messageId: "msg-333",
      channelId: "chan-444",
    };

    const result = formatReactionEvent(event);
    expect(result).not.toContain("Original message:");
  });

  it("produces consistent format with opening and closing tags", () => {
    const event: ReactionEvent = {
      type: "add",
      emoji: "check",
      userName: "eve",
      messageId: "msg-555",
      channelId: "chan-666",
    };

    const result = formatReactionEvent(event);
    const lines = result.split("\n");
    expect(lines[0]).toMatch(/^<reaction /);
    expect(lines[lines.length - 1]).toBe("</reaction>");
  });
});
