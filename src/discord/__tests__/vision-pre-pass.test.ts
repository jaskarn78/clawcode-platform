import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DownloadResult } from "../attachment-types.js";
import type { Logger } from "pino";

const mockResizeImageForVision = vi.fn();
const mockCallHaikuVision = vi.fn();

vi.mock("../image-resizer.js", () => ({
  resizeImageForVision: mockResizeImageForVision,
}));

vi.mock("../../manager/haiku-direct.js", () => ({
  callHaikuVision: mockCallHaikuVision,
}));

const { runVisionPrePass } = await import("../vision-pre-pass.js");

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function makeImageResult(path: string, contentType = "image/png"): DownloadResult {
  return {
    success: true,
    path,
    error: null,
    attachmentInfo: { name: "img.png", url: "https://cdn.discord.com/img.png", contentType, size: 5000, proxyUrl: "" },
  };
}

function makeFailedResult(): DownloadResult {
  return {
    success: false,
    path: null,
    error: "download failed",
    attachmentInfo: { name: "img.png", url: "https://cdn.discord.com/img.png", contentType: "image/png", size: 5000, proxyUrl: "" },
  };
}

describe("runVisionPrePass", () => {
  beforeEach(() => {
    mockResizeImageForVision.mockReset();
    mockCallHaikuVision.mockReset();
    (mockLog.info as ReturnType<typeof vi.fn>).mockReset();
    (mockLog.warn as ReturnType<typeof vi.fn>).mockReset();
  });

  it("returns empty map when results list is empty", async () => {
    const map = await runVisionPrePass([], { timeoutMs: 5000 }, mockLog);
    expect(map.size).toBe(0);
  });

  it("returns empty map for failed downloads", async () => {
    const map = await runVisionPrePass([makeFailedResult()], { timeoutMs: 5000 }, mockLog);
    expect(map.size).toBe(0);
    expect(mockResizeImageForVision).not.toHaveBeenCalled();
  });

  it("returns empty map for non-image content types", async () => {
    const pdfResult = makeImageResult("/tmp/doc.pdf", "application/pdf");
    const map = await runVisionPrePass([pdfResult], { timeoutMs: 5000 }, mockLog);
    expect(map.size).toBe(0);
    expect(mockResizeImageForVision).not.toHaveBeenCalled();
  });

  it("returns analysis mapped to path for successful image", async () => {
    const buf = Buffer.from("img-bytes");
    mockResizeImageForVision.mockResolvedValue(buf);
    mockCallHaikuVision.mockResolvedValue("TYPE: screenshot\nSUMMARY: login form");

    const r = makeImageResult("/tmp/inbox/screenshot.png");
    const map = await runVisionPrePass([r], { timeoutMs: 5000 }, mockLog);

    expect(map.size).toBe(1);
    expect(map.get("/tmp/inbox/screenshot.png")).toBe("TYPE: screenshot\nSUMMARY: login form");
    expect(mockResizeImageForVision).toHaveBeenCalledWith("/tmp/inbox/screenshot.png");
  });

  it("excludes failed images from map without throwing", async () => {
    mockResizeImageForVision.mockRejectedValue(new Error("sharp error"));

    const r = makeImageResult("/tmp/bad.png");
    const map = await runVisionPrePass([r], { timeoutMs: 5000 }, mockLog);

    expect(map.size).toBe(0);
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it("excludes images where haiku vision returns empty string", async () => {
    const buf = Buffer.from("img");
    mockResizeImageForVision.mockResolvedValue(buf);
    mockCallHaikuVision.mockResolvedValue("");

    const r = makeImageResult("/tmp/empty.png");
    const map = await runVisionPrePass([r], { timeoutMs: 5000 }, mockLog);
    expect(map.size).toBe(0);
  });

  it("processes multiple images in parallel and returns all analyses", async () => {
    const buf = Buffer.from("bytes");
    mockResizeImageForVision.mockResolvedValue(buf);
    mockCallHaikuVision
      .mockResolvedValueOnce("analysis-a")
      .mockResolvedValueOnce("analysis-b");

    const results = [
      makeImageResult("/tmp/a.png"),
      makeImageResult("/tmp/b.jpeg", "image/jpeg"),
    ];
    const map = await runVisionPrePass(results, { timeoutMs: 5000 }, mockLog);

    expect(map.size).toBe(2);
    expect(map.get("/tmp/a.png")).toBe("analysis-a");
    expect(map.get("/tmp/b.jpeg")).toBe("analysis-b");
  });
});
