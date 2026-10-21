/**
 * Phase 999.161 — fast lane: quick questions answer in seconds.
 *
 * Measured motivation (7 d to 2026-09-23): the median Discord turn is 47.6 s and
 * p90 is 225 s, while a large share of messages are short questions that need no
 * tools. Every one of them today spins the agent's full session — Opus at high or
 * ultracode effort with 10–13 MCP servers mounted.
 *
 * v1.1 (2026-09-23, after the first live measurements): ONE bridge call, not two.
 * v1 ran a separate haiku classifier before the quick answer; on prod each
 * haiku-direct call is a fresh `claude` binary spawn (3–8 s on clawdy), so the
 * classifier alone cost more than the answer and its 8 s deadline was a coin
 * flip (first live message: classifier SIGTERM'd at 8.4 s → task lane; second:
 * 7.6 s classify + 5.1 s answer = 12.8 s for an 18-char reply). Now the rule
 * pre-filter routes obvious work to the task lane for free, and the quick-answer
 * call is its own gate: the model replies NEEDS_TASK_LANE when the message needs
 * tools, live data, an action or depth, and a non-answer heuristic catches the
 * "I can't check that from here" shapes. The call runs with a trimmed CLI
 * startup (no settings/hooks/plugins/MCP/tools; measured 3.8 → 2.3 s).
 *
 * The quick reply carries a `⚡` footer so the user always knows which lane
 * answered, and the exchange is captured to the conversation store like any
 * other turn. Because the persistent session never saw a quick exchange, the
 * next task-lane message carries a compact recap of recent quick answers.
 *
 * 999.164: which messages may reach the quick answer at all is decided first, per
 * agent, by `fast-lane-routing.ts`; the prompt then names what the agent's full
 * session can see, so "Should I add more miles to today's run?" is never answered
 * from persona alone.
 *
 * Pure module: prompts, parsing and the recap buffer. No I/O.
 */

import { icons } from "../discord/icons.js";

/** Hard ceiling for a quick reply on Discord (bot-direct sends do not chunk). */
export const QUICK_REPLY_MAX_CHARS = 1900;
export const NEEDS_TASK_LANE = "NEEDS_TASK_LANE";

