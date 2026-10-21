import { describe, it, expect } from "vitest";
import {
  Cv2ValidationError,
  attachmentNamesIn,
  emitActions,
  emitButton,
  emitFile,
  emitMedia,
  emitSection,
} from "../cv2-blocks.js";

describe("cv2-blocks emitters", () => {
  it("emits an interactive button (style 2 + custom_id)", () => {
    expect(emitButton({ style: 2, label: "Details", customId: "demo:1:client-a:panel" })).toEqual({
      type: 2,
      style: 2,
      label: "Details",
      custom_id: "demo:1:client-a:panel",
    });
  });

  it("emits a link button (style 5 + url) and parses emoji", () => {
    expect(emitButton({ style: 5, label: "Docs", emoji: "🔗", url: "https://example.com/x" })).toEqual({
      type: 2,
      style: 5,
      label: "Docs",
      emoji: { name: "🔗" },
      url: "https://example.com/x",
    });
  });

  it("rejects invalid button combinations", () => {
    expect(() => emitButton({ style: 5, label: "x" })).toThrow(/requires a url/);
    expect(() => emitButton({ style: 2, label: "x" })).toThrow(/requires a customId/);
    expect(() => emitButton({ style: 2, label: "x", customId: "y", url: "z" })).toThrow(/must not have a url/);
    expect(() => emitButton({ style: 2, label: "x", customId: "c".repeat(101) })).toThrow(/at most 100/);
    expect(() => emitButton({ style: 2, label: "L".repeat(81), customId: "c" })).toThrow(/at most 80/);
  });

  it("emits a section with a button accessory", () => {
    const out = emitSection(["Limit 280 → 291", "-# 95% of the previous value"], { kind: "button", button: { style: 3, label: "Apply", customId: "demo:1:client-a:apply" } });
    expect(out.type).toBe(9);
    expect(out.components).toEqual([{ type: 10, content: "Limit 280 → 291" }, { type: 10, content: "-# 95% of the previous value" }]);
    expect(out.accessory).toMatchObject({ type: 2, style: 3, label: "Apply" });
  });

  it("rejects a section with 0 or >3 lines", () => {
    expect(() => emitSection([], { kind: "thumb", filename: "x.png" })).toThrow(/1-3/);
    expect(() => emitSection(["a", "b", "c", "d"], { kind: "thumb", filename: "x.png" })).toThrow(/1-3/);
  });

  it("emits media and file blocks with attachment:// urls", () => {
    expect(emitMedia([{ filename: "pmc.png", description: "chart" }])).toEqual({
      type: 12,
      items: [{ media: { url: "attachment://pmc.png" }, description: "chart" }],
    });
    expect(emitFile("data.csv")).toEqual({ type: 13, file: { url: "attachment://data.csv" } });
    expect(() => emitMedia([])).toThrow(/1-10/);
  });

  it("requires a select to be alone in its action row", () => {
    const sel = { kind: "select" as const, customId: "demo:1:client-a:pick", options: [{ label: "7d", value: "7d" }] };
    expect(emitActions([sel]).components[0]).toMatchObject({ type: 3, custom_id: sel.customId });
    expect(() => emitActions([sel, { kind: "button", style: 2, label: "x", customId: "y" }])).toThrow(/alone/);
  });

  it("rejects more than 5 buttons in a row", () => {
    const btn = { kind: "button" as const, style: 2 as const, label: "b", customId: "c" };
    expect(() => emitActions([btn, btn, btn, btn, btn, btn])).toThrow(/at most 5/);
  });

  it("attachmentNamesIn collects references", () => {
    expect(attachmentNamesIn(emitMedia([{ filename: "a.png" }, { filename: "b.png" }]))).toEqual(["a.png", "b.png"]);
    expect(attachmentNamesIn(emitFile("c.png"))).toEqual(["c.png"]);
  });

  it("throws Cv2ValidationError instances", () => {
    try {
      emitButton({ style: 9 as 1, label: "x", customId: "y" });
    } catch (e) {
      expect(e).toBeInstanceOf(Cv2ValidationError);
    }
  });
});
