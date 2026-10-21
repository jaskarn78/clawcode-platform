/**
 * Phase 999.100 — mid-turn intent classification + steering (main channels).
 *
 * Copilot-style routing for messages that arrive while the bound agent's
 * turn is IN FLIGHT on a v2 main Discord channel:
 *
 *   - "steer"    → the message corrects/redirects the running work. It is
 *                  wrapped in a <mid-turn-user-steering> envelope and pushed
 *                  into the RUNNING turn's SDK input stream (no interrupt).
 *                  Spike-verified 2026-07-23 on claude 2.1.211 + SDK 0.2.140:
 *                  a user message pushed mid-turn is consumed by the agentic
 *                  loop at the next tool-call boundary — same turn, single
 *                  result frame, and the pushed input is NOT echoed as a
 *                  stream frame (so the WS-1 AttributedStreamDemux state
 *                  machine is untouched by injection).
 *   - "new_task" → unrelated request / casual check-in → EXACTLY today's
 *                  path (SerialTurnQueue queued slot → MessageCoalescer).
 *   - "stop"     → abort the running turn via interruptAgent, dispatch
 *                  nothing.
 *
 * Decision order (single source of truth = routeMidturnMessage):
 *   1. Deterministic heuristics (free, no LLM):
 *        🧭 leading marker            → steer   (parity with subagent threads)
 *        whole-message stop verb      → stop
 *        Discord reply to the message
 *        that started the running turn→ steer
 *   2. Otherwise ONE Haiku call (haiku-direct route, telemetry site
 *      "midturn-intent") classifies 3-way with a confidence score.
 *      Low confidence / timeout / parse garbage → new_task (fail-safe =
 *      pre-feature behavior).
 *
 * This module is pure-orchestration with injected deps (no Discord client,
 * no SessionManager import) so unit tests can pass vi.fn() for each dep —
 * same pattern as prepareSubagentSteer in steer-subagent.ts.
 */

import { hasLeadingSteerMarker } from "./steer-subagent.js";

/** Minimal pino-like logger surface (matches DemuxLogger pattern). */
export type MidturnLogger = Readonly<{
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}>;

export type MidturnIntent = "steer" | "new_task" | "stop";

export type MidturnClassification = Readonly<{
  intent: MidturnIntent;
  /** 0..1. Heuristic hits report 1. Fallbacks report 0. */
  confidence: number;
  source: "heuristic" | "llm" | "fallback";
}>;

/**
 * Runtime steering config consumed by the bridge gate. The loader emits a
 * fully-resolved block on ResolvedAgentConfig.steering (per-field cascade
 * agents[].steering ?? defaults.steering ?? baseline); this helper covers
 * consumers holding a hand-built / legacy config where the field is absent.
 */
export type ResolvedSteeringConfig = Readonly<{
  autoClassify: boolean;
  stopIntent: boolean;
  maxInjectionsPerTurn: number;
  minConfidence: number;
  stopMinConfidence: number;
  classifierTimeoutMs: number;
}>;

export const STEERING_BASELINE: ResolvedSteeringConfig = Object.freeze({
  autoClassify: false,
  stopIntent: true,
  maxInjectionsPerTurn: 3,
  minConfidence: 0.75,
  stopMinConfidence: 0.85,
  // 2026-08-02 — 4000 → 12000 in lockstep with steeringConfigSchema's
  // default (cold haiku-direct measured 5.2s on prod; 4s killed the
  // first live classification). Keep BOTH sources aligned.
  classifierTimeoutMs: 12_000,
});

export function resolveSteeringRuntime(
  cfg: Partial<ResolvedSteeringConfig> | undefined,
): ResolvedSteeringConfig {
  if (!cfg) return STEERING_BASELINE;
  return {
    autoClassify: cfg.autoClassify ?? STEERING_BASELINE.autoClassify,
    stopIntent: cfg.stopIntent ?? STEERING_BASELINE.stopIntent,
    maxInjectionsPerTurn:
      cfg.maxInjectionsPerTurn ?? STEERING_BASELINE.maxInjectionsPerTurn,
    minConfidence: cfg.minConfidence ?? STEERING_BASELINE.minConfidence,
    stopMinConfidence:
      cfg.stopMinConfidence ?? STEERING_BASELINE.stopMinConfidence,
    classifierTimeoutMs:
      cfg.classifierTimeoutMs ?? STEERING_BASELINE.classifierTimeoutMs,
  };
}

