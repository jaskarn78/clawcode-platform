/**
 * 999.178 R1 — Retry button for a turn that ended in failure.
 *
 * Before R1 a failed turn got only a ❌ reaction (and, for a mutating wedge, a
 * "please resend" line); the dead status text "react 🔍 to retry" pointed at a
 * feature that was never wired. Now every visible failure — a wedge with no
 * auto re-run, crash retries exhausted, a generic failure, or a no-answer /
 * empty turn — carries a one-line reason and a Retry button that re-dispatches
 * the EXACT message the model saw (`replayMessage`), so the user taps once instead
 * of retyping.
 *
 * Registry contract (mirrors reply-actions.ts, but its own `retry:` prefix so
 * the two are measured and routed apart):
 *   - single-use: the first valid click consumes the entry (the notice's button
 *     is disabled in the same handler). A second click finds no entry and is
 *     told the retry is spent — synchronous delete-on-click IS the dedupe, so
 *     no double-dispatch is possible even on a fast double-tap;
 *   - author-or-admin: only the message's original author, or a configured
 *     admin id, may click;
 *   - expiring: a failed turn is retryable for 24h (checked lazily on click;
 *     stale entries are pruned on register). In-memory + per-process — after a
 *     daemon restart a click finds no entry and gets an ephemeral "send it
 *     again", which is the correct degrade.
 *
 * Pure module: no discord.js calls, no timers, no I/O. The bridge owns the
 * Discord side (posting the notice, disabling the button, re-dispatching).
 */

import { icons } from "./icons.js";

export const RETRY_PREFIX = "retry:";

/** A failed turn stays retryable for a full day. */
export const RETRY_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

/** customId = `retry:<noticeMessageId>` — the failure-notice message the button sits on. */
export function retryCustomId(noticeMessageId: string): string {
  return `${RETRY_PREFIX}${noticeMessageId}`;
}

export function parseRetryCustomId(customId: string): string | null {
  if (!customId.startsWith(RETRY_PREFIX)) return null;
  const id = customId.slice(RETRY_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Plain component JSON: one secondary Retry button (cc_retry emoji when the set is loaded). */
export function buildRetryButtonRow(noticeMessageId: string): {
  readonly type: 1;
  readonly components: ReadonlyArray<{
    readonly type: 2;
    readonly style: 2;
    readonly custom_id: string;
    readonly label: string;
    readonly emoji?: { readonly id: string; readonly name: string };
  }>;
} {
  const emoji = icons.button("retry");
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        custom_id: retryCustomId(noticeMessageId),
        label: "Retry",
        ...(emoji ? { emoji } : {}),
      },
    ],
  };
}

/**
 * Failure kinds a terminal turn can end in. The user-facing reason is a plain
 * sentence — the raw error is never shown (the orphan-delivery policy already
 * calls a raw abort string a leak). A wedge/stall carries the classifier's own
 * wording (`describeStallNotice`) instead of these.
 *
 * `"no-answer"` and {@link classifyFailure} are RESERVED for the deferred
 * no-answer/empty-turn Retry (see the bridge success-tail comment): the terminal
 * paths pass their kind directly, so only `plainFailureReason` is wired in
 * production today. Kept so the follow-up that adds a reliable no-tool signal
 * can turn it on without a taxonomy change.
 */
export type FailureKind = "crash" | "queue-full" | "no-answer" | "generic";

/** Map a caught error message to a failure kind, defaulting to generic. Reserved (see above). */
export function classifyFailure(errorMsg: string): FailureKind {
  if (errorMsg.includes("code 143") || errorMsg.includes("is not running")) return "crash";
  if (/queue[\s_-]*full/i.test(errorMsg)) return "queue-full";
  return "generic";
}

/** The one-line, user-safe reason shown above the Retry button. */
export function plainFailureReason(kind: FailureKind): string {
  switch (kind) {
    case "crash":
      return "The session was restarting and couldn't pick that up in time.";
    case "queue-full":
      return "Too many messages at once — that one didn't get queued.";
    case "no-answer":
      return "That finished without a reply.";
    case "generic":
      return "Something went wrong on that one.";
  }
}

