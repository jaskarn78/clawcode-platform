/**
 * Phase 999.160 — reply actions are relevance-gated. Each trigger has an
 * on-case and an off-case; the policy caps and gates are pinned; the registry
 * is single-use, addressee-only and expiring; the <actions> block never leaks.
 */
import { describe, expect, it } from "vitest";
import {
  ReplyActionRegistry,
  buildReplyActionRow,
  countStructuredRows,
  endsWithOffer,
  evaluateReplyActions,
  parseActionsBlock,
  parseReplyActionCustomId,
  replyActionCustomId,
  MAX_REPLY_ACTIONS,
  MIN_CHARS_FOR_ACTIONS,
  LastReplyTracker,
  buildShortenPrompt,
  isShorterRequest,
  parseShortened,
  stripActionsForStreaming,
} from "../reply-actions.js";
import { icons } from "../icons.js";

const base = { nSources: 0, durationMs: 5_000, chunked: false };
const filler = (n: number): string => "Words that carry the answer along. ".repeat(Math.ceil(n / 36)).slice(0, n);

describe("relevance triggers", () => {
  it("a plain short reply earns nothing", () => {
    expect(evaluateReplyActions({ ...base, text: "Done — the file is saved." })).toEqual([]);
  });

  it("an ordinary long reply with no signals earns nothing", () => {
    expect(evaluateReplyActions({ ...base, text: filler(800) })).toEqual([]);
  });

  it("Yes-go-ahead: only when the reply ends with an OFFER; a flat ending earns nothing", () => {
    const offer = `${filler(300)}\n\nWant me to draft the email as well?`;
    const kinds = evaluateReplyActions({ ...base, text: offer }).map((a) => a.kind);
    expect(kinds).toContain("go-ahead");
    const flat = `${filler(300)}\n\nThat concludes the summary.`;
    expect(evaluateReplyActions({ ...base, text: flat })).toEqual([]);
  });

  it("an open question to the user earns nothing — they have to answer it (the 2026-09-23 'Continue' under 'What do you want done on it?')", () => {
    for (const q of ["What do you want done on it?", "Which one do you prefer?", "How should I proceed?", "When works for you?"]) {
      expect(evaluateReplyActions({ ...base, text: `${filler(300)}\n\n${q}` })).toEqual([]);
      expect(endsWithOffer(`${filler(300)}\n\n${q}`)).toBe(false);
    }
  });

  it("offer detection ignores a footer line when judging the tail", () => {
    const text = `${filler(300)}\n\nShall I book it?\n\n-# 2m10s · 4 tools`;
    expect(endsWithOffer(text)).toBe(true);
  });

  it("an offer may decorate even a short reply (it is the one exception)", () => {
    const kinds = evaluateReplyActions({ ...base, text: "Two options. Want the cheaper one?" }).map((a) => a.kind);
    expect(kinds).toEqual(["go-ahead"]);
  });

  it("Retry + Continue when the turn was cut short; Retry alone when nothing was said", () => {
    const cut = evaluateReplyActions({ ...base, text: filler(400), cutShortReason: "exit-143" });
    expect(cut.map((a) => a.kind)).toEqual(["retry", "continue"]);
    const empty = evaluateReplyActions({ ...base, text: "", failed: true });
    expect(empty.map((a) => a.kind)).toEqual(["retry"]);
  });

  it("Sources: ledger sources ≥ 2 OR ≥ 2 distinct URLs; never on one", () => {
    const two = `${filler(300)} see https://a.example/x and https://b.example/y`;
    expect(evaluateReplyActions({ ...base, text: two }).map((a) => a.kind)).toContain("sources");
    const one = `${filler(300)} see https://a.example/x and https://a.example/x again`;
    expect(evaluateReplyActions({ ...base, text: one }).map((a) => a.kind)).not.toContain("sources");
    expect(evaluateReplyActions({ ...base, text: filler(300), nSources: 2 }).map((a) => a.kind)).toContain("sources");
    expect(evaluateReplyActions({ ...base, text: filler(300), nSources: 1 }).map((a) => a.kind)).not.toContain("sources");
  });

  it("Shorter: over 1,800 chars or chunked; not at 1,500", () => {
    expect(evaluateReplyActions({ ...base, text: filler(1_900) }).map((a) => a.kind)).toContain("shorter");
    expect(evaluateReplyActions({ ...base, text: filler(1_500), chunked: true }).map((a) => a.kind)).toContain("shorter");
    expect(evaluateReplyActions({ ...base, text: filler(1_500) }).map((a) => a.kind)).not.toContain("shorter");
  });

  it("As a file: a 12-row table or list; not an 8-row one", () => {
    const table = `${filler(250)}\n\n| a | b |\n|---|---|\n${"| 1 | 2 |\n".repeat(12)}`;
    expect(evaluateReplyActions({ ...base, text: table }).map((a) => a.kind)).toContain("file");
    const list = `${filler(250)}\n\n${"- item\n".repeat(8)}`;
    expect(evaluateReplyActions({ ...base, text: list }).map((a) => a.kind)).not.toContain("file");
    expect(countStructuredRows("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(2);
  });

  it("Thread: turns over 3 minutes, or any subagent", () => {
    expect(evaluateReplyActions({ ...base, text: filler(400), durationMs: 200_000 }).map((a) => a.kind)).toContain("thread");
    expect(evaluateReplyActions({ ...base, text: filler(400), subagentCount: 1 }).map((a) => a.kind)).toContain("thread");
    expect(evaluateReplyActions({ ...base, text: filler(400), durationMs: 90_000 }).map((a) => a.kind)).not.toContain("thread");
  });

  it("short replies get no decoration except Continue/Retry", () => {
    const text = filler(MIN_CHARS_FOR_ACTIONS - 10) + " https://a.example https://b.example";
    // Shorter than the floor, two URLs, long duration: still nothing.
    expect(evaluateReplyActions({ ...base, text: text.slice(0, MIN_CHARS_FOR_ACTIONS - 1), durationMs: 400_000 })).toEqual([]);
  });
});

describe("policy", () => {
  it("caps at MAX_REPLY_ACTIONS in priority order", () => {
    const text = `${filler(1_900)}\n\n${"- row\n".repeat(14)}\n\nWant more?`;
    const acts = evaluateReplyActions({ ...base, text, nSources: 3, durationMs: 400_000 });
    expect(acts.length).toBe(MAX_REPLY_ACTIONS);
    expect(acts.map((a) => a.kind)).toEqual(["go-ahead", "sources", "shorter"]);
  });

  it("model-proposed actions fill spare slots only, and never collide with a deterministic one", () => {
    const proposed = [
      { kind: "custom" as const, label: "Book it", icon: "sparkles" as const, message: "book the 7:10", trigger: "model-proposed" },
      { kind: "custom" as const, label: "Shorter", icon: "sparkles" as const, message: "shorter", trigger: "model-proposed" },
    ];
    const acts = evaluateReplyActions({ ...base, text: filler(1_900), proposed });
    expect(acts.map((a) => a.label)).toEqual(["Shorter", "Book it"]);
  });

  it("every action records why it appeared", () => {
    const acts = evaluateReplyActions({ ...base, text: filler(1_900), nSources: 4 });
    expect(acts.every((a) => a.trigger.length > 0)).toBe(true);
    expect(acts.find((a) => a.kind === "sources")?.trigger).toBe("sources:4");
  });
});

describe("<actions> block", () => {
  it("strips the block and returns validated actions", () => {
    const r = parseActionsBlock(`Answer.\n\n<actions>[{"label":"Book it","message":"book the 7:10"},{"label":"Send to client-a","message":"send this to client-a"},{"label":"third","message":"ignored"}]</actions>`);
    expect(r.text).toBe("Answer.");
    expect(r.actions.map((a) => a.label)).toEqual(["Book it", "Send to client-a"]);
    expect(r.actions[0]!.kind).toBe("custom");
  });

  it("strips a malformed block and yields no actions — the tag never reaches the user", () => {
    const r = parseActionsBlock("Answer.\n<actions>not json</actions>");
    expect(r.text).toBe("Answer.");
    expect(r.actions).toEqual([]);
  });

  it("rejects over-long labels and messages", () => {
    const r = parseActionsBlock(`x<actions>[{"label":"${"L".repeat(21)}","message":"m"},{"label":"ok","message":"${"m".repeat(201)}"}]</actions>`);
    expect(r.actions).toEqual([]);
  });

  it("leaves text without a block untouched", () => {
    expect(parseActionsBlock("plain")).toEqual({ text: "plain", actions: [] });
  });
});

describe("wire shapes", () => {
  it("customId round-trips, including snowflake ids", () => {
    const id = replyActionCustomId("000000000000000025", 2);
    expect(id).toBe("ra:000000000000000025:2");
    expect(parseReplyActionCustomId(id)).toEqual({ messageId: "000000000000000025", index: 2 });
    expect(parseReplyActionCustomId("vsrc:123")).toBeNull();
    expect(parseReplyActionCustomId("ra:123:x")).toBeNull();
  });

  it("builds a single row of secondary buttons with text-only labels (no emoji)", () => {
    const acts = evaluateReplyActions({ ...base, text: filler(1_900), nSources: 2 });
    const row = buildReplyActionRow("42", acts);
    expect(row.type).toBe(1);
    expect(row.components.map((c) => c.custom_id)).toEqual(["ra:42:0", "ra:42:1"]);
    expect(row.components.every((c) => c.style === 2 && c.label.length <= 20)).toBe(true);
    expect(row.components.some((c) => "emoji" in c)).toBe(false);
  });

  it("carries the application-emoji icon on each button once the set is loaded", () => {
    icons.setAll([{ id: "11", name: "cc_check" }, { id: "12", name: "cc_book" }]);
    try {
      const acts = evaluateReplyActions({ ...base, text: `${filler(300)}\n\nWant me to draft it?`, nSources: 2 });
      const row = buildReplyActionRow("42", acts);
      expect(row.components[0]!.emoji).toEqual({ id: "11", name: "cc_check" });
      expect(row.components[1]!.emoji).toEqual({ id: "12", name: "cc_book" });
    } finally {
      icons.clear();
    }
  });
});

describe("registry", () => {
  const acts = evaluateReplyActions({ ...base, text: filler(1_900), nSources: 2 });
  const entry = { messageId: "m1", channelId: "c1", agentName: "personal", userId: "u1", originalMessageId: "o1", actions: acts, keepRows: [] };

  it("resolves a click for the addressee and consumes the entry", () => {
    const reg = new ReplyActionRegistry();
    reg.register(entry);
    const r = reg.click("ra:m1:0", "u1");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.action.kind).toBe("sources");
    expect(reg.click("ra:m1:0", "u1").kind).toBe("expired");
  });

  it("refuses anyone but the addressee, without consuming", () => {
    const reg = new ReplyActionRegistry();
    reg.register(entry);
    expect(reg.click("ra:m1:0", "u2").kind).toBe("not-yours");
    expect(reg.click("ra:m1:0", "u1").kind).toBe("ok");
  });

  it("expires after the TTL", () => {
    let t = 1_000;
    const reg = new ReplyActionRegistry(60_000, () => t);
    reg.register(entry);
    t += 60_001;
    expect(reg.click("ra:m1:0", "u1").kind).toBe("expired");
    expect(reg.size()).toBe(0);
  });

  it("reports unknown indexes and foreign customIds", () => {
    const reg = new ReplyActionRegistry();
    reg.register(entry);
    expect(reg.click("ra:m1:9", "u1").kind).toBe("unknown");
    expect(reg.click("vsrc:m1", "u1").kind).toBe("unknown");
  });

  it("expire() hands back the entry once for the removal edit", () => {
    const reg = new ReplyActionRegistry();
    reg.register(entry);
    expect(reg.expire("m1")?.messageId).toBe("m1");
    expect(reg.expire("m1")).toBeUndefined();
  });
});

describe("v1.3 — shorter in place", () => {
  it("recognises explicit typed requests only", () => {
    for (const t of ["shorter", "Shorter!", "tl;dr", "TLDR", "make it shorter", "the short version", "shorter please", "too long"]) expect(isShorterRequest(t)).toBe(true);
    for (const t of ["shorter than last time?", "make it shorter and add the dates", "what's the short version of the plan?", "tl;dr of the meeting notes please"]) expect(isShorterRequest(t)).toBe(false);
  });

  it("tracks the latest reply per channel and forgets stale ones", () => {
    let now = 1_000;
    const t = new LastReplyTracker(60_000, () => now);
    t.record({ channelId: "c1", messageId: "m1", agentName: "personal", userId: "u1", text: "long reply" });
    t.record({ channelId: "c1", messageId: "m2", agentName: "personal", userId: "u1", text: "newer reply" });
    expect(t.get("c1")?.messageId).toBe("m2");
    now += 60_001;
    expect(t.get("c1")).toBeUndefined();
    expect(t.size()).toBe(0);
  });

  it("accepts only a real, fitting reduction", () => {
    const original = "x".repeat(1_000);
    expect(parseShortened("  ", original)).toEqual({ kind: "unusable", reason: "empty" });
    expect(parseShortened("y".repeat(1_200), original)).toEqual({ kind: "unusable", reason: "not-shorter" });
    expect(parseShortened("y".repeat(950), original)).toEqual({ kind: "unusable", reason: "too-long" });
    expect(parseShortened("<reply>Short and complete.</reply>", original)).toEqual({ kind: "ok", text: "Short and complete." });
    expect(buildShortenPrompt("hello", 300)).toContain("at most 300 characters");
  });
});

describe("999.163 — follow-up buttons from the model", () => {
  it("streamed partials never show the block, even a half-typed tag", () => {
    expect(stripActionsForStreaming("Answer so far.\n\n<actions>[{\"label\":")).toBe("Answer so far.");
    expect(stripActionsForStreaming("Answer so far.\n\n<act")).toBe("Answer so far.");
    expect(stripActionsForStreaming("Answer so far. <a")).toBe("Answer so far.");
    expect(stripActionsForStreaming("Answer with <b>bold</b> and an <a href> link")).toBe("Answer with <b>bold</b> and an <a href> link");
    expect(stripActionsForStreaming("plain")).toBe("plain");
  });
});
