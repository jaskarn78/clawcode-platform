import { describe, it, expect } from "vitest";
import {
  chunkMarkdownByH2,
  scoreWeightForPath,
  applyTimeWindowFilter,
  splitIntoParts,
  stripPartSuffix,
  DEFAULT_MAX_WORDS_PER_PART,
} from "../memory-chunks.js";
import { BGE_SMALL_MAX_WORDS } from "../embedder-bge-small.js";
import { MINILM_MAX_WORDS } from "../embedder.js";

describe("memory-chunks (Phase 90 MEM-02)", () => {
  describe("chunkMarkdownByH2", () => {
    it("MEM-02-CH1: splits content on H2 boundaries", () => {
      const content = "# Top\n## A\nbody1\n## B\nbody2";
      const chunks = chunkMarkdownByH2(content);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].heading).toBe("A");
      expect(chunks[0].body).toContain("body1");
      expect(chunks[1].heading).toBe("B");
      expect(chunks[1].body).toContain("body2");
    });

    it("MEM-02-CH2: splits oversized chunks (>1000 token soft cap) on paragraph boundaries", () => {
      // Create an H2 body > 800 tokens (~3200 chars with TOKEN_PER_CHAR=0.25)
      const paragraph = "word ".repeat(100); // ~500 chars
      const body = Array.from({ length: 12 }, () => paragraph).join("\n\n"); // ~6000 chars → 1500 tokens
      const content = `## Big\n${body}`;
      const chunks = chunkMarkdownByH2(content, 800);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.tokenCount).toBeLessThanOrEqual(1000);
      }
    });

    it("MEM-02-CH3: content with only H1 and body → single chunk with null heading", () => {
      const content = "# Top Level Only\n\nSome body text without H2s.";
      const chunks = chunkMarkdownByH2(content);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].heading).toBeNull();
      expect(chunks[0].body).toContain("Some body text");
    });

    it("MEM-02-CH4: empty content → zero chunks", () => {
      expect(chunkMarkdownByH2("")).toHaveLength(0);
      expect(chunkMarkdownByH2("   \n  ")).toHaveLength(0);
    });

    // WP2 (2026-10-25): long sections become parts that keep the heading.
    it("WP2-CH5: a section longer than 220 words is split into parts headed '<heading> (part n/N)'", () => {
      const para = (i: number) => `Paragraph ${i} ` + "filler ".repeat(70).trim() + ".";
      const body = Array.from({ length: 10 }, (_, i) => para(i)).join("\n\n"); // ~720 words
      const lastFact = "The loading dock override code is 4471.";
      const chunks = chunkMarkdownByH2(`# Title\n\n## Long section\n\n${body}\n\n${lastFact}\n\n## Short\n\nOne line.`);
      const parts = chunks.filter((c) => c.heading?.startsWith("Long section"));
      expect(parts.length).toBeGreaterThanOrEqual(4);
      parts.forEach((c, i) => {
        expect(c.heading).toBe(`Long section (part ${i + 1}/${parts.length})`);
        expect(c.body.split(/\s+/).length).toBeLessThanOrEqual(DEFAULT_MAX_WORDS_PER_PART);
        expect(stripPartSuffix(c.heading)).toBe("Long section");
      });
      // The last paragraph lands in the last part, intact.
      expect(parts[parts.length - 1]!.body).toContain(lastFact);
      // The short section is untouched and keeps its plain heading.
      expect(chunks[chunks.length - 1]).toMatchObject({ heading: "Short", body: "One line." });
      // Chunks keep source order.
      expect(chunks.map((c) => c.heading)).toEqual([...parts.map((p) => p.heading), "Short"]);
    });

    it("WP2-CH6: a part fits both embedding windows (heading + 220 words under the caps)", () => {
      expect(DEFAULT_MAX_WORDS_PER_PART + 10).toBeLessThanOrEqual(BGE_SMALL_MAX_WORDS);
      // MiniLM sees the first 200 words: most of a part, and all of a typical one.
      expect(MINILM_MAX_WORDS).toBeLessThanOrEqual(DEFAULT_MAX_WORDS_PER_PART);
      expect(MINILM_MAX_WORDS).toBeGreaterThanOrEqual(DEFAULT_MAX_WORDS_PER_PART * 0.9);
    });

    it("WP2-CH7: a 3,000-word single-paragraph section is split on sentences, nothing lost", () => {
      const sentence = "Alpha beta gamma delta epsilon zeta eta theta iota kappa.";
      const words = 3000;
      const sentences = Math.ceil(words / 10);
      const body = Array.from({ length: sentences }, () => sentence).join(" ") + " The final sentence names the Kestrel account.";
      const chunks = chunkMarkdownByH2(`## Wall\n\n${body}`);
      expect(chunks.length).toBeGreaterThanOrEqual(13);
      for (const c of chunks) {
        expect(c.heading).toMatch(/^Wall \(part \d+\/\d+\)$/);
        expect(c.body.split(/\s+/).length).toBeLessThanOrEqual(DEFAULT_MAX_WORDS_PER_PART);
      }
      const rejoined = chunks.map((c) => c.body).join(" ");
      expect(rejoined.split(/\s+/).length).toBe(body.split(/\s+/).length);
      expect(chunks[chunks.length - 1]!.body).toContain("Kestrel account");
    });

    it("WP2-CH8: a headless file longer than the cap gets '(part n/N)' headings; a short one stays null", () => {
      const long = Array.from({ length: 30 }, (_, i) => `Line ${i} ` + "word ".repeat(20)).join("\n");
      const parts = chunkMarkdownByH2(`# Only a title\n\n${long}`);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts[0]!.heading).toBe(`(part 1/${parts.length})`);
      expect(chunkMarkdownByH2("# T\n\nshort body")[0]!.heading).toBeNull();
    });

    it("WP2-CH9: splitIntoParts packs paragraphs, then lines, then sentences, then word windows", () => {
      expect(splitIntoParts("", 5)).toEqual([]);
      expect(splitIntoParts("one two three", 5)).toEqual(["one two three"]);
      expect(splitIntoParts("a b c\n\nd e f\n\ng h", 6)).toEqual(["a b c\n\nd e f", "g h"]);
      // the bullet dash counts as a word: 4 + 4 > 6, then 4 + 2 fits
      expect(splitIntoParts("- a b c\n- d e f\n- g", 6)).toEqual(["- a b c", "- d e f\n- g"]);
      expect(splitIntoParts("One two three. Four five six. Seven.", 4)).toEqual(["One two three.", "Four five six. Seven."]);
      expect(splitIntoParts("w1 w2 w3 w4 w5 w6 w7", 3)).toEqual(["w1 w2 w3", "w4 w5 w6", "w7"]);
    });
  });

  describe("scoreWeightForPath", () => {
    it("MEM-02-SW1: vault/ gets +0.2, procedures/ gets +0.1, archive/ gets -0.2, others 0.0", () => {
      expect(scoreWeightForPath("/ws/memory/vault/rules.md")).toBe(0.2);
      expect(scoreWeightForPath("/ws/memory/procedures/x.md")).toBe(0.1);
      expect(scoreWeightForPath("/ws/memory/archive/old.md")).toBe(-0.2);
      expect(scoreWeightForPath("/ws/memory/2026-04-24-note.md")).toBe(0.0);
    });
  });

  describe("applyTimeWindowFilter", () => {
    it("MEM-02-TW1: filters dated files >14 days old; keeps vault/procedures all-time", () => {
      const now = Date.UTC(2026, 3, 24); // 2026-04-24
      const chunks = [
        {
          path: "/ws/memory/2026-04-24-today.md",
          file_mtime_ms: now,
        },
        {
          path: "/ws/memory/2026-04-01-old.md",
          file_mtime_ms: now - 23 * 86_400_000, // 23 days ago
        },
        {
          path: "/ws/memory/vault/rules.md",
          file_mtime_ms: now - 365 * 86_400_000, // 1 year old
        },
        {
          path: "/ws/memory/procedures/runbook.md",
          file_mtime_ms: now - 100 * 86_400_000,
        },
      ];
      const filtered = applyTimeWindowFilter(chunks, 14, now);
      const paths = filtered.map((c) => c.path);
      expect(paths).toContain("/ws/memory/2026-04-24-today.md");
      expect(paths).not.toContain("/ws/memory/2026-04-01-old.md");
      expect(paths).toContain("/ws/memory/vault/rules.md");
      expect(paths).toContain("/ws/memory/procedures/runbook.md");
    });
  });
});
