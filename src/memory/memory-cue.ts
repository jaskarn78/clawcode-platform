/**
 * Phase 90 MEM-05 — "remember this" cue detection + one-shot memory file write.
 *
 * Closes the v2.1 crisis where a Discord user saying "remember this: X"
 * was silently ignored — the cue never reached disk, the scanner never
 * indexed anything, and on the next session boot the agent had no recall
 * of the standing rule the user had just asked it to hold.
 *
 * D-30: case-insensitive regex on user turn text matching the cue
 * vocabulary: remember / keep this (in long-term) memory / standing rule /
 * don't forget / note for later / save to memory.
 *
 * D-31: on cue match, write {workspace}/memory/YYYY-MM-DD-remember-<nanoid4>.md
 * with frontmatter (type=cue, captured_at, cue, optional discord_link) and
 * the containing-paragraph context (first 3 sentences around the cue).
 *
 * D-32: caller (TurnDispatcher post-turn hook) fires a ✅ reaction on the
 * originating Discord message — kept OUT of this module so memory-cue.ts
 * stays pure and headless-friendly (OpenAI-endpoint turns never reach
 * Discord; the reaction is opt-in via the DispatcherDeps.discordReact slot).
 *
 * Wave 2 scanner auto-ingests the new dated files within ≤1s
 * (awaitWriteFinish 300ms + chokidar handler); downstream retrieval picks
 * up the standing rule on the next turn with zero extra wiring.
 */

import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import { atomicWriteFile } from "./memory-flush.js";

/**
 * D-30 cue regex (verbatim). Core alternation:
 *   - remember[ this]
 *   - keep this [in] [long[- ]term] memory
 *   - standing rule
 *   - don['t] forget
 *   - note for later
 *   - save to memory
 *
 * Case-insensitive flag applied at the regex level so callers need not
 * pre-lowercase.
 */
export const MEMORY_CUE_REGEX =
  /(remember( this)?|keep this (in )?(long[- ]?term )?memory|standing rule|don'?t forget|note for later|save to memory)/i;

/** Result shape for detectCue — keeps the boolean and the match text distinct. */
export type CueDetection = Readonly<{
  match: boolean;
  captured: string | null;
}>;

/**
 * Test the cue regex against arbitrary text (the user turn content, or
 * a subset like the last 500 chars). When the regex matches, `captured`
 * contains the matched substring (the cue phrase itself) for persistence
 * in the frontmatter.
 */
export function detectCue(text: string): CueDetection {
  const m = MEMORY_CUE_REGEX.exec(text);
  return Object.freeze({
    match: m !== null,
    captured: m?.[0] ?? null,
  });
}

/**
 * D-31 context extractor — returns the containing paragraph (up to 3
 * sentences) around the first cue-matching sentence. When no sentence
 * contains a cue (defensive fallback for callers that called detectCue
 * separately and got a match but pass odd text here), returns the first
 * 500 chars so we never write an empty body.
 */
export function extractCueContext(
  fullText: string,
  maxSentences: number = 3,
): string {
  // Split on sentence-ending punctuation (period/question/exclamation) +
  // at least one whitespace char. `(?<=[.?!])` preserves the punctuation
  // on the preceding sentence.
  const parts = fullText.split(/(?<=[.?!])\s+/);
  const idx = parts.findIndex((p) => MEMORY_CUE_REGEX.test(p));
  if (idx === -1) return fullText.slice(0, 500);
  const start = Math.max(0, idx - 1);
  const slice = parts.slice(start, start + maxSentences).join(" ").trim();
  return slice;
}

/**
 * D-31 write — persists the cue as a standalone memory file. Filename
 * includes a nanoid(4) suffix so two cues in the same minute (possible
 * when the user edits-and-resends or two agents watch one channel) stay
 * distinct on disk.
 *
 * Frontmatter fields:
 *   - type: "cue" (disambiguates from subagent-return and session flushes)
 *   - captured_at: ISO timestamp of the turn (not wall-clock)
 *   - cue: JSON-stringified cue phrase (handles quotes/colons cleanly)
 *   - discord_link: original Discord message link (optional — omitted when
 *     the origin is OpenAI endpoint / task scheduler / scheduled cron)
 */
export async function writeCueMemory(
  args: Readonly<{
    workspacePath: string;
    cue: string;
    context: string;
    turnIso: string;
    messageLink?: string;
    log: Logger;
  }>,
): Promise<string> {
  const date = args.turnIso.slice(0, 10); // YYYY-MM-DD
  const suffix = nanoid(4);
  const path = join(
    args.workspacePath,
    "memory",
    `${date}-remember-${suffix}.md`,
  );
  const body = `---
type: cue
captured_at: ${args.turnIso}
cue: ${JSON.stringify(args.cue)}
${args.messageLink ? `discord_link: ${args.messageLink}\n` : ""}---

## Standing note

${args.context}
`;
  await atomicWriteFile(path, body);
  args.log.info(
    { path, cue: args.cue },
    "cue memory written",
  );
  return path;
}
