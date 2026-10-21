/**
 * Evidence ledger parsers — fixtures are the REAL shapes observed on prod
 * (fin-client transcripts, 2026-08-26), not idealised ones.
 */
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_MAX_FOUND_PER_RESULT,
  asOfFromFilename,
  evidenceFromToolResult,
  evidenceFromToolUse,
  evidenceKey,
  extractCitations,
  normalizeUrl,
  reconcileCitations,
  tablesFromSql,
  isNonSourceHost,
  isArtifactFile,
} from "../evidence-ledger.js";

const AT = 1_700_000_000_000;

const WEBSEARCH_RESULT = `Web search results for query: "Connecticut successor liability asset purchase product line exception continuity of enterprise"

Links: [{"title":"Successor Liability for Defective Products","url":"https://brooklynworks.brooklaw.edu/cgi/viewcontent.cgi?article=1340&context=blr"},{"title":"Successor Corporation Liability is Expanded by Connecticut Court - Wiggin and Dana LLP","url":"https://www.wiggin.com/publication/successor-corporation-liability-is-expanded-by-connecticut-court/"},{"title":"RMD FAQs [brackets] in title","url":"https://www.irs.gov/retirement-plans/rmd-faqs?utm_source=x#top"}]

Based on the search results, Connecticut recognizes …`;

const BRAVE_RESULT = `{"result":[{"title":"529 Plan FAQs: Contributions, Withdrawals & Rules | ScholarShare 529","url":"https://www.scholarshare529.com/resources/faq/","description":"…"},{"title":"How a 529 Plan Works","url":"https://www.scholarshare529.com/learn/how-does-a-529-plan-work/","description":"…"}]}`;

describe("normalizeUrl", () => {
  it("lowercases, strips www, tracking params, fragment and trailing slash", () => {
    expect(normalizeUrl("HTTPS://www.IRS.gov/retirement-plans/rmd-faqs/?utm_source=x&b=1#top")).toEqual({
      url: "https://irs.gov/retirement-plans/rmd-faqs?b=1",
      host: "irs.gov",
    });
  });
  it("rejects non-http schemes and garbage", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl(42)).toBeNull();
  });
});

describe("evidenceFromToolUse", () => {
  it("WebFetch url → read, tiered by host", () => {
    const [e] = evidenceFromToolUse("WebFetch", "t1", { url: "https://www.irs.gov/x", prompt: "p" }, AT);
    expect(e).toMatchObject({ kind: "read", host: "irs.gov", tier: "primary", toolUseId: "t1" });
    const [s] = evidenceFromToolUse("WebFetch", "t2", { url: "https://wiggin.com/a" }, AT);
    expect(s?.tier).toBe("secondary");
  });
  it("mysql_query sql → one queried entry per table, client tier", () => {
    const es = evidenceFromToolUse(
      "mcp__acme-db__mysql_query",
      "t3",
      { sql: "SELECT a FROM pipeline_clients pc JOIN `client_accounts` ca ON pc.id=ca.client_id WHERE x" },
      AT,
    );
    expect(es.map((e) => e.table)).toEqual(["pipeline_clients", "client_accounts"]);
    expect(es.every((e) => e.kind === "queried" && e.tier === "client")).toBe(true);
  });
  it("ingest_document → document with basename only and as-of date", () => {
    const [e] = evidenceFromToolUse(
      "mcp__clawcode__ingest_document",
      "t4",
      { file_path: "/home/clawcode/secret/vallejos/statement-2026-04-30.pdf" },
      AT,
    );
    expect(e).toMatchObject({ kind: "document", file: "statement-2026-04-30.pdf", asOf: "2026-04-30", tier: "client" });
    expect(JSON.stringify(e)).not.toContain("secret");
  });
  it("Read counts only under a documents dir", () => {
    // A client RECORD under the documents dir counts; a rendered artifact
    // (plan.html) under the same dir does not — see isArtifactFile.
    expect(evidenceFromToolUse("Read", "t5", { file_path: "/w/clients/vallejos/plan.pdf" }, AT)).toHaveLength(1);
    expect(evidenceFromToolUse("Read", "t5b", { file_path: "/w/clients/vallejos/plan.html" }, AT)).toHaveLength(0);
    expect(evidenceFromToolUse("Read", "t6", { file_path: "/w/memory/MEMORY.md" }, AT)).toHaveLength(0);
  });
  it("is total on malformed input", () => {
    expect(evidenceFromToolUse("WebFetch", "t", null, AT)).toEqual([]);
    expect(evidenceFromToolUse("WebFetch", "t", { url: 5 }, AT)).toEqual([]);
    expect(evidenceFromToolUse("Bash", "t", { command: "ls" }, AT)).toEqual([]);
  });
});

