/**
 * 999.63d/4 — chunk-ref store + chunk-edit planner tests (the wall
 * killer). Pure module: fixtures re-derive chunks with the SAME
 * transform the planner uses (formatOutboundText → splitMessage), so the
 * happy paths hold byte-for-byte regardless of splitter internals.
 */
import { describe, it, expect } from "vitest";
import {
  ChunkRefStore,
  planChunkEdits,
  CHUNK_REF_MAX_AGE_MS,
  CHUNK_REF_MAX_PER_AGENT,
  type ChunkRef,
} from "../chunk-refs.js";
import { splitMessage } from "../webhook-manager.js";
import { formatOutboundText } from "../markdown-table-wrap.js";
import { MAX_EDIT_LENGTH } from "../correction-edit.js";

/** A long draft that splits into 3 chunks, with a correctable claim in chunk 2. */
function makeDraft(): string {
  const para = (n: number) =>
    `Paragraph ${n}. ` + "The projections cover ordinary income and capital events in detail. ".repeat(20);
  return [
    para(1),
    para(2),
    "The 2026 Social Security wage base is $176,100 under current law.",
    para(3),
    para(4),
    para(5),
  ].join("\n\n");
}

function chunksOf(text: string): readonly string[] {
  return splitMessage(formatOutboundText(text), MAX_EDIT_LENGTH);
}

function refsFromChunks(
  chunks: readonly string[],
  opts: { at?: number; idPrefix?: string; channelId?: string; lastSuffix?: string } = {},
): ChunkRef[] {
  const { at = 1_000_000, idPrefix = "m", channelId = "c1", lastSuffix = "" } = opts;
  return chunks.map((text, i) => ({
    messageId: `${idPrefix}${i}`,
    channelId,
    kind: "webhook" as const,
    text: i === chunks.length - 1 ? `${text}${lastSuffix}` : text,
    at,
  }));
}

const FOOTER = "*— correction applied (verified figures)*";

describe("ChunkRefStore", () => {
  it("records, age-prunes, and caps per agent", () => {
    const store = new ChunkRefStore();
    store.record("a", refsFromChunks(["one", "two"], { at: 1000 }));
    expect(store.refsFor("a", 2000).length).toBe(2);
    // Age prune.
    expect(store.refsFor("a", 1000 + CHUNK_REF_MAX_AGE_MS + 1).length).toBe(0);
    // Cap: oldest evicted first.
    const many = Array.from({ length: CHUNK_REF_MAX_PER_AGENT + 10 }, (_, i) => ({
      messageId: `m${i}`,
      channelId: "c1",
      kind: "webhook" as const,
      text: `t${i}`,
      at: 5000,
    }));
    store.record("b", many);
    const kept = store.refsFor("b", 5000);
    expect(kept.length).toBe(CHUNK_REF_MAX_PER_AGENT);
    expect(kept[0]?.messageId).toBe("m10");
  });
});

