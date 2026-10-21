/**
 * Goal-completion judge — the independent evaluator behind the goal loop.
 * Mirrors Claude Code `/goal`'s judge: a fast model (Haiku by default) decides,
 * after each turn, whether the natural-language CONDITION is satisfied by what
 * the agent surfaced this turn. It does NOT run tools or read files — it only
 * judges the agent's reply text (so the condition must be phrased so the reply
 * can demonstrate it).
 *
 * PURE except for the injected `callModel`, so prompt-building and the
 * (failure-tolerant) verdict parser are unit-testable without a live model.
 * Phase 2 wires `callModel` to `callHaikuDirect` / `callModelDirect`.
 */
import type { GoalEvaluateInput, GoalVerdict } from "./goal-loop.js";

/** A one-shot text model call: (systemPrompt, userPrompt) → raw model text. */
export type JudgeModelCall = (systemPrompt: string, userPrompt: string) => Promise<string>;

const JUDGE_SYSTEM_PROMPT =
  "You are a strict goal-completion judge for an autonomous coding agent. After " +
  "each turn you decide whether the user's CONDITION has been satisfied, based " +
  "ONLY on the agent's latest reply text — you cannot run commands or read " +
  "files, so treat unverified claims skeptically: if the condition requires " +
  "evidence (tests passing, a build succeeding, a file existing) and the reply " +
  "does not actually SHOW that evidence, the condition is NOT met. The condition " +
  "may include natural-language stop clauses such as 'or stop after 20 turns' or " +
  "'or stop after 2 hours' — honor them using the provided turn number and " +
  "elapsed time, and if such a clause fires, report met=true with a reason that " +
  "says the stop clause triggered.\n\n" +
  'Respond with ONLY a JSON object on a single line: {"met": <true|false>, ' +
  '"reason": "<one short sentence>"}. No prose, no code fences.';

/** Trim history to the last few iterations to keep the judge prompt bounded. */
function recentHistoryLines(input: GoalEvaluateInput, max = 3): string {
  const recent = input.history.slice(-max);
  if (recent.length === 0) return "(this is the first turn)";
  return recent
    .map((h) => `  turn ${h.turn}: judge said ${h.verdict.met ? "MET" : "not met"} — ${h.verdict.reason}`)
    .join("\n");
}

/** Build the judge's user prompt from the evaluate input. */
export function buildJudgeUserPrompt(input: GoalEvaluateInput): string {
  const elapsedMin = Math.round(input.elapsedMs / 60_000);
  return (
    `CONDITION: ${input.condition}\n\n` +
    `CURRENT TURN: ${input.turn}\n` +
    `ELAPSED: ~${elapsedMin} minute(s)\n\n` +
    `PRIOR TURNS:\n${recentHistoryLines(input)}\n\n` +
    `THE AGENT'S REPLY THIS TURN:\n"""\n${input.latestReply || "(the agent produced no reply this turn)"}\n"""\n\n` +
    `Is the CONDITION now met? Respond with the JSON object only.`
  );
}

/**
 * Parse a judge verdict from raw model text. Tolerant of code fences, leading
 * prose, and trailing junk — extracts the first JSON object and coerces the
 * fields. On ANY failure returns met=false with a diagnostic reason rather than
 * throwing (a parse failure must never be read as "goal met", and must never
 * crash the loop).
 */
export function parseVerdict(raw: string): GoalVerdict {
  const text = (raw ?? "").trim();
  if (text === "") {
    return { met: false, reason: "judge returned no output (treated as not met)" };
  }
  // Extract the first balanced-looking {...} (greedy to the last brace handles
  // a reason that itself contains no braces; judge is instructed to single-line).
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return {
      met: false,
      reason: `could not parse judge verdict (no JSON object): ${text.slice(0, 120)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch {
    return {
      met: false,
      reason: `could not parse judge verdict (invalid JSON): ${text.slice(0, 120)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { met: false, reason: "judge verdict was not an object (treated as not met)" };
  }
  const obj = parsed as Record<string, unknown>;
  const met = coerceMet(obj.met);
  const reason =
    typeof obj.reason === "string" && obj.reason.trim() !== ""
      ? obj.reason.trim()
      : met
        ? "goal met"
        : "not yet met";
  return { met, reason };
}

/** Coerce a JSON `met` field to a strict boolean (default false). */
function coerceMet(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "met";
  }
  return false;
}

/**
 * Run the judge for one turn. Never throws — a model-call failure resolves to
 * met=false (the loop keeps going; the runaway backstop bounds repeated
 * failures).
 */
export async function evaluateGoal(
  input: GoalEvaluateInput,
  callModel: JudgeModelCall,
): Promise<GoalVerdict> {
  let raw: string;
  try {
    raw = await callModel(JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt(input));
  } catch (err) {
    return {
      met: false,
      reason: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseVerdict(raw);
}

export { JUDGE_SYSTEM_PROMPT };
