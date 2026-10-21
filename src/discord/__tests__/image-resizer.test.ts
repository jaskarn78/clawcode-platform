import { describe, it, expect, beforeEach, vi } from "vitest";

const mockChain = {
  resize: vi.fn(),
  png: vi.fn(),
  toBuffer: vi.fn(),
  // P1-TIMEOUT — resizeImageForVision now chains .timeout({ seconds: 15 }).
  timeout: vi.fn(),
};
mockChain.resize.mockReturnValue(mockChain);
mockChain.png.mockReturnValue(mockChain);
mockChain.timeout.mockReturnValue(mockChain);

const mockSharp = vi.fn(() => mockChain);

vi.mock("sharp", () => ({ default: mockSharp }));

const { resizeImageForVision } = await import("../image-resizer.js");

describe("resizeImageForVision", () => {
  beforeEach(() => {
    mockSharp.mockClear();
    mockChain.resize.mockClear();
    mockChain.png.mockClear();
    mockChain.toBuffer.mockClear();
    mockChain.timeout.mockClear();
    mockChain.resize.mockReturnValue(mockChain);
    mockChain.png.mockReturnValue(mockChain);
    mockChain.timeout.mockReturnValue(mockChain);
  });

  it("calls sharp with the file path, resizes to 1568px, outputs PNG", async () => {
    const buf = Buffer.from("fake-image-bytes");
    mockChain.toBuffer.mockResolvedValue(buf);

    const result = await resizeImageForVision("/tmp/screenshot.png");

    expect(result).toBe(buf);
    // P1-PIXELGUARD — sharp() now takes the limitInputPixels guard as 2nd arg.
    expect(mockSharp).toHaveBeenCalledWith("/tmp/screenshot.png", {
      limitInputPixels: 89_478_485,
    });
    // P1-TIMEOUT — native libvips cancel wall.
    expect(mockChain.timeout).toHaveBeenCalledWith({ seconds: 15 });
    expect(mockChain.resize).toHaveBeenCalledWith(1568, 1568, {
      fit: "inside",
      withoutEnlargement: true,
    });
    expect(mockChain.png).toHaveBeenCalled();
    expect(mockChain.toBuffer).toHaveBeenCalled();
  });

  it("withoutEnlargement: true so small images are not upscaled", async () => {
    mockChain.toBuffer.mockResolvedValue(Buffer.alloc(4));
    await resizeImageForVision("/tmp/small.jpg");
    const [, , opts] = mockChain.resize.mock.calls[0]!;
    expect((opts as { withoutEnlargement: boolean }).withoutEnlargement).toBe(true);
  });

  it("uses fit: inside to preserve aspect ratio", async () => {
    mockChain.toBuffer.mockResolvedValue(Buffer.alloc(4));
    await resizeImageForVision("/tmp/wide.png");
    const [, , opts] = mockChain.resize.mock.calls[0]!;
    expect((opts as { fit: string }).fit).toBe("inside");
  });
});
