/**
 * Phase 999.124 — memory-recall footer rendering.
 */

import { describe, it, expect } from "vitest";
import {
  recallFooterLine,
  recallVerboseBlock,
  renderRecallFooter,
  summarizeRecall,
} from "../recall-footer.js";
import type { MemoryRetrievalResult } from "../../memory/memory-retrieval.js";

const NOW = Date.UTC(2026, 8, 5, 20, 0, 0);
/** The footer's lead-in, "*" + U+2014 + " recalled" (escaped here; the source string is unchanged). */
const LEAD = "*\u2014 recalled";

const chunk = (o: Partial<MemoryRetrievalResult> & { chunkId: string; path: string; source: "memory" | "chunk" }): MemoryRetrievalResult =>
  ({ heading: null, body: "", fusedScore: 0.5, scoreWeight: 0, ...o }) as MemoryRetrievalResult;

const chunks = [
  chunk({ chunkId: "m1", path: "memory:m1", source: "memory", body: "## Zaid\nZaid wants **40% SGOV** and the rest in VTI.", createdAt: "2026-06-12T17:00:00.000Z" }),
  chunk({ chunkId: "m2", path: "memory:m2", source: "memory", body: "x".repeat(200), createdAt: "2026-08-30T17:00:00.000Z" }),
  chunk({ chunkId: "c1", path: "/home/a/ws/MEMORY.md", source: "chunk", heading: "Preferences", body: "Brief answers." }),
  chunk({ chunkId: "d1", path: "document:q2-statement", source: "chunk", heading: "Fees", body: "..." }),
];

describe("summarizeRecall", () => {
  it("splits memories, notes and documents and keeps a trimmed snippet + date per memory", () => {
    const r = summarizeRecall(chunks, NOW);
    expect(r.at).toBe(NOW);
    expect(r.memories.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(r.memories[0]!.snippet).toBe("Zaid");
    expect(r.memories[1]!.snippet).toHaveLength(90);
    expect(r.memories[0]!.createdAt).toBe("2026-06-12T17:00:00.000Z");
    expect(r.notes).toEqual([{ path: "MEMORY.md", heading: "Preferences" }]);
    expect(r.documents).toEqual([{ path: "q2-statement", heading: "Fees" }]);
  });

  it("WP2: notes and documents carry their file date when the result has one", () => {
    const r = summarizeRecall(
      [
        chunk({ chunkId: "c1", path: "/ws/memory/2026-08-02.md", source: "chunk", heading: "Decisions", fileMtimeMs: Date.UTC(2026, 7, 2, 12) }),
        chunk({ chunkId: "d1", path: "document:invoice", source: "chunk", heading: null, fileMtimeMs: Date.UTC(2026, 6, 15, 12) }),
        chunk({ chunkId: "shared:f", path: "shared-facts", source: "chunk", heading: "Owner fact", createdAt: "2026-07-01T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(r.notes).toEqual([
      { path: "2026-08-02.md", heading: "Decisions", date: "2026-08-02T12:00:00.000Z" },
      { path: "shared-facts", heading: "Owner fact", date: "2026-07-01T00:00:00.000Z" },
    ]);
    expect(r.documents).toEqual([{ path: "invoice", heading: null, date: "2026-07-15T12:00:00.000Z" }]);
  });
});

describe("footer rendering", () => {
  it("one italic line with counts and the memory date range", () => {
    const r = summarizeRecall(chunks, NOW);
    expect(recallFooterLine(r, NOW)).toBe("*— recalled 2 memories (Jun 12 to Aug 30), 1 note, 1 document*");
  });

  it("WP2: notes and documents get their own date range from their file dates", () => {
    const dated = summarizeRecall(
      [
        chunks[0]!,
        { ...chunks[2]!, fileMtimeMs: Date.UTC(2026, 8, 1, 12) },
        { ...chunks[3]!, fileMtimeMs: Date.UTC(2026, 4, 20, 12) },
      ],
      NOW,
    );
    expect(recallFooterLine(dated, NOW)).toBe(`${LEAD} 1 memory (Jun 12), 1 note (Sep 1), 1 document (May 20)*`);
    const notesOnly = summarizeRecall([{ ...chunks[2]!, fileMtimeMs: Date.UTC(2026, 8, 1, 12) }], NOW);
    expect(recallFooterLine(notesOnly, NOW)).toBe(`${LEAD} 1 note (Sep 1)*`);
  });

  it("singular forms, a single date, and a year when it differs from now", () => {
    const one = summarizeRecall([chunks[0]!], NOW);
    expect(recallFooterLine(one, NOW)).toBe("*— recalled 1 memory (Jun 12)*");
    const old = summarizeRecall([{ ...chunks[0]!, createdAt: "2025-01-03T12:00:00.000Z" }], NOW);
    expect(recallFooterLine(old, NOW)).toBe("*— recalled 1 memory (Jan 3, 2025)*");
    const undated = summarizeRecall([{ ...chunks[0]!, createdAt: undefined }], NOW);
    expect(recallFooterLine(undated, NOW)).toBe("*— recalled 1 memory*");
  });

  it("is empty when nothing was recalled", () => {
    expect(renderRecallFooter(summarizeRecall([], NOW), "normal", NOW)).toBe("");
  });

  it("normal = the line; verbose = the line plus an itemised block, capped", () => {
    const r = summarizeRecall(chunks, NOW);
    expect(renderRecallFooter(r, "normal", NOW)).toBe("\n\n*— recalled 2 memories (Jun 12 to Aug 30), 1 note, 1 document*");
    const verbose = renderRecallFooter(r, "verbose", NOW);
    expect(verbose).toContain("🧠 recalled\n• Jun 12: Zaid\n• Aug 30: xxx");
    expect(verbose).toContain("• MEMORY.md › Preferences\n• q2-statement › Fees");
    const datedVerbose = recallVerboseBlock(
      summarizeRecall([{ ...chunks[2]!, fileMtimeMs: Date.UTC(2026, 8, 1, 12) }], NOW),
      NOW,
    );
    expect(datedVerbose).toContain("• Sep 1: MEMORY.md › Preferences");
    const many = summarizeRecall(
      Array.from({ length: 12 }, (_, i) => chunk({ chunkId: `c${i}`, path: `/ws/n${i}.md`, source: "chunk", heading: `H${i}` })),
      NOW,
    );
    const block = recallVerboseBlock(many, NOW);
    expect(block.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(9);
    expect(block).toContain("• … and 4 more");
  });
});