describe("evidenceFromToolResult", () => {
  it("WebSearch Links array → found entries with query + title, brackets in titles survive", () => {
    const es = evidenceFromToolResult("WebSearch", "t1", WEBSEARCH_RESULT, AT);
    expect(es).toHaveLength(3);
    expect(es[0]).toMatchObject({ kind: "found", host: "brooklynworks.brooklaw.edu", tier: "secondary" });
    expect(es[0]?.query).toContain("Connecticut successor liability");
    expect(es[2]).toMatchObject({ host: "irs.gov", tier: "primary", url: "https://irs.gov/retirement-plans/rmd-faqs" });
    expect(es[2]?.title).toContain("[brackets]");
  });
  it("brave {result:[…]} → found entries", () => {
    const es = evidenceFromToolResult("mcp__brave-search__search", "t2", BRAVE_RESULT, AT);
    expect(es).toHaveLength(2);
    expect(es[0]?.host).toBe("scholarshare529.com");
  });
  it("caps found entries per result and dedupes by URL", () => {
    const links = Array.from({ length: 40 }, (_, i) => ({ title: `t${i}`, url: `https://x.com/p${i % 25}` }));
    const es = evidenceFromToolResult("WebSearch", "t", `Links: ${JSON.stringify(links)}`, AT);
    expect(es.length).toBeLessThanOrEqual(EVIDENCE_MAX_FOUND_PER_RESULT);
    expect(new Set(es.map((e) => e.url)).size).toBe(es.length);
  });
  it("is total on truncated JSON, non-search tools and huge text", () => {
    expect(evidenceFromToolResult("WebSearch", "t", 'Links: [{"title":"x","url":"https://a.com/', AT)).toEqual([]);
    expect(evidenceFromToolResult("Bash", "t", "some output", AT)).toEqual([]);
    expect(evidenceFromToolResult("WebSearch", "t", "x".repeat(2_000_000), AT)).toEqual([]);
  });
});

describe("tablesFromSql / asOfFromFilename / evidenceKey", () => {
  it("parses FROM/JOIN/UPDATE/INTO with schema + quoting", () => {
    expect(tablesFromSql('UPDATE acme.`client_interactions` SET x=1')).toEqual(["client_interactions"]);
    expect(tablesFromSql("INSERT INTO client_interactions (a) VALUES (1)")).toEqual(["client_interactions"]);
    expect(tablesFromSql(42)).toEqual([]);
  });
  it("as-of dates in both filename styles", () => {
    expect(asOfFromFilename("statement-2026-04-30.pdf")).toBe("2026-04-30");
    expect(asOfFromFilename("stmt_20260430.pdf")).toBe("2026-04-30");
    expect(asOfFromFilename("plan.html")).toBeUndefined();
  });
  it("evidenceKey is per kind + target", () => {
    const [a] = evidenceFromToolUse("WebFetch", "1", { url: "https://irs.gov/x" }, AT);
    const [b] = evidenceFromToolUse("WebFetch", "2", { url: "https://www.irs.gov/x/" }, AT);
    expect(evidenceKey(a!)).toBe(evidenceKey(b!));
  });
});

