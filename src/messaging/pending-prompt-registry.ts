/**
 * Phase 145 WS3 (Plan 04) — the platform-neutral pending-prompt registry.
 *
 * The `ask_user_question` MCP tool blocks a worker mid-tool-call awaiting the
 * operator's answer. On a platform WITHOUT native interactive components
 * (Slack today — `interactivePrompt: false`) the answer arrives as a NORMAL
 * inbound message. `bridge.handleMessage` (and, in Plan 07, the Slack
 * `onSlackEvent` path) would otherwise dispatch that reply as a FRESH TURN —
 * the single most under-explored WS3 landmine (RESEARCH Pitfall 4 / LANDMINE B):
 * the blocked tool call never resolves AND a spurious turn spawns.
 *
 * This module is the fix: a per-`(platform, channelId)` registry that the
 * inbound handler consults BEFORE turn dispatch. On a match (a pending prompt
 * exists for that channel AND the sender is in the prompt's fail-closed
 * operator allowlist AND the reply parses to valid option(s)) it resolves the
 * blocked tool call and the handler suppresses the turn. On any miss it is an
 * O(1) no-op so the non-pending inbound path stays byte-identical.
 *
 * SINGLETON: exactly ONE instance is shared across BOTH the Discord bridge
 * (this plan, `bridge.ts handleMessage`) AND the Slack adapter (Plan 07,
 * `onSlackEvent`). It is exported as the module-level `pendingPromptRegistry`
 * const — module caching gives the single instance with no injection plumbing.
 * Tests instantiate `PendingPromptRegistry` directly so timers do not leak
 * across cases.
 *
 * Operator attribution is FAIL-CLOSED (the `CLAWCODE_ACCTLINK_AUTHORIZED_IDS`
 * model): an empty allowlist means NO ONE can answer via this registry —
 * never trust-first-replier (RESEARCH Security Domain / T-145-10).
 *
 * The bounded timeout is DAEMON-OWNED (the IPC client has no socket timeout):
 * the registry exposes `register` with a `timeoutMs` + `onTimeout` so the
 * daemon handler always settles (answer or clean timeout) and the entry is
 * cleared either way (T-145-11).
 */

import type {
  NeutralQuestion,
  NeutralAnswer,
  NeutralAnswers,
  PlatformCapabilities,
  PlatformKind,
} from "./types.js";

/** A registered, currently-pending prompt awaiting the operator's answer. */
export interface PendingPromptEntry {
  /** Correlation id (nanoid) issued by the daemon handler. */
  readonly promptId: string;
  /** The platform the prompt was posted to. */
  readonly platform: PlatformKind;
  /** The channel the prompt was posted to (the routing key, with platform). */
  readonly channelId: string;
  /** The neutral question batch (≤4) used to parse a text reply. */
  readonly questions: readonly NeutralQuestion[];
  /**
   * The fail-closed operator allowlist. Only a `senderId` in this set may
   * resolve the prompt. EMPTY → no one can answer (the daemon surfaces a
   * `no-operator` reason before ever registering, but the registry stays
   * fail-closed defensively).
   */
  readonly allowlistIds: readonly string[];
  /** Invoked with the parsed answers when the operator resolves the prompt. */
  readonly resolve: (answers: NeutralAnswers) => void;
  /** Node timer handle for the daemon-owned bounded timeout. */
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
}

/** Inputs to {@link PendingPromptRegistry.register}. */
export interface RegisterArgs {
  readonly promptId: string;
  readonly platform: PlatformKind;
  readonly channelId: string;
  readonly questions: readonly NeutralQuestion[];
  readonly allowlistIds: readonly string[];
  readonly timeoutMs: number;
  /** Resolves the blocked tool call with the operator's answer. */
  readonly resolve: (answers: NeutralAnswers) => void;
  /** Fired (once) when the bounded timeout elapses with no answer. */
  readonly onTimeout: () => void;
}

/** Result of {@link PendingPromptRegistry.tryResolve}. */
export type TryResolveResult =
  | { readonly resolved: false }
  | { readonly resolved: true; readonly answers: NeutralAnswers };

/** Compose the internal map key from platform + channel. */
function keyFor(platform: PlatformKind, channelId: string): string {
  return `${platform}:${channelId}`;
}

/**
 * Map a 1-based numbered text reply to {@link NeutralAnswers}. PURE.
 *
 * Supports:
 *  - single-select questions: a single index ("2")
 *  - multiSelect questions: a comma/space-separated list ("1,3" / "1 3")
 *
 * Out-of-range indices, non-numeric tokens, an empty reply, more than one
 * index for a single-select question, or any question left unanswered →
 * returns `null` (unparseable → the caller does NOT resolve). For a batch the
 * reply is one line per question (split on newline); a single-question batch
 * accepts the whole reply as that question's selection.
 */
export function parseTextReply(
  questions: readonly NeutralQuestion[],
  replyText: string,
): NeutralAnswers | null {
  const trimmed = replyText.trim();
  if (trimmed.length === 0) return null;
  if (questions.length === 0) return null;

  // One line per question (a single-question batch may be a bare "2").
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim());
  if (lines.length !== questions.length) {
    // Allow a single-question batch where the reply is a single line even if
    // it contains internal whitespace (e.g. "1 3" multiSelect). Otherwise the
    // line count must match the question count.
    if (!(questions.length === 1 && lines.length === 1)) return null;
  }

  const answers: NeutralAnswer[] = [];
  for (let qi = 0; qi < questions.length; qi++) {
    const question = questions[qi];
    const line = lines[qi] ?? "";
    const tokens = line.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) return null;
    if (!question.multiSelect && tokens.length > 1) return null;

    const selectedOptionIds: string[] = [];
    const seen = new Set<number>();
    for (const tok of tokens) {
      if (!/^\d+$/.test(tok)) return null;
      const idx = Number.parseInt(tok, 10); // 1-based
      if (idx < 1 || idx > question.options.length) return null;
      if (seen.has(idx)) return null; // duplicate pick → reject
      seen.add(idx);
      selectedOptionIds.push(question.options[idx - 1].id);
    }
    answers.push({ questionId: question.id, selectedOptionIds });
  }

  return { answers };
}