describe("planChunkEdits", () => {
  const draft = makeDraft();
  const patched = draft.replace("$176,100", "$184,500");

  it("happy path: edits ONLY the changed chunk, footer appended, react on it", () => {
    const orig = chunksOf(draft);
    expect(orig.length).toBeGreaterThan(1);
    const refs = refsFromChunks(orig);
    const plan = planChunkEdits({
      refs,
      originalResponse: draft,
      correctedText: patched,
      footer: FOOTER,
    });
    expect(plan).not.toBeNull();
    const newChunks = chunksOf(patched);
    let lastChangedIdx = -1;
    for (let i = 0; i < orig.length; i++) {
      if (orig[i] !== newChunks[i]) lastChangedIdx = i;
    }
    expect(plan!.edits.length).toBe(
      orig.filter((c, i) => c !== newChunks[i]).length,
    );
    const last = plan!.edits[plan!.edits.length - 1]!;
    expect(last.text.endsWith(`\n\n${FOOTER}`)).toBe(true);
    expect(last.text).toContain("$184,500");
    expect(plan!.reactMessageId).toBe(`m${lastChangedIdx}`);
    // Every edit targets a genuinely changed chunk.
    for (const e of plan!.edits) {
      const idx = Number(e.messageId.slice(1));
      expect(orig[idx]).not.toBe(newChunks[idx]);
    }
  });

  it("tolerates a delivery-time footer suffix on the LAST chunk and preserves it", () => {
    const orig = chunksOf(draft);
    const suffix = "\n\n*— consulted advisor (Opus) before responding*";
    const refs = refsFromChunks(orig, { lastSuffix: suffix });
    // Patch the LAST chunk's content so the suffix-preservation is exercised:
    const lastText = orig[orig.length - 1]!;
    const marker = "Paragraph 5";
    expect(lastText).toContain(marker);
    const patchedLast = draft.replace(marker, "Paragraph FIVE");
    const plan = planChunkEdits({
      refs,
      originalResponse: draft,
      correctedText: patchedLast,
      footer: FOOTER,
    });
    expect(plan).not.toBeNull();
    const lastEdit = plan!.edits[plan!.edits.length - 1]!;
    expect(lastEdit.text).toContain("Paragraph FIVE");
    expect(lastEdit.text).toContain(suffix.trim());
    expect(lastEdit.text.endsWith(`\n\n${FOOTER}`)).toBe(true);
  });

  it("chunk-count change → null (positional diff unsafe)", () => {
    const orig = chunksOf(draft);
    const refs = refsFromChunks(orig);
    const plan = planChunkEdits({
      refs,
      originalResponse: draft,
      correctedText: patched + "\n\n" + "Additional content. ".repeat(300),
      footer: FOOTER,
    });
    expect(plan).toBeNull();
  });

  it("no matching run in the store → null", () => {
    const refs = refsFromChunks(["completely", "different", "delivery"]);
    const plan = planChunkEdits({
      refs,
      originalResponse: draft,
      correctedText: patched,
      footer: FOOTER,
    });
    expect(plan).toBeNull();
  });

  it("empty store → null; identical text (no changed chunk) → null", () => {
    expect(
      planChunkEdits({
        refs: [],
        originalResponse: draft,
        correctedText: patched,
        footer: FOOTER,
      }),
    ).toBeNull();
    const refs = refsFromChunks(chunksOf(draft));
    expect(
      planChunkEdits({
        refs,
        originalResponse: draft,
        correctedText: draft,
        footer: FOOTER,
      }),
    ).toBeNull();
  });

  it("non-newline suffix on the last chunk (foreign edit) → null", () => {
    const orig = chunksOf(draft);
    const refs = refsFromChunks(orig, { lastSuffix: " TAMPERED" });
    expect(
      planChunkEdits({
        refs,
        originalResponse: draft,
        correctedText: patched,
        footer: FOOTER,
      }),
    ).toBeNull();
  });

  it("latest run wins when the same content was delivered twice", () => {
    const orig = chunksOf(draft);
    const older = refsFromChunks(orig, { at: 1000, idPrefix: "old" });
    const newer = refsFromChunks(orig, { at: 2000, idPrefix: "new" });
    const plan = planChunkEdits({
      refs: [...older, ...newer],
      originalResponse: draft,
      correctedText: patched,
      footer: FOOTER,
    });
    expect(plan).not.toBeNull();
    expect(plan!.edits.every((e) => e.messageId.startsWith("new"))).toBe(true);
  });

  it("oversize edit (footer overflows the changed chunk) → null", () => {
    // Build a draft whose middle chunk is near the 2000 limit so the
    // footer append cannot fit.
    const nearMax = "y".repeat(1995);
    const text = `${"x".repeat(1990)}\n${nearMax}\n${"z".repeat(1990)}`;
    const orig = chunksOf(text);
    const refs = refsFromChunks(orig);
    const changed = text.replace("yyyy", "YYYY");
    const plan = planChunkEdits({
      refs,
      originalResponse: text,
      correctedText: changed,
      footer: FOOTER,
    });
    expect(plan).toBeNull();
  });
});
