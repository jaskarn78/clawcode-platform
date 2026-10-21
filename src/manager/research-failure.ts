/**
 * Phase 999.173 polish — why a researcher ended without finishing, as a short
 * human cause. Never the raw error: the notification summary can carry HTTP
 * codes, request ids and error types; only the cause and a reset time reach
 * Discord.
 *
 * First prod run (fin-client, 2026-09-25 13:58 PT): all three researchers
 * ended `failed` with "Agent terminated early due to an API error: You've hit
 * your session limit · resets 5:30pm (America/Los_Angeles) (error type
 * rate_limit, HTTP 429 …)".
 */

export type FailureCode = "usage-limit" | "api-error" | "timeout" | "stopped" | "cap" | "failed";

export type FailureReason = Readonly<{
  code: FailureCode;
  /** One short phrase for the card, e.g. "usage limit reached, resets 5:30 PM PT". */
  text: string;
  /** Normalised reset time ("5:30 PM PT") when the error named one. */
  resetsAt?: string;
}>;

/** Most significant first: the card shows the top one once. */
const PRIORITY: readonly FailureCode[] = ["usage-limit", "api-error", "timeout", "cap", "stopped", "failed"];

const TZ_ABBR: Readonly<Record<string, string>> = Object.freeze({
  "America/Los_Angeles": "PT",
  "America/Vancouver": "PT",
  "America/Denver": "MT",
  "America/Phoenix": "MT",
  "America/Chicago": "CT",
  "America/New_York": "ET",
  "America/Toronto": "ET",
  UTC: "UTC",
  "Etc/UTC": "UTC",
});

const USAGE_LIMIT_RE = /hit your (?:session |usage |weekly |daily |5[- ]hour )?limit|usage limit|session limit|rate[_ ]limit|\b429\b/i;
const API_ERROR_RE = /api error|overloaded|internal server error|\bhttp 5\d\d\b|\b5\d\d\b.*error|api_error|connection (?:reset|refused)|timed out talking/i;
const RESET_RE = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*(?:\(([^)]+)\))?/i;

/** "5:30pm (America/Los_Angeles)" → "5:30 PM PT"; undefined when the text names no time. */
export function parseResetTime(text: string): string | undefined {
  const m = RESET_RE.exec(text);
  if (m === null) return undefined;
  const hour = Number(m[1]);
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return undefined;
  const minutes = m[2] ?? "00";
  const meridiem = m[3]!.toUpperCase() === "P" ? "PM" : "AM";
  const tz = m[4]?.trim();
  const abbr = tz !== undefined ? (TZ_ABBR[tz] ?? (/^[A-Z]{2,4}$/.test(tz) ? tz : undefined)) : undefined;
  return `${hour}:${minutes} ${meridiem}${abbr ? ` ${abbr}` : ""}`;
}

/** Classify one ended researcher from its notification status + summary. */
export function classifyFailure(status: string, summary: unknown): FailureReason {
  const text = typeof summary === "string" ? summary : "";
  if (status === "stopped") return { code: "stopped", text: "stopped by user" };
  if (USAGE_LIMIT_RE.test(text)) {
    const resetsAt = parseResetTime(text);
    return resetsAt !== undefined
      ? { code: "usage-limit", text: `usage limit reached, resets ${resetsAt}`, resetsAt }
      : { code: "usage-limit", text: "usage limit reached" };
  }
  if (API_ERROR_RE.test(text)) return { code: "api-error", text: "API error" };
  return { code: "failed", text: "failed" };
}

export const TIMEOUT_REASON: FailureReason = Object.freeze({ code: "timeout", text: "timed out" });
export const CAP_REASON: FailureReason = Object.freeze({ code: "cap", text: "over the research limit" });

/** The single most significant reason among several (null when none). */
export function topReason(reasons: readonly (FailureReason | null | undefined)[]): FailureReason | null {
  let best: FailureReason | null = null;
  for (const r of reasons) {
    if (!r) continue;
    if (best === null || PRIORITY.indexOf(r.code) < PRIORITY.indexOf(best.code)) best = r;
  }
  return best;
}

/**
 * The daemon's own reply when EVERY researcher failed and the parent could not
 * answer (it is usually rate-limited too). Null when no notice is warranted
 * (the user stopped them, or the cause is unknown).
 */
export function failureNotice(reason: FailureReason | null, savedTo?: string): string | null {
  if (reason === null) return null;
  const saved = savedTo ? ` Partial notes are saved in ${savedTo}.` : "";
  switch (reason.code) {
    case "usage-limit":
      return reason.resetsAt
        ? `Research couldn't run: the Claude usage limit is reached until ${reason.resetsAt}. Ask again after that.${saved}`
        : `Research couldn't run: the Claude usage limit is reached. Ask again later.${saved}`;
    case "api-error":
      return `Research couldn't finish: the researchers hit an API error. Ask again in a few minutes.${saved}`;
    case "timeout":
      return `Research timed out before any researcher finished.${saved}`;
    default:
      return null;
  }
}
