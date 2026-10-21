/**
 * Phase 142 P3 — optimizer skill actions + proposer.
 *
 * The optimizer's "step": given the agent's current skills + which eval tasks
 * failed (with a representative failing response), an LLM proposes ≤N skill
 * actions — add / revise / remove (skills are AutoGen's "functions").
 *
 * FAIL-SAFE, like the judge (judge.ts): any malformation — LLM error, JSON that
 * doesn't parse, wrong shape — yields ZERO actions (a no-op the loop reports as
 * "no change"), NEVER a half-parsed or fabricated action. The cap is enforced by
 * TRUNCATION, not by trusting the model. Every action is validated before it can
 * reach the candidate set: a revise/remove of a skill that isn't in the current
 * set or isn't in `eligibleSkills` is dropped; an add/revise with empty content
 * is dropped. So a hallucinated action cannot mutate anything (and operator
 * review is still the final gate — P4).
 */
import { z } from "zod";
import type { EvalTask } from "./eval-set.js";
import type { EvalScore } from "./types.js";
import type { SkillOverride } from "./candidate-skills.js";

export type OptimizerAction =
  | { readonly kind: "add"; readonly name: string; readonly skillMd: string; readonly rationale: string }
  | { readonly kind: "revise"; readonly name: string; readonly skillMd: string; readonly rationale: string }
  | { readonly kind: "remove"; readonly name: string; readonly rationale: string };

/** Injected LLM seam: (systemPrompt, userPrompt) => raw model text. */
export type ProposerLlm = (systemPrompt: string, userPrompt: string) => Promise<string>;

const PROPOSER_SYSTEM = [
  "You are an agent-skill optimizer. You improve an AI agent's SKILL set so it",
  "passes more of its evaluation tasks.",
  "You are given the agent's current skill names and the eval tasks it FAILED",
  "(each with its success criterion and a representative failing response).",
  "Propose the SMALLEST set of concrete skill changes that would fix the observed",
  "failures. Output ONLY a JSON array of action objects, nothing else:",
  '[{"kind":"add"|"revise"|"remove","name":string,"skillMd"?:string,"rationale":string}]',
  "Rules: for add/revise, skillMd is the FULL new SKILL.md file content.",
  "Only revise or remove a skill that already exists. Prefer revise over remove.",
  "If no change would clearly help, output an empty array [].",
].join(" ");

const FAILING_EXAMPLE_PROMPT_MAX = 400;

/** Build the (system, user) proposer prompt from the agent's current skills + eval failures. */
export function buildProposalPrompt(args: {
  readonly currentSkills: readonly string[];
  readonly evalScore: EvalScore;
  readonly tasks: readonly EvalTask[];
  readonly maxActions: number;
}): { readonly system: string; readonly user: string } {
  const taskById = new Map(args.tasks.map((t) => [t.id, t]));
  const failed = args.evalScore.perTask.filter((t) => t.score < 1);
  const failureLines = failed.map((t) => {
    const task = taskById.get(t.taskId);
    const criteria = task?.successCriteria ?? "(unknown criterion)";
    const example = (t.failingExample ?? "(no response captured)").slice(0, FAILING_EXAMPLE_PROMPT_MAX);
    return [
      `- task "${t.taskId}" (pass rate ${t.passes}/${t.samples}):`,
      `    criterion: ${criteria}`,
      `    failing response: ${example}`,
    ].join("\n");
  });
  const user = [
    `Current skills: ${args.currentSkills.length > 0 ? args.currentSkills.join(", ") : "(none)"}`,
    "",
    failureLines.length > 0 ? "Failed tasks:" : "No tasks failed.",
    ...failureLines,
    "",
    `Propose at most ${args.maxActions} actions as a JSON array. Output only the JSON array.`,
  ].join("\n");
  return { system: PROPOSER_SYSTEM, user };
}

