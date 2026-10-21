import { describe, it, expect } from "vitest";

import { encodeScreenshot, resolveScreenshotSavePath } from "../screenshot.js";

describe("encodeScreenshot", () => {
  it("returns a text + image content envelope when bytes ≤ maxInlineBytes", () => {
    const buffer = Buffer.alloc(100, 7);
    const envelope = encodeScreenshot(buffer, 512, { path: "/tmp/a.png" });
    expect(envelope.content).toHaveLength(2);
    expect(envelope.content[0].type).toBe("text");
    if (envelope.content[0].type === "text") {
      const parsed = JSON.parse(envelope.content[0].text) as {
        path: string;
        bytes: number;
        inline: boolean;
      };
      expect(parsed.path).toBe("/tmp/a.png");
      expect(parsed.bytes).toBe(100);
      expect(parsed.inline).toBe(true);
    }
    expect(envelope.content[1].type).toBe("image");
    if (envelope.content[1].type === "image") {
      expect(envelope.content[1].mimeType).toBe("image/png");
      expect(envelope.content[1].data).toBe(buffer.toString("base64"));
    }
  });

  it("inlines when bytes exactly equals the threshold (boundary)", () => {
    const threshold = 256;
    const buffer = Buffer.alloc(threshold, 1);
    const envelope = encodeScreenshot(buffer, threshold, { path: "/tmp/b.png" });
    expect(envelope.content).toHaveLength(2);
    expect(envelope.content[1].type).toBe("image");
  });

  it("returns a path-only envelope when bytes > maxInlineBytes (Pitfall 7 guard)", () => {
    const buffer = Buffer.alloc(1024, 0);
    const envelope = encodeScreenshot(buffer, 512, { path: "/tmp/big.png" });
    expect(envelope.content).toHaveLength(1);
    expect(envelope.content[0].type).toBe("text");
    if (envelope.content[0].type === "text") {
      const parsed = JSON.parse(envelope.content[0].text) as {
        path: string;
        bytes: number;
        inline: boolean;
        note: string;
      };
      expect(parsed.path).toBe("/tmp/big.png");
      expect(parsed.bytes).toBe(1024);
      expect(parsed.inline).toBe(false);
      expect(parsed.note).toContain("Read tool");
    }
  });

  it("never inlines when maxInlineBytes = 0 (sentinel: disable inline)", () => {
    const buffer = Buffer.alloc(10, 0);
    const envelope = encodeScreenshot(buffer, 0, { path: "/tmp/any.png" });
    expect(envelope.content).toHaveLength(1);
    expect(envelope.content[0].type).toBe("text");
  });

  it("returns a frozen envelope (immutability per CLAUDE.md)", () => {
    const buffer = Buffer.alloc(32);
    const envelope = encodeScreenshot(buffer, 512, { path: "/tmp/f.png" });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.content)).toBe(true);
    for (const item of envelope.content) {
      expect(Object.isFrozen(item)).toBe(true);
    }
  });
});

describe("resolveScreenshotSavePath", () => {
  it("returns override path verbatim when caller provides one", () => {
    const out = resolveScreenshotSavePath("/ws", "/custom/location.png");
    expect(out).toBe("/custom/location.png");
  });

  it("treats empty-string override as absent (falls through to default)", () => {
    const out = resolveScreenshotSavePath("/ws", "");
    expect(out).toContain("/ws/browser/screenshots/");
    expect(out).toMatch(/\.png$/);
  });

  it("composes default path under <workspace>/browser/screenshots/<date>/", () => {
    const out = resolveScreenshotSavePath("/workspace/clawdy");
    expect(out).toContain("/workspace/clawdy/browser/screenshots/");
    // Dated subdir matching yyyy-MM-dd pattern.
    expect(out).toMatch(/\/\d{4}-\d{2}-\d{2}\//);
    // Filename ends in .png
    expect(out).toMatch(/\.png$/);
  });

  it("produces unique filenames on rapid successive calls", () => {
    const a = resolveScreenshotSavePath("/ws");
    const b = resolveScreenshotSavePath("/ws");
    const c = resolveScreenshotSavePath("/ws");
    // nanoid(6) + epochMs makes collisions astronomically unlikely.
    const set = new Set([a, b, c]);
    expect(set.size).toBe(3);
  });
});
