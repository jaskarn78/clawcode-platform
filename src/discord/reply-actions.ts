import { icons, type IconName } from "./icons.js";
/**
 * Phase 999.160 — reply actions: buttons under a reply that appear ONLY when
 * something about the turn makes them relevant.
 *
 * Operator direction (2026-09-23): "intelligently handle the reply actions as
 * buttons so they only appear when relevant." So there is no "always" here.
 * Every button has one explicit trigger, the set is capped, and a click sends a
 * canonical message through the ordinary turn pipeline — no new execution path.
 *
 * Pure module: no discord.js calls, no timers, no I/O. The bridge owns the
 * Discord side (attaching the row, expiring it, dispatching the click).
 *
 * Measured motivation (7 d to 2026-09-23): p90 turn = 225 s, 22% of replies
 * exceed Discord's 2,000-char limit (Admin Clawdy 62%), 3.1% of turns never
 * complete, and the follow-up a user types on a phone is the friction.
 */

export const RA_PREFIX = "ra:";

/** Buttons expire — a dead control row is worse than no row. */
export const REPLY_ACTION_TTL_MS = 10 * 60 * 1000;
/** Discord allows 5 buttons per row; we cap lower so the row stays scannable. */
export const MAX_REPLY_ACTIONS = 3;
/** Below this, a reply is a quip; only Continue/Retry may decorate it. */
export const MIN_CHARS_FOR_ACTIONS = 200;
/** "Shorter" only earns its place when the reply is genuinely long. */
export const SHORTER_THRESHOLD_CHARS = 1800;
/** "Thread" only when the turn was long enough that a channel is the wrong place. */
export const THREAD_THRESHOLD_MS = 3 * 60 * 1000;
/** "As a file" when the reply is a table or a long enumerated list. */
export const FILE_ROW_THRESHOLD = 12;

export type ReplyActionKind =
  | "continue"
  | "go-ahead"
  | "retry"
  | "shorter"
  | "sources"
  | "thread"
  | "file"
  | "remember"
  | "custom"
  // 999.172 — the model's predicted next prompt (CLI `prompt_suggestion`).
  // Its own kind, not `custom`, so it can be measured apart from the
  // model-proposed <actions> buttons.
  | "suggestion";

export type ReplyAction = {
  readonly kind: ReplyActionKind;
  /**
   * Button label, ≤ 20 chars (Discord allows 80; short reads better on a phone).
   * Exception: a `suggestion` label is the full suggestion (≤ 80), so the user
   * sees exactly what a click sends.
   * Text only — no Unicode emoji (operator, 2026-09-23). A proper icon set means
   * application emojis uploaded once from an icon library and referenced by
   * id; until that exists, labels stand alone.
   */
  readonly label: string;
  /** Icon from the application emoji set (see icons.ts); rendered only when loaded. */
  readonly icon: IconName;
  /** The message a click sends, as the user, through the normal turn pipeline. */
  readonly message: string;
  /** Why it appeared — kept for telemetry and the click-through pruning loop. */
  readonly trigger: string;
};

export type ReplyActionInput = {
  /** The delivered reply text (after footers are composed). */
  readonly text: string;
  /** Sources the verification ledger recorded for this turn. */
  readonly nSources: number;
  /** Wall time from the user's message to delivery. */
  readonly durationMs: number;
  /** The reply was split across messages (> 2,000 chars). */
  readonly chunked: boolean;
  /** The turn ended in a failure the user can see (❌, cut short, tool failure). */
  readonly failed?: boolean;
  /** How the turn ended when it did not complete normally. */
  readonly cutShortReason?: string;
  /** Subagent threads spawned during the turn, when known. */
  readonly subagentCount?: number;
  /** Model-proposed actions parsed from an `<actions>` block, already validated. */
  readonly proposed?: readonly ReplyAction[];
};

const OFFER_PATTERNS: readonly RegExp[] = [
  /\b(want me to|would you like|do you want|shall i|should i|can i|let me know if)\b[^.?!\n]{0,80}\?/i,
  // A yes/no question that opens a sentence: "Want the cheaper one?"
  /(^|[.!?]\s+)(want|need|like)\b[^.?!\n]{0,60}\?/i,
  /\bi can (also )?(do|run|draft|send|build|set up|book|check|look into|dig|expand|continue)\b[^.?!\n]{0,80}(\?|\.)/i,
  /\b(say the word|just say|tell me)\b[^.?!\n]{0,60}(and|to)\b[^.?!\n]{0,60}[.!?]/i,
];
/** A wh-question needs an answer from the user; no button can give one. */
const WH_QUESTION = /^(what|which|where|when|who|whom|whose|how|why)\b/i;

