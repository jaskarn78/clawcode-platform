/** Phase 999.187 — natural questions become OR-of-terms MATCH expressions. */
import { describe, it, expect } from "vitest";
import { buildFtsMatchQuery, extractFtsTerms } from "../fts-query.js";

describe("buildFtsMatchQuery", () => {
  it("drops stopwords, lowercases, dedupes and ORs quoted terms", () => {
    expect(buildFtsMatchQuery("What did we decide about the Database engine? The database!"))
      .toBe('"decide" OR "database" OR "engine"');
  });
  it("neutralises FTS5 syntax and punctuation", () => {
    expect(buildFtsMatchQuery('NEAR(x) col:val "quoted" AND NOT -foo')).toBe('"near" OR "col" OR "val" OR "quoted" OR "foo"');
  });
  it("falls back to stopwords when nothing else remains", () => {
    expect(buildFtsMatchQuery("what is it")).toBe('"what" OR "is" OR "it"');
  });
  it("returns null for empty or unusable input", () => {
    expect(buildFtsMatchQuery("")).toBeNull();
    expect(buildFtsMatchQuery("?? !! ..")).toBeNull();
    expect(buildFtsMatchQuery("a")).toBeNull();
  });
  it("caps the term count", () => {
    const q = Array.from({ length: 30 }, (_, i) => `term${i}`).join(" ");
    expect(extractFtsTerms(q)).toHaveLength(12);
  });

  it("WP2: a Discord envelope contributes no terms, only the user's words do", () => {
    const wrapped =
      '<channel source="discord" chat_id="000000000000000001" message_id="1433000000000000000" user="jas" ts="2026-10-25 09:14 PDT">\n' +
      "is it safe to run the migration on staging?\n" +
      "</channel>";
    expect(extractFtsTerms(wrapped)).toEqual(["safe", "run", "migration", "staging"]);
    expect(buildFtsMatchQuery(wrapped)).toBe('"safe" OR "run" OR "migration" OR "staging"');
  });
});
