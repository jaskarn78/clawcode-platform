import { describe, it, expect } from "vitest";
import {
  buildCv2Payload,
  Cv2ValidationError,
  pruneUnbackedAttachments,
  referencedAttachments,
  type Cv2Block,
  type Cv2Spec,
} from "../cv2-renderer.js";

describe("cv2-renderer v2 blocks", () => {
  it("renders media / file / section / actions to raw Discord shapes", () => {
    const out = buildCv2Payload({
      accentColor: 0xfc4c02,
      blocks: [
        { type: "text", content: "# Card" },
        { type: "media", items: [{ filename: "pmc.png", description: "chart" }] },
        { type: "actions", components: [{ kind: "button", style: 2, label: "Details", customId: "demo:1:client-a:panel" }] },
      ],
    });
    const types = out.components[0]!.components.map((c) => (c as { type: number }).type);
    expect(types).toEqual([10, 12, 1]);
  });

  it("enforces total text ≤4000 across MULTIPLE blocks (the per-block check misses this)", () => {
    const big = "x".repeat(1500);
    const spec: Cv2Spec = {
      blocks: [
        { type: "text", content: big },
        { type: "text", content: big },
        { type: "text", content: big },
        { type: "media", items: [{ filename: "pmc.png" }] }, // rich block → gate active
      ],
    };
    expect(() => buildCv2Payload(spec)).toThrow(/4000 across all text/);
  });

  it("enforces the flattened component count ≤40 with nested rows", () => {
    const blocks: Cv2Block[] = [];
    for (let i = 0; i < 30; i++) blocks.push({ type: "text", content: `t${i}` });
    const fiveButtons = Array.from({ length: 5 }, (_, i) => ({ kind: "button" as const, style: 2 as const, label: `b${i}`, customId: `c${i}` }));
    blocks.push({ type: "actions", components: fiveButtons });
    blocks.push({ type: "actions", components: fiveButtons });
    blocks.push({ type: "section", text: ["a", "b", "c"], accessory: { kind: "button", button: { style: 2, label: "x", customId: "y" } } });
    // 33 blocks (≤40 pre-check) but flattened = 1+30+6+6+5 = 48 > 40.
    expect(() => buildCv2Payload({ blocks })).toThrow(/40 total/);
  });

  it("does NOT apply the new budgets to text/separator-only specs (ledger card back-compat)", () => {
    const big = "y".repeat(3000);
    expect(() => buildCv2Payload({ blocks: [{ type: "text", content: big }, { type: "text", content: big }] })).not.toThrow();
  });

  it("referencedAttachments + pruneUnbackedAttachments drop unbacked media", () => {
    const spec: Cv2Spec = {
      blocks: [
        { type: "text", content: "# x" },
        { type: "separator" },
        { type: "media", items: [{ filename: "pmc.png" }] },
        { type: "separator" },
        { type: "actions", components: [{ kind: "button", style: 2, label: "z", customId: "c" }] },
      ],
    };
    expect(referencedAttachments(spec)).toEqual(["pmc.png"]);
    const pruned = pruneUnbackedAttachments(spec, new Set());
    expect(referencedAttachments(pruned)).toEqual([]); // media dropped
    expect(pruned.blocks.some((b) => b.type === "media")).toBe(false);
    // consecutive separators from the drop are collapsed
    expect(() => buildCv2Payload(pruned)).not.toThrow();
  });

  it("keeps backed attachments after pruning", () => {
    const spec: Cv2Spec = { blocks: [{ type: "text", content: "x" }, { type: "media", items: [{ filename: "a.png" }, { filename: "b.png" }] }] };
    const pruned = pruneUnbackedAttachments(spec, new Set(["a.png"]));
    expect(referencedAttachments(pruned)).toEqual(["a.png"]);
  });

  it("throws Cv2ValidationError for a bad custom_id length inside a rich block", () => {
    expect(() =>
      buildCv2Payload({ blocks: [{ type: "actions", components: [{ kind: "button", style: 2, label: "x", customId: "c".repeat(101) }] }] }),
    ).toThrow(Cv2ValidationError);
  });
});
