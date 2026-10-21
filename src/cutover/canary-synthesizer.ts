/**
 * Phase 92 Plan 05 — Canary prompt synthesizer (CUT-08, D-08).
 *
 * Reads `topIntents[]` from an AgentProfile (Plan 92-01), slices the top N
 * by count DESC (default 20 per `CANARY_TOP_INTENT_LIMIT`), and runs ONE
 * `TurnDispatcher.dispatch` call asking the profiler agent (default
 * "clawdy") to emit a JSON array of `{intent, prompt}` rows — one
 * representative user message per intent that exercises the agent's
 * typical tool/skill/MCP usage for that intent.
 *
 * Output is sorted by intent ASC for deterministic iteration order — two
 * runs with the same topIntents[] (regardless of input order) produce the
 * same prompt sequence. Cron-prefixed intents (per D-11) flow through
 * verbatim — the LLM is instructed to render them as a manual-trigger
 * phrasing so the canary battery exercises cron-dispatch parity.
 *
 * Pure DI module — `deps.dispatcher` is `Pick<TurnDispatcher, "dispatch">`.
 * Tests pass `vi.fn(async () => CANNED_JSON)`. Production wires the real
 * TurnDispatcher constructed at daemon boot.
 */

import { z } from "zod/v4";
import type { Logger } from "pino";
import type { TurnOrigin } from "../manager/turn-origin.js";
import { makeRootOrigin } from "../manager/turn-origin.js";
import {
  canaryPromptSchema,
  CANARY_TOP_INTENT_LIMIT,
  type CanaryPrompt,
  type CanarySynthesizeOutcome,
} from "./types.js";

/**
 * Mirror of the TurnDispatcher.dispatch surface narrowed to what the
 * synthesizer actually needs. Tests stub via `vi.fn(async () => string)`.
 */
export type SynthesizerDispatchFn = (
  origin: TurnOrigin,
  agentName: string,
  message: string,
  options?: unknown,
) => Promise<string>;

export type SynthesizerDeps = {
  /** ClawCode agent under canary (e.g. "fin-client"). Used in the prompt context only. */
  readonly agent: string;
  /** AgentProfile.topIntents[] (Plan 92-01 emission). */
  readonly topIntents: readonly { intent: string; count: number }[];
  /** Override the slice limit. Default: CANARY_TOP_INTENT_LIMIT (20). */
  readonly limit?: number;
  /** TurnDispatcher (or structural test stub). One dispatch call per synthesize. */
  readonly dispatcher: { dispatch: SynthesizerDispatchFn };
  /** Profiler agent name (default: "clawdy"). */
  readonly profilerAgent?: string;
  readonly log: Logger;
};

const SYNTHESIZER_SYSTEM_PROMPT = `You are a canary-prompt generator for an OpenClaw → ClawCode cutover parity verifier. Given a list of historically observed user intents (with frequency counts), emit a JSON array of representative example prompts — ONE prompt per intent — that exercise the agent's typical tool/skill/MCP usage for that intent.

Each prompt must:
- Be a realistic user message (1-3 sentences)
- Be specific enough to invoke the agent's typical tool/skill behavior for that intent
- Pair 1:1 with the intent (same string in the "intent" field, verbatim)

For intents prefixed with "cron:" (these are scheduled-runner intents, not user-initiated), generate a representative MANUAL TRIGGER phrasing like "Please run the <intent-name-after-prefix> job now and report the result." so the canary battery exercises cron-dispatch parity.

Output ONLY the JSON array. No prose. Schema:
[{"intent": "<intent verbatim>", "prompt": "<example user message>"}, ...]`;

/**
 * Run one synthesize cycle. Returns a CanarySynthesizeOutcome — never
 * throws in the happy path. Dispatcher errors and schema-validation
 * failures are surfaced as outcome variants so the CLI wrapper can map
 * them to exit codes without unwinding.
 */
export async function synthesizeCanaryPrompts(
  deps: SynthesizerDeps,
): Promise<CanarySynthesizeOutcome> {
  const start = Date.now();
  if (deps.topIntents.length === 0) {
    return { kind: "no-intents", agent: deps.agent };
  }

  const limit = deps.limit ?? CANARY_TOP_INTENT_LIMIT;

  // Spread + sort (CLAUDE.md immutability — never mutate the input).
  // Sort by count DESC, ties broken by intent ASC for deterministic slice.
  const topN = [...deps.topIntents]
    .sort(
      (a, b) => b.count - a.count || a.intent.localeCompare(b.intent),
    )
    .slice(0, limit);

  const userMessage =
    "Intents:\n" +
    topN.map((t) => `- ${t.intent} (count: ${t.count})`).join("\n");
  const fullPrompt = SYNTHESIZER_SYSTEM_PROMPT + "\n\n" + userMessage;
  const origin = makeRootOrigin(
    "scheduler",
    `cutover-canary-synthesizer:${deps.agent}`,
  );

  let response: string;
  try {
    response = await deps.dispatcher.dispatch(
      origin,
      deps.profilerAgent ?? "clawdy",
      fullPrompt,
    );
  } catch (err) {
    return {
      kind: "dispatcher-failed",
      agent: deps.agent,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(extractJsonArray(response));
  } catch (err) {
    return {
      kind: "schema-validation-failed",
      agent: deps.agent,
      error: err instanceof Error ? err.message : String(err),
      rawResponse: response.slice(0, 4000),
    };
  }

  const parsed = z.array(canaryPromptSchema).safeParse(parsedJson);
  if (!parsed.success) {
    return {
      kind: "schema-validation-failed",
      agent: deps.agent,
      error: parsed.error.message,
      rawResponse: response.slice(0, 4000),
    };
  }

  // Sort by intent ASC for deterministic output order. Spread to avoid
  // mutating parsed.data.
  const prompts: CanaryPrompt[] = [...parsed.data].sort((a, b) =>
    a.intent.localeCompare(b.intent),
  );

  return {
    kind: "synthesized",
    agent: deps.agent,
    prompts,
    durationMs: Date.now() - start,
  };
}

/**
 * Extract a JSON array from a possibly-fenced LLM response. If the
 * response is wrapped in ```json ... ``` fences, return the inner; else
 * find the first `[` and last `]` and return that slice. Falls back to
 * the trimmed whole text if neither bracket is found.
 */
function extractJsonArray(text: string): string {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]+?)\n```/);
  const inner = (fence?.[1] ?? text).trim();
  const startIdx = inner.indexOf("[");
  const endIdx = inner.lastIndexOf("]");
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return inner;
  return inner.slice(startIdx, endIdx + 1);
}
