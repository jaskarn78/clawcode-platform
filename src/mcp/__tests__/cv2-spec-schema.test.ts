/**
 * `post_cv2_embed` input schema — tested the way an agent probes it.
 *
 * 2026-09-10 (client-a-personal): `{"type":"media"}` returned MCP -32602 "No
 * matching discriminator" because the tool advertised only text|separator
 * while the renderer had supported the full CV2 vocabulary since 999.135.
 */
import { describe, it, expect } from "vitest";
import { CV2_FILES_SCHEMA, CV2_SPEC_SCHEMA, MAX_CV2_FILES } from "../cv2-spec-schema.js";

const ok = (spec: unknown) => CV2_SPEC_SCHEMA.safeParse(spec).success;
const err = (spec: unknown): string => {
  const r = CV2_SPEC_SCHEMA.safeParse(spec);
  return r.success ? "" : r.error.issues.map((i) => i.message).join(" | ");
};

describe("CV2_SPEC_SCHEMA — the probe that used to fail", () => {
  it("accepts a media block (client-a-personal's exact probe)", () => {
    expect(ok({ blocks: [{ type: "media", items: [{ filename: "chart1.png" }] }] })).toBe(true);
  });

  it("accepts four charts each under its own header — the requested layout", () => {
    const blocks = [1, 2, 3, 4].flatMap((n) => [
      { type: "text", content: `## Chart ${n}` },
      { type: "media", items: [{ filename: `chart${n}.png`, description: `chart ${n}` }] },
      { type: "separator" },
    ]);
    expect(ok({ accentColor: 0x5865f2, blocks })).toBe(true);
  });

  it("accepts a section with a thumbnail accessory", () => {
    expect(ok({ blocks: [{ type: "section", text: ["**Fox Ranger** $64.95"], accessory: { kind: "thumb", filename: "fox.png" } }] })).toBe(true);
  });

  it("accepts a section with a link-button accessory", () => {
    expect(
      ok({
        blocks: [
          { type: "section", text: ["Spotti half-zip $24.99"], accessory: { kind: "button", button: { style: 5, label: "Buy", url: "https://www.amazon.com/dp/B0747HLHCZ" } } },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a file block and a row of link buttons", () => {
    expect(
      ok({
        blocks: [
          { type: "file", filename: "report.pdf" },
          { type: "actions", components: [{ kind: "button", style: 5, label: "Open", url: "https://example.com" }] },
        ],
      }),
    ).toBe(true);
  });

  it("legacy text/separator specs are unchanged", () => {
    expect(ok({ blocks: [{ type: "text", content: "# Board" }, { type: "separator", divider: true, spacing: 2 }] })).toBe(true);
  });
});

describe("CV2_SPEC_SCHEMA — what it still refuses, with a reason", () => {
  it("rejects a customId button — there is no handler, it would fail on click", () => {
    const r = CV2_SPEC_SCHEMA.safeParse({
      blocks: [{ type: "actions", components: [{ kind: "button", style: 1, label: "Do it", customId: "x" }] }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-link style even without customId", () => {
    expect(ok({ blocks: [{ type: "actions", components: [{ kind: "button", style: 2, label: "Hm", url: "https://e.com" }] }] })).toBe(false);
  });

  it("rejects a button with neither label nor emoji", () => {
    expect(err({ blocks: [{ type: "actions", components: [{ kind: "button", style: 5, url: "https://e.com" }] }] })).toMatch(/label or an emoji/);
  });

  it("rejects an unknown block type", () => {
    expect(ok({ blocks: [{ type: "poll", question: "?" }] })).toBe(false);
  });

  it("rejects a filename with a path separator or traversal", () => {
    expect(ok({ blocks: [{ type: "media", items: [{ filename: "../etc/passwd" }] }] })).toBe(false);
    expect(ok({ blocks: [{ type: "media", items: [{ filename: "a/b.png" }] }] })).toBe(false);
    expect(ok({ blocks: [{ type: "file", filename: ".." }] })).toBe(false);
  });

  it("rejects an empty media gallery and one over 10 items", () => {
    expect(ok({ blocks: [{ type: "media", items: [] }] })).toBe(false);
    expect(ok({ blocks: [{ type: "media", items: Array.from({ length: 11 }, (_, i) => ({ filename: `c${i}.png` })) }] })).toBe(false);
  });

  it("rejects a section with more than 3 lines", () => {
    expect(ok({ blocks: [{ type: "section", text: ["a", "b", "c", "d"], accessory: { kind: "thumb", filename: "t.png" } }] })).toBe(false);
  });
});

describe("CV2_SPEC_SCHEMA — security-review hardening (2026-09-10)", () => {
  it("rejects bidi-override / zero-width characters in a filename (extension spoofing)", () => {
    const rtl = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE
    const zw = String.fromCharCode(0x200b); // ZERO WIDTH SPACE
    expect(ok({ blocks: [{ type: "media", items: [{ filename: `report${rtl}gnp.exe` }] }] })).toBe(false);
    expect(ok({ blocks: [{ type: "file", filename: `chart${zw}.png` }] })).toBe(false);
    expect(ok({ blocks: [{ type: "file", filename: "chart.png" }] })).toBe(true);
  });

  it("rejects a non-http(s) link button url", () => {
    const btn = (url: string) => ({ blocks: [{ type: "actions", components: [{ kind: "button", style: 5, label: "x", url }] }] });
    expect(ok(btn("javascript:alert(1)"))).toBe(false);
    expect(ok(btn("file:///etc/passwd"))).toBe(false);
    expect(ok(btn("https://www.amazon.com/dp/B0747HLHCZ"))).toBe(true);
    expect(ok(btn("http://example.com"))).toBe(true);
  });

  it("rejects unknown keys on a button accessory (strict, like the button itself)", () => {
    expect(
      ok({
        blocks: [
          { type: "section", text: ["a"], accessory: { kind: "button", button: { style: 5, label: "x", url: "https://e.com" }, customId: "smuggled" } },
        ],
      }),
    ).toBe(false);
  });

  it("rejects a select menu outright (no handler exists for agent-authored ids)", () => {
    expect(ok({ blocks: [{ type: "actions", components: [{ kind: "select", customId: "s", options: [{ label: "a", value: "a" }] }] }] })).toBe(false);
  });
});

describe("CV2_FILES_SCHEMA", () => {
  it("accepts workspace paths with optional name/description", () => {
    expect(CV2_FILES_SCHEMA.safeParse([{ path: "charts/one.png" }, { path: "/abs/two.png", name: "two.png", description: "alt" }]).success).toBe(true);
  });

  it(`caps at ${MAX_CV2_FILES} files`, () => {
    expect(CV2_FILES_SCHEMA.safeParse(Array.from({ length: MAX_CV2_FILES + 1 }, (_, i) => ({ path: `f${i}.png` }))).success).toBe(false);
  });

  it("rejects a name that is not a single path segment", () => {
    expect(CV2_FILES_SCHEMA.safeParse([{ path: "x.png", name: "../x.png" }]).success).toBe(false);
  });
});
