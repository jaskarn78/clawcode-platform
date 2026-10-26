/**
 * Contextual chunk headers for document retrieval.
 *
 * Every document chunk (the `document_chunks` row the search_documents tool
 * reads and the `memory_chunks` mirror the per-turn retriever reads) carries
 * a one-line header in its indexed text so that BM25 and the embedding both
 * see the provenance that used to live only in the `documents` row:
 *
 *   Document: <original filename> | uploaded <YYYY-MM-DD> | from <user> in #<channel> | page <p> | part <i>/<n>
 *
 * Unknown fields are omitted. The header is the first line of the chunk
 * content; the body follows after a newline.
 *
 * The memory mirror is re-chunked to about 300 words
 * (MIRROR_CHUNK_TARGET_TOKENS at the chunker's 0.75 words-per-token ratio)
 * so that each mirror row embeds fully with the bge-small word cap.
 */

import { chunkText, type ChunkInput } from "./chunker.js";

/** Provenance known at ingest time. Every field is optional. */
export type DocumentChunkContext = {
  readonly filename?: string | null;
  /** ISO timestamp or YYYY-MM-DD; only the date part is rendered. */
  readonly uploadedAt?: string | null;
  readonly userName?: string | null;
  readonly channelName?: string | null;
};

/** Position of a chunk inside its document (1-based page and part). */
export type ChunkPosition = {
  readonly page?: number;
  readonly part: number;
  readonly total: number;
};

/** About 300 words at the chunker's 0.75 words-per-token heuristic. */
export const MIRROR_CHUNK_TARGET_TOKENS = 400;
/** About 30 words of overlap between adjacent mirror chunks. */
export const MIRROR_CHUNK_OVERLAP_TOKENS = 40;

/** Marker every header line starts with. */
export const CHUNK_HEADER_PREFIX = "Document: ";

/** Render the date part of an ISO timestamp; null when unparseable. */
export function formatUploadDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (m) return m[1];
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toISOString().slice(0, 10);
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build the header line for one chunk. Fields whose value is unknown are
 * left out; a chunk with no known provenance still gets
 * `Document: unknown | part i/n` so the line is never empty.
 */
export function buildChunkHeader(
  ctx: DocumentChunkContext,
  pos: ChunkPosition,
): string {
  const parts: string[] = [];
  parts.push(`${CHUNK_HEADER_PREFIX}${clean(ctx.filename) ?? "unknown"}`);
  const date = formatUploadDate(ctx.uploadedAt);
  if (date) parts.push(`uploaded ${date}`);
  const user = clean(ctx.userName);
  const channel = clean(ctx.channelName)?.replace(/^#/, "") ?? null;
  if (user && channel) parts.push(`from ${user} in #${channel}`);
  else if (user) parts.push(`from ${user}`);
  else if (channel) parts.push(`in #${channel}`);
  if (pos.page !== undefined && pos.page > 0) parts.push(`page ${pos.page}`);
  parts.push(`part ${pos.part}/${pos.total}`);
  return parts.join(" | ");
}

/**
 * Start offset of every page inside the engine's concatenated text, which is
 * `pageTexts.join("\n\n").trim()`. Offsets are relative to the trimmed text,
 * so the first page may start at a negative offset when it began with
 * whitespace; `pageForOffset` handles that.
 */
export function pageOffsetsFor(pageTexts: readonly string[]): readonly number[] {
  const joined = pageTexts.join("\n\n");
  const lead = joined.length - joined.trimStart().length;
  const offsets: number[] = [];
  let pos = 0;
  for (const text of pageTexts) {
    offsets.push(pos - lead);
    pos += text.length + 2;
  }
  return Object.freeze(offsets);
}

/** 1-based page that contains `startChar`; undefined when there is no page map. */
export function pageForOffset(
  offsets: readonly number[],
  startChar: number,
): number | undefined {
  if (offsets.length === 0) return undefined;
  let page = 1;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] <= startChar) page = i + 1;
    else break;
  }
  return page;
}

export type ChunkWithContextOptions = {
  readonly targetTokens?: number;
  readonly overlapTokens?: number;
  /**
   * Per-page text as the engine produced it (index 0 = page 1). When given
   * and there is more than one page, each header carries `page <p>` for the
   * page the chunk starts on.
   */
  readonly pageTexts?: readonly string[];
};

/**
 * Chunk `text` with the standard chunker and prepend the contextual header
 * to every chunk's content. `startChar` / `endChar` still describe the body
 * inside the original text (the header is not part of the source text).
 */
export function chunkWithContext(
  text: string,
  ctx: DocumentChunkContext,
  opts: ChunkWithContextOptions = {},
): readonly ChunkInput[] {
  const raw = chunkText(text, opts.targetTokens ?? 500, opts.overlapTokens ?? 50);
  if (raw.length === 0) return raw;
  const pageTexts = opts.pageTexts ?? [];
  const offsets = pageTexts.length > 1 ? pageOffsetsFor(pageTexts) : [];
  const total = raw.length;
  return Object.freeze(
    raw.map((chunk) =>
      Object.freeze({
        ...chunk,
        content: `${buildChunkHeader(ctx, {
          page: offsets.length > 0 ? pageForOffset(offsets, chunk.startChar) : undefined,
          part: chunk.chunkIndex + 1,
          total,
        })}\n${chunk.content}`,
      }),
    ),
  );
}

/**
 * Chunk `text` for the memory mirror: smaller chunks (about 300 words) with
 * the same contextual header. Returned in the shape `crossIngestToMemory`
 * consumes.
 */
export function chunkForMirror(
  text: string,
  ctx: DocumentChunkContext,
  pageTexts?: readonly string[],
): readonly { readonly index: number; readonly content: string }[] {
  const chunks = chunkWithContext(text, ctx, {
    targetTokens: MIRROR_CHUNK_TARGET_TOKENS,
    overlapTokens: MIRROR_CHUNK_OVERLAP_TOKENS,
    pageTexts,
  });
  return Object.freeze(chunks.map((c) => ({ index: c.chunkIndex, content: c.content })));
}

/** Strip a leading contextual header line from stored chunk content. */
export function stripChunkHeader(content: string): string {
  if (!content.startsWith(CHUNK_HEADER_PREFIX)) return content;
  const nl = content.indexOf("\n");
  if (nl === -1) return "";
  return content.slice(nl + 1);
}