/**
 * Whole-message stop detector. Anchored both ends on the TRIMMED content so
 * "stop by the store later" can never abort a turn; only a bare stop
 * utterance (optionally punctuated) counts. Deliberately conservative —
 * anything richer goes through the LLM leg with its own (higher) stop
 * confidence threshold.
 */
export const STOP_VERB_REGEX =
  /^(?:stop|stop it|stop that|stop please|please stop|cancel|cancel that|cancel it|abort|halt|nvm|never\s?mind|forget it|don'?t bother)[.!\s]*$/i;

/**
 * Steering envelope tag — pinned by static-grep in tests. The envelope tells
 * the model this is in-flight guidance, not a fresh task, so it integrates
 * without restarting. Sibling of frameSteeringGuidance (subagent threads);
 * kept separate because the main-channel wording must not claim "operator
 * updated the directive" (this is the same requesting user, mid-task).
 */
export const MIDTURN_STEER_TAG = "mid-turn-user-steering";

/**
 * Late-steer envelope tag — 2026-09-24. Classification takes seconds (spawn
 * + API), so a message classified `steer` routinely lands AFTER the turn it
 * meant to steer has ended (`inject declined, reason: idle` — observed twice
 * on prod for `projects` with steer confidence 0.85). Silently dispatching it
 * as a bare new task made the agent treat the correction as an unrelated
 * request. This envelope rides the fallback dispatch instead, telling the
 * model the message corrects the work it JUST finished.
 */
export const MIDTURN_LATE_STEER_TAG = "late-user-steering";

export function frameLateSteer(
  formattedMessage: string,
  triggerExcerpt: string | null,
): string {
  const trigger =
    triggerExcerpt && triggerExcerpt.trim().length > 0
      ? ["", "The request it corrects (excerpt):", `<<<${triggerExcerpt.trim()}>>>`]
      : [];
  return [
    `<${MIDTURN_LATE_STEER_TAG}>`,
    "The user sent this as a correction or refinement of the task you were JUST working on, but that turn finished before it arrived. Treat it as feedback on the work you just completed — apply the correction to that work. Do NOT treat it as an unrelated new task, and do NOT redo the parts it doesn't touch.",
    ...trigger,
    "",
    formattedMessage.trim(),
    `</${MIDTURN_LATE_STEER_TAG}>`,
  ].join("\n");
}

export function frameMidturnSteer(formattedMessage: string): string {
  return [
    `<${MIDTURN_STEER_TAG}>`,
    "The user sent this message WHILE you are still working on their current request. It is guidance or a correction for the work in flight — integrate it into what you are doing right now. Do NOT restart from scratch and do NOT treat it as a separate new task. Where it contradicts your current approach, this message wins.",
    "",
    formattedMessage.trim(),
    `</${MIDTURN_STEER_TAG}>`,
  ].join("\n");
}

/**
 * Deterministic fast-path. Returns null when no heuristic fires (caller
 * falls through to the LLM leg). Pure — single source of truth for the
 * trigger conditions so refactors can't quietly desync gates from tests
 * (same rationale as shouldAutoSteer).
 */
export function detectMidturnHeuristic(args: {
  readonly content: string;
  readonly isReplyToInFlightTrigger: boolean;
}): "steer" | "stop" | null {
  const trimmed = (args.content ?? "").trim();
  if (trimmed.length === 0) return null;
  if (hasLeadingSteerMarker(trimmed)) return "steer";
  if (STOP_VERB_REGEX.test(trimmed)) return "stop";
  if (args.isReplyToInFlightTrigger) return "steer";
  return null;
}

// ---------------------------------------------------------------------------
// 999.178 R1 — status-ping detection (STATUS intent)
// ---------------------------------------------------------------------------

/**
 * Second guard, not the test: the anchored allowlist below is the classifier.
 * A message longer than this can never be a ping even if it starts with a
 * status word ("any update on the rollover?").
 */
export const STATUS_PING_MAX_CHARS = 25;

/** Strip user (`<@123>`/`<@!123>`) and role (`<@&123>`) mentions before matching. */
function stripMentions(s: string): string {
  return s.replace(/<@[!&]?\d+>/g, " ");
}

/**
 * The check-in vocabulary, anchored so the whole (mention-stripped, trimmed)
 * message must BE one of these — not merely contain one. That anchoring is
 * what keeps real asks out: `status of smith?` has trailing content after
 * `status`, so it never matches. Trailing `?`/`!`/`.` (repeated) is allowed
 * ("eta??"), and an optional leading greeting ("hey eta").
 */
const STATUS_PING_KEYWORDS = [
  "eta",
  "status",
  "updates?",
  "any\\s+updates?",
  "meow",
  "ping",
  "(?:are\\s+)?we\\s+good",
  "(?:you|u)\\s+good",
  "(?:you|u)\\s+(?:there|around)",
  "(?:you|u)?\\s*still\\s+(?:working|going|there|on\\s+it)",
  "still\\s+(?:working|going|there)",
  "how\\s+(?:long|much\\s+longer)",
  "almost\\s+(?:done|there)",
  // NB: greetings ("hey", "hello", "yo") are deliberately NOT standalone
  // keywords — with the flag on, a bare "hey" would get "Nothing running."
  // instead of the agent. They remain the optional leading filler below, so
  // "hey eta" still matches.
].join("|");

const STATUS_PING_REGEX = new RegExp(
  // bare punctuation ("?", "???") reads as "you there?"; OR an optional
  // greeting + a keyword + trailing punctuation.
  `^(?:[?!]+|(?:(?:hey|hi|yo|so|ok|okay|hello|hola)[\\s,]+)?(?:${STATUS_PING_KEYWORDS})[?!.\\s]*)$`,
  "i",
);

/**
 * True when `content` is a bare status check-in the daemon should answer from
 * the live trail rather than dispatch as a model turn. Pure and deterministic.
 *
 * The caller (bridge `tryStatusPing`) additionally requires no attachments and
 * gates the whole behaviour on `uxFeatures.statusPing`. It is independent of
 * `steering.autoClassify` — a ping is answered whether or not mid-turn steering
 * is enabled. "continue" and "stop" carry a real instruction and are NEVER
 * pings (they are absent from the allowlist).
 */
export function isStatusPing(content: string): boolean {
  const stripped = stripMentions(content ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (stripped.length === 0) return false;
  if (stripped.length > STATUS_PING_MAX_CHARS) return false;
  return STATUS_PING_REGEX.test(stripped);
}

// ---------------------------------------------------------------------------
// LLM leg
// ---------------------------------------------------------------------------

/** Excerpt cap for both the trigger and the new message fed to the classifier. */
export const CLASSIFIER_EXCERPT_CHARS = 600;

export const CLASSIFIER_SYSTEM_PROMPT = [
  "You are an intent router inside a chat-ops system. An AI agent is ALREADY WORKING on a task for the user. The user just sent a NEW message while the agent is still mid-task.",
  "Classify the new message's intent toward the IN-FLIGHT work:",
  '- "steer": it corrects, redirects, constrains, or adds requirements to the work currently in flight (e.g. "actually make it blue", "no — the OTHER file", "also add tests to that").',
  '- "new_task": it is a separate/unrelated request that can simply run afterwards, OR a casual check-in ("still going?", "how does it look?"), an acknowledgment, or anything ambiguous.',
  '- "stop": the user wants the current work aborted ("stop", "cancel that", "don\'t bother finishing").',
  "Rules: when unsure, choose new_task with low confidence. Never invent context.",
  'Reply with ONLY strict JSON: {"intent":"steer"|"new_task"|"stop","confidence":<0..1>}',
].join("\n");

export function buildClassifierUserPrompt(args: {
  readonly triggerExcerpt: string | null;
  readonly elapsedInFlightMs: number | null;
  readonly newMessage: string;
}): string {
  const trigger =
    args.triggerExcerpt && args.triggerExcerpt.trim().length > 0
      ? args.triggerExcerpt.slice(0, CLASSIFIER_EXCERPT_CHARS)
      : "(unknown — trigger message unavailable)";
  const elapsed =
    args.elapsedInFlightMs !== null
      ? `${Math.max(1, Math.round(args.elapsedInFlightMs / 1000))}s`
      : "unknown";
  return [
    "In-flight task (the user's original request, excerpt):",
    `<<<${trigger}>>>`,
    `The agent has been working on it for: ${elapsed}`,
    "",
    "New message from the same user:",
    `<<<${args.newMessage.slice(0, CLASSIFIER_EXCERPT_CHARS)}>>>`,
  ].join("\n");
}

/**
 * Parse the classifier's reply. Tolerates surrounding prose by extracting
 * the first {...} block; anything that doesn't yield a valid intent enum +
 * finite confidence throws (caller maps to the new_task fallback).
 */
export function parseClassifierReply(raw: string): {
  intent: MidturnIntent;
  confidence: number;
} {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) throw new Error("no JSON object in classifier reply");
  const parsed: unknown = JSON.parse(match[0]);
  const obj = parsed as { intent?: unknown; confidence?: unknown };
  const intent = obj.intent;
  if (intent !== "steer" && intent !== "new_task" && intent !== "stop") {
    throw new Error(`invalid intent: ${String(intent)}`);
  }
  const rawConf =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0;
  const confidence = Math.min(1, Math.max(0, rawConf));
  return { intent, confidence };
}

/** One-shot LLM classifier call signature (production: callHaikuDirect). */
export type ClassifierCallFn = (
  systemPrompt: string,
  userPrompt: string,
  opts: { readonly signal?: AbortSignal; readonly maxTokens?: number },
) => Promise<string>;

export async function classifyMidturnIntent(args: {
  readonly callClassifier: ClassifierCallFn;
  readonly triggerExcerpt: string | null;
  readonly elapsedInFlightMs: number | null;
  readonly newMessage: string;
  readonly timeoutMs: number;
  readonly log: MidturnLogger;
  readonly agentName: string;
}): Promise<MidturnClassification> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const reply = await args.callClassifier(
      CLASSIFIER_SYSTEM_PROMPT,
      buildClassifierUserPrompt({
        triggerExcerpt: args.triggerExcerpt,
        elapsedInFlightMs: args.elapsedInFlightMs,
        newMessage: args.newMessage,
      }),
      { signal: controller.signal, maxTokens: 64 },
    );
    const { intent, confidence } = parseClassifierReply(reply);
    return { intent, confidence, source: "llm" };
  } catch (err) {
    // Fail-safe: classification troubles must never change behavior beyond
    // "act like the feature is off" — queue it like today.
    args.log.warn(
      { agent: args.agentName, err: (err as Error).message },
      "midturn-intent classifier failed — falling back to new_task",
    );
    return { intent: "new_task", confidence: 0, source: "fallback" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Route orchestrator
// ---------------------------------------------------------------------------

export type MidturnRouteAction =
  | { readonly action: "steered"; readonly classification: MidturnClassification }
  | { readonly action: "stopped"; readonly classification: MidturnClassification }
  | {
      readonly action: "dispatch";
      readonly reason:
        | "new-task"
        | "below-confidence"
        | "stop-disabled"
        | "inject-declined"
        | "stop-failed";
      readonly classification: MidturnClassification;
      /**
       * 2026-09-24 late-steer grace — set ONLY on `inject-declined` when the
       * intent was steer: the caller dispatches THIS text (the user message
       * wrapped in the late-steer envelope) instead of the bare formatted
       * message, and must bypass the fast lane for it.
       */
      readonly dispatchText?: string;
    };

export type MidturnRouteDeps = Readonly<{
  /**
   * Push the framed steer into the RUNNING turn's input stream. Production
   * binds sessionManager.injectMidTurn(agentName, text, {maxPerTurn}).
   * Returns {injected:false} when the turn ended meanwhile / handle doesn't
   * support injection / per-turn cap hit — caller falls back to dispatch.
   */
  inject: (framedText: string) => { injected: boolean; reason?: string };
  /** Abort the running turn. Production binds sessionManager.interruptAgent. */
  interruptAgent: () => Promise<unknown>;
  /** LLM leg (see classifyMidturnIntent). */
  callClassifier: ClassifierCallFn;
  log: MidturnLogger;
}>;

/**
 * Decide + act for one mid-turn message. NEVER throws — every failure mode
 * folds into a "dispatch" result so the caller (bridge) can proceed with
 * the normal queue path exactly as if the feature were off.
 */
export async function routeMidturnMessage(args: {
  readonly agentName: string;
  readonly content: string;
  readonly formattedMessage: string;
  readonly isReplyToInFlightTrigger: boolean;
  readonly triggerExcerpt: string | null;
  readonly elapsedInFlightMs: number | null;
  readonly cfg: ResolvedSteeringConfig;
  readonly deps: MidturnRouteDeps;
}): Promise<MidturnRouteAction> {
  const { cfg, deps } = args;

  const heuristic = detectMidturnHeuristic({
    content: args.content,
    isReplyToInFlightTrigger: args.isReplyToInFlightTrigger,
  });

  let classification: MidturnClassification;
  if (heuristic) {
    classification = { intent: heuristic, confidence: 1, source: "heuristic" };
  } else {
    classification = await classifyMidturnIntent({
      callClassifier: deps.callClassifier,
      triggerExcerpt: args.triggerExcerpt,
      elapsedInFlightMs: args.elapsedInFlightMs,
      newMessage: args.content,
      timeoutMs: cfg.classifierTimeoutMs,
      log: deps.log,
      agentName: args.agentName,
    });
  }

  // Threshold gates. Heuristics carry confidence 1 so they pass their gate
  // by construction; stopIntent:false disables BOTH stop sources (operator
  // asked for no auto-stops at all).
  if (classification.intent === "stop") {
    if (!cfg.stopIntent) {
      return { action: "dispatch", reason: "stop-disabled", classification };
    }
    if (
      classification.source === "llm" &&
      classification.confidence < cfg.stopMinConfidence
    ) {
      return { action: "dispatch", reason: "below-confidence", classification };
    }
    try {
      await deps.interruptAgent();
      return { action: "stopped", classification };
    } catch (err) {
      deps.log.warn(
        { agent: args.agentName, err: (err as Error).message },
        "midturn-intent stop — interrupt failed; dispatching message normally",
      );
      return { action: "dispatch", reason: "stop-failed", classification };
    }
  }

  if (classification.intent === "steer") {
    if (
      classification.source === "llm" &&
      classification.confidence < cfg.minConfidence
    ) {
      return { action: "dispatch", reason: "below-confidence", classification };
    }
    try {
      const res = deps.inject(frameMidturnSteer(args.formattedMessage));
      if (res.injected) {
        return { action: "steered", classification };
      }
      deps.log.info(
        { agent: args.agentName, reason: res.reason ?? "unknown" },
        "midturn-intent steer — inject declined (turn ended / cap / unsupported); dispatching with late-steer envelope",
      );
      return {
        action: "dispatch",
        reason: "inject-declined",
        classification,
        dispatchText: frameLateSteer(args.formattedMessage, args.triggerExcerpt),
      };
    } catch (err) {
      deps.log.warn(
        { agent: args.agentName, err: (err as Error).message },
        "midturn-intent steer — inject threw; dispatching with late-steer envelope",
      );
      return {
        action: "dispatch",
        reason: "inject-declined",
        classification,
        dispatchText: frameLateSteer(args.formattedMessage, args.triggerExcerpt),
      };
    }
  }

  return { action: "dispatch", reason: "new-task", classification };
}
