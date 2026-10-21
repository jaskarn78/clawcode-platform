import { describe, it, expect } from "vitest";
import {
  chunkMarkdownByH2,
  scoreWeightForPath,
  applyTimeWindowFilter,
} from "../memory-chunks.js";

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
