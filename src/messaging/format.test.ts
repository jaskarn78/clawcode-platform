import { describe, it, expect } from "vitest";
import { formatAgentMessage } from "./format.js";
import type { InboundMessage } from "./types.js";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "slack",
    channelId: "C123",
    messageId: "1718000000.000100",
    userId: "U999",
    userName: "alice",
    text: "hello there",
    isBot: false,
    ts: new Date("2026-06-16T00:00:00.000Z"),
    ...overrides,
  };
}

describe("formatAgentMessage", () => {
  it("stamps source with the originating platform", () => {
    const out = formatAgentMessage(msg());
    expect(out).toContain('source="slack"');
    expect(out).toContain('chat_id="C123"');
    expect(out).toContain('message_id="1718000000.000100"');
    expect(out).toContain('user="alice"');
    expect(out).toContain("<channel ");
    expect(out).toContain("</channel>");
    expect(out).toContain("hello there");
  });

  it("uses the platform field verbatim (telegram-ready)", () => {
    const out = formatAgentMessage(msg({ platform: "telegram" }));
    expect(out).toContain('source="telegram"');
  });

  it("escapes XML-significant characters in attributes", () => {
    const out = formatAgentMessage(msg({ userName: 'a<b>&"x' }));
    expect(out).toContain("a&lt;b&gt;&amp;&quot;x");
    expect(out).not.toContain('user="a<b>');
  });

  it("adds a thread hint when the message is a threaded reply", () => {
    const out = formatAgentMessage(msg({ threadId: "1717000000.000001" }));
    expect(out).toContain("(in thread 1717000000.000001)");
  });

  it("omits the thread hint for a thread-parent message (threadId === messageId)", () => {
    const out = formatAgentMessage(msg({ threadId: "1718000000.000100" }));
    expect(out).not.toContain("(in thread");
  });

  it("renders a downloaded image with a Read hint pointing at the local path", () => {
    const out = formatAgentMessage(
      msg({
        attachments: [
          { name: "shot.png", mimeType: "image/png", sizeBytes: 2048, url: "u", localPath: "/tmp/a/shot.png" },
        ],
      }),
    );
    expect(out).toContain("Attachments:");
    expect(out).toContain("- shot.png (image/png, 2048 bytes)");
    expect(out).toContain("(Image downloaded -- read the file at /tmp/a/shot.png to see its contents)");
  });

  it("uses non-image wording for a downloaded non-image file", () => {
    const out = formatAgentMessage(
      msg({
        text: "see attached",
        attachments: [
          { name: "doc.pdf", mimeType: "application/pdf", sizeBytes: 99, url: "u", localPath: "/tmp/a/doc.pdf" },
        ],
      }),
    );
    expect(out).toContain("(File downloaded -- read the file at /tmp/a/doc.pdf)");
    expect(out).not.toContain("Image downloaded");
  });

  it("marks an attachment that could not be downloaded (no localPath)", () => {
    const out = formatAgentMessage(
      msg({
        attachments: [{ name: "big.zip", mimeType: null, sizeBytes: 0, url: "u" }],
      }),
    );
    expect(out).toContain("- big.zip (unknown, 0 bytes) [not downloaded]");
    expect(out).not.toContain("read the file at");
  });

  it("renders no attachments block when there are none", () => {
    expect(formatAgentMessage(msg())).not.toContain("Attachments:");
  });
});