/**
 * Decide how to render a prompt for a platform. PURE.
 *
 * `interactivePrompt: true` → `"native"` (Discord buttons/select today; Slack
 * Block Kit once Plan 07 lands). `false` → `"text"` (the universal numbered
 * text fallback). Capability-gated graceful degradation — no per-platform
 * special-casing at the call site.
 */
export function decideRenderMode(
  capabilities: PlatformCapabilities,
): "native" | "text" {
  return capabilities.interactivePrompt ? "native" : "text";
}

/**
 * Is `senderId` allowed to answer under this fail-closed allowlist? An empty
 * allowlist denies everyone (never trust-first-replier).
 */
export function isOperator(
  allowlistIds: readonly string[],
  senderId: string,
): boolean {
  return allowlistIds.length > 0 && allowlistIds.includes(senderId);
}

/**
 * The per-`(platform, channelId)` pending-prompt registry. One entry per
 * channel at a time (a second register for the same channel cancels the
 * first — the prior prompt's resolve was already settled by its own timeout
 * or is being superseded). Methods are synchronous + side-effect-bounded so
 * the inbound handler's `tryResolve` call is cheap.
 */
export class PendingPromptRegistry {
  private readonly entries = new Map<string, PendingPromptEntry>();

  /**
   * Register a pending prompt + arm its daemon-owned bounded timeout. Returns
   * nothing; the caller awaits its own Promise (resolved via the stored
   * `resolve` on answer, or via `onTimeout` → the caller's timeout settle).
   *
   * If an entry already exists for the same channel it is cancelled first
   * (its timer cleared) so only one prompt is live per channel.
   */
  register(args: RegisterArgs): void {
    const key = keyFor(args.platform, args.channelId);
    const existing = this.entries.get(key);
    if (existing) {
      clearTimeout(existing.timeoutHandle);
      this.entries.delete(key);
    }

    const timeoutHandle = setTimeout(() => {
      // Idempotent settle: only fire if still the live entry for this key.
      const current = this.entries.get(key);
      if (current && current.promptId === args.promptId) {
        this.entries.delete(key);
        args.onTimeout();
      }
    }, args.timeoutMs);
    // Do not keep the event loop alive solely for a pending prompt.
    if (typeof timeoutHandle === "object" && "unref" in timeoutHandle) {
      (timeoutHandle as { unref: () => void }).unref();
    }

    this.entries.set(key, {
      promptId: args.promptId,
      platform: args.platform,
      channelId: args.channelId,
      questions: args.questions,
      allowlistIds: args.allowlistIds,
      resolve: args.resolve,
      timeoutHandle,
    });
  }

  /**
   * Attempt to resolve a pending prompt with an inbound reply. FAIL-CLOSED.
   *
   * Resolves ONLY when ALL hold:
   *  - a pending prompt exists for `(platform, channelId)`
   *  - `senderId` is in that prompt's operator allowlist
   *  - `replyText` parses to valid option index(es) for the batch
   *
   * On resolve it clears the timer, removes the entry, invokes the stored
   * `resolve(answers)`, and returns `{ resolved: true, answers }`. On ANY
   * miss (no pending / non-operator / unparseable) it returns
   * `{ resolved: false }` and leaves the entry intact so the inbound message
   * falls through to normal turn dispatch (non-operator chatter is NOT
   * consumed; a garbage reply from the operator is also left for the agent /
   * the timeout — it does not silently eat the message).
   */
  tryResolve(
    platform: PlatformKind,
    channelId: string,
    senderId: string,
    replyText: string,
  ): TryResolveResult {
    const key = keyFor(platform, channelId);
    const entry = this.entries.get(key);
    if (!entry) return { resolved: false };
    if (!isOperator(entry.allowlistIds, senderId)) return { resolved: false };

    const answers = parseTextReply(entry.questions, replyText);
    if (!answers) return { resolved: false };

    clearTimeout(entry.timeoutHandle);
    this.entries.delete(key);
    entry.resolve(answers);
    return { resolved: true, answers };
  }

  /**
   * Cancel a pending prompt by its promptId (the daemon handler calls this on
   * timeout / failure to clear the entry + timer). No-op if already settled.
   */
  cancel(promptId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.promptId === promptId) {
        clearTimeout(entry.timeoutHandle);
        this.entries.delete(key);
        return;
      }
    }
  }

  /** Test/observability helper — number of live pending prompts. */
  size(): number {
    return this.entries.size;
  }
}

/**
 * The SHARED singleton. BOTH the Discord bridge (`bridge.ts handleMessage`,
 * Plan 04) AND the Slack adapter (`onSlackEvent`, Plan 07) import THIS exact
 * instance so a text-fallback reply on either platform resolves the same
 * blocked tool call. Module caching guarantees a single instance.
 */
export const pendingPromptRegistry = new PendingPromptRegistry();
