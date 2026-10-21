/**
 * 999.160 v1.2 — the icon registry renders text only until the application
 * emoji set is loaded, keeps only `cc_*` names, and emits the three Discord
 * shapes (inline, button, reaction) from one source.
 */
import { describe, expect, it } from "vitest";
import { ICON_NAMES, IconRegistry, isIconEmojiName } from "../icons.js";

describe("IconRegistry", () => {
  it("is text-only when empty", () => {
    const r = new IconRegistry();
    expect(r.size()).toBe(0);
    expect(r.inline("zap")).toBe("");
    expect(r.prefix("zap", "quick lane · 2.3s")).toBe("quick lane · 2.3s");
    expect(r.button("check")).toBeUndefined();
    expect(r.reaction("thought")).toBeUndefined();
  });

  it("loads only cc_* names and renders the three Discord shapes", () => {
    const r = new IconRegistry();
    r.setAll([{ id: "1", name: "cc_zap" }, { id: "2", name: "cc_check" }, { id: "3", name: "partyparrot" }, { id: "4", name: "cc_Bad-Name" }]);
    expect(r.size()).toBe(2);
    expect(r.inline("zap")).toBe("<:cc_zap:1>");
    expect(r.prefix("zap", "quick lane")).toBe("<:cc_zap:1> quick lane");
    expect(r.button("check")).toEqual({ id: "2", name: "cc_check" });
    expect(r.reaction("check")).toBe("cc_check:2");
    expect(r.has("brain")).toBe(false);
    r.clear();
    expect(r.size()).toBe(0);
  });

  it("emoji names follow Discord's rules with our prefix", () => {
    expect(isIconEmojiName("cc_zap")).toBe(true);
    expect(isIconEmojiName("cc_dot_green")).toBe(true);
    expect(isIconEmojiName("zap")).toBe(false);
    expect(isIconEmojiName("cc_")).toBe(false);
    expect(isIconEmojiName("cc_" + "a".repeat(30))).toBe(false);
    for (const n of ICON_NAMES) expect(isIconEmojiName(`cc_${n}`)).toBe(true);
  });
});
