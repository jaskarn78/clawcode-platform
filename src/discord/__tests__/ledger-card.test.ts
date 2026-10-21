/** Ledger card — renders under the CV2 caps for any input, accent by verdict. */
import { describe, expect, it } from "vitest";
import { buildCv2Payload } from "../cv2-renderer.js";
import { buildLedgerCardSpec, buildLedgerPlainText, CARD_ACCENT, CARD_MAX_CLAIMS } from "../ledger-card.js";
import { evidenceFromToolResult, evidenceFromToolUse, type EvidenceEntry } from "../../manager/evidence-ledger.js";
import { validateClaim, type ClaimEntry } from "../../manager/claim-ledger.js";

const AT = 1;
const evidence: EvidenceEntry[] = [
  ...evidenceFromToolUse("WebFetch", "1", { url: "https://www.irs.gov/retirement-plans/rmd-faqs" }, AT),
  ...evidenceFromToolUse("mcp__clawcode__ingest_document", "2", { file_path: "/x/statement-2026-04-30.pdf" }, AT),
  ...evidenceFromToolUse("mcp__acme-db__mysql_query", "3", { sql: "select 1 from client_accounts" }, AT),
  ...evidenceFromToolResult("WebSearch", "4", 'Web search results for query: "rmd age"\n\nLinks: [{"title":"RMD","url":"https://www.irs.gov/rmd"}]', AT),
];
const mk = (over: Partial<Parameters<typeof validateClaim>[0]> & { claim: string }, id = "c1"): ClaimEntry =>
  ({ ...validateClaim({ verdict: "verified", ...over }, evidence, "must begin at age 73"), id, turnId: "t", at: AT });

describe("buildLedgerCardSpec", () => {
  it("renders claims with source + quote and grouped sources; accent green when all verified", () => {
    const spec = buildLedgerCardSpec({
      agent: "fin-client",
      promptExcerpt: "when does his RMD start",
      at: "14:32",
      claims: [mk({ claim: "RMD start age is 73", source: "https://irs.gov/retirement-plans/rmd-faqs", quote: "must begin at age 73" })],
      evidence,
    });
    expect(spec.accentColor).toBe(CARD_ACCENT.verified);
    const text = spec.blocks.filter((b) => b.type === "text").map((b) => (b as { content: string }).content).join("\n");
    expect(text).toContain("✓ **RMD start age is 73**");
    expect(text).toContain("irs.gov");
    expect(text).toContain('"must begin at age 73"');
    expect(text).toContain("📖 read");
    expect(text).toContain("🔎 found");
    expect(text).toContain("🗂️ CRM");
    expect(text).toContain("📄 document");
    expect(() => buildCv2Payload(spec)).not.toThrow();
  });
  it("accent follows precedence: unverified red > corrected yellow", () => {
    const red = buildLedgerCardSpec({ agent: "a", claims: [mk({ claim: "x", source: "https://example.com/z" })], evidence });
    expect(red.accentColor).toBe(CARD_ACCENT.unverified);
    const yellow = buildLedgerCardSpec({ agent: "a", claims: [mk({ claim: "x", verdict: "corrected", correction: "y", source: "https://irs.gov/retirement-plans/rmd-faqs" })], evidence });
    expect(yellow.accentColor).toBe(CARD_ACCENT.corrected);
  });
  it("stays within the renderer caps with many long claims", () => {
    const claims = Array.from({ length: CARD_MAX_CLAIMS + 10 }, (_, i) =>
      mk({ claim: `claim ${i} `.padEnd(280, "z"), quote: "q".repeat(290), source: "https://irs.gov/retirement-plans/rmd-faqs" }, `c${i}`),
    );
    const spec = buildLedgerCardSpec({ agent: "a", claims, evidence });
    expect(spec.blocks.length).toBeLessThanOrEqual(40);
    expect(() => buildCv2Payload(spec)).not.toThrow();
    const specText = spec.blocks.filter((b) => b.type === "text").map((b) => (b as { content: string }).content).join("\n");
    expect(specText).toContain("+10 more");
    const text = buildLedgerPlainText({ agent: "a", claims, evidence });
    expect(text.length).toBeLessThanOrEqual(1900);
  });
  it("empty ledger renders an honest card", () => {
    const spec = buildLedgerCardSpec({ agent: "a", claims: [], evidence: [] });
    const text = spec.blocks.filter((b) => b.type === "text").map((b) => (b as { content: string }).content).join("\n");
    expect(text).toContain("No claims were recorded");
    expect(text).toContain("No sources were consulted");
    expect(spec.accentColor).toBe(CARD_ACCENT.none);
  });
  it("sanitizes hostile claim text", () => {
    const spec = buildLedgerCardSpec({ agent: "a", claims: [mk({ claim: "@everyone `rm -rf` [x](y)" })], evidence });
    const text = spec.blocks.filter((b) => b.type === "text").map((b) => (b as { content: string }).content).join("\n");
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("`");
  });

  it("does not list the previous turn's (stale) sources unless a claim names them", () => {
    const stale = evidenceFromToolUse("WebFetch", "s1", { url: "https://www.ssa.gov/oact/cola/cbb.html" }, 1).map((e) => ({ ...e, stale: true }));
    const spec = buildLedgerCardSpec({ agent: "a", claims: [], evidence: [...evidence, ...stale] });
    const text = spec.blocks.filter((b) => b.type === "text").map((b) => (b as { content: string }).content).join("\n");
    expect(text).not.toContain("ssa.gov");
    expect(text).toContain("irs.gov");
  });
});

