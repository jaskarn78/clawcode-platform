/**
 * WP3 (2026-10-25): contextual chunk headers, mirror re-chunking, stub
 * chunks and header-aware reassembly.
 */
import { describe, it, expect } from "vitest";
import {
  buildChunkHeader,
  buildEmptyDocumentStub,
  chunkForMirror,
  chunkWithContext,
  isChunkHeaderLine,
  pageForOffset,
  pageOffsetsFor,
  stripChunkHeader,
  withChunkHeaders,
  formatUploadDate,
} from "../chunk-context.js";
import { chunkText, reassembleChunkedText } from "../chunker.js";

function words(n: number, prefix = "w"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
}

describe("buildChunkHeader", () => {
  it("renders every known field in the documented order", () => {
    const h = buildChunkHeader(
      {
        filename: "invoice-10432.pdf",
        uploadedAt: "2026-10-20T14:03:00.000Z",
        userName: "jas",
        channelName: "billing",
      },
      { page: 2, part: 3, total: 5 },
    );
    expect(h).toBe(
      "Document: invoice-10432.pdf | uploaded 2026-10-20 | from jas in #billing | page 2 | part 3/5",
    );
  });

  it("omits unknown fields", () => {
    expect(buildChunkHeader({ filename: "a.png" }, { part: 1, total: 1 })).toBe(
      "Document: a.png | part 1/1",
    );
    expect(
      buildChunkHeader({ filename: "a.png", userName: "jas" }, { part: 1, total: 2 }),
    ).toBe("Document: a.png | from jas | part 1/2");
    expect(
      buildChunkHeader({ filename: "a.png", channelName: "#ops" }, { part: 2, total: 2 }),
    ).toBe("Document: a.png | in #ops | part 2/2");
  });

  it("formats only the date part and ignores garbage dates", () => {
    expect(formatUploadDate("2026-10-20T23:59:59Z")).toBe("2026-10-20");
    expect(formatUploadDate("not a date")).toBeNull();
    expect(formatUploadDate(null)).toBeNull();
  });
});

describe("chunkWithContext", () => {
  it("prefixes every chunk with a header and keeps body offsets", () => {
    const text = words(900);
    const chunks = chunkWithContext(text, { filename: "big.txt", uploadedAt: "2026-10-01" });
    const plain = chunkText(text);
    expect(chunks).toHaveLength(plain.length);
    chunks.forEach((c, i) => {
      const [first, ...rest] = c.content.split("\n");
      expect(first).toBe(`Document: big.txt | uploaded 2026-10-01 | part ${i + 1}/${plain.length}`);
      expect(isChunkHeaderLine(first)).toBe(true);
      expect(rest.join("\n")).toBe(plain[i].content);
      expect(c.startChar).toBe(plain[i].startChar);
      expect(c.endChar).toBe(plain[i].endChar);
    });
  });

  it("maps each chunk to the page it starts on", () => {
    const pageTexts = [words(400, "a"), "", words(400, "c")];
    const text = pageTexts.join("\n\n").trim();
    const chunks = chunkWithContext(text, { filename: "p.pdf" }, { pageTexts });
    const pages = chunks.map((c) => /\| page (\d+) \|/.exec(c.content)?.[1]);
    // Chunk 0 starts on page 1, chunk 1 inside page 1 (word 337), chunk 2 on page 3.
    expect(pages[0]).toBe("1");
    expect(pages[1]).toBe("1");
    expect(pages[2]).toBe("3");
    // The body of the chunk on page 3 really comes from page 3.
    expect(stripChunkHeader(chunks[2].content).startsWith("c")).toBe(true);
  });

  it("does not label pages for single-page text", () => {
    const chunks = chunkWithContext("hello world", { filename: "x.txt" }, { pageTexts: ["hello world"] });
    expect(chunks[0].content).toBe("Document: x.txt | part 1/1\nhello world");
  });

  it("page offsets account for leading whitespace trimmed from the text", () => {
    const pageTexts = ["  lead", "second"];
    const offsets = pageOffsetsFor(pageTexts);
    const text = pageTexts.join("\n\n").trim();
    expect(pageForOffset(offsets, text.indexOf("lead"))).toBe(1);
    expect(pageForOffset(offsets, text.indexOf("second"))).toBe(2);
    expect(pageForOffset([], 10)).toBeUndefined();
  });
});

