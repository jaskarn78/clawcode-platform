/**
 * Memory overhaul WP2 - stripChannelEnvelope keeps the user's words and
 * drops the Discord `<channel ...>` wrapper that polluted retrieval queries.
 */
import { describe, it, expect } from "vitest";
import { hasChannelEnvelope, stripChannelEnvelope } from "../channel-envelope.js";
import { formatDiscordMessage } from "../../discord/bridge.js";

const ENVELOPE =
  '<channel source="discord" chat_id="000000000000000001" message_id="1433000000000000000" user="jas" ts="2026-10-25 09:14 PDT">\n' +
  "is it safe to run the migration on staging?\n" +
  "</channel>";

describe("stripChannelEnvelope", () => {
  it("returns the inner text of a <channel ...>...</channel> wrapper", () => {
    expect(stripChannelEnvelope(ENVELOPE)).toBe("is it safe to run the migration on staging?");
  });

  it("leaves text without an envelope alone (trimmed)", () => {
    expect(stripChannelEnvelope("  plain question  ")).toBe("plain question");
    expect(stripChannelEnvelope("")).toBe("");
  });

  it("keeps text that follows the closing tag (attachment metadata)", () => {
    const withAttachment = `${ENVELOPE}\n\n[attachment: invoice.pdf saved to inbox/invoice.pdf]`;
    expect(stripChannelEnvelope(withAttachment)).toBe(
      "is it safe to run the migration on staging?\n\n[attachment: invoice.pdf saved to inbox/invoice.pdf]",
    );
  });

  it("unwraps several envelopes in one string", () => {
    const two = `<channel source="discord" user="a" ts="t">first</channel>\n<channel source="discord" user="b" ts="t">second</channel>`;
    expect(stripChannelEnvelope(two)).toBe("first\nsecond");
  });

  it("keeps multi-line inner text and nested tags such as <replying-to>", () => {
    const nested =
      '<channel source="discord" chat_id="1" message_id="2" user="jas" ts="t">\n' +
      '<replying-to message_id="9" user="bot" ts="t">\nearlier\n</replying-to>\n' +
      "line one\nline two\n</channel>";
    expect(stripChannelEnvelope(nested)).toBe(
      '<replying-to message_id="9" user="bot" ts="t">\nearlier\n</replying-to>\nline one\nline two',
    );
  });

  it("drops a dangling opening or closing tag", () => {
    expect(stripChannelEnvelope('<channel source="discord" user="jas" ts="t">\ntruncated words')).toBe("truncated words");
    expect(stripChannelEnvelope("stray words\n</channel>")).toBe("stray words");
  });

  it("is idempotent", () => {
    const once = stripChannelEnvelope(ENVELOPE);
    expect(stripChannelEnvelope(once)).toBe(once);
  });

  it("does not touch unrelated tags", () => {
    expect(stripChannelEnvelope("<b>bold</b> and <channel-ish>x</channel-ish>")).toBe(
      "<b>bold</b> and <channel-ish>x</channel-ish>",
    );
  });
});

describe("stripChannelEnvelope against the real formatDiscordMessage output", () => {
  const base = {
    channelId: "000000000000000001",
    id: "1433000000000000000",
    author: { username: "jas" },
    createdAt: new Date("2026-10-25T16:14:00Z"),
    attachments: new Map(),
  };

  it("returns exactly the user's words for a plain message", () => {
    const formatted = formatDiscordMessage(
      { ...base, content: "is it safe to run the migration on staging?" } as never,
      undefined,
      undefined,
      "America/Los_Angeles",
    );
    expect(formatted).toContain("<channel source=\"discord\"");
    expect(stripChannelEnvelope(formatted)).toBe("is it safe to run the migration on staging?");
  });

  it("keeps the reply context and attachment lines, drops only the wrapper", () => {
    const formatted = formatDiscordMessage(
      {
        ...base,
        content: "what is the total on this one?",
        reference: { messageId: "1432999999999999999" },
      } as never,
      undefined,
      {
        author: { username: "bot" },
        content: "Here is the invoice summary.",
        createdAt: new Date("2026-10-25T16:10:00Z"),
      } as never,
      "America/Los_Angeles",
    );
    const stripped = stripChannelEnvelope(formatted);
    expect(stripped).not.toContain("<channel");
    expect(stripped).not.toContain("</channel>");
    expect(stripped).toContain("what is the total on this one?");
    expect(stripped.startsWith("<replying-to")).toBe(true);
  });
});

describe("hasChannelEnvelope", () => {
  it("detects the opening tag only", () => {
    expect(hasChannelEnvelope(ENVELOPE)).toBe(true);
    expect(hasChannelEnvelope("plain")).toBe(false);
    expect(hasChannelEnvelope("</channel>")).toBe(false);
  });
});
