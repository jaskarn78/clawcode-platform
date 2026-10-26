/**
 * Memory overhaul WP2 - stripChannelEnvelope keeps the user's words and
 * drops the Discord `<channel ...>` wrapper that polluted retrieval queries.
 */
import { describe, it, expect } from "vitest";
import { hasChannelEnvelope, stripChannelEnvelope } from "../channel-envelope.js";

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

describe("hasChannelEnvelope", () => {
  it("detects the opening tag only", () => {
    expect(hasChannelEnvelope(ENVELOPE)).toBe(true);
    expect(hasChannelEnvelope("plain")).toBe(false);
    expect(hasChannelEnvelope("</channel>")).toBe(false);
  });
});