/** The last non-empty paragraph, with footers (`-# …`) and code fences ignored. */
export function lastParagraph(text: string): string {
  const paras = text
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("-#") && !/^\*—/.test(p));
  return paras.length > 0 ? paras[paras.length - 1]! : "";
}

/**
 * True when the reply ends by OFFERING to do more ("Want me to…?", "Shall I…?",
 * "I can also…"). An open question to the user ("What do you want done on it?",
 * "Which one?") is deliberately NOT an offer — v1 treated any short closing
 * question as one and put a meaningless "Continue" under exactly that line
 * (2026-09-23). The user has to answer those; no button can.
 */
export function endsWithOffer(text: string): boolean {
  const tail = lastParagraph(text);
  if (tail.length === 0) return false;
  const lastLine = tail.split("\n").pop()!.trim();
  if (WH_QUESTION.test(lastLine)) return false;
  return OFFER_PATTERNS.some((re) => re.test(tail));
}

/** Count enumerated rows: markdown table rows or list items. */
export function countStructuredRows(text: string): number {
  let rows = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("|") && line.endsWith("|") && !/^\|[\s:|-]+\|$/.test(line)) rows++;
    else if (/^([-*•]|\d+[.)])\s+\S/.test(line)) rows++;
  }
  return rows;
}

export function countUrls(text: string): number {
  const m = text.match(/https?:\/\/[^\s)>\]]+/g);
  return m ? new Set(m).size : 0;
}

const CATALOG: Readonly<Record<Exclude<ReplyActionKind, "custom" | "suggestion">, Omit<ReplyAction, "trigger">>> = {
  continue: { kind: "continue", label: "Continue", icon: "arrow_right", message: "continue" },
  "go-ahead": { kind: "go-ahead", label: "Yes, go ahead", icon: "check", message: "yes — go ahead with what you proposed" },
  retry: { kind: "retry", label: "Retry", icon: "retry", message: "retry that" },
  shorter: { kind: "shorter", label: "Shorter", icon: "scissors", message: "give me the short version" },
  sources: { kind: "sources", label: "Sources", icon: "book", message: "list the sources you used" },
  thread: { kind: "thread", label: "In a thread", icon: "messages_square", message: "continue this in a thread" },
  file: { kind: "file", label: "As a file", icon: "paperclip", message: "send that as a file" },
  remember: { kind: "remember", label: "Remember", icon: "brain", message: "remember that" },
};

/**
 * Decide which actions a reply earns. Deterministic, ordered by usefulness,
 * capped at MAX_REPLY_ACTIONS. Returns [] for the common short reply.
 */
export function evaluateReplyActions(input: ReplyActionInput): readonly ReplyAction[] {
  const out: ReplyAction[] = [];
  const text = input.text;
  const short = text.length < MIN_CHARS_FOR_ACTIONS;

  if (input.failed === true || input.cutShortReason !== undefined) {
    const reason = input.cutShortReason ?? "failed";
    out.push({ ...CATALOG.retry, trigger: `failed:${reason}` });
    if (text.trim().length > 0) out.push({ ...CATALOG.continue, trigger: `cut-short:${reason}` });
  } else if (endsWithOffer(text)) {
    // An offer earns a one-tap yes. "Continue" is reserved for cut-short turns.
    out.push({ ...CATALOG["go-ahead"], trigger: "ends-with-offer" });
  }

  if (!short) {
    const urls = countUrls(text);
    if (input.nSources >= 2 || urls >= 2) {
      out.push({ ...CATALOG.sources, trigger: input.nSources >= 2 ? `sources:${input.nSources}` : `urls:${urls}` });
    }
    if (input.chunked || text.length > SHORTER_THRESHOLD_CHARS) {
      out.push({ ...CATALOG.shorter, trigger: input.chunked ? "chunked" : `chars:${text.length}` });
    }
    const rows = countStructuredRows(text);
    if (rows >= FILE_ROW_THRESHOLD) out.push({ ...CATALOG.file, trigger: `rows:${rows}` });
    if (input.durationMs >= THREAD_THRESHOLD_MS || (input.subagentCount ?? 0) > 0) {
      out.push({
        ...CATALOG.thread,
        trigger: (input.subagentCount ?? 0) > 0 ? `subagents:${input.subagentCount}` : `duration:${Math.round(input.durationMs / 1000)}s`,
      });
    }
  }

  // Model-proposed actions fill remaining slots; deterministic ones win collisions.
  for (const p of input.proposed ?? []) {
    if (out.length >= MAX_REPLY_ACTIONS) break;
    if (out.some((a) => a.kind === p.kind || a.label.toLowerCase() === p.label.toLowerCase())) continue;
    out.push(p);
  }

  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.kind + a.label) ? false : (seen.add(a.kind + a.label), true))).slice(0, MAX_REPLY_ACTIONS);
}

