/**
 * The editorial pass over a finished workflow: one bounded model call that
 * turns N raw worker results into a title, a bottom line, key findings and a
 * condensed retelling per step.
 *
 * WHY A SEPARATE CALL AND NOT A WORKER. A workflow worker is a full agent
 * session with a thread binding, a reaper contract and a 4h ceiling. This needs
 * none of that - it is one prompt in, one JSON object out. `callModelDirect`
 * (the same bridge path the session summarizer uses) gives exactly that, on the
 * subscription entitlement rather than the API key.
 *
 * EVERY FAILURE RETURNS null. Malformed JSON, an empty response, a timeout, a
 * bridge error: all mean "publish the deterministic composition instead". The
 * report is never blocked on this succeeding, so there is nothing to retry and
 * nothing to escalate.
 */

import type { Logger } from "pino";
import type { ReportDoc, ReportSynthesis } from "../../reports/types.js";

/**
 * Per-step input cap. The incident run was 90k chars across four steps; sending
 * all of it is affordable but slow, and the marginal editorial value of a
 * step's 12,000th character is nil.
 */
export const MAX_STEP_CHARS = 12_000;
/** Total input cap across all steps, so a 30-step workflow cannot blow the window. */
export const MAX_TOTAL_CHARS = 60_000;

const SYSTEM_PROMPT = `You are the editor of an institutional research desk. You are given the raw
outputs of a multi-step research workflow and you produce the editorial layer for a printed
brief: a title, a standfirst, a bottom line, key findings, a condensed retelling of each step,
risks, and next steps.

Rules:
- Report only what the source material supports. Never introduce a figure, entity or claim that
  is not in the inputs. If the inputs disagree, say so rather than picking one.
- A step that failed is a finding: name it and say what is now unknown because of it.
- Write like a research note, not like a chat reply. No preamble, no "I have analysed", no
  offers of further help.
- Preserve concrete figures verbatim. They are the point of the document.
- Markdown is allowed in the text fields: bold, italic, lists, tables, inline code.

Respond with a SINGLE JSON object and nothing else - no prose before or after, no code fence.
Schema:
{
  "title": string,              // <= 60 chars, names the subject, not the workflow
  "dek": string,                // one sentence, <= 200 chars
  "bluf": string,               // the bottom line: 2-4 sentences a reader can stop after
  "keyFindings": string[],      // 3-6 items, each one sentence, figures included
  "perStep": { "<stepId>": string },  // condensed markdown per step, <= 1500 chars each
  "risks": string[],            // 0-4 items
  "nextSteps": string[]         // 0-4 items
}`;

/** Builds the user prompt from the document, applying the input caps. */
export function buildSynthesisPrompt(doc: ReportDoc): string {
  const perStepBudget = Math.max(
    1_000,
    Math.min(MAX_STEP_CHARS, Math.floor(MAX_TOTAL_CHARS / Math.max(1, doc.steps.length))),
  );
  const sections = doc.steps.map((s) => {
    const head = `### step: ${s.stepId} (status: ${s.status})`;
    if (s.status !== "done") {
      return `${head}\nThis step did not complete. Error: ${s.error ?? "unknown"}`;
    }
    const text = s.result ?? "";
    const body =
      text.length > perStepBudget
        ? `${text.slice(0, perStepBudget)}\n[...truncated for the editing pass; the full text is published unabridged in the complete record]`
        : text;
    return `${head}\n${body}`;
  });
  return [
    `Workflow ${doc.workflowId}, run by the "${doc.agentName}" agent.`,
    `${doc.steps.filter((s) => s.status === "done").length} of ${doc.steps.length} steps completed.`,
    `The stepIds you must use as keys in "perStep" are: ${doc.steps.map((s) => s.stepId).join(", ")}`,
    "",
    ...sections,
  ].join("\n\n");
}

/** Extracts the JSON object from a response that may still carry a fence or prose. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Last resort: the outermost brace pair. Models occasionally prepend a line
    // of commentary despite the instruction, and losing the whole edit over
    // that would be a poor trade.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t.slice(0, max);
};

const strArray = (v: unknown, maxItems: number, maxChars: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((x) => str(x, maxChars))
    .filter((x): x is string => x !== undefined)
    .slice(0, maxItems);
  return out.length > 0 ? out : undefined;
};

/**
 * Validates and clamps a parsed response into a `ReportSynthesis`.
 *
 * Deliberately field-by-field rather than all-or-nothing: a response with a
 * good bottom line and a malformed `perStep` should still contribute its bottom
 * line. Unknown stepIds are dropped so a hallucinated key cannot create a
 * section for a step that never ran.
 */
export function coerceSynthesis(raw: unknown, knownStepIds: readonly string[]): ReportSynthesis | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const perStep: Record<string, string> = {};
  if (o.perStep !== null && typeof o.perStep === "object") {
    for (const [k, v] of Object.entries(o.perStep as Record<string, unknown>)) {
      if (!knownStepIds.includes(k)) continue;
      const text = str(v, 4_000);
      if (text) perStep[k] = text;
    }
  }

  const out: ReportSynthesis = {
    ...(str(o.title, 120) !== undefined ? { title: str(o.title, 120)! } : {}),
    ...(str(o.dek, 400) !== undefined ? { dek: str(o.dek, 400)! } : {}),
    ...(str(o.bluf, 2_000) !== undefined ? { bluf: str(o.bluf, 2_000)! } : {}),
    ...(strArray(o.keyFindings, 8, 600) !== undefined
      ? { keyFindings: strArray(o.keyFindings, 8, 600)! }
      : {}),
    ...(Object.keys(perStep).length > 0 ? { perStep } : {}),
    ...(strArray(o.risks, 6, 600) !== undefined ? { risks: strArray(o.risks, 6, 600)! } : {}),
    ...(strArray(o.nextSteps, 6, 600) !== undefined
      ? { nextSteps: strArray(o.nextSteps, 6, 600)! }
      : {}),
  };
  // Nothing usable survived validation - say so rather than returning an empty
  // object, which would read downstream as "synthesis succeeded".
  return Object.keys(out).length > 0 ? out : null;
}

export interface SynthesizeDeps {
  readonly logger: Logger;
  /** One-shot model call. Production: `callModelDirect(..., "sonnet", ...)`. */
  readonly callModel: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

/** Runs the editorial pass. Returns null on any failure. */
export async function synthesizeReport(
  doc: ReportDoc,
  deps: SynthesizeDeps,
): Promise<ReportSynthesis | null> {
  try {
    const text = await deps.callModel(SYSTEM_PROMPT, buildSynthesisPrompt(doc));
    // callModelDirect's failure contract is an EMPTY STRING, not a throw.
    if (typeof text !== "string" || text.trim() === "") {
      deps.logger.warn(
        { component: "workflow-synthesis", workflowId: doc.workflowId },
        "workflow report synthesis returned nothing - publishing unedited",
      );
      return null;
    }
    const result = coerceSynthesis(
      extractJsonObject(text),
      doc.steps.map((s) => s.stepId),
    );
    if (!result) {
      deps.logger.warn(
        {
          component: "workflow-synthesis",
          workflowId: doc.workflowId,
          responseChars: text.length,
        },
        "workflow report synthesis was unparseable - publishing unedited",
      );
    }
    return result;
  } catch (err: unknown) {
    deps.logger.warn(
      {
        component: "workflow-synthesis",
        workflowId: doc.workflowId,
        err: err instanceof Error ? err.message : String(err),
      },
      "workflow report synthesis threw - publishing unedited",
    );
    return null;
  }
}