const RULE_TASK_PATTERNS: readonly RegExp[] = [
  /\b(properly|in detail|thorough|step by step|full (answer|version|report)|do it|go ahead|run |execute|deploy|send |email|schedule|book|buy|order|check (my|the) (calendar|email|inbox|account)|look up|search|browse|open|download|upload|file|attach|screenshot|restart|install)\b/i,
  /```|https?:\/\//i,
];

/** Cheap pre-filter: obvious task requests never reach the bridge at all. */
export function ruleSaysTask(message: string): boolean {
  return RULE_TASK_PATTERNS.some((re) => re.test(message));
}

// ─────────────────────────── the quick answer ───────────────────────────

const SOUL_BUDGET_CHARS = 6000;
const IDENTITY_BUDGET_CHARS = 3000;

export function buildQuickSystemPrompt(args: {
  readonly agentName: string;
  readonly soul: string | undefined;
  readonly identity: string | undefined;
  readonly hotMemories: readonly string[];
  /**
   * 999.164 — what the agent's full session can see that this lane cannot, one
   * domain per line (`renderDomainDigest`). Empty when unknown.
   */
  readonly canSee?: string;
}): string {
  const soul = (args.soul ?? "").trim().slice(0, SOUL_BUDGET_CHARS);
  const identity = (args.identity ?? "").trim().slice(0, IDENTITY_BUDGET_CHARS);
  const hot = args.hotMemories.slice(0, 5).map((m) => `- ${m.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  const canSee = (args.canSee ?? "").trim();
  return [
    `You are ${args.agentName}, answering one quick question in a Discord chat. Stay fully in character.`,
    identity ? `\n# Identity\n${identity}` : "",
    soul ? `\n# Soul\n${soul}` : "",
    hot ? `\n# Background notes about the user (may be out of date — not their current state)\n${hot}` : "",
    canSee
      ? `\n# What your full session can see and this quick lane cannot\n${canSee}\nAny question in these areas — even one phrased generally, like "is a 20% jump risky?" — belongs to your full session: the user means their own situation, and their data answers it better than a rule of thumb. So does anything about the user's plans, data, schedule, body, money, devices or work.`
      : "",
    `\n# Rules for this reply
- This is the QUICK lane. Answer ONLY: a greeting, thanks or small talk; a general-knowledge question whose answer is the same for anyone; or a question about the conversation shown here.
- Reply with exactly ${NEEDS_TASK_LANE} (nothing else) when the message asks you to DO something (run, send, book, schedule, deploy, look up, check, search, open, edit, create), needs a tool, a file, live or account data, an image or attachment, is about the user's own situation, touches anything your full session can see, or asks for depth ("properly", "in detail", "full", "step by step"). When unsure, ${NEEDS_TASK_LANE}.
- A generic answer to a personal question is a wrong answer. Never reply "it depends", never hand the question back to the user, never guess what their data would say.
- Otherwise answer directly, in your own voice, in at most ~900 characters. No preamble, no headings.
- Do not invent facts, dates, prices or statuses. Never describe what you would check or do — if checking is needed, it is ${NEEDS_TASK_LANE}.`,
  ].join("\n");
}

export function buildQuickUserPrompt(args: { readonly message: string; readonly recentTurns: readonly { role: string; content: string }[] }): string {
  const recent = args.recentTurns
    .slice(-6)
    .map((t) => `${t.role === "assistant" ? "You" : "User"}: ${t.content.replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
  return `${recent.length > 0 ? `Recent conversation:\n${recent}\n\n` : ""}User: ${args.message}`;
}

export type QuickAnswer =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "needs-task-lane"; readonly reason: "sentinel" | "empty" | "non-answer" | "deflection" };

/**
 * A quick reply that talks about checking, accessing or getting back to the
 * user is a non-answer: the message needed the task lane. Cheap and tight —
 * a false positive only costs the ordinary (slower, correct) turn.
 */
const NON_ANSWER_PATTERNS: readonly RegExp[] = [
  /\bI (can'?t|cannot|don'?t have|do not have|am unable to|won'?t be able to) (access|check|see|look|verify|pull|open|read|reach|browse|run)\b/i,
  /\bI(?:'d| would| will|'ll) (need|have) to (check|look|verify|pull|run|open)\b/i,
  /\blet me (check|look|pull|verify|run|open)\b/i,
  /\b(I don'?t have|without) (access|the ability|a way) to\b/i,
  /\bI(?:'ll|'d| will| would) (check|look into|get back to you|find out)\b/i,
];

export function looksLikeNonAnswer(text: string): boolean {
  return NON_ANSWER_PATTERNS.some((re) => re.test(text));
}

/**
 * 999.164 — a quick reply that hands a personal question back to the user is a
 * deflection: the live one was "That depends on how you're feeling! … What's your
 * gut telling you?" to "Should I add more miles to today's run?", which the agent's
 * training data answered minutes later. Same economics as the non-answer check.
 */
/** Checked against the reply's opening sentence: that is where a hand-back leads. */
const DEFLECTION_LEAD_PATTERNS: readonly RegExp[] = [
  /^(?:that|it|this)(?:'s| is)? (?:really |all |totally )?up to you\b/i,
  /^(?:that|it|this) (?:really |all |totally )?depends[!.…]/i,
  /\bdepends (?:on|upon) (?:how|what|whether|if|when) you\b/i,
  /\bdepends (?:on|upon) your\b/i,
  /\bhow (?:are|do) you feel(?:ing)?\b/i,
];
/** A hand-back anywhere in the reply. */
const DEFLECTION_ANYWHERE_PATTERNS: readonly RegExp[] = [
  /\bwhat(?:'s| is| does) your (?:gut|body|instinct)\b/i,
  /\blisten to your body\b/i,
  /\bonly you (?:can|know)\b/i,
];

export function looksLikeDeflection(text: string): boolean {
  const t = text.replace(/[’‘]/g, "'").trim();
  const lead = /^[^.!?]*[.!?…]?/.exec(t)?.[0] ?? t;
  return DEFLECTION_LEAD_PATTERNS.some((re) => re.test(lead)) || DEFLECTION_ANYWHERE_PATTERNS.some((re) => re.test(t));
}

export function parseQuickAnswer(raw: string): QuickAnswer {
  const text = raw.trim();
  if (text.length === 0) return { kind: "needs-task-lane", reason: "empty" };
  if (text.includes(NEEDS_TASK_LANE)) return { kind: "needs-task-lane", reason: "sentinel" };
  if (looksLikeNonAnswer(text)) return { kind: "needs-task-lane", reason: "non-answer" };
  if (looksLikeDeflection(text)) return { kind: "needs-task-lane", reason: "deflection" };
  return { kind: "answer", text };
}

/** Bot-direct sends fail above 2,000 chars; keep headroom for the footer. */
export function truncateForDiscord(text: string, max = QUICK_REPLY_MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return `${(at > max * 0.6 ? cut.slice(0, at + 1) : cut).trimEnd()}…`;
}

export function quickLaneFooter(durationMs: number): string {
  return icons.prefix("zap", `quick lane · ${(durationMs / 1000).toFixed(1)}s`);
}

// ─────────────────────────── continuity for the task lane ───────────────────────────

/**
 * The persistent session never saw quick-lane exchanges. Keep the last few per
 * agent and hand them to the next task-lane message as a compact recap, then
 * clear — so the session's own transcript stays the source of truth afterwards.
 */
export class QuickLaneRecentBuffer {
  private readonly byAgent = new Map<string, { q: string; a: string; at: number }[]>();

  constructor(private readonly keep = 4, private readonly maxAgeMs = 30 * 60 * 1000) {}

  push(agentName: string, question: string, answer: string, now = Date.now()): void {
    const list = this.byAgent.get(agentName) ?? [];
    list.push({ q: question, a: answer, at: now });
    this.byAgent.set(agentName, list.slice(-this.keep));
  }

  /** Render and clear. Empty string when nothing recent. */
  drain(agentName: string, now = Date.now()): string {
    const list = (this.byAgent.get(agentName) ?? []).filter((e) => now - e.at <= this.maxAgeMs);
    this.byAgent.delete(agentName);
    if (list.length === 0) return "";
    const lines = list.map((e) => `- User: ${e.q.replace(/\s+/g, " ").slice(0, 200)}\n  You (quick lane): ${e.a.replace(/\s+/g, " ").slice(0, 300)}`);
    return `[Recent quick-lane exchanges you answered without your session — for continuity only]\n${lines.join("\n")}\n[End of recap]`;
  }

  size(agentName: string): number {
    return (this.byAgent.get(agentName) ?? []).length;
  }
}
