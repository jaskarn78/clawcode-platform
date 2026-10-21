/**
 * Phase 125 Plan 03 — robust parser for Haiku Tier 2 output.
 *
 * Phase 95 dreaming hit three failure modes in 2026 that we pin here:
 *   - JSON fences around YAML (` ```yaml … ``` `).
 *   - Leading prose preamble ("Here is the YAML:") before the first key.
 *   - Haiku emitting JSON instead of YAML when asked for YAML.
 *
 * Never throws. Always returns `Tier2Facts | null`. Caller treats null as
 * "Tier 2 unavailable, fall back to Plan 02 output".
 */

import YAML from "yaml";
import { z } from "zod";
import type { Tier2Facts } from "./types.js";

const MAX_ACTIVE_CLIENTS = 20;
const MAX_DECISIONS = 20;
const MAX_STANDING_RULES = 20;
const MAX_IN_FLIGHT_TASKS = 20;
const MAX_DRIVE_PATHS = 30;
const MAX_CRITICAL_NUMBERS = 30;

const decisionSchema = z.object({
  decision: z.string().min(1),
  context: z.string().default(""),
});

const standingRuleSchema = z.object({
  rule: z.string().min(1),
  changedAt: z.string().default(""),
});

const taskSchema = z.object({
  task: z.string().min(1),
  state: z.string().default(""),
});

const criticalNumberSchema = z.object({
  context: z.string().default(""),
  value: z.string().min(1),
});

const tier2Schema = z.object({
  activeClients: z.array(z.string().min(1)).default([]),
  decisions: z.array(decisionSchema).default([]),
  standingRulesChanged: z.array(standingRuleSchema).default([]),
  inFlightTasks: z.array(taskSchema).default([]),
  drivePathsTouched: z.array(z.string().min(1)).default([]),
  criticalNumbers: z.array(criticalNumberSchema).default([]),
});

const FENCE_OPEN_RE = /^```(?:yaml|yml|json)?\s*\n/i;
const FENCE_CLOSE_RE = /\n```\s*$/;

/** Strip a single ```yaml/```json fence pair if present. */
function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  if (!FENCE_OPEN_RE.test(trimmed)) return trimmed;
  const openStripped = trimmed.replace(FENCE_OPEN_RE, "");
  return openStripped.replace(FENCE_CLOSE_RE, "");
}

/**
 * Walk lines until we find the first one that looks like a YAML key
 * (`<word>:` at column 0). Everything above is discarded as preamble.
 */
function stripProsePreamble(input: string): string {
  const lines = input.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(lines[i])) {
      return lines.slice(i).join("\n");
    }
  }
  return input;
}

/** Best-effort JSON fallback — used only when YAML parse fails. */
function tryJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function capFacts(facts: z.infer<typeof tier2Schema>): Tier2Facts {
  return Object.freeze({
    activeClients: Object.freeze(facts.activeClients.slice(0, MAX_ACTIVE_CLIENTS)),
    decisions: Object.freeze(
      facts.decisions
        .slice(0, MAX_DECISIONS)
        .map((d) => Object.freeze({ decision: d.decision, context: d.context })),
    ),
    standingRulesChanged: Object.freeze(
      facts.standingRulesChanged
        .slice(0, MAX_STANDING_RULES)
        .map((r) => Object.freeze({ rule: r.rule, changedAt: r.changedAt })),
    ),
    inFlightTasks: Object.freeze(
      facts.inFlightTasks
        .slice(0, MAX_IN_FLIGHT_TASKS)
        .map((t) => Object.freeze({ task: t.task, state: t.state })),
    ),
    drivePathsTouched: Object.freeze(
      facts.drivePathsTouched.slice(0, MAX_DRIVE_PATHS),
    ),
    criticalNumbers: Object.freeze(
      facts.criticalNumbers
        .slice(0, MAX_CRITICAL_NUMBERS)
        .map((n) => Object.freeze({ context: n.context, value: n.value })),
    ),
  });
}

export function parseTier2Output(rawText: string): Tier2Facts | null {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return null;
  }

  const fenceStripped = stripCodeFence(rawText);
  const proseStripped = stripProsePreamble(fenceStripped);

  let parsed: unknown;
  try {
    parsed = YAML.parse(proseStripped);
  } catch {
    parsed = tryJsonParse(proseStripped);
  }

  if (parsed === null || parsed === undefined) {
    parsed = tryJsonParse(proseStripped);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const validated = tier2Schema.safeParse(parsed);
  if (!validated.success) return null;

  return capFacts(validated.data);
}