// ── Phase 999.133 — recalled memory on the card + button label ────────
import { recallLines, sourcesButtonLabel } from "../ledger-card.js";
const recall = {
  at: 0,
  memories: [{ id: "m1", createdAt: "2026-06-12T17:00:00.000Z", snippet: "Zaid wants 40% SGOV" }],
  notes: [{ path: "MEMORY.md", heading: "Preferences" }],
  documents: [{ path: "q2-statement", heading: null }],
};

describe("recall on the Sources card (Phase 999.133)", () => {
  it("labels the button from sources + recall", () => {
    expect(sourcesButtonLabel(3, recall)).toBe("Sources · 3 · 3 recalled");
    expect(sourcesButtonLabel(3, undefined)).toBe("Sources · 3");
    expect(sourcesButtonLabel(0, recall)).toBe("Sources · 3 recalled");
  });

  it("appends a Recalled section after the verification sections", () => {
    const spec = buildLedgerCardSpec({
      agent: "a",
      claims: [mk({ claim: "RMD start age is 73", source: "https://irs.gov/retirement-plans/rmd-faqs", quote: "must begin at age 73" })],
      evidence,
      recall,
    });
    const text = spec.blocks.map((b) => (b.type === "text" ? b.content : "---")).join("\n");
    expect(text).toContain("**Verification · a**");
    expect(text).toContain("**Recalled from memory** · 1 memory · 1 note · 1 document");
    expect(text).toContain("-# 🧠 Jun 12 · Zaid wants 40% SGOV");
    expect(text).toContain("-# 📎 MEMORY.md › Preferences");
    expect(text).toContain("-# 📎 q2-statement");
    expect(text.indexOf("Sources consulted")).toBeLessThan(text.indexOf("Recalled from memory"));
  });

  it("a recall-only turn renders a plain Sources card with no claim lines", () => {
    const spec = buildLedgerCardSpec({ agent: "personal", promptExcerpt: "what did Zaid want", at: "17:48", claims: [], evidence: [], recall });
    const text = buildLedgerPlainText({ agent: "personal", promptExcerpt: "what did Zaid want", at: "17:48", claims: [], evidence: [], recall });
    expect(spec.accentColor).toBe(CARD_ACCENT.none);
    expect(text).toContain("**Sources · personal**");
    expect(text).toContain("no verification this turn");
    expect(text).not.toContain("No claims were recorded");
    expect(text).toContain("Recalled from memory");
    expect(recallLines(undefined)).toEqual([]);
  });
});