describe("chunkForMirror", () => {
  it("re-chunks to about 300 body words with a 30-word overlap", () => {
    const text = words(1000);
    const mirror = chunkForMirror(text, { filename: "long.pdf" });
    for (const m of mirror) {
      const body = stripChunkHeader(m.content).split(/\s+/).filter(Boolean);
      expect(body.length).toBeLessThanOrEqual(300);
    }
    expect(stripChunkHeader(mirror[0].content).split(" ")).toHaveLength(300);
    // Second mirror chunk starts 270 words in (300 minus 30 overlap).
    expect(stripChunkHeader(mirror[1].content).split(" ")[0]).toBe("w270");
    expect(mirror.map((m) => m.index)).toEqual(mirror.map((_, i) => i));
    expect(mirror[0].content.startsWith(`Document: long.pdf | part 1/${mirror.length}\n`)).toBe(true);
  });

  it("returns nothing for empty text", () => {
    expect(chunkForMirror("   ", { filename: "e.txt" })).toEqual([]);
  });
});

describe("stripChunkHeader", () => {
  it("removes a real header line", () => {
    expect(stripChunkHeader("Document: a.pdf | part 1/2\nbody text")).toBe("body text");
    expect(stripChunkHeader("Document: a.pdf | part 1/1")).toBe("");
  });

  it("leaves legacy content that merely starts with 'Document:' unchanged", () => {
    const legacy = "Document: Lease Agreement between the parties dated 2024";
    expect(stripChunkHeader(legacy)).toBe(legacy);
    const legacyNl = "Document: Lease Agreement\nsecond line";
    expect(stripChunkHeader(legacyNl)).toBe(legacyNl);
    expect(stripChunkHeader("plain text")).toBe("plain text");
  });
});

describe("buildEmptyDocumentStub", () => {
  it("stores a one-line description, never file bytes", () => {
    const stub = buildEmptyDocumentStub(
      { filename: "IMG_1256.jpg", uploadedAt: "2026-10-25T08:00:00Z", userName: "jas" },
      "image",
    );
    expect(stub.content).toBe(
      "Document: IMG_1256.jpg | uploaded 2026-10-25 | from jas | part 1/1\n" +
        "Image IMG_1256.jpg uploaded 2026-10-25; no text could be extracted",
    );
    expect(stub.chunkIndex).toBe(0);
    expect(buildEmptyDocumentStub({ filename: "scan.pdf" }, "file").content).toContain(
      "File scan.pdf; no text could be extracted",
    );
  });
});

describe("withChunkHeaders", () => {
  it("adds headers to chunks produced elsewhere", () => {
    const out = withChunkHeaders(chunkText(words(10)), { filename: "x.pdf" });
    expect(out[0].content).toBe(`Document: x.pdf | part 1/1\n${words(10)}`);
  });
});

describe("reassembleChunkedText", () => {
  it("rebuilds the whitespace-normalized source from headered chunks", () => {
    const text = `${words(800)}\n\n  tail   words  here`;
    const chunks = chunkWithContext(text, { filename: "r.txt" });
    const rebuilt = reassembleChunkedText(chunks.map((c) => stripChunkHeader(c.content)));
    expect(rebuilt).toBe(text.split(/\s+/).filter(Boolean).join(" "));
  });
});

describe("chunkText offsets (linear-time rewrite)", () => {
  it("startChar/endChar still point at the first and last word of each chunk", () => {
    const text = `  ${words(700).replace(/ /g, " \n\t ")}  `;
    for (const c of chunkText(text)) {
      const ws = c.content.split(" ");
      expect(text.slice(c.startChar, c.startChar + ws[0].length)).toBe(ws[0]);
      expect(text.slice(c.endChar - ws[ws.length - 1].length, c.endChar)).toBe(ws[ws.length - 1]);
    }
  });
});
