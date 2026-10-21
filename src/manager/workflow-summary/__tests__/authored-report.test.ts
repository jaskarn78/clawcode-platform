import { describe, it, expect } from "vitest";
import { buildAuthoredReportPrompt, extractAuthoredHtml } from "../authored-report.js";
import { hardenAgentDesignedHtml } from "../../../reports/report-html.js";

describe("extractAuthoredHtml", () => {
  const doc = `<!doctype html><html><head><style>body{background:#111}</style></head><body>${"<p>real content</p>".repeat(40)}</body></html>`;

  it("accepts a bare document and one wrapped in a ```html fence", () => {
    expect(extractAuthoredHtml(doc)).toContain("<body>");
    expect(extractAuthoredHtml("Here it is:\n```html\n" + doc + "\n```")).toContain("<body>");
  });

  it("returns null for markdown (the fixed-template fallback path)", () => {
    expect(extractAuthoredHtml("# Report\n\nJust markdown with <b>a tag</b>.")).toBeNull();
  });

  it("returns null for a stray html tag in prose", () => {
    expect(extractAuthoredHtml("Use <html> semantics. </html> done.")).toBeNull();
  });
});

describe("hardenAgentDesignedHtml", () => {
  it("strips script blocks and injects fonts + page pin", () => {
    const raw =
      '<!doctype html><html><head><style>p{}</style><script>alert(1)</script></head>' +
      "<body><p>x</p><script src=\"data:text/javascript,1\"></script></body></html>";
    const out = hardenAgentDesignedHtml(raw);
    expect(out).not.toContain("<script");
    expect(out).toContain("data:font/woff2;base64,");
    expect(out).toContain("@page { size: 4.5in 8in; margin: 0; }");
  });

  it("injects a head when the agent omitted one", () => {
    const out = hardenAgentDesignedHtml("<html><body><p>x</p></body></html>");
    expect(out).toContain("@page");
    expect(out.indexOf("@page")).toBeLessThan(out.indexOf("<body"));
  });
});

describe("buildAuthoredReportPrompt", () => {
  const prompt = buildAuthoredReportPrompt([
    { stepId: "a", prompt: "find pools", status: "done", result: "Pool findings." },
    { stepId: "b", prompt: "find food", status: "failed" },
  ]);
  it("carries the design brief and the security constraints", () => {
    expect(prompt).toContain("EDITOR and the DESIGNER");
    expect(prompt).toContain("BLOCKS all network requests");
    expect(prompt).toContain("JavaScript is disabled");
    expect(prompt).toContain("4.5in x 8in");
  });
  it("folds failed steps in as known gaps", () => {
    expect(prompt).toContain("FAILED");
  });
});

// ── Phase 999.120 — findings block ───────────────────────────────────────
import {
  extractFindingsBlock,
  stripFindingsBlock,
  FINDINGS_BLOCK_INSTRUCTION,
} from "../authored-report.js";

describe("findings block instruction (Phase 999.120)", () => {
  it("the agent-designed prompt now asks for the findings block too", () => {
    expect(FINDINGS_BLOCK_INSTRUCTION).toContain("```findings");
  });
});

describe("extractFindingsBlock / stripFindingsBlock (Phase 999.120)", () => {
  const result = `<!doctype html><html><body><p>doc</p></body></html>

\`\`\`findings
summary: The asset is cheaper than it looks.
findings:
  - Margins fell 640bps.
  - Churn is flat.
next_steps:
  - Ask for the Q3 deck.
\`\`\`
`;

  it("parses the block and strips it from the document body", () => {
    const f = extractFindingsBlock(result)!;
    expect(f.summary).toBe("The asset is cheaper than it looks.");
    expect(f.findings).toEqual(["Margins fell 640bps.", "Churn is flat."]);
    expect(f.nextSteps).toEqual(["Ask for the Q3 deck."]);
    const body = stripFindingsBlock(result);
    expect(body).not.toContain("```findings");
    expect(body).toContain("</html>");
  });

  it("returns null when the block is absent, empty, or not YAML", () => {
    expect(extractFindingsBlock("no block here")).toBeNull();
    expect(extractFindingsBlock("```findings\nfindings: []\n```")).toBeNull();
    expect(extractFindingsBlock("```findings\n: : : [\n```")).toBeNull();
  });
});
