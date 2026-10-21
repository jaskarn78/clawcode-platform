/**
 * Phase 999.123 — the reserved verify-figures step: prompt, ledger parsing,
 * report instruction, post summary and PDF appendix.
 */

import { describe, it, expect } from "vitest";
import {
  appendLedgerToHtml,
  buildVerifyFiguresPrompt,
  extractLedgerBlock,
  flaggedFigureLines,
  hasFigures,
  ledgerInstructionForReport,
  ledgerMarkdownSection,
  ledgerSummaryLine,
  stripLedgerBlock,
  verificationSummary,
} from "../verify-figures.js";

const sources = [
  { stepId: "fees", prompt: "Find the fee.", status: "done", result: "The advisory fee is $11,700 per year (statement, 2026-08-30)." },
  { stepId: "returns", prompt: "Find returns.", status: "done", result: "The fund returned 7.2% (Morningstar). The fee is $11,700." },
  { stepId: "broken", prompt: "Do x.", status: "failed" },
];

const LEDGER_RESULT = `I audited the research.

\`\`\`ledger
figures:
  - value: "$11,700"
    claim: "annual advisory fee"
    step: fees
    source: "client statement, 2026-08-30"
    status: verified
  - value: "7.2%"
    claim: "fund return"
    step: returns
    source: null
    status: unsourced
  - value: "$23,500"
    claim: "401(k) employee limit 2026"
    step: fees
    source: "worker assertion"
    status: wrong
    note: "IRS Notice 2025-67 sets it at $24,500"
  - value: "5%"
    claim: "assumed growth"
    status: conflicting
    note: "5% in fees, 7% in returns"
  - value: 42
    claim: "bogus status"
    status: maybe
summary:
  total: 99
  verified: 99
\`\`\`

Overall the fee figures are solid; the return figure has no source and one limit is wrong.

Trailing chatter that must not be typeset.`;

describe("hasFigures + prompt", () => {
  it("skips the audit when no completed source carries a digit", () => {
    expect(hasFigures(sources)).toBe(true);
    expect(hasFigures([{ stepId: "a", prompt: "p", status: "done", result: "No numbers here." }])).toBe(false);
    expect(hasFigures([{ stepId: "a", prompt: "p", status: "failed", result: "42" }])).toBe(false);
  });

  it("builds the fact-checker prompt with every source and the ledger contract", () => {
    const p = buildVerifyFiguresPrompt(sources);
    expect(p).toContain("FACT-CHECKER");
    expect(p).toContain("```ledger");
    expect(p).toContain("### source: fees");
    expect(p).toContain("$11,700 per year");
    expect(p).toContain("### source: broken");
    expect(p).toContain("FAILED - nothing to audit");
    expect(p).not.toContain("—");
  });
});

describe("extractLedgerBlock", () => {
  it("parses figures, drops invalid statuses, recomputes the counts, keeps the reliability note", () => {
    const l = extractLedgerBlock(LEDGER_RESULT);
    expect(l).not.toBeNull();
    expect(l!.figures.map((f) => f.value)).toEqual(["$11,700", "7.2%", "$23,500", "5%"]);
    expect(l!.figures[1]).toEqual({ value: "7.2%", claim: "fund return", step: "returns", status: "unsourced" });
    expect(l!.counts).toEqual({ total: 4, verified: 1, consistent: 0, unsourced: 1, conflicting: 1, wrong: 1 });
    expect(l!.note).toBe("Overall the fee figures are solid; the return figure has no source and one limit is wrong.");
  });

  it("returns null without a block, on bad YAML, and when no figure survives", () => {
    expect(extractLedgerBlock("no block here")).toBeNull();
    expect(extractLedgerBlock("```ledger\nfigures: [\n```")).toBeNull();
    expect(extractLedgerBlock("```ledger\nfigures:\n  - value: x\n    status: nonsense\n```")).toBeNull();
  });

  it("strips the block and everything after it", () => {
    expect(stripLedgerBlock(LEDGER_RESULT)).toBe("I audited the research.");
  });
});

describe("report instruction + post summary + appendix", () => {
  const ledger = extractLedgerBlock(LEDGER_RESULT)!;

  it("tells the editor exactly how to treat each status", () => {
    const text = ledgerInstructionForReport(ledger);
    expect(text).toContain("VERIFICATION LEDGER");
    expect(text).toContain("- $11,700 (annual advisory fee; fees): verified [source: client statement, 2026-08-30]");
    expect(text).toContain("- 7.2% (fund return; returns): UNVERIFIED");
    expect(text).toContain("CORRECTED: IRS Notice 2025-67 sets it at $24,500");
    expect(text).toContain("CONFLICTING: 5% in fees, 7% in returns");
    expect(text).toContain("Fact-checker's reliability note:");
    expect(text).not.toContain("—");
  });

  it("summarises for the channel post with the flagged figures", () => {
    expect(ledgerSummaryLine(ledger)).toBe("4 figure(s) checked: 1 sourced, 1 unverified, 1 conflicting, 1 corrected");
    expect(flaggedFigureLines(ledger)).toEqual([
      "7.2% (fund return): no source named",
      "$23,500 (401(k) employee limit 2026): wrong: IRS Notice 2025-67 sets it at $24,500",
      "5% (assumed growth): conflicting: 5% in fees, 7% in returns",
    ]);
    const s = verificationSummary(ledger);
    expect(s.counts.unsourced).toBe(1);
    expect(s.flagged).toHaveLength(3);
  });

  it("renders a markdown appendix and an HTML appendix", () => {
    const md = ledgerMarkdownSection(ledger);
    expect(md.startsWith("## Verification")).toBe(true);
    expect(md).toContain("| Figure | Claim | Source | Status |");
    expect(md).toContain("| 7.2% | fund return | none named | UNVERIFIED |");
    const html = appendLedgerToHtml("<html><body><p>doc</p></body></html>", ledger);
    expect(html).toContain('<section class="verification"');
    expect(html.indexOf("</section>")).toBeLessThan(html.indexOf("</body>"));
    expect(html).toContain("<td>$11,700</td>");
    expect(appendLedgerToHtml("<p>fragment</p>", ledger).endsWith("</section>")).toBe(true);
  });
});