const rawActionSchema = z.object({
  kind: z.enum(["add", "revise", "remove"]),
  name: z.string(),
  skillMd: z.string().optional(),
  rationale: z.string().optional(),
});

/**
 * Extract + shape-validate a JSON array of actions from raw model text. Tolerates
 * prose/fences by grabbing the first `[...]`. Returns [] on any failure (the loop
 * treats [] as "no proposal"). Does NOT validate semantics — see validateActions.
 */
export function parseActions(raw: string): OptimizerAction[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const parsed = z.array(rawActionSchema).safeParse(arr);
  if (!parsed.success) return [];
  const out: OptimizerAction[] = [];
  for (const a of parsed.data) {
    const rationale = a.rationale ?? "";
    if (a.kind === "remove") {
      out.push({ kind: "remove", name: a.name, rationale });
    } else {
      out.push({ kind: a.kind, name: a.name, skillMd: a.skillMd ?? "", rationale });
    }
  }
  return out;
}

/** `["*"]` = any skill; otherwise the name must be listed. */
export function isEligible(name: string, eligibleSkills: readonly string[]): boolean {
  return eligibleSkills.includes("*") || eligibleSkills.includes(name);
}

/**
 * Drop semantically-invalid actions + dedup by skill name (first wins) + TRUNCATE
 * to maxActions. Validity:
 *   - add:    name NOT already a current skill, skillMd non-empty.
 *   - revise: name IS a current skill, eligible, skillMd non-empty.
 *   - remove: name IS a current skill, eligible.
 * (Adds create new skills, so they're not gated by eligibleSkills; eligibleSkills
 *  gates which EXISTING skills the optimizer may touch.)
 */
export function validateActions(
  actions: readonly OptimizerAction[],
  opts: {
    readonly currentSkills: readonly string[];
    readonly eligibleSkills: readonly string[];
    readonly maxActions: number;
  },
): OptimizerAction[] {
  const current = new Set(opts.currentSkills);
  const seen = new Set<string>();
  const out: OptimizerAction[] = [];
  for (const a of actions) {
    if (seen.has(a.name)) continue; // one action per skill
    let ok = false;
    if (a.kind === "add") {
      ok = !current.has(a.name) && a.skillMd.trim().length > 0;
    } else if (a.kind === "revise") {
      ok = current.has(a.name) && isEligible(a.name, opts.eligibleSkills) && a.skillMd.trim().length > 0;
    } else {
      ok = current.has(a.name) && isEligible(a.name, opts.eligibleSkills);
    }
    if (!ok) continue;
    seen.add(a.name);
    out.push(a);
    if (out.length >= opts.maxActions) break; // truncate — don't trust the model's count
  }
  return out;
}

/**
 * Propose validated skill actions for the agent's eval failures. FAIL-SAFE: any
 * LLM/parse error → []. The returned actions are already validated + capped.
 */
export async function proposeActions(
  llm: ProposerLlm,
  args: {
    readonly currentSkills: readonly string[];
    readonly evalScore: EvalScore;
    readonly tasks: readonly EvalTask[];
    readonly maxActions: number;
    readonly eligibleSkills: readonly string[];
  },
): Promise<OptimizerAction[]> {
  const { system, user } = buildProposalPrompt(args);
  let raw: string;
  try {
    raw = await llm(system, user);
  } catch {
    return [];
  }
  const parsed = parseActions(raw);
  return validateActions(parsed, {
    currentSkills: args.currentSkills,
    eligibleSkills: args.eligibleSkills,
    maxActions: args.maxActions,
  });
}

/** Map validated actions to candidate-skills overrides (add/revise → write, remove → remove). */
export function actionsToOverrides(actions: readonly OptimizerAction[]): SkillOverride[] {
  return actions.map((a) =>
    a.kind === "remove"
      ? { op: "remove", name: a.name }
      : { op: "write", name: a.name, skillMd: a.skillMd },
  );
}
