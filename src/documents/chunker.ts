/**
 * Document chunking utilities.
 *
 * Splits text into overlapping chunks sized by approximate token count.
 * Uses word-count heuristic: 1 token ~ 0.75 words.
 */

/** Shape of a chunk before it gets an ID and timestamp in the store. */
export type ChunkInput = {
  readonly content: string;
  readonly chunkIndex: number;
  readonly startChar: number;
  readonly endChar: number;
};

/** Words-per-token ratio used for the token heuristic. */
const WORDS_PER_TOKEN = 0.75;

/**
 * Split text into overlapping chunks of approximately `targetTokens` tokens.
 *
 * Uses a word-count heuristic (1 token ~ 0.75 words) to determine chunk
 * boundaries. Each chunk overlaps the previous by `overlapTokens` tokens.
 *
 * Returns an empty array for empty or whitespace-only input.
 */
export function chunkText(
  text: string,
  targetTokens = 500,
  overlapTokens = 50,
): readonly ChunkInput[] {
  if (!text || !text.trim()) return [];

  // One pass over the text collects every word and its start offset, so
  // chunk boundaries resolve in O(1) instead of rescanning from offset 0 per
  // chunk (WP3: the memory mirror chunks at about 300 words, which doubled
  // the number of boundary lookups on large documents).
  const words: string[] = [];
  const wordStarts: number[] = [];
  const wordRe = /\S+/g;
  for (let m = wordRe.exec(text); m !== null; m = wordRe.exec(text)) {
    words.push(m[0]);
    wordStarts.push(m.index);
  }
  if (words.length === 0) return [];

  const targetWords = Math.max(1, Math.round(targetTokens * WORDS_PER_TOKEN));
  const overlapWords = Math.max(0, Math.round(overlapTokens * WORDS_PER_TOKEN));
  const stepWords = Math.max(1, targetWords - overlapWords);

  const chunks: ChunkInput[] = [];
  let wordStart = 0;
  let chunkIndex = 0;

  while (wordStart < words.length) {
    const wordEnd = Math.min(wordStart + targetWords, words.length);
    const chunkWords = words.slice(wordStart, wordEnd);
    const content = chunkWords.join(" ");

    // startChar: offset of the first word of this chunk in the original text
    const startChar = wordStarts[wordStart];
    // endChar: position after the last character of the last word in this chunk
    const endChar = wordStarts[wordEnd - 1] + words[wordEnd - 1].length;

    chunks.push(Object.freeze({ content, chunkIndex, startChar, endChar }));

    chunkIndex++;
    wordStart += stepWords;

    // If the next step would start past the last chunk boundary, stop
    if (wordStart >= words.length) break;
    // If remaining words fit in the overlap, we already captured them
    if (wordEnd >= words.length) break;
  }

  return Object.freeze(chunks);
}

/**
 * Parse a PDF buffer and chunk the extracted text.
 *
 * Uses pdf-parse to extract text content, then delegates to chunkText.
 */
export async function chunkPdf(
  buffer: Buffer,
  targetTokens = 500,
  overlapTokens = 50,
): Promise<readonly ChunkInput[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return chunkText(result.text, targetTokens, overlapTokens);
  } finally {
    await parser.destroy();
  }
}

/**
 * Rebuild the whitespace-normalized source text from chunks that
 * `chunkText` produced with the same `targetTokens` / `overlapTokens`.
 *
 * Chunk i (i > 0) starts `stepWords` after chunk i-1, so its first
 * `overlapWords` words repeat the tail of the previous chunk; dropping them
 * and joining the rest restores the original word sequence. Chunk contents
 * must be passed in chunk order and must not carry a contextual header
 * (callers strip it with `stripChunkHeader` first).
 */
export function reassembleChunkedText(
  contents: readonly string[],
  targetTokens = 500,
  overlapTokens = 50,
): string {
  const targetWords = Math.max(1, Math.round(targetTokens * WORDS_PER_TOKEN));
  const overlapWords = Math.max(0, Math.round(overlapTokens * WORDS_PER_TOKEN));
  const stepWords = Math.max(1, targetWords - overlapWords);
  const repeated = targetWords - stepWords;
  const words: string[] = [];
  contents.forEach((content, i) => {
    const w = content.split(/\s+/).filter(Boolean);
    if (i === 0) words.push(...w);
    else words.push(...w.slice(repeated));
  });
  return words.join(" ");
}
