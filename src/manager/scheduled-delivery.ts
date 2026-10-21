/**
 * 999.178 R1 — scheduled-delivery robustness helpers (pure).
 *
 * Trigger-fired output (cron schedules, reminders, recurring tasks) used to be
 * TRUNCATED at 2000 chars and, on a Discord hiccup, silently dropped: the
 * TriggerEngine advances the watermark BEFORE delivery (so a failed tick is
 * never re-dispatched — re-running the agent turn would double the work and
 * cost), and a delivery throw was only warn-logged. A missed birthday card or
 * status post just vanished.
 *
 * These pure helpers give the daemon's `triggerDeliveryFn` a bounded retry and
 * an operator dead-letter so a failed scheduled post is never lost. Chunking
 * (never truncating) and draft extraction live at the daemon call site with the
 * outbound splitters; only the retry loop and the dead-letter text — the
 * testable decision logic — live here.
 */

import {
  extractDrafts,
  splitDraftForDelivery,
  DRAFT_ONLY_BODY,
} from "../discord/draft-extract.js";
import { stripIconShortcodes } from "../discord/icon-shortcodes.js";
import {
  formatOutboundText,
  splitKeepingAnnotations,
} from "../discord/markdown-table-wrap.js";
import { splitMessage } from "../messaging/split.js";

/** Discord's hard per-message ceiling. */
export const SCHEDULED_MAX_MESSAGE_LENGTH = 2000;

/** Attempts per atomic post before dead-lettering (1 initial + 2 retries). */
export const SCHEDULED_DELIVERY_ATTEMPTS = 3;
/** Backoff base; the nth retry waits `base * 2^(n-1)` ms (500ms, 1000ms). */
export const SCHEDULED_DELIVERY_BASE_BACKOFF_MS = 500;
/** How much of the undelivered output the dead-letter quotes back to the operator. */
export const DEAD_LETTER_PREVIEW_CHARS = 300;

export type RetryResult =
  | { readonly ok: true; readonly attempts: number }
  | { readonly ok: false; readonly error: string; readonly attempts: number };

export type RetryOptions = {
  readonly attempts?: number;
  readonly baseBackoffMs?: number;
  /** Injectable for tests (avoids real timers). Defaults to setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Observed on every failed attempt (for warn-logging at the call site). */
  readonly onAttemptError?: (attempt: number, error: string) => void;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `send` with bounded exponential backoff. Resolves `{ok:true}` on the
 * first success; `{ok:false, error}` only after every attempt has thrown. Never
 * throws — the caller decides what a total failure means (dead-letter). Total
 * added latency at the defaults is ~1.5s (the engine awaits this), so it stays
 * well inside a scheduled tick's budget.
 */
export async function retryWithBackoff(
  send: () => Promise<unknown>,
  opts: RetryOptions = {},
): Promise<RetryResult> {
  const attempts = opts.attempts ?? SCHEDULED_DELIVERY_ATTEMPTS;
  const base = opts.baseBackoffMs ?? SCHEDULED_DELIVERY_BASE_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await send();
      return { ok: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      opts.onAttemptError?.(attempt, lastError);
      if (attempt < attempts) await sleep(base * 2 ** (attempt - 1));
    }
  }
  return { ok: false, error: lastError, attempts };
}

export type DeadLetterInfo = {
  readonly agent: string;
  /** Human-readable schedule identity — the trigger sourceId, or a caller label. */
  readonly label: string;
  readonly error: string;
  /** The full undelivered output; a preview is quoted so the content isn't lost. */
  readonly preview: string;
  /** Which post in the ordered sequence failed (0-based) and how many there were. */
  readonly postIndex: number;
  readonly postCount: number;
  readonly attempts: number;
};

/**
 * The operator dead-letter for a scheduled post that could not be delivered.
 * Plain text, no glyphs (icon rule: never a Unicode emoji from these paths;
 * this is an operator alert, so no `cc_*` icon is required either). Carries
 * enough to act: which agent and schedule, where in the sequence it failed, the
 * error, and a preview so the content is recoverable.
 */
export function formatScheduledDeadLetter(info: DeadLetterInfo): string {
  const collapsed = info.preview.replace(/\s+/g, " ").trim();
  const preview = collapsed.slice(0, DEAD_LETTER_PREVIEW_CHARS);
  const ellipsis = collapsed.length > DEAD_LETTER_PREVIEW_CHARS ? "…" : "";
  return [
    `Scheduled delivery failed — output NOT delivered after ${info.attempts} attempts.`,
    `- agent: ${info.agent}`,
    `- schedule: ${info.label}`,
    `- failed on message ${info.postIndex + 1} of ${info.postCount}`,
    `- error: ${info.error}`,
    `- preview: ${preview}${ellipsis}`,
  ].join("\n");
}

/** A flapping schedule can't spam the operator: at most one post per this window. */
export const DEAD_LETTER_MIN_INTERVAL_MS = 30 * 60_000;

/**
 * Rate-limits dead-letter posts per (agent, schedule): at most one Admin Clawdy
 * post per {@link DEAD_LETTER_MIN_INTERVAL_MS}. Failures inside the window are
 * counted, and the next post that gets through appends
 * "(+N more failures suppressed since <time>)" so nothing is hidden. Pure and
 * injectable (clock + in-memory state map) — the daemon owns one instance so it
 * survives across ticks; a restart resets it (documented).
 */
