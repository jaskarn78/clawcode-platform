import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdir, writeFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  formatAttachmentMetadata,
  downloadAttachment,
  isImageAttachment,
  cleanupAttachments,
} from "../attachments.js";
import type { AttachmentInfo, DownloadResult } from "../attachment-types.js";
import { MAX_ATTACHMENT_SIZE } from "../attachment-types.js";

function makeInfo(overrides: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return {
    name: "photo.png",
    url: "https://cdn.discordapp.com/attachments/123/456/photo.png",
    contentType: "image/png",
    size: 12345,
    proxyUrl: "https://media.discordapp.net/attachments/123/456/photo.png",
    ...overrides,
  };
}

function makeResult(overrides: Partial<DownloadResult> = {}): DownloadResult {
  return {
    success: true,
    path: "/tmp/downloads/1234-photo.png",
    error: null,
    attachmentInfo: makeInfo(),
    ...overrides,
  };
}

describe("formatAttachmentMetadata", () => {
  it("returns structured XML-like block with name, type, size, local_path for each attachment", () => {
    const results: readonly DownloadResult[] = [
      makeResult({
        path: "/tmp/dl/1234-photo.png",
        attachmentInfo: makeInfo({ name: "photo.png", contentType: "image/png", size: 12345 }),
      }),
    ];

    const output = formatAttachmentMetadata(results);

    expect(output).toContain("<attachments>");
    expect(output).toContain("</attachments>");
    expect(output).toContain('name="photo.png"');
    expect(output).toContain('type="image/png"');
    expect(output).toContain('size="12345"');
    expect(output).toContain('local_path="/tmp/dl/1234-photo.png"');
  });

  it("returns empty string for empty array", () => {
    const output = formatAttachmentMetadata([]);
    expect(output).toBe("");
  });

  it("includes error attribute for failed downloads instead of local_path", () => {
    const results: readonly DownloadResult[] = [
      makeResult({
        success: false,
        path: null,
        error: "Fetch failed",
        attachmentInfo: makeInfo({ name: "broken.pdf" }),
      }),
    ];

    const output = formatAttachmentMetadata(results);

    expect(output).toContain('name="broken.pdf"');
    expect(output).toContain('error="Fetch failed"');
    expect(output).not.toContain("local_path");
  });
});

describe("downloadAttachment", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `att-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("fetches URL, writes to targetDir with timestamped sanitized name, returns DownloadResult with path", async () => {
    const fakeBody = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(fakeBody, { status: 200 }),
    );

    const info = makeInfo({ name: "my photo (1).png", size: 100 });
    const result = await downloadAttachment(info, testDir);

    expect(result.success).toBe(true);
    expect(result.path).not.toBeNull();
    expect(result.error).toBeNull();
    expect(result.attachmentInfo).toBe(info);

    // Check file exists and name is sanitized
    const files = await readdir(testDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d+-my_photo__1_.png$/);

    vi.restoreAllMocks();
  });

  it("rejects files over MAX_ATTACHMENT_SIZE without downloading", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const info = makeInfo({ size: MAX_ATTACHMENT_SIZE + 1 });
    const result = await downloadAttachment(info, testDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("exceeds");
    expect(result.path).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("handles fetch failure gracefully (returns error result, does not throw)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const info = makeInfo({ size: 100 });
    const result = await downloadAttachment(info, testDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
    expect(result.path).toBeNull();

    vi.restoreAllMocks();
  });

  it("times out after DOWNLOAD_TIMEOUT_MS", async () => {
    // Mock fetch to never resolve within timeout
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        }),
    );

    const info = makeInfo({ size: 100 });
    // Use a short timeout override for test speed
    const result = await downloadAttachment(info, testDir, 50);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timeout|abort/i);
    expect(result.path).toBeNull();

    vi.restoreAllMocks();
  });
});

describe("isImageAttachment", () => {
  it("returns true for image/png, image/jpeg, image/gif, image/webp", () => {
    expect(isImageAttachment("image/png")).toBe(true);
    expect(isImageAttachment("image/jpeg")).toBe(true);
    expect(isImageAttachment("image/gif")).toBe(true);
    expect(isImageAttachment("image/webp")).toBe(true);
  });

  it("returns false for application/pdf, text/plain, null", () => {
    expect(isImageAttachment("application/pdf")).toBe(false);
    expect(isImageAttachment("text/plain")).toBe(false);
    expect(isImageAttachment(null)).toBe(false);
  });
});

describe("cleanupAttachments", () => {
  let cleanupDir: string;

  beforeEach(async () => {
    cleanupDir = join(tmpdir(), `cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(cleanupDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(cleanupDir, { recursive: true, force: true });
  });

  it("removes files older than maxAgeMs from a directory", async () => {
    // Create a file and backdate its mtime
    const oldFile = join(cleanupDir, "old-file.png");
    await writeFile(oldFile, "old data");
    const pastTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    const { utimes } = await import("node:fs/promises");
    await utimes(oldFile, pastTime, pastTime);

    const removed = await cleanupAttachments(cleanupDir, 60 * 60 * 1000); // 1 hour max age

    expect(removed).toBe(1);
    const remaining = await readdir(cleanupDir);
    expect(remaining.length).toBe(0);
  });

  it("skips files younger than maxAgeMs", async () => {
    // Create a recent file
    const newFile = join(cleanupDir, "new-file.png");
    await writeFile(newFile, "new data");

    const removed = await cleanupAttachments(cleanupDir, 60 * 60 * 1000); // 1 hour max age

    expect(removed).toBe(0);
    const remaining = await readdir(cleanupDir);
    expect(remaining.length).toBe(1);
  });
});