// ─────────────────────────── model-proposed <actions> ───────────────────────────

const ACTIONS_BLOCK = /<actions>\s*([\s\S]*?)\s*<\/actions>/i;
export const MAX_PROPOSED_ACTIONS = 2;
export const MAX_PROPOSED_LABEL = 20;
export const MAX_PROPOSED_MESSAGE = 200;

/**
 * Strip a model-emitted `<actions>[{"label":"…","message":"…"}]</actions>` block
 * and return the validated actions. Malformed blocks are stripped and ignored —
 * the user must never see the tag, and a bad block must never break delivery.
 */
export function parseActionsBlock(text: string): { readonly text: string; readonly actions: readonly ReplyAction[] } {
  const m = ACTIONS_BLOCK.exec(text);
  if (!m) return { text, actions: [] };
  const stripped = text.replace(ACTIONS_BLOCK, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1] ?? "");
  } catch {
    return { text: stripped, actions: [] };
  }
  if (!Array.isArray(parsed)) return { text: stripped, actions: [] };
  const actions: ReplyAction[] = [];
  for (const item of parsed) {
    if (actions.length >= MAX_PROPOSED_ACTIONS) break;
    if (typeof item !== "object" || item === null) continue;
    const label = String((item as { label?: unknown }).label ?? "").trim();
    const message = String((item as { message?: unknown }).message ?? "").trim();
    if (label.length === 0 || label.length > MAX_PROPOSED_LABEL) continue;
    if (message.length === 0 || message.length > MAX_PROPOSED_MESSAGE) continue;
    actions.push({ kind: "custom", label, icon: "sparkles", message, trigger: "model-proposed" });
  }
  return { text: stripped, actions };
}

// ─────────────────────────── 999.172 prompt suggestion ───────────────────────────
//
// Consent rule (PR #190 review): the button label IS the full suggestion and a
// click sends exactly that text — nothing the user did not see. The text is
// model output (steerable by prompt injection), so it is also sanitized:
// whitespace collapsed; empty, over-long (> Discord's 80-char label max),
// mention-bearing or URL-bearing suggestions are dropped, never trimmed.

/** Discord's button label limit; a longer suggestion is dropped, not cut. */
export const MAX_SUGGESTION_LABEL = 80;

const SUGGESTION_MENTION = /<@|<#|@everyone|@here/i;
const SUGGESTION_URL = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|app|dev|ai|co|me|ly|gg|xyz|info|biz)\b/i;

export type SuggestionActionResult =
  | { readonly kind: "ok"; readonly action: ReplyAction }
  | { readonly kind: "drop"; readonly reason: "empty" | "too-long" | "unsafe" };

/**
 * The reply action for a prompt suggestion, or the reason it is dropped.
 * Label and click message are the same sanitized text.
 */
export function suggestionAction(suggestion: unknown): SuggestionActionResult {
  if (typeof suggestion !== "string") return { kind: "drop", reason: "empty" };
  const text = suggestion.replace(/\s+/g, " ").trim();
  if (text.length === 0) return { kind: "drop", reason: "empty" };
  if (text.length > MAX_SUGGESTION_LABEL) return { kind: "drop", reason: "too-long" };
  if (SUGGESTION_MENTION.test(text) || SUGGESTION_URL.test(text)) return { kind: "drop", reason: "unsafe" };
  return {
    kind: "ok",
    action: { kind: "suggestion", label: text, icon: "lightbulb", message: text, trigger: "prompt-suggestion" },
  };
}

// ─────────────────────────── Discord wire shapes ───────────────────────────

/** customId = `ra:<messageId>:<index>` — index into the registered action list. */
export function replyActionCustomId(messageId: string, index: number): string {
  return `${RA_PREFIX}${messageId}:${index}`;
}

export function parseReplyActionCustomId(customId: string): { readonly messageId: string; readonly index: number } | null {
  if (!customId.startsWith(RA_PREFIX)) return null;
  const rest = customId.slice(RA_PREFIX.length);
  const i = rest.lastIndexOf(":");
  if (i <= 0) return null;
  const index = Number.parseInt(rest.slice(i + 1), 10);
  if (!Number.isInteger(index) || index < 0) return null;
  return { messageId: rest.slice(0, i), index };
}

