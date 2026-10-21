/**
 * 999.95-fu3 — per-channel preview isolation.
 *
 * Before this, PreviewStore held ONE global `mostRecentId`, written by every
 * push from every agent, and `/preview/current` handed it to whoever asked.
 * Opening the Activity from any channel surfaced whichever agent pushed last,
 * so client-a-personal's preview could appear in #shopping's Activity and vice
 * versa. client-a-personal handles client PII, which makes that a confidentiality
 * problem rather than a UX wrinkle.
 */

import { describe, it, expect } from "vitest";
import { PreviewStore } from "../preview-store.js";

const CLIENT_A = "chan-client-a";
const SHOP = "chan-shopping";
const html = (s: string) => ({ kind: "html" as const, html: `<p>${s}</p>` });

describe("PreviewStore — channel isolation", () => {
  it("resolves each channel's OWN most-recent preview", () => {
    const store = new PreviewStore();
    store.set("client-a1", html("client-a client sheet"), CLIENT_A);
    store.set("shop1", html("shopping table"), SHOP);

    // The ordering matters: shopping pushed LAST. Before this change both
    // channels resolved "shop1".
    expect(store.currentId(CLIENT_A)).toBe("client-a1");
    expect(store.currentId(SHOP)).toBe("shop1");
  });

  it("a channel with no preview gets null, never another channel's", () => {
    const store = new PreviewStore();
    store.set("client-a1", html("client-a client sheet"), CLIENT_A);
    expect(store.currentId(SHOP)).toBeNull();
  });

  it("FAILS CLOSED with no channel — the unscoped fallback cannot leak", () => {
    // The live Activity client asks scoped-first and falls back to an
    // unscoped call. If unscoped returned the global most-recent, that
    // fallback would re-open the exact leak this closes.
    const store = new PreviewStore();
    store.set("client-a1", html("client-a client sheet"), CLIENT_A);
    expect(store.currentId(null)).toBeNull();
    expect(store.currentId("")).toBeNull();
  });

  it("a preview from an unbound agent never becomes any channel's current", () => {
    const store = new PreviewStore();
    store.set("orphan", html("no channel"));
    expect(store.currentId(CLIENT_A)).toBeNull();
    expect(store.currentId(null)).toBeNull();
    // ...but is still retrievable by id (the nested iframe loads it directly).
    expect(store.get("orphan")).not.toBeNull();
  });

  it("an id-reuse edit keeps its original channel", () => {
    // Re-pushes omit the channel; the preview must not silently orphan itself.
    const store = new PreviewStore();
    store.set("client-a1", html("v1"), CLIENT_A);
    store.set("client-a1", html("v2"));
    expect(store.currentId(CLIENT_A)).toBe("client-a1");
  });

  it("respects the freshness window per channel", () => {
    let t = 1_000_000;
    const store = new PreviewStore({ now: () => t });
    store.set("client-a1", html("x"), CLIENT_A);
    expect(store.currentId(CLIENT_A)).toBe("client-a1");
    t += 10 * 60_000; // well past the ~2 min window
    expect(store.currentId(CLIENT_A)).toBeNull();
  });

  it("does not resurrect an LRU-evicted preview as current", () => {
    const store = new PreviewStore();
    store.set("keep", html("first"), CLIENT_A);
    // Push past the LRU cap on the SAME channel; "keep" is evicted and must
    // not linger as that channel's pointer.
    for (let i = 0; i < 40; i++) store.set(`p${i}`, html(`${i}`), CLIENT_A);
    const current = store.currentId(CLIENT_A);
    expect(current).not.toBe("keep");
    if (current) expect(store.get(current)).not.toBeNull();
  });
});
