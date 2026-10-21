import { describe, it, expect } from "vitest";
import { renderMarkdown, escapeHtml } from "../markdown.js";

/**
 * The input is model-authored worker output being fed to a real Chromium page
 * inside the daemon, so the escaping tests are the load-bearing ones here.
 */
describe("markdown — escaping is the security boundary", () => {
  it("never emits author-supplied markup, even for a script tag", () => {
    const html = renderMarkdown('Hello <script>alert("x")</script> world');
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes markup smuggled inside every block type", () => {
    const src = [
      "# <img src=x onerror=alert(1)>",
      "",
      "- <iframe src=//evil>",
      "",
      "> <object data=//evil>",
      "",
      "| <svg onload=1> | b |",
      "| --- | --- |",
      "| <a href=//evil>x</a> | y |",
      "",
      "```",
      "<script>evil()</script>",
      "```",
    ].join("\n");
    const html = renderMarkdown(src);
    for (const tag of ["<img", "<iframe", "<object", "<svg", "<a ", "<script"]) {
      expect(html).not.toContain(tag);
    }
  });

  it("escapes attribute-breaking characters", () => {
    expect(escapeHtml(`" ' & < >`)).toBe("&quot; &#39; &amp; &lt; &gt;");
  });
});

describe("markdown — structure", () => {
  it("demotes author headings so the document keeps ONE h1", () => {
    const html = renderMarkdown("# Top\n\n## Second\n\n###### Deep");
    expect(html).toContain("<h2>Top</h2>");
    expect(html).toContain("<h3>Second</h3>");
    expect(html).not.toContain("<h1>");
  });

  it("renders a GFM table and right-aligns numeric cells with tabular figures", () => {
    const html = renderMarkdown(
      ["| Seg | ARR |", "| --- | --- |", "| Managed | 39,800,000 |", "| Usage | -3.4% |"].join("\n"),
    );
    expect(html).toContain("<table>");
    expect(html).toContain('<td class="num">39,800,000</td>');
    expect(html).toContain('<td class="num">-3.4%</td>');
    expect(html).toContain('<td class="a-left">Managed</td>');
  });

  it("honours an explicit alignment row", () => {
    const html = renderMarkdown(["| a | b |", "| :--- | ---: |", "| x | y |"].join("\n"));
    expect(html).toContain('<th class="a-left">a</th>');
    expect(html).toContain('<th class="a-right">b</th>');
  });

  it("leaves ** inside a code span alone", () => {
    // Naive inline handling emits a stray <strong> here and unbalances the doc.
    const html = renderMarkdown("Use `a ** b` carefully");
    expect(html).toContain("<code>a ** b</code>");
    expect(html).not.toContain("<strong>");
  });

  it("keeps a link's label and prints its target", () => {
    const html = renderMarkdown("See [the filing](https://example.com/f/1) for detail.");
    expect(html).toContain("the filing");
    expect(html).toContain('<span class="url">https://example.com/f/1</span>');
    expect(html).not.toContain("href");
  });

  it("closes an UNCLOSED fence at end of document instead of throwing", () => {
    // Truncated worker output is routine; a parser that throws loses the report.
    const html = renderMarkdown("intro\n\n```\nnever closed");
    expect(html).toContain("<pre><code>never closed</code></pre>");
  });

  it("renders ordered and unordered lists separately", () => {
    const html = renderMarkdown("- a\n- b\n\n1. one\n2. two");
    expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
  });

  it("renders blockquotes and thematic breaks", () => {
    const html = renderMarkdown("> quoted line\n\n---");
    expect(html).toContain("<blockquote>quoted line</blockquote>");
    expect(html).toContain('<hr class="rule" />');
  });

  it("does not treat an intra-word underscore as emphasis", () => {
    const html = renderMarkdown("the file_name_here is fine");
    expect(html).not.toContain("<em>");
  });

  it("returns empty output for empty input rather than throwing", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("\n\n   \n")).toBe("");
  });
});
