/**
 * Phase 135.1 Phase 4 — streaming sentence aggregator.
 *
 * dispatchStream delivers the agent's response as a growing ACCUMULATED string
 * (turn-dispatcher.ts:974 — each onChunk carries the full text so far). To speak
 * before the whole response is generated (the single biggest latency win), we
 * diff that accumulated text and emit COMPLETE sentences the moment each one
 * closes, so the first sentence goes to TTS while the model is still writing the
 * rest.
 *
 * Boundary rules (tuned for speech, not prose):
 *   - split on `.`, `!`, `?` only when followed by whitespace (so "3.14" and a
 *     token still being streamed never split), or on a newline;
 *   - guard common abbreviations and initials ("Dr.", "e.g.", "J.") so they
 *     don't cut a sentence short;
 *   - the FIRST sentence uses a smaller minimum length (start audio ASAP); later
 *     sentences use a larger minimum so we don't emit choppy fragments;
 *   - `flush()` emits whatever remains at stream end.
 *
 * Pure + synchronous — no I/O — so it is exhaustively unit-testable and reused
 * by tts-ws.ts to feed the ElevenLabs multi-context WebSocket.
 */

const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "vs", "etc", "no", "fig",
  "approx", "dept", "gen", "col", "gov", "sen", "rep", "inc", "ltd", "co",
  "eg", "ie", "al", "vol", "pp",
]);

export type SentenceAggregatorOptions = {
  /** Minimum length for the FIRST emitted sentence (start audio fast). */
  readonly firstSentenceChars?: number;
  /** Minimum length for subsequent sentences (avoid choppy fragments). */
  readonly minSentenceChars?: number;
};

export class SentenceAggregator {
  private emittedLen = 0;
  private firstEmitted = false;
  private readonly firstMin: number;
  private readonly restMin: number;

  constructor(opts: SentenceAggregatorOptions = {}) {
    this.firstMin = opts.firstSentenceChars ?? 6;
    this.restMin = opts.minSentenceChars ?? 12;
  }

  /**
   * Feed the latest accumulated response text; returns any newly-complete
   * sentences (trimmed, in order). Idempotent w.r.t. already-emitted text.
   */
  push(accumulated: string): string[] {
    const out: string[] = [];
    let searchFrom = this.emittedLen;
    // Guard against pathological inputs where emittedLen ran ahead of a
    // shorter accumulated (shouldn't happen — accumulated only grows).
    if (this.emittedLen > accumulated.length) {
      this.emittedLen = accumulated.length;
      return out;
    }
    for (;;) {
      const boundary = this.findSentenceEnd(accumulated, searchFrom);
      if (boundary < 0) break;
      const sentence = accumulated.slice(this.emittedLen, boundary + 1).trim();
      const min = this.firstEmitted ? this.restMin : this.firstMin;
      if (sentence.length >= min) {
        out.push(sentence);
        this.emittedLen = boundary + 1;
        this.firstEmitted = true;
        searchFrom = this.emittedLen;
      } else {
        // Too short to stand alone — keep the text buffered and look for a
        // later boundary that makes a long-enough sentence.
        searchFrom = boundary + 1;
      }
    }
    return out;
  }

  /**
   * Emit any remaining un-emitted text as the final sentence (call once when
   * the LLM stream ends). Returns null when nothing meaningful remains.
   */
  flush(accumulated: string): string | null {
    if (this.emittedLen >= accumulated.length) return null;
    const tail = accumulated.slice(this.emittedLen).trim();
    this.emittedLen = accumulated.length;
    this.firstEmitted = true;
    return tail.length > 0 ? tail : null;
  }

  /** Index of a real sentence-ending char at/after `from`, or -1. */
  private findSentenceEnd(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (c === "\n") return i;
      if (c === "." || c === "!" || c === "?") {
        const next = text[i + 1];
        // End-of-string mid-stream is ambiguous (more may arrive, e.g. "3." →
        // "3.14") — wait for the next char rather than splitting speculatively.
        if (next === undefined) return -1;
        if (!/\s/.test(next)) continue; // "3.14", "u.s.a" mid-token → not a break
        if (this.isAbbreviation(text, i)) continue;
        return i;
      }
    }
    return -1;
  }

  /** Does the token ending at `dotIndex` look like an abbreviation/initial? */
  private isAbbreviation(text: string, dotIndex: number): boolean {
    let j = dotIndex - 1;
    while (j >= 0 && /[A-Za-z0-9]/.test(text[j] as string)) j--;
    const token = text.slice(j + 1, dotIndex).toLowerCase();
    if (token.length === 0) return false;
    if (ABBREVIATIONS.has(token)) return true;
    // Single letter before the dot = an initial ("J." in "J. Doe", the
    // internal dots of "e.g.").
    if (token.length === 1 && /[a-z]/.test(token)) return true;
    return false;
  }
}
