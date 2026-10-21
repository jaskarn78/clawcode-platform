/**
 * Phase 999.172 — the prompt-suggestion reply action. The model's predicted
 * next prompt becomes ONE button: its own kind (so it can be measured apart
 * from the model-proposed `custom` actions) whose label IS the full sanitized
 * suggestion and whose click sends exactly that label. It is APPENDED to an existing row —
 * never reordering the positional customIds, never past the cap, never
 * resurrecting a row the user already consumed, never extending its expiry.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_REPLY_ACTIONS,
  MAX_SUGGESTION_LABEL,
  ReplyActionRegistry,
  buildReplyActionRow,
  suggestionAction,
  type ReplyAction,
} from "../reply-actions.js";

/** The ok action for a known-safe suggestion. */
const sug = (text: string): ReplyAction => {
  const r = suggestionAction(text);
  if (r.kind !== "ok") throw new Error(r.reason);
  return r.action;
};

const act = (kind: ReplyAction["kind"], label: string): ReplyAction => ({
  kind,
  label,
  icon: "check",
  message: label.toLowerCase(),
  trigger: "test",
});

const baseEntry = {
  messageId: "m1",
  channelId: "c1",
  agentName: "personal",
  userId: "u1",
  originalMessageId: "o1",
  keepRows: [],
} as const;

describe("suggestionAction — consent + sanitization (PR #190 review)", () => {
  const ok = (text: unknown): ReplyAction => {
    const r = suggestionAction(text);
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.reason}`);
    return r.action;
  };

  it("the label IS the full suggestion and the click sends exactly the label", () => {
    const a = ok("Suggest a 3-day itinerary for Príncipe Real");
    expect(a.kind).toBe("suggestion");
    expect(a.icon).toBe("lightbulb");
    expect(a.label).toBe("Suggest a 3-day itinerary for Príncipe Real");
    expect(a.message).toBe(a.label);
    expect(a.trigger).toBe("prompt-suggestion");
  });

  it("collapses whitespace and newlines (label and message alike)", () => {
    const a = ok("  What\n\nshould   I\teat there?  ");
    expect(a.label).toBe("What should I eat there?");
    expect(a.message).toBe(a.label);
  });

  it("accepts exactly 80 chars; drops 81+ as too-long (never trimmed)", () => {
    expect(ok("x".repeat(MAX_SUGGESTION_LABEL)).label.length).toBe(80);
    expect(suggestionAction("x".repeat(MAX_SUGGESTION_LABEL + 1))).toEqual({ kind: "drop", reason: "too-long" });
    expect(MAX_SUGGESTION_LABEL).toBe(80);
  });

  it("drops empty / whitespace / non-string", () => {
    for (const v of ["", "   \n ", undefined, 42, null]) {
      expect(suggestionAction(v)).toEqual({ kind: "drop", reason: "empty" });
    }
  });

  it("drops Discord mentions as unsafe", () => {
    for (const v of ["Ping <@000000000000000002> about it", "Post in <#000000000000000023>", "Tell <@&123> now", "Notify @everyone", "Ask @here"]) {
      expect(suggestionAction(v)).toEqual({ kind: "drop", reason: "unsafe" });
    }
  });

  it("drops URLs and bare domains as unsafe", () => {
    for (const v of ["Open https://evil.example/x", "Check http://a.b", "Visit www.example.org", "Book it on hyatt.com"]) {
      expect(suggestionAction(v)).toEqual({ kind: "drop", reason: "unsafe" });
    }
  });

  it("keeps ordinary text with @-free punctuation and numbers", () => {
    expect(ok("What's the 7:35 wave corral close time?").label).toBe("What's the 7:35 wave corral close time?");
  });
});

describe("ReplyActionRegistry.append", () => {
  it("appends to an existing row, keeping the original expiresAt and positions", () => {
    let t = 1_000;
    const reg = new ReplyActionRegistry(60_000, () => t);
    const first = reg.register({ ...baseEntry, actions: [act("sources", "Sources")] });
    t = 5_000;
    const out = reg.append("m1", sug("What should I eat there?"));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.entry.expiresAt).toBe(first.expiresAt);
    expect(out.entry.actions.map((a) => a.kind)).toEqual(["sources", "suggestion"]);
    // Positional ids: the existing button keeps index 0.
    const row = buildReplyActionRow("m1", out.entry.actions);
    expect(row.components.map((c) => c.custom_id)).toEqual(["ra:m1:0", "ra:m1:1"]);
    // A click on index 1 resolves the suggestion.
    const click = reg.click("ra:m1:1", "u1");
    expect(click.kind).toBe("ok");
    if (click.kind === "ok") expect(click.action.kind).toBe("suggestion");
  });

  it("refuses when the row is already full", () => {
    const reg = new ReplyActionRegistry();
    const full = Array.from({ length: MAX_REPLY_ACTIONS }, (_, i) => act("custom", `A${i}`));
    reg.register({ ...baseEntry, actions: full });
    expect(reg.append("m1", sug("next")).kind).toBe("full");
  });

  it("never resurrects a consumed (clicked) row", () => {
    const reg = new ReplyActionRegistry();
    reg.register({ ...baseEntry, actions: [act("sources", "Sources")] });
    expect(reg.click("ra:m1:0", "u1").kind).toBe("ok");
    expect(reg.append("m1", sug("next")).kind).toBe("missing");
  });

  it("refuses an expired row", () => {
    let t = 0;
    const reg = new ReplyActionRegistry(1_000, () => t);
    reg.register({ ...baseEntry, actions: [act("sources", "Sources")] });
    t = 2_000;
    expect(reg.append("m1", sug("next")).kind).toBe("expired");
  });

  it("refuses a duplicate of an action already on the row", () => {
    const reg = new ReplyActionRegistry();
    reg.register({ ...baseEntry, actions: [{ ...act("custom", "Itinerary"), message: "suggest a 3-day itinerary" }] });
    expect(reg.append("m1", sug("Suggest a 3-day itinerary")).kind).toBe("duplicate");
  });
});