export class DeadLetterRateLimiter {
  private readonly state = new Map<
    string,
    { lastPostedAt: number; suppressed: number; firstSuppressedAt: number }
  >();

  constructor(
    private readonly minIntervalMs: number = DEAD_LETTER_MIN_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Decide whether to post a dead-letter for (agent, label). Returns the text to
   * post (with the suppressed-summary suffix when failures accrued since the
   * last post), or `null` to suppress this one.
   */
  gate(agent: string, label: string, message: string): string | null {
    const key = `${agent}\u0000${label}`;
    const now = this.now();
    const prev = this.state.get(key);
    if (prev && now - prev.lastPostedAt < this.minIntervalMs) {
      this.state.set(key, {
        lastPostedAt: prev.lastPostedAt,
        suppressed: prev.suppressed + 1,
        firstSuppressedAt: prev.suppressed === 0 ? now : prev.firstSuppressedAt,
      });
      return null;
    }
    const suffix =
      prev && prev.suppressed > 0
        ? `\n- (+${prev.suppressed} more failure${prev.suppressed === 1 ? "" : "s"} suppressed since ${new Date(prev.firstSuppressedAt).toISOString()})`
        : "";
    this.state.set(key, { lastPostedAt: now, suppressed: 0, firstSuppressedAt: 0 });
    return `${message}${suffix}`;
  }
}

export type ScheduledDeliveryDeps = {
  /** True when the agent has a webhook (identity send that splits internally). */
  readonly hasWebhook: boolean;
  /** Post one logical message via the webhook (WebhookManager.send splits it). */
  readonly sendWebhook: (text: string) => Promise<unknown>;
  /** Post one already-≤max chunk via bot-direct (sendText does NOT split). */
  readonly sendBotDirect: (chunk: string) => Promise<unknown>;
  /** Deliver the operator dead-letter (never throws by contract). */
  readonly deadLetter: (message: string) => Promise<void>;
  /** Observed on every failed post attempt, for warn-logging. */
  readonly onAttemptError?: (info: {
    readonly postIndex: number;
    readonly postCount: number;
    readonly attempt: number;
    readonly error: string;
  }) => void;
  readonly maxChars?: number;
  readonly attempts?: number;
  /** Injectable backoff sleep for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
};

export type ScheduledDeliveryResult = {
  /** How many atomic posts landed before stopping. */
  readonly posted: number;
  /** True when a post exhausted its retries and was dead-lettered. */
  readonly deadLettered: boolean;
};

/**
 * Plan and deliver one trigger-fired response: extract a client-facing
 * ```draft``` block from the RAW text (before formatting, which would wrap
 * tables in ```text``` fences the matcher grabs), CHUNK the analysis and each
 * draft piece so nothing is truncated, and post each atomic message with
 * bounded retry. A post that exhausts its attempts is dead-lettered to the
 * operator (agent, schedule label, position, error, preview) and the remaining
 * posts are abandoned — re-posting the earlier ones would duplicate. Pure of
 * daemon plumbing: every side effect is an injected dependency, so the chunking
 * / retry / dead-letter wiring is unit-testable. The caller keeps the watermark
 * semantics (advance-before-delivery) — a failed post is dead-lettered, never
 * re-dispatched.
 */
export async function deliverScheduledOutput(
  response: string,
  agent: string,
  label: string,
  deps: ScheduledDeliveryDeps,
): Promise<ScheduledDeliveryResult> {
  const maxChars = deps.maxChars ?? SCHEDULED_MAX_MESSAGE_LENGTH;
  const ex = extractDrafts(response);
  const analysis =
    ex.drafts.length > 0
      ? ex.text.trim().length > 0
        ? ex.text
        : DRAFT_ONLY_BODY
      : response;

  const posts: Array<() => Promise<unknown>> = [];
  const pushText = (text: string): void => {
    if (text.trim().length === 0) return;
    if (deps.hasWebhook) {
      posts.push(() => deps.sendWebhook(text));
    } else {
      for (const chunk of splitKeepingAnnotations(
        formatOutboundText(text),
        maxChars,
        splitMessage,
      )) {
        posts.push(() => deps.sendBotDirect(chunk));
      }
    }
  };
  pushText(analysis);
  // Drafts are client-facing (pasted into texts/emails): strip every icon
  // token, whether still a `:cc_x:` shortcode or already rendered upstream.
  for (const draft of ex.drafts) {
    const clean = stripIconShortcodes(draft);
    for (const piece of splitDraftForDelivery(clean, maxChars)) pushText(piece);
  }

  for (let i = 0; i < posts.length; i++) {
    const result = await retryWithBackoff(posts[i]!, {
      attempts: deps.attempts ?? SCHEDULED_DELIVERY_ATTEMPTS,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      onAttemptError: (attempt, error) =>
        deps.onAttemptError?.({ postIndex: i, postCount: posts.length, attempt, error }),
    });
    if (result.ok) continue;
    await deps.deadLetter(
      formatScheduledDeadLetter({
        agent,
        label,
        error: result.error,
        preview: response,
        postIndex: i,
        postCount: posts.length,
        attempts: result.attempts,
      }),
    );
    return { posted: i, deadLettered: true };
  }
  return { posted: posts.length, deadLettered: false };
}
