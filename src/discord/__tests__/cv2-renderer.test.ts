import { describe, it, expect } from "vitest";
import {
  buildCv2Payload,
  Cv2ValidationError,
  type Cv2Spec,
} from "../cv2-renderer.js";

describe("buildCv2Payload", () => {
  it("builds a minimal text-only container", () => {
    const spec: Cv2Spec = {
      blocks: [{ type: "text", content: "Hello" }],
    };
    const out = buildCv2Payload(spec);
    expect(out.flags).toBe(1 << 15); // IsComponentsV2 = 32768
    expect(out.components).toHaveLength(1);
    expect(out.components[0]!.type).toBe(17);
    expect(out.components[0]!.accent_color).toBeUndefined();
    expect(out.components[0]!.components).toEqual([
      { type: 10, content: "Hello" },
    ]);
  });

  it("preserves accent color when set", () => {
    const out = buildCv2Payload({
      accentColor: 0x5865f2,
      blocks: [{ type: "text", content: "x" }],
    });
    expect(out.components[0]!.accent_color).toBe(0x5865f2);
  });

  it("renders separator with defaults (divider=true, spacing=1)", () => {
    const out = buildCv2Payload({
      blocks: [{ type: "separator" }],
    });
    expect(out.components[0]!.components[0]).toEqual({
      type: 14,
      divider: true,
      spacing: 1,
    });
  });

  it("renders separator with explicit divider=false and spacing=2", () => {
    const out = buildCv2Payload({
      blocks: [{ type: "separator", divider: false, spacing: 2 }],
    });
    expect(out.components[0]!.components[0]).toEqual({
      type: 14,
      divider: false,
      spacing: 2,
    });
  });

  it("renders a mixed task-board-shaped container", () => {
    const out = buildCv2Payload({
      accentColor: 0xff6b6b,
      blocks: [
        { type: "text", content: "# 📋 Task Board" },
        { type: "separator" },
        { type: "text", content: "🔴 **Overdue**\n• 🟡 T-001" },
        { type: "separator", spacing: 2 },
        { type: "text", content: "Progress ▰▰▱▱  1/2" },
      ],
    });
    expect(out.components[0]!.components).toHaveLength(5);
    expect(out.components[0]!.components.map((c) => c.type)).toEqual([
      10, 14, 10, 14, 10,
    ]);
  });

  it("rejects empty blocks", () => {
    expect(() => buildCv2Payload({ blocks: [] })).toThrow(Cv2ValidationError);
  });

  it("rejects more than 40 blocks", () => {
    const blocks = Array.from({ length: 41 }, (_, i) => ({
      type: "text" as const,
      content: `b${i}`,
    }));
    expect(() => buildCv2Payload({ blocks })).toThrow(/at most 40/);
  });

  it("rejects text content longer than 4000 chars", () => {
    const huge = "x".repeat(4001);
    expect(() =>
      buildCv2Payload({ blocks: [{ type: "text", content: huge }] }),
    ).toThrow(/4000/);
  });

  it("rejects empty text content", () => {
    expect(() =>
      buildCv2Payload({ blocks: [{ type: "text", content: "" }] }),
    ).toThrow(/must not be empty/);
  });

  it("rejects accent color out of range", () => {
    expect(() =>
      buildCv2Payload({
        accentColor: 0x1000000,
        blocks: [{ type: "text", content: "x" }],
      }),
    ).toThrow(/0xFFFFFF/);
    expect(() =>
      buildCv2Payload({
        accentColor: -1,
        blocks: [{ type: "text", content: "x" }],
      }),
    ).toThrow(/0xFFFFFF/);
  });

  it("rejects non-array blocks", () => {
    expect(() =>
      buildCv2Payload({ blocks: "nope" as unknown as Cv2Spec["blocks"] }),
    ).toThrow(/must be an array/);
  });

  it("rejects unknown block type", () => {
    expect(() =>
      buildCv2Payload({
        blocks: [
          { type: "image", content: "x" } as unknown as Cv2Spec["blocks"][0],
        ],
      }),
    ).toThrow(/text.*separator/);
  });

  it("rejects separator with invalid spacing", () => {
    expect(() =>
      buildCv2Payload({
        blocks: [
          {
            type: "separator",
            spacing: 3 as unknown as 1 | 2,
          },
        ],
      }),
    ).toThrow(/spacing must be 1 or 2/);
  });
});