/** Plain component JSON (type 1 row of type 2 secondary buttons) — no builder dependency. */
export function buildReplyActionRow(messageId: string, actions: readonly ReplyAction[]): {
  readonly type: 1;
  readonly components: ReadonlyArray<{ readonly type: 2; readonly style: 2; readonly custom_id: string; readonly label: string; readonly emoji?: { readonly id: string; readonly name: string } }>;
} {
  return {
    type: 1,
    components: actions.slice(0, MAX_REPLY_ACTIONS).map((a, i) => ({
      type: 2,
      style: 2,
      custom_id: replyActionCustomId(messageId, i),
      label: a.label,
      ...(icons.button(a.icon) ? { emoji: icons.button(a.icon) } : {}),
    })),
  };
}

// ─────────────────────────── registry (single-use, expiring) ───────────────────────────

export type ReplyActionEntry = {
  readonly messageId: string;
  readonly channelId: string;
  readonly agentName: string;
  /** Only this user may click — the addressee of the reply. */
  readonly userId: string;
  /** The user message the reply answered; a click re-dispatches on it. */
  readonly originalMessageId: string;
  readonly actions: readonly ReplyAction[];
  /** Rows to keep on the message when the action row is removed (e.g. the 🧾 ledger row). */
  readonly keepRows: readonly unknown[];
  /** The delivered reply text — v1.3 in-place rewrites (Shorter) work from it without a session turn. */
  readonly replyText?: string;
  readonly shownAt: number;
  readonly expiresAt: number;
};

export type ClickOutcome =
  | { readonly kind: "ok"; readonly entry: ReplyActionEntry; readonly action: ReplyAction }
  | { readonly kind: "not-yours" }
  | { readonly kind: "expired" }
  | { readonly kind: "unknown" };

/** 999.172 — outcome of appending one action to a shown row. */
export type AppendOutcome =
  | { readonly kind: "ok"; readonly entry: ReplyActionEntry }
  | { readonly kind: "missing" }
  | { readonly kind: "expired" }
  | { readonly kind: "full" }
  | { readonly kind: "duplicate" };

/**
 * In-memory, per-process. Entries are single-use: the first valid click
 * consumes the whole row (the message is edited to drop it). Expiry is the
 * bridge's job to *render*; the registry only reports it.
 */
export class ReplyActionRegistry {
  private readonly entries = new Map<string, ReplyActionEntry>();

  constructor(private readonly ttlMs: number = REPLY_ACTION_TTL_MS, private readonly now: () => number = () => Date.now()) {}

  register(input: Omit<ReplyActionEntry, "shownAt" | "expiresAt">): ReplyActionEntry {
    const shownAt = this.now();
    const entry: ReplyActionEntry = { ...input, shownAt, expiresAt: shownAt + this.ttlMs };
    this.entries.set(input.messageId, entry);
    return entry;
  }

  /** Resolve a click. A successful resolution consumes the entry. */
  click(customId: string, userId: string): ClickOutcome {
    const parsed = parseReplyActionCustomId(customId);
    if (!parsed) return { kind: "unknown" };
    const entry = this.entries.get(parsed.messageId);
    if (!entry) return { kind: "expired" };
    if (entry.userId !== userId) return { kind: "not-yours" };
    if (this.now() > entry.expiresAt) {
      this.entries.delete(parsed.messageId);
      return { kind: "expired" };
    }
    const action = entry.actions[parsed.index];
    if (!action) return { kind: "unknown" };
    this.entries.delete(parsed.messageId);
    return { kind: "ok", entry, action };
  }

  /**
   * 999.172 — append one action to a row that is still showing. customIds are
   * positional (`ra:<messageId>:<index>`), so existing actions keep their
   * indices and the new one goes last. The row's original expiry is kept (the
   * bridge's single TTL timer still owns removal); a consumed row is never
   * resurrected; the cap and duplicates are refused.
   */
  append(messageId: string, action: ReplyAction): AppendOutcome {
    const entry = this.entries.get(messageId);
    if (!entry) return { kind: "missing" };
    if (this.now() > entry.expiresAt) return { kind: "expired" };
    if (entry.actions.length >= MAX_REPLY_ACTIONS) return { kind: "full" };
    const msg = action.message.trim().toLowerCase();
    const label = action.label.trim().toLowerCase();
    if (entry.actions.some((a) => a.message.trim().toLowerCase() === msg || a.label.trim().toLowerCase() === label)) {
      return { kind: "duplicate" };
    }
    const next: ReplyActionEntry = { ...entry, actions: [...entry.actions, action] };
    this.entries.set(messageId, next);
    return { kind: "ok", entry: next };
  }