describe("citations", () => {
  it("extracts URLs and bare primary hosts from a draft", () => {
    const c = extractCitations("Per https://www.irs.gov/retirement-plans/rmd-faqs. See also ssa.gov and example.com.");
    expect(c.urls).toEqual(["https://irs.gov/retirement-plans/rmd-faqs"]);
    expect(c.hosts).toContain("irs.gov");
    expect(c.hosts).toContain("ssa.gov");
    // non-primary bare hosts are not treated as citations (too noisy)
    expect(c.hosts).not.toContain("example.com");
  });
  it("reconciles against evidence: opened host matches, never-opened host is flagged", () => {
    const evidence = evidenceFromToolUse("WebFetch", "1", { url: "https://www.irs.gov/retirement-plans/other-page" }, AT);
    const r = reconcileCitations(
      { urls: ["https://irs.gov/retirement-plans/rmd-faqs", "https://dol.gov/x"], hosts: ["ssa.gov"] },
      evidence,
    );
    expect(r.matched).toEqual(["https://irs.gov/retirement-plans/rmd-faqs"]);
    expect(r.unmatchedHosts.sort()).toEqual(["dol.gov", "ssa.gov"]);
  });
  it("is total", () => {
    expect(extractCitations(undefined)).toEqual({ urls: [], hosts: [] });
    expect(reconcileCitations({ urls: [], hosts: [] }, [])).toEqual({ matched: [], unmatchedHosts: [] });
  });
});

describe("2026-08-27 — delivery surfaces are not citations; artifacts are not documents", () => {
  it("ignores links to the agent's own uploads and shared drives", () => {
    const draft = "[Download the PDF](https://cdn.discordapp.com/attachments/1/2/plan.pdf) · [Drive](https://drive.google.com/file/d/abc/view) — per https://www.irs.gov/retirement-plans/x";
    const c = extractCitations(draft);
    expect(c.hosts).toEqual(["irs.gov"]);
    expect(c.urls.some((u) => u.includes("discordapp"))).toBe(false);
    for (const h of ["cdn.discordapp.com", "media.discordapp.net", "drive.google.com", "docs.google.com", "localhost"]) expect(isNonSourceHost(h)).toBe(true);
    expect(isNonSourceHost("irs.gov")).toBe(false);
  });
  it("a rendered plan or a chart script the agent wrote is not document evidence; a client record is", () => {
    for (const f of ["2026-08-26-montoya-financial-plan.html", "make_charts_2026-08-26.py", "styles.css", "build.sh"]) expect(isArtifactFile(f)).toBe(true);
    for (const f of ["2026-08-26-montoya-facts.json", "statement-2026-04-30.pdf", "cotp-filing.pdf", "notes.md"]) expect(isArtifactFile(f)).toBe(false);
    const dir = "/home/x/.clawcode/agents/acme/clients/client-b-montoya/";
    expect(evidenceFromToolUse("Read", "t1", { file_path: `${dir}make_charts_2026-08-26.py` }, 1)).toEqual([]);
    expect(evidenceFromToolUse("mcp__clawcode__ingest_document", "t2", { file_path: `${dir}2026-08-26-montoya-financial-plan.html` }, 1)).toEqual([]);
    expect(evidenceFromToolUse("Read", "t3", { file_path: `${dir}2026-08-26-montoya-facts.json` }, 1)).toHaveLength(1);
  });
});

describe("2026-08-28 — market-data tools are evidence", () => {
  it("finnhub stock_quote → queried evidence on finnhub.io; a finnhub citation reconciles", () => {
    const ev = evidenceFromToolUse("mcp__finnhub__stock_quote", "t1", { symbol: "SPCX" }, 1);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "queried", host: "finnhub.io", title: "SPCX stock quote", tier: "secondary" });
    const r = reconcileCitations({ urls: ["https://finnhub.io/quote/SPCX"], hosts: ["finnhub.io"] }, ev);
    expect(r.unmatchedHosts).toEqual([]);
  });
});
