import { describe, it, expect } from "vitest";
import { extractDrafts, splitDraftForDelivery, DRAFT_MAX_CHARS } from "../draft-extract.js";

describe("extractDrafts", () => {
  it("pulls a ```draft block out of the reply, keeping the surrounding analysis", () => {
    const reply = "**Too small - skip it.** Only two positions are red.\n\nDraft below.\n\n```draft\nHappy Friday Steven! Quick FYI, everything is up.\n\nReach out if you need anything!\n```\n\n-# Sources: [crm](<x>)";
    const r = extractDrafts(reply);
    expect(r.drafts).toEqual(["Happy Friday Steven! Quick FYI, everything is up.\n\nReach out if you need anything!"]);
    // 2026-08-28 — "Draft below." is an introducer, not content (it shipped as
    // an orphan line above the separately-posted draft).
    expect(r.text).toBe("**Too small - skip it.** Only two positions are red.\n\n-# Sources: [crm](<x>)");
  });
  it("accepts email/text/sms/message info strings and multiple blocks in order", () => {
    const r = extractDrafts("a\n```email\nOne\n```\nb\n```text\nTwo\n```\n");
    expect(r.drafts).toEqual(["One", "Two"]);
    expect(r.text).toBe("a\n\nb");
  });
  it("leaves ordinary code fences alone", () => {
    const reply = "Run this:\n```bash\nls -la\n```";
    expect(extractDrafts(reply)).toEqual({ text: reply, drafts: [] });
    expect(extractDrafts("no fences")).toEqual({ text: "no fences", drafts: [] });
  });
  it("999.178 R1 — keeps a runaway draft WHOLE (no 2000-char cut); split happens at delivery", () => {
    const r = extractDrafts("```draft\n" + "x".repeat(2500) + "\n```");
    // The full body survives extraction; splitDraftForDelivery breaks it up.
    expect(r.drafts[0].length).toBe(2500);
  });

  it("drops the lead-in line that only introduced the draft", () => {
    const r = extractDrafts("Analysis here.\n\nBirthday draft, in their voice:\n\n```draft\nHappy birthday Sam!\n```");
    expect(r.text).toBe("Analysis here.");
    expect(r.drafts).toEqual(["Happy birthday Sam!"]);
    // A colon line that is NOT about the draft stays.
    const keep = extractDrafts("Two things to check:\n- a\n- b\n\n```draft\nHi\n```");
    expect(keep.text).toBe("Two things to check:\n- a\n- b");
  });
});

describe("extractDrafts — 2026-08-28 lead-in ending with a period", () => {
  it("drops \"Draft below.\" (period, not colon) that only introduced the fence", () => {
    const r = extractDrafts("Analysis line.\n\nDraft below.\n\n```draft\nHi Nevin,\nthree names changed.\n```");
    expect(r.text).toBe("Analysis line.");
    expect(r.drafts).toEqual(["Hi Nevin,\nthree names changed."]);
  });
});

describe("extractDrafts — the period lead-in is capped to short introducers", () => {
  it("keeps a real sentence that mentions a message and ends with a period", () => {
    const body = "Send him a message once the funds settle, not before the statement posts.";
    const r = extractDrafts(`${body}\n\n\`\`\`draft\nHi\n\`\`\``);
    expect(r.text).toBe(body);
    expect(r.drafts).toEqual(["Hi"]);
  });
});

describe("splitDraftForDelivery — 999.178 R1 (drafts never truncated)", () => {
  it("returns a short draft unchanged as a single piece", () => {
    expect(splitDraftForDelivery("Hi Alex, all good.")).toEqual(["Hi Alex, all good."]);
    expect(splitDraftForDelivery("")).toEqual([]);
  });

  it("splits at paragraph boundaries, keeping every piece within the limit", () => {
    const para = (n: number) => `Paragraph ${n}. ` + "word ".repeat(120).trim(); // ~615 chars
    const draft = [para(1), para(2), para(3), para(4)].join("\n\n"); // > 2000 chars
    const pieces = splitDraftForDelivery(draft);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(DRAFT_MAX_CHARS);
    // Boundaries fall between paragraphs — no paragraph is broken mid-way.
    for (const p of pieces) expect(p.startsWith("Paragraph")).toBe(true);
    // Every paragraph survives somewhere, in order.
    const rejoined = pieces.join("\n\n");
    for (let i = 1; i <= 4; i++) expect(rejoined).toContain(`Paragraph ${i}.`);
  });

  it("falls to sentence boundaries when ONE paragraph exceeds the limit", () => {
    const sentence = (n: number) => `This is sentence number ${n} and it carries some filler words to add length. `;
    const oneBigParagraph = Array.from({ length: 60 }, (_, i) => sentence(i + 1)).join("").trim();
    expect(oneBigParagraph.length).toBeGreaterThan(DRAFT_MAX_CHARS);
    const pieces = splitDraftForDelivery(oneBigParagraph);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(DRAFT_MAX_CHARS);
    // Pieces break at sentence ends: each piece ends with terminal punctuation.
    for (const p of pieces) expect(/[.!?]$/.test(p)).toBe(true);
  });

  it("hard-splits a single sentence with no interior boundary", () => {
    const runaway = "x".repeat(4500); // one token, no spaces or punctuation
    const pieces = splitDraftForDelivery(runaway);
    expect(pieces.length).toBe(3);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(DRAFT_MAX_CHARS);
    expect(pieces.join("")).toBe(runaway);
  });

  it("keeps a fenced code block intact when it fits within a piece", () => {
    const intro = "Here is the config to paste:\n\n";
    const fence = "```\n" + "line\n".repeat(50) + "```"; // ~265 chars, has blank-free fence
    const tail = "\n\n" + "Tail paragraph. ".repeat(120).trim(); // pushes total over the limit
    const pieces = splitDraftForDelivery(intro + fence + tail);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(DRAFT_MAX_CHARS);
    // The fence is not broken across messages: one piece holds the whole block.
    const withFence = pieces.filter((p) => p.includes("```"));
    expect(withFence.length).toBe(1);
    expect(withFence[0]!.match(/```/g)!.length).toBe(2);
  });
});
