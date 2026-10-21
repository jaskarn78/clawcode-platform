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

  const words = text.split(/\s+/).filter(Boolean);
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

    // Find startChar: locate the first word of this chunk in the original text
    const startChar = findWordPosition(text, words, wordStart);
    // endChar: position after the last character of the last word in this chunk
    const lastWordPos = findWordPosition(text, words, wordEnd - 1);
    const endChar = lastWordPos + words[wordEnd - 1].length;

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
 * Find the character position of a word by index in the original text.
 * Walks through whitespace-separated tokens to find the nth word's offset.
 */
function findWordPosition(text: string, words: readonly string[], wordIndex: number): number {
  let pos = 0;
  for (let i = 0; i < wordIndex; i++) {
    // Find the word at position pos
    // Skip leading whitespace
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    // Skip the word itself
    pos += words[i].length;
  }
  // Skip whitespace to reach the target word
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  return pos;
}