  /** Remove and return an entry (for the expiry edit), or undefined if already consumed. */
  expire(messageId: string): ReplyActionEntry | undefined {
    const entry = this.entries.get(messageId);
    if (entry) this.entries.delete(messageId);
    return entry;
  }

  size(): number {
    return this.entries.size;
  }
}

// ───────────────────── v1.3 — "Shorter" replaces the reply in place ─────────────────────
//
// Operator (2026-09-23): "If I say 'shorter' can it replace the original message
// instead?" Yes: the Shorter button, or a typed `shorter` / `tl;dr`, rewrites
// the LAST delivered reply with the fast lane's haiku path (seconds, no session
// turn) and EDITS the original message — the channel ends up with one short
// reply, not two. The short version is captured to the conversation store; the
// session's own transcript still holds the long one.

/** A typed message that means "shorten your last reply" — short, explicit forms only. */
export function isShorterRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  return /^(shorter|shorter please|make (it|that) shorter|tl;?dr|(the |give me the )?short version|too long|condense (it|that))$/.test(t);
}

export type LastReply = {
  readonly channelId: string;
  readonly messageId: string;
  readonly agentName: string;
  /** The addressee — only they can shorten it by typing. */
  readonly userId: string;
  readonly text: string;
  readonly at: number;
};

export const LAST_REPLY_MAX_AGE_MS = 10 * 60 * 1000;

/** The most recent delivered reply per channel, so a typed "shorter" knows its target. */
export class LastReplyTracker {
  private readonly byChannel = new Map<string, LastReply>();

  constructor(private readonly maxAgeMs: number = LAST_REPLY_MAX_AGE_MS, private readonly now: () => number = () => Date.now()) {}

  record(entry: Omit<LastReply, "at"> & { readonly at?: number }): void {
    this.byChannel.set(entry.channelId, { ...entry, at: entry.at ?? this.now() });
  }

  /** The latest reply in the channel if it is still fresh; otherwise undefined. */
  get(channelId: string): LastReply | undefined {
    const e = this.byChannel.get(channelId);
    if (!e) return undefined;
    if (this.now() - e.at > this.maxAgeMs) {
      this.byChannel.delete(channelId);
      return undefined;
    }
    return e;
  }

  size(): number {
    return this.byChannel.size;
  }
}

/** Target length for a shortened reply; comfortably one Discord message with its note. */
export const SHORTEN_MAX_CHARS = 700;
/** Replies below this are already short; the button never shows and typed requests fall through. */
export const SHORTEN_MIN_SOURCE_CHARS = 200;

export const SHORTEN_SYSTEM_PROMPT = `You shorten one chat reply that an assistant already sent. Rules:
- Keep every concrete fact, number, name, date, decision and next step; drop preamble, repetition, hedging and pleasantries.
- Same voice and tense as the original; plain text or minimal markdown; no headings; no new information.
- Reply with ONLY the shortened text.`;

export function buildShortenPrompt(text: string, maxChars: number = SHORTEN_MAX_CHARS): string {
  return `Shorten the reply below to at most ${maxChars} characters.\n\n<reply>\n${text.trim().slice(0, 12_000)}\n</reply>`;
}

export type ShortenOutcome = { readonly kind: "ok"; readonly text: string } | { readonly kind: "unusable"; readonly reason: "empty" | "not-shorter" | "too-long" };

/** Accept only a real reduction that fits; anything else falls back to the ordinary path. */
export function parseShortened(raw: string, original: string, maxChars: number = SHORTEN_MAX_CHARS): ShortenOutcome {
  const text = raw.trim().replace(/^<reply>\s*|\s*<\/reply>$/g, "").trim();
  if (text.length === 0) return { kind: "unusable", reason: "empty" };
  if (text.length >= original.trim().length) return { kind: "unusable", reason: "not-shorter" };
  if (text.length > maxChars * 1.3) return { kind: "unusable", reason: "too-long" };
  return { kind: "ok", text };
}

/** The subtext note under a shortened reply (icon when the set is loaded). */
export function shortenedNote(): string {
  return icons.prefix("scissors", "shortened");
}

/**
 * 999.163 — streamed partials must never flash the machine block. Cut at the
 * first `<actions>`; if the partial ends in a prefix of the tag ("<act"), cut
 * that tail too, since the next chunk would complete it.
 */
export function stripActionsForStreaming(partial: string): string {
  const at = partial.indexOf("<actions>");
  if (at >= 0) return partial.slice(0, at).trimEnd();
  const m = /<a(?:c(?:t(?:i(?:o(?:n(?:s>?)?)?)?)?)?)?$/.exec(partial);
  return m ? partial.slice(0, m.index).trimEnd() : partial;
}
