/**
 * Phase 999.128 — named workflow templates.
 *
 * WHY. The useful workflows repeat: the weekly market scan, the monthly
 * client-review pack, the fleet audit. Today an agent re-authors the
 * step list from scratch each time (and drifts), and a schedule can only
 * say "run the weekly scan" and hope the agent rebuilds it faithfully.
 * A template is an operator-authored spec in `clawcode.yaml`, launched by
 * NAME with parameters: `start_workflow({ template: "market-scan",
 * params: { ticker: "NVDA" } })`.
 *
 * Prompts use `{{param}}` placeholders. Every placeholder must be declared
 * in `params` and supplied at launch (or carry a default); an unknown or
 * missing parameter is a launch error, never a prompt with a literal
 * `{{ticker}}` in it. The substituted spec then goes through the same
 * `normalizeWorkflowSpec` validation as a hand-written one.
 */

import type { WorkflowSpec, WorkflowStep } from "./workflow-orchestrator.js";

export interface WorkflowTemplateParam {
  readonly name: string;
  readonly description?: string;
  readonly default?: string;
}

export interface WorkflowTemplate {
  readonly name: string;
  readonly description?: string;
  readonly params?: readonly WorkflowTemplateParam[];
  readonly steps?: readonly WorkflowStep[];
  readonly waves?: readonly (readonly WorkflowStep[])[];
}

export type ResolveTemplateResult =
  | { readonly ok: true; readonly spec: WorkflowSpec; readonly params: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: "unknown-template" | "missing-params" | "unknown-params" | "invalid-template"; readonly message: string };

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Placeholders referenced anywhere in the template's prompts. */
export function templatePlaceholders(template: WorkflowTemplate): readonly string[] {
  const found = new Set<string>();
  const steps = template.waves ? template.waves.flat() : (template.steps ?? []);
  for (const step of steps) {
    for (const m of step.prompt.matchAll(PLACEHOLDER)) found.add(m[1]!);
  }
  return [...found].sort();
}

/** Static validation an operator gets at config load: names, shapes, placeholder coverage. */
export function validateWorkflowTemplate(template: WorkflowTemplate): readonly string[] {
  const errors: string[] = [];
  if (!NAME_RE.test(template.name)) {
    errors.push(`template name "${template.name}" must match ${NAME_RE}`);
  }
  if ((template.steps === undefined) === (template.waves === undefined)) {
    errors.push(`template "${template.name}" must declare exactly one of steps or waves`);
  }
  const declared = new Set((template.params ?? []).map((p) => p.name));
  for (const p of template.params ?? []) {
    if (!NAME_RE.test(p.name)) errors.push(`template "${template.name}": param name "${p.name}" is invalid`);
  }
  for (const ph of templatePlaceholders(template)) {
    if (!declared.has(ph)) {
      errors.push(`template "${template.name}": prompt uses {{${ph}}} but params does not declare it`);
    }
  }
  const steps = template.waves ? template.waves.flat() : (template.steps ?? []);
  for (const s of steps) {
    if (!s.stepId || s.stepId.trim().length === 0) errors.push(`template "${template.name}": a step has an empty stepId`);
    if (!s.prompt || s.prompt.trim().length === 0) errors.push(`template "${template.name}": step "${s.stepId}" has an empty prompt`);
  }
  return errors;
}

/** Per-agent templates win over fleet templates with the same name. */
export function mergeTemplates(
  fleet: readonly WorkflowTemplate[] | undefined,
  agent: readonly WorkflowTemplate[] | undefined,
): readonly WorkflowTemplate[] {
  const byName = new Map<string, WorkflowTemplate>();
  for (const t of fleet ?? []) byName.set(t.name, t);
  for (const t of agent ?? []) byName.set(t.name, t);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function substitute(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => values[name] ?? "");
}

/** Resolve a template + params into a launchable spec. */
export function resolveWorkflowTemplate(
  templates: readonly WorkflowTemplate[],
  name: string,
  params: Readonly<Record<string, string>> = {},
): ResolveTemplateResult {
  const template = templates.find((t) => t.name === name);
  if (!template) {
    const known = templates.map((t) => t.name);
    return {
      ok: false,
      reason: "unknown-template",
      message:
        known.length > 0
          ? `no workflow template named "${name}"; available: ${known.join(", ")}`
          : `no workflow template named "${name}"; none are configured for this agent`,
    };
  }
  const staticErrors = validateWorkflowTemplate(template);
  if (staticErrors.length > 0) {
    return { ok: false, reason: "invalid-template", message: staticErrors.join("; ") };
  }
  const declared = template.params ?? [];
  const declaredNames = new Set(declared.map((p) => p.name));
  const unknown = Object.keys(params).filter((k) => !declaredNames.has(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: "unknown-params",
      message: `template "${name}" does not take: ${unknown.join(", ")}${declared.length > 0 ? ` (it takes: ${declared.map((p) => p.name).join(", ")})` : ""}`,
    };
  }
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const p of declared) {
    const supplied = params[p.name];
    if (supplied !== undefined && supplied.trim().length > 0) values[p.name] = supplied;
    else if (p.default !== undefined) values[p.name] = p.default;
    else missing.push(p.name);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "missing-params",
      message: `template "${name}" needs: ${missing.join(", ")}`,
    };
  }
  const mapStep = (s: WorkflowStep): WorkflowStep => ({
    stepId: substitute(s.stepId, values),
    prompt: substitute(s.prompt, values),
    ...(s.mcpServers !== undefined ? { mcpServers: s.mcpServers } : {}),
  });
  const spec: WorkflowSpec = template.waves
    ? { waves: template.waves.map((w) => w.map(mapStep)) }
    : { steps: (template.steps ?? []).map(mapStep) };
  return { ok: true, spec, params: Object.freeze(values) };
}

/** The listing an agent (or the CLI) sees. */
export function describeTemplates(templates: readonly WorkflowTemplate[]): ReadonlyArray<{
  readonly name: string;
  readonly description: string | null;
  readonly params: ReadonlyArray<{ name: string; description: string | null; required: boolean; default: string | null }>;
  readonly steps: number;
  readonly waves: number;
}> {
  return templates.map((t) => {
    const stepCount = t.waves ? t.waves.reduce((n, w) => n + w.length, 0) : (t.steps ?? []).length;
    return Object.freeze({
      name: t.name,
      description: t.description ?? null,
      params: Object.freeze(
        (t.params ?? []).map((p) =>
          Object.freeze({
            name: p.name,
            description: p.description ?? null,
            required: p.default === undefined,
            default: p.default ?? null,
          }),
        ),
      ),
      steps: stepCount,
      waves: t.waves ? t.waves.length : 1,
    });
  });
}
