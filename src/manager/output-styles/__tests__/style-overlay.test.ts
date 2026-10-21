import { describe, it, expect } from "vitest";
import { STYLE_CHOICES } from "../../../discord/slash-types.js";
import { OUTPUT_STYLE_IDS } from "../roster.js";
import { renderStyleOverlay, getOutputStyle } from "../roster.js";

describe("renderStyleOverlay", () => {
  it("returns null for default — the baseline is the ABSENCE of an overlay", () => {
    expect(renderStyleOverlay("default")).toBeNull();
  });

  it("wraps a real style in the <output-style> tag with trailing separation", () => {
    const out = renderStyleOverlay("bluf");
    expect(out).toMatch(/^<output-style>\n/);
    expect(out).toMatch(/\n<\/output-style>\n\n$/);
    expect(out).toContain(getOutputStyle("bluf")!.block!);
  });

  it("prepending composes: overlay + message keeps the message intact", () => {
    const overlay = renderStyleOverlay("brief")!;
    const composed = overlay + "What is our runway?";
    expect(composed.endsWith("What is our runway?")).toBe(true);
    expect(composed.indexOf("<output-style>")).toBe(0);
  });
});

describe("2026-08-27 — bluf stays neutral on length; bluf-brief composite", () => {
  it("bluf no longer tells the model not to shorten", () => {
    const bluf = getOutputStyle("bluf");
    expect(bluf?.block).toBeDefined();
    expect(bluf!.block!.toLowerCase()).not.toContain("do not shorten");
    expect(bluf!.block!.toLowerCase()).toContain("own length rules");
  });
  it("bluf-brief exists, renders an overlay, and carries both halves", () => {
    const def = getOutputStyle("bluf-brief");
    expect(def).toBeDefined();
    const overlay = renderStyleOverlay("bluf-brief");
    expect(overlay).not.toBeNull();
    expect(overlay!.startsWith("<output-style>")).toBe(true);
    const b = def!.block!.toLowerCase();
    expect(b).toContain("open with the answer");
    expect(b).toContain("fewest words");
    expect(b).toContain("one-line ask gets a one-line answer");
  });
  it("every enum id has a roster entry and a slash choice", () => {
    for (const id of OUTPUT_STYLE_IDS) {
      expect(getOutputStyle(id), id).toBeDefined();
      expect(STYLE_CHOICES.some((c) => c.value === id), id).toBe(true);
    }
  });
});
