import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { downloadSlackAttachments, __resetCleanupThrottleForTest } from "./file-download.js";
import type { SlackWebClient } from "./web-api.js";
import type { InboundMessage } from "../types.js";
import { logger } from "../../shared/logger.js";

function baseMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "slack",
    channelId: "C1",
    messageId: "1718000000.000100",
    userId: "U1",
    userName: "U1",
    text: "look",
    isBot: false,
    ts: new Date("2026-06-16T00:00:00Z"),
    ...overrides,
  };
}

describe("downloadSlackAttachments", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetCleanupThrottleForTest();
  });

  it("returns the message unchanged when there are no attachments", async () => {
    const web = { downloadFile: vi.fn() } as unknown as SlackWebClient;
    const msg = baseMessage();
    expect(await downloadSlackAttachments(web, msg, logger)).toBe(msg);
    expect(web.downloadFile).not.toHaveBeenCalled();
  });

  it("downloads each file to a local path the agent can read", async () => {
    const payload = new TextEncoder().encode("PNGDATA");
    const web = { downloadFile: vi.fn(async () => payload) } as unknown as SlackWebClient;

    const msg = baseMessage({
      attachments: [{ name: "shot.png", mimeType: "image/png", sizeBytes: 7, url: "https://files/x.png" }],
    });
    const out = await downloadSlackAttachments(web, msg, logger);

    const localPath = out.attachments![0].localPath;
    expect(localPath).toBeDefined();
    expect(localPath).toContain("clawcode-slack-attachments");
    expect(new TextDecoder().decode(await readFile(localPath!))).toBe("PNGDATA");
    // sanitized filename: <msgId>-<idx>-<name>
    expect(localPath).toContain("1718000000.000100-0-shot.png".replace(/[^A-Za-z0-9._-]/g, "_"));

    await rm(localPath!, { force: true });
  });

  it("fails open: a download error keeps the metadata-only attachment", async () => {
    const web = {
      downloadFile: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as SlackWebClient;

    const msg = baseMessage({
      attachments: [{ name: "x.png", mimeType: "image/png", sizeBytes: 7, url: "https://files/x.png" }],
    });
    const out = await downloadSlackAttachments(web, msg, logger);
    expect(out.attachments![0].localPath).toBeUndefined();
    expect(out.attachments![0].name).toBe("x.png");
  });
});
