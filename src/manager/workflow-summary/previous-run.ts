/**
 * Phase 999.129 — recurring workflows report what changed.
 *
 * A workflow launched from a named template (999.128) is usually recurring:
 * the weekly scan, the monthly pack. Each run used to be written as if it
 * were the first; the reader had to diff two PDFs by eye. Now every
 * template run persists a small `run.json` (bottom line, findings, next
 * steps, changes) next to its artifacts, and the next run with the same
 * template + params reads the latest one, hands it to the editor as
 * "PREVIOUS RUN", and leads with a "Since last run" section. The completion
 * post carries the same deltas above the key findings.
 *
 * Pure: the daemon supplies the file listing/reading; the orchestrator
 * supplies the current run's synthesis.
 */

export const RUN_RECORD_FILE = "run.json";
const MAX_LIST = 8;
const MAX_ITEM_CHARS = 400;

export interface WorkflowOrigin {
  readonly template: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface RunRecord {
  readonly workflowId: string;
  readonly template: string;
  readonly params: Readonly<Record<string, string>>;
  /** Epoch ms. */
  readonly finishedAt: number;
  readonly status: string;
  readonly bluf?: string;
  readonly keyFindings: readonly string[];
  readonly nextSteps: readonly string[];
  readonly changes: readonly string[];
}

export type PreviousRun = RunRecord;

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().slice(0, MAX_ITEM_CHARS))
        .filter((x) => x.length > 0)
        .slice(0, MAX_LIST)
    : [];

/** The JSON written at finalize. */
export function runRecordJson(record: RunRecord): string {
  return JSON.stringify(record, null, 2);
}

/** Parse a `run.json`; null when it is not a run record. */
export function parseRunRecord(json: string): RunRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.workflowId !== "string" || typeof r.template !== "string") return null;
  if (typeof r.finishedAt !== "number" || !Number.isFinite(r.finishedAt)) return null;
  const params: Record<string, string> = {};
  if (r.params && typeof r.params === "object" && !Array.isArray(r.params)) {
    for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
      if (typeof v === "string") params[k] = v;
    }
  }
  return Object.freeze({
    workflowId: r.workflowId,
    template: r.template,
    params: Object.freeze(params),
    finishedAt: r.finishedAt,
    status: typeof r.status === "string" ? r.status : "done",
    ...(typeof r.bluf === "string" && r.bluf.trim() ? { bluf: r.bluf.trim().slice(0, 2000) } : {}),
    keyFindings: Object.freeze(strList(r.keyFindings)),
    nextSteps: Object.freeze(strList(r.nextSteps)),
    changes: Object.freeze(strList(r.changes)),
  });
}

export function sameParams(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/**
 * The most recent completed run of the same template + params, excluding the
 * current workflow. Null when there is none.
 */
export function pickPreviousRun(
  records: readonly RunRecord[],
  origin: WorkflowOrigin,
  currentWorkflowId: string,
): PreviousRun | null {
  let best: RunRecord | null = null;
  for (const r of records) {
    if (r.workflowId === currentWorkflowId) continue;
    if (r.template !== origin.template || !sameParams(r.params, origin.params)) continue;
    if (r.status !== "done") continue;
    if (!best || r.finishedAt > best.finishedAt) best = r;
  }
  return best;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The section appended to the editor prompt. */
export function previousRunPromptSection(previous: PreviousRun): string {
  const params = Object.entries(previous.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return [
    `PREVIOUS RUN. This is a recurring workflow (template "${previous.template}"${params ? `, ${params}` : ""}).`,
    `The previous run finished on ${fmtDate(previous.finishedAt)}. What it concluded:`,
    ...(previous.bluf ? [`- Bottom line then: ${previous.bluf}`] : []),
    ...previous.keyFindings.map((f) => `- Finding then: ${f}`),
    ...(previous.nextSteps.length > 0 ? [`- Next steps then: ${previous.nextSteps.join(" | ")}`] : []),
    "",
    "Hard rules for THIS report:",
    "- LEAD with what changed: open the body with a section titled",
    "  \"Since last run\" (2 to 6 one-sentence items, each with its figure, or",
    `  a single line \"No material change since ${fmtDate(previous.finishedAt)}\").`,
    "- In the ```findings block add a `changes:` list with the same items",
    "  (2 to 5, or one \"No material change\" item).",
    "- Do not repeat a previous finding as new unless it has changed; say",
    "  \"unchanged\" for the ones that still hold.",
  ].join("\n");
}
