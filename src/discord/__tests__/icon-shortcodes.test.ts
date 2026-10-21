import { describe, it, expect } from "vitest";
import {
  rewriteIconShortcodes,
  stripIconShortcodes,
  type IconLookup,
} from "../icon-shortcodes.js";

/** A registry with `hourglass` and `circle_check` loaded; everything else
 * missing (returns ""). Mirrors IconRegistry.inline's contract. */
const REGISTRY: IconLookup = {
  inline(name: string): string {
    const ids: Record<string, string> = {
      hourglass: "111",
      circle_check: "222",
    };
    const id = ids[name];
    return id ? `<:cc_${name}:${id}>` : "";
  },
};

/** A registry with nothing loaded — the boot / empty-set case. */
const EMPTY_REGISTRY: IconLookup = { inline: () => "" };

describe("rewriteIconShortcodes", () => {
  it("resolves a known shortcode to the formed token", () => {
    expect(rewriteIconShortcodes("queued :cc_hourglass: now", REGISTRY)).toBe(
      "queued <:cc_hourglass:111> now",
    );
  });

  it("strips an unknown name cleanly, leaving no double space", () => {
    expect(rewriteIconShortcodes("a :cc_nope: b", REGISTRY)).toBe("a b");
  });

  it("strips a known-but-unloaded icon (registry has no id) cleanly", () => {
    expect(rewriteIconShortcodes("x :cc_compass: y", REGISTRY)).toBe("x y");
  });

  it("strips every shortcode when the registry is empty (no Unicode fallback)", () => {
    const out = rewriteIconShortcodes(":cc_hourglass: working :cc_circle_check:", EMPTY_REGISTRY);
    expect(out).toBe("working");
    expect(out).not.toMatch(/<:cc_/);
  });

  it("drops a leading space when the stripped shortcode starts the line", () => {
    expect(rewriteIconShortcodes(":cc_nope: text", REGISTRY)).toBe("text");
    expect(rewriteIconShortcodes("one\n:cc_nope: two", REGISTRY)).toBe("one\ntwo");
  });

  it("does NOT touch shortcodes inside a fenced code block", () => {
    const input = "before :cc_hourglass:\n```\n:cc_hourglass: literal\n```\nafter :cc_hourglass:";
    expect(rewriteIconShortcodes(input, REGISTRY)).toBe(
      "before <:cc_hourglass:111>\n```\n:cc_hourglass: literal\n```\nafter <:cc_hourglass:111>",
    );
  });

  it("does NOT touch shortcodes inside inline code", () => {
    expect(rewriteIconShortcodes("use `:cc_hourglass:` here :cc_hourglass:", REGISTRY)).toBe(
      "use `:cc_hourglass:` here <:cc_hourglass:111>",
    );
  });

  it("protects an UNCLOSED fence to end of text", () => {
    const input = "ok :cc_hourglass:\n```\n:cc_hourglass: still code";
    expect(rewriteIconShortcodes(input, REGISTRY)).toBe(
      "ok <:cc_hourglass:111>\n```\n:cc_hourglass: still code",
    );
  });

  it("does NOT re-process an already-formed token (no double-wrap)", () => {
    const input = "<:cc_hourglass:111> and :cc_circle_check:";
    expect(rewriteIconShortcodes(input, REGISTRY)).toBe(
      "<:cc_hourglass:111> and <:cc_circle_check:222>",
    );
  });

  it("leaves another app's / animated emoji token intact", () => {
    const input = "<a:party:999> <:someother:1> :cc_hourglass:";
    expect(rewriteIconShortcodes(input, REGISTRY)).toBe(
      "<a:party:999> <:someother:1> <:cc_hourglass:111>",
    );
  });

  it("is idempotent (second pass is a no-op)", () => {
    const once = rewriteIconShortcodes("q :cc_hourglass: r :cc_nope: s", REGISTRY);
    expect(rewriteIconShortcodes(once, REGISTRY)).toBe(once);
  });

  it("returns empty / falsy input unchanged", () => {
    expect(rewriteIconShortcodes("", REGISTRY)).toBe("");
  });

  it("leaves non-cc colon tokens alone", () => {
    expect(rewriteIconShortcodes("ratio 3:30:00 and :shrug:", REGISTRY)).toBe(
      "ratio 3:30:00 and :shrug:",
    );
  });
});

describe("stripIconShortcodes", () => {
  it("removes a shortcode and its doubled space", () => {
    expect(stripIconShortcodes("Saved :cc_bookmark: the fact")).toBe("Saved the fact");
  });

  it("removes a formed token too (drafts carry no icons in either form)", () => {
    expect(stripIconShortcodes("done <:cc_circle_check:222> ok")).toBe("done ok");
  });

  it("removes a leading token cleanly", () => {
    expect(stripIconShortcodes(":cc_hourglass: draft body")).toBe("draft body");
    expect(stripIconShortcodes("<:cc_hourglass:111> draft body")).toBe("draft body");
  });

  it("leaves non-cc emoji and colon text alone", () => {
    expect(stripIconShortcodes("meet at 9:00 :wave: <:party:9>")).toBe(
      "meet at 9:00 :wave: <:party:9>",
    );
  });

  it("returns empty input unchanged", () => {
    expect(stripIconShortcodes("")).toBe("");
  });
});