export type RetryEntry = {
  /** The failure-notice message that carries the Retry button. */
  readonly noticeMessageId: string;
  readonly channelId: string;
  readonly agentName: string;
  /** The addressee — the original message's author. Only they (or an admin) may click. */
  readonly userId: string;
  /** The user message the failed turn answered; a click re-dispatches ON it. */
  readonly originalMessageId: string;
  /** The formatted message the model saw — replayed verbatim so the retry is faithful. */
  readonly replayMessage: string;
  readonly registeredAt: number;
  readonly expiresAt: number;
};

export type RetryClickOutcome =
  | { readonly kind: "ok"; readonly entry: RetryEntry }
  | { readonly kind: "not-yours" }
  | { readonly kind: "expired" }
  | { readonly kind: "unknown" };

/**
 * In-memory, per-process. A click is resolved in two steps so the bridge can
 * interpose a busy-guard between them:
 *   1. `peek` — validate the customId, auth and TTL WITHOUT consuming, so a
 *      click that lands while the agent is still working keeps its button;
 *   2. `beginRetry` / `consume` / `endRetry` — once the bridge confirms the
 *      agent is idle, mark the notice in-flight (a second click on the same
 *      notice while a retry is running is a no-op), consume the single-use
 *      entry, dispatch, and clear the in-flight mark.
 */
export class RetryActionRegistry {
  private readonly entries = new Map<string, RetryEntry>();
  /** Notices whose retry is currently dispatching — dedupe a double-click. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly ttlMs: number = RETRY_ACTION_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  register(input: Omit<RetryEntry, "registeredAt" | "expiresAt">): RetryEntry {
    this.pruneExpired();
    const registeredAt = this.now();
    const entry: RetryEntry = { ...input, registeredAt, expiresAt: registeredAt + this.ttlMs };
    this.entries.set(input.noticeMessageId, entry);
    return entry;
  }

  /**
   * Validate a click WITHOUT consuming the entry: parse the customId, check
   * TTL, and check the clicker is the original author or a configured admin
   * (`adminIds` — e.g. an operator allowlist). The caller consumes the entry only once it has
   * decided to dispatch.
   */
  peek(customId: string, userId: string, adminIds: readonly string[] = []): RetryClickOutcome {
    const noticeId = parseRetryCustomId(customId);
    if (!noticeId) return { kind: "unknown" };
    const entry = this.entries.get(noticeId);
    if (!entry) return { kind: "expired" };
    if (this.now() > entry.expiresAt) {
      this.entries.delete(noticeId);
      return { kind: "expired" };
    }
    if (entry.userId !== userId && !adminIds.includes(userId)) return { kind: "not-yours" };
    return { kind: "ok", entry };
  }

  /** True if this notice's retry was newly marked in-flight; false if one is already running. */
  beginRetry(noticeMessageId: string): boolean {
    if (this.inFlight.has(noticeMessageId)) return false;
    this.inFlight.add(noticeMessageId);
    return true;
  }

  /** Clear the in-flight mark (in a finally, after the dispatch settles). */
  endRetry(noticeMessageId: string): void {
    this.inFlight.delete(noticeMessageId);
  }

  /** Whether a retry of this notice is currently dispatching. */
  isRetrying(noticeMessageId: string): boolean {
    return this.inFlight.has(noticeMessageId);
  }

  /** Single-use consume: delete the entry so its button can't be reused. */
  consume(noticeMessageId: string): RetryEntry | undefined {
    const entry = this.entries.get(noticeMessageId);
    if (entry) this.entries.delete(noticeMessageId);
    return entry;
  }

  /** Drop an entry without consuming it as a click (e.g. its notice message was deleted). */
  forget(noticeMessageId: string): RetryEntry | undefined {
    return this.consume(noticeMessageId);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(id);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
