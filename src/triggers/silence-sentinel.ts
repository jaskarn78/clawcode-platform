/**
 * INC-2026-08-14c — scheduled polls narrating their own silence.
 *
 * The shopping agent's price-watch cron says "If nothing hit, end the turn
 * SILENTLY with no output" — but a model cannot end a turn with an empty
 * final message, so it emits "Watchlist is empty - nothing to check. Ending
 * silently per instructions." and the engine's only delivery guard
 * (`response.trim().length > 0`) happily posts the narration to the channel.
 *
 * Fix, both halves at the ONE seam every scheduled turn crosses
 * (TriggerEngine.ingest):
 *   1. CONTRACT — scheduled-source payloads get a suffix giving the model an
 *      achievable silence mechanism: reply with exactly NO_REPORT.
 *   2. SUPPRESSION — before deliveryFn, a sentinel reply (or a short
 *      narrated-silence reply from a model that ignored the contract — the
 *      backstop) is dropped with an info log instead of posted.
 *
 * Scope: scheduler-family sources only (config crons "scheduler",
 * "reminder:<id>", "recurring:<id>"). Event sources (mysql, webhook, inbox,
 * calendar) fire because something happened — their payloads are untouched.
 * The suppression check, by contrast, runs on every delivered response: the
 * sentinel is an explicit opt-out whichever source produced it.
 *
 * Same design family as workflow-summary/result-quality.ts: conservative
 * thresholds, verbatim prod strings as test fixtures.
 */

/** The magic word. Exact-match head of a reply that must not be posted. */
export const SILENCE_SENTINEL = "NO_REPORT";

/**
 * Appended to every scheduler-family payload at dispatch. Phrased as the
 * mechanism for the "end silently" intent schedule prompts already express,
 * because an empty reply is not something a model can produce.
 */
export const SCHEDULED_SILENCE_CONTRACT =
  "\n\nSILENCE CONTRACT: this is a scheduled check; your final message is " +
  "auto-posted to the agent's channel. If there is nothing to report this " +
  "run, reply with exactly NO_REPORT and nothing else — that reply is " +
  "suppressed and never posted (this is the ONLY way to end silently; an " +
  "empty reply is impossible, and any other wording WILL be posted). If " +
  "there IS something to report, post it normally and never include " +
  "NO_REPORT.";

/** Scheduler-family source ids (see scheduler-source.ts sourceId builders). */
export function isScheduledSourceId(sourceId: string): boolean {
  return (
    sourceId === "scheduler" ||
    sourceId.startsWith("reminder:") ||
    sourceId.startsWith("recurring:")
  );
}

/** Sentinel replies may carry a short trailing annotation ("NO_REPORT —
 *  watchlist empty") without losing suppression; anything longer is treated
 *  as a real report that merely leads with the token. */
const SENTINEL_MAX_CHARS = 120;

/** Backstop only fires on short replies — a real report that happens to say
 *  "no changes" mid-text must never be swallowed. The observed prod
 *  narration was 74 chars. */
const NARRATED_SILENCE_MAX_CHARS = 200;

const NARRATED_SILENCE_PATTERNS: readonly RegExp[] = [
  /\bnothing (new )?to (report|check|post|track|update)\b/i,
  /\bno (changes?|updates?|hits?|new activity|state changes?|price (changes?|drops?))\b/i,
  /\bend(ing)? (the turn )?silently\b/i,
  /\ball (quiet|clear)\b/i,
];

/**
 * 999.174 — shapes that make a short reply a real alert, which the backstop
 * must never swallow even when it ends with a courtesy "no changes on others"
 * ("AirPods $179→$149. No changes on others." matched the backstop and was
 * dropped as silence). A price MOVE, not a quoted price: "No price drops —
 * Terra holding at $279.94" is still narration. A shape preceded by a negator
 * ("Nothing hit your target", "still not back in stock") is narration too.
 */
const ALERT_SHAPES: readonly RegExp[] = [
  /\$\s?\d[\d,.]*\s*(?:→|->|=>|➜|to)\s*\$\s?\d/gi,
  /\b(?:dropped|fell|down|cut|lowered|reduced|slashed)\b[^.;\n]{0,15}\$\s?\d/gi,
  /\bwas\s+\$\s?\d[^\n]{0,40}\bnow\b/gi,
  /\bprice drop(?:ped)?\b/gi,
  /\b\d{1,2}% (?:off|drop|lower|cheaper)\b|\bdropped \d{1,2}%/gi,
  /\b(?:all-time low|lowest (?:price|in \d+ days))\b/gi,
  /\b(?:back in stock|in stock again|restocked|(?:hit|under|below) (?:your |the )?target)\b/gi,
];

/** A negator shortly before a shape turns it into narration. */
const NEGATED_BEFORE = /\b(?:no|not|nothing|never|none|isn't|wasn't|didn't|hasn't|haven't|aren't)\b[^.;!?\n]{0,25}$/i;

function hasAlertShape(text: string): boolean {
  for (const shape of ALERT_SHAPES) {
    for (const m of text.matchAll(shape)) {
      if (!NEGATED_BEFORE.test(text.slice(Math.max(0, m.index - 40), m.index))) return true;
    }
  }
  return false;
}

/**
 * True when a dispatched response should be suppressed instead of posted.
 * Layer 1: the explicit sentinel (contract-following model). Layer 2: the
 * narrated-silence backstop (short reply matching the observed failure
 * shapes, unless it carries an alert shape). Pure; conservative by
 * construction via the length caps.
 */
export function isSilentTickResponse(response: string): boolean {
  const trimmed = response.trim();
  if (trimmed.length === 0) return true;

  // Tolerate markdown emphasis around the token (**NO_REPORT**, `NO_REPORT`).
  const unwrapped = trimmed.replace(/^[*_`\s]+/, "").replace(/[*_`.\s]+$/, "");
  if (
    unwrapped.startsWith(SILENCE_SENTINEL) &&
    trimmed.length <= SENTINEL_MAX_CHARS
  ) {
    return true;
  }

  if (trimmed.length > NARRATED_SILENCE_MAX_CHARS) return false;
  if (hasAlertShape(trimmed)) return false;
  return NARRATED_SILENCE_PATTERNS.some((p) => p.test(trimmed));
}
