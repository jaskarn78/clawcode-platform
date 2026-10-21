/**
 * Phase 89 Plan 01 Task 2 — restart-greeting.ts
 *
 * Pure helper module for the agent-restart greeting flow. Composes every
 * greeting rule into a single exported function `sendRestartGreeting` with
 * dependency injection for ALL I/O surfaces (webhook, conversation store,
 * summarizer, clock, logger, cool-down Map). Zero coupling to the session
 * manager's internals — Plan 89-02 wires the call at the restart chokepoint.
 *
 * Decisions honoured:
 *   - D-03/GREET-02: skip forks (`-fork-<nanoid6>`) and subagent threads
 *     (`-sub-<nanoid6>`) by name-suffix regex.
 *   - D-04/GREET-03: `classifyRestart(prevConsecutiveFailures)` returns
 *     "crash-suspected" when >0, "clean" otherwise.
 *   - D-05/D-06/GREET-04: fresh Haiku summarization at restart-time with
 *     a 10s AbortController; no fallback greeting on timeout.
 *   - D-07/GREET-03: embed carries the summary ONLY (no last-active
 *     timestamp, no model, no effort, no open-loops).
 *   - D-08/GREET-06: agent's own webhook identity via
 *     webhookManager.sendAsAgent (self-send).
 *   - D-09/GREET-07: `config.greetOnRestart === false` short-circuits.
 *   - D-10/GREET-05: dormancy threshold 7d; skip when last-activity >7d.
 *   - D-11/GREET-05: empty-state (zero terminated sessions OR zero turns
 *     OR empty summary) skips entirely — no fallback.
 *   - D-14/GREET-10: per-agent cool-down via a Map<string, number> owned by
 *     the caller (5-minute default window, configurable per-agent).
 *   - D-15/GREET-06: new message every restart (no edit-in-place, no
 *     messageId persistence across boots).
 *   - D-16/GREET-06: on send failure, returns `{kind: "send-failed"}`;
 *     caller owns the fire-and-forget `.catch` + log-and-swallow.
 *
 * This module imports NOTHING from the session manager. All types are
 * parameterized via the dep struct so tests can inject `vi.fn()` shims.
 */

import { EmbedBuilder } from "discord.js";
import type { Logger } from "pino";
import { isSubagentThreadName } from "./subagent-name.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { ConversationTurn } from "../memory/conversation-types.js";
import type { ConversationSession } from "../memory/conversation-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Signature of the injected Haiku summarizer. Matches the existing
 * `summarizeWithHaiku(prompt, opts)` in `src/manager/summarize-with-haiku.ts`
 * so the session manager (Plan 89-02) can pass it directly.
 */
export type SummarizeFn = (
  prompt: string,
  opts: { readonly signal?: AbortSignal },
) => Promise<string>;

/**
 * Narrow structural surface from WebhookManager used by the greeting helper.
 * We accept the structural shape rather than the concrete class so tests can
 * pass a plain object without instantiating a real WebhookManager.
 */
export type WebhookSender = Readonly<{
  hasWebhook(agentName: string): boolean;
  sendAsAgent(
    targetAgent: string,
    senderDisplayName: string,
    senderAvatarUrl: string | undefined,
    embed: EmbedBuilder,
  ): Promise<string>;
}>;

/**
 * Narrow ConversationStore surface used by the greeting helper. Tests build
 * a plain object implementing just these two methods. Production code passes
 * the real ConversationStore which already satisfies this shape.
 */
export type ConversationReader = Readonly<{
  listRecentTerminatedSessions(
    agentName: string,
    limit: number,
  ): readonly ConversationSession[];
  getTurnsForSession(
    sessionId: string,
    limit?: number,
  ): readonly ConversationTurn[];
}>;

/**
 * Fallback sender used when no per-agent webhook is provisioned. Sends the
 * greeting embed to the bound Discord channel under the bot's own identity
 * (instead of the per-agent webhook identity). Less pretty (no custom
 * avatar/display name), but keeps the greeting functional when the bot lacks
 * MANAGE_WEBHOOKS or the auto-provisioner hasn't created webhooks yet.
 * Phase 90.1 hotfix — 2026-04-24.
 */
export type BotDirectSender = Readonly<{
  sendEmbed(channelId: string, embed: EmbedBuilder): Promise<string>;
  /**
   * Phase 100 follow-up — plain-text channel send for non-interaction posts
   * (scheduled trigger output, alerts, etc.). Used by TriggerEngine's
   * deliveryFn when the target agent has no per-agent webhook provisioned.
   * Returns the sent message id.
   */
  sendText(channelId: string, content: string): Promise<string>;
  /**
   * INC-2026-08-10 - text plus file attachments in ONE message (Discord's
   * `send({content, files})`). Added for workflow report delivery.
   *
   * OPTIONAL on purpose: every existing consumer of this type builds it as an
   * object literal, and a required method would make each of them a compile
   * error for a capability they do not use. Callers must handle its absence,
   * which they have to anyway - the bot can lack ATTACH_FILES in the channel.
   */
  sendFiles?(
    channelId: string,
    content: string,
    files: readonly { readonly name: string; readonly data: Buffer }[],
  ): Promise<string>;
  /**
   * 999.103 WS-1 - edit a previously-sent bot message in place (the todo-card
   * fallback for agents without a masking webhook). Optional for the same
   * reason as sendFiles: existing object-literal implementations keep
   * compiling, and callers must handle absence anyway.
   */
  editText?(channelId: string, messageId: string, content: string): Promise<void>;
  /**
   * 999.173 - plain-text send as a Discord REPLY to `replyToMessageId`
   * (message_reference, fail_if_not_exists=false, no pings). Used to deliver
   * a research synthesis under the message that asked for it. Optional for the
   * same reason as sendFiles; callers fall back to sendText.
   */
  sendReply?(channelId: string, content: string, replyToMessageId: string): Promise<string>;
}>;

export type SendRestartGreetingDeps = Readonly<{
  webhookManager: WebhookSender;
  conversationStore: ConversationReader;
  summarize: SummarizeFn;
  /**
   * Phase 99 D-fix (2026-04-25 evening): optional fast-path lookup for an
   * existing session-summary memory entry (Phase 64 SessionSummarizer output,
   * OR the Phase 99-D recovery summaries). When provided AND the chosen
   * session has summaryMemoryId set, the resolved content is used directly
   * — bypassing the Haiku summarize-from-raw-turns step that reliably
   * times out (10s) on 60+ turn translated OpenClaw sessions.
   *
   * Returns the memory entry's content string if found, undefined otherwise.
   * Wired by SessionManager.restartAgent → memoryStores.get(agent).getById.
   */
  getMemoryById?: (id: string) => string | undefined;
  now: () => number;
  log: Logger;
  /**
   * Per-agent last-greeting-at timestamp in epoch ms. Owned by the caller
   * (the session manager) and mutated by this helper on successful send.
   * The caller is responsible for clearing entries on stopAgent() so a
   * clean restart does not trip the cool-down gate.
   */
  coolDownState: Map<string, number>;
  /** Optional bot-direct fallback when no webhook is provisioned (Phase 90.1). */
  botDirectSender?: BotDirectSender;
}>;

export type RestartKind = "clean" | "crash-suspected";

export type SendRestartGreetingInput = Readonly<{
  agentName: string;
  config: ResolvedAgentConfig;
  restartKind: RestartKind;
  /** Default 7 * 24 * 3600_000 ms (7 days). */
  dormancyThresholdMs?: number;
  /** Default 10_000 ms. */
  summaryTimeoutMs?: number;
  /** Default 50 turns. */
  maxTurnsForSummary?: number;
}>;

/**
 * Discriminated union of every observable outcome. Plan 89-02 (the caller)
 * ignores the value (fire-and-forget), but callers of this module in tests
 * or future observability code can exhaustively switch on `.kind`.
 */
export type GreetingOutcome =
  | { readonly kind: "sent"; readonly messageId: string }
  | { readonly kind: "skipped-disabled" }
  | { readonly kind: "skipped-fork" }
  | { readonly kind: "skipped-subagent-thread" }
  | { readonly kind: "skipped-no-channel" }
  | { readonly kind: "skipped-no-webhook" }
  | { readonly kind: "skipped-dormant"; readonly lastActivityMs: number }
  | { readonly kind: "skipped-empty-state" }
  | { readonly kind: "skipped-cool-down"; readonly lastGreetingAtMs: number }
  | { readonly kind: "send-failed"; readonly error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** D-10: dormancy threshold — skip greeting when last-activity > 7 days. */
export const DEFAULT_DORMANCY_THRESHOLD_MS = 7 * 24 * 3600_000;

/** D-05/D-06: Haiku timeout — mirrors SessionSummarizer's 10s budget. */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 10_000;

/** Cap turn count handed to the Haiku prompt so the prompt stays bounded. */
export const DEFAULT_MAX_TURNS_FOR_SUMMARY = 50;

/** D-06: hard cap on embed description length (500 chars incl. ellipsis). */
export const DESCRIPTION_MAX_CHARS = 500;

/** D-13: Discord blurple — "I'm back online" neutral brand color. */
export const CLEAN_EMBED_COLOR = 0x5865f2;

/** D-13: amber — matches sendBudgetAlert's "warning" color. */
export const CRASH_EMBED_COLOR = 0xffcc00;

/**
 * D-03 fork name pattern: `{parent}-fork-{nanoid6}`.
 * nanoid(6) alphabet: [A-Za-z0-9_-].
 * Source: src/manager/fork.ts:25-27.
 */
const FORK_SUFFIX_RE = /-fork-[A-Za-z0-9_-]{6}$/;

// ---------------------------------------------------------------------------
// Pure predicates (exported for the session manager + tests)
// ---------------------------------------------------------------------------

export function isForkAgent(agentName: string): boolean {
  return FORK_SUFFIX_RE.test(agentName);
}

/**
 * D-03 subagent-thread name detection. Phase 999.19 — delegates to the
 * central, strict {@link isSubagentThreadName} predicate in
 * `subagent-name.ts`, which catches BOTH spawner patterns:
 *   - Direct:    `{parent}-sub-{nanoid6}`
 *   - Delegated: `{parent}-via-{delegate}-{nanoid6}`
 * Pre-999.19 this used a local `-sub-`-only regex and missed delegated
 * sessions, so a restart greeting could fire inside a `*-via-*` thread.
 * Source pattern: src/discord/subagent-thread-spawner.ts.
 */
export function isSubagentThread(agentName: string): boolean {
  return isSubagentThreadName(agentName);
}

/**
 * GREET-03 classifier: single signal, single rule.
 *   prevConsecutiveFailures > 0 ? "crash-suspected" : "clean"
 *
 * `consecutiveFailures` is reset by the 5-min stability timer in
 * session-recovery.ts, so restarts that happen after stability reset
 * are treated as clean — acceptable semantics per D-04.
 */
export function classifyRestart(prevConsecutiveFailures: number): RestartKind {
  return prevConsecutiveFailures > 0 ? "crash-suspected" : "clean";
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * 2026-04-30 fix — detect when the prior session was dominated by API errors
 * (auth failures, rate-limit rejections, platform 5xx) so we skip the Haiku
 * summarization and use a verbatim recovery message instead.
 *
 * Background: when Anthropic's platform has an incident or the org's quota is
 * tight, agents' `query()` calls fail mid-turn. The Discord bridge surfaces
 * these failures as bot-authored messages in the agent's channel (e.g.
 * "Failed to authenticate. API Error: 403 ..."). On restart, the
 * conversation history handed to Haiku for summarization is dominated by
 * those error strings, and Haiku reliably produces a misleading one-liner
 * like "Credit balance is too low" — even on OAuth/Max accounts where
 * "credit balance" is not a real concept.
 *
 * Pattern set is intentionally generous: any one of these in a turn's
 * content marks the turn as an "error turn." When ≥50% of turns are error
 * turns, the session is treated as API-error-dominated.
 *
 * Pure function — no I/O, no logging.
 */
const API_ERROR_FINGERPRINTS: readonly RegExp[] = [
  /\bAPI Error:\s*\d{3}\b/i,
  /\bFailed to authenticate\b/i,
  /\bpermission_error\b/i,
  /\brate_limit_error\b/i,
  /\boverloaded_error\b/i,
  /\bauthentication_error\b/i,
  /\bCredit balance is too low\b/i,
  /\bnot a member of the organization\b/i,
  /\b(401|403|429|500|502|503|529)\s+error\b/i,
];

export function isApiErrorDominatedSession(
  turns: readonly ConversationTurn[],
): boolean {
  if (turns.length === 0) return false;
  const errorTurnCount = turns.filter((t) =>
    API_ERROR_FINGERPRINTS.some((re) => re.test(t.content)),
  ).length;
  return errorTurnCount * 2 >= turns.length;
}

/**
 * Verbatim recovery message used when the prior session was API-error-
 * dominated. Stays under DESCRIPTION_MAX_CHARS, OAuth/Max-friendly (no
 * "credit balance" phrasing), and tells the operator clearly that nothing
 * useful happened in the prior session.
 */
export const PLATFORM_ERROR_RECOVERY_MESSAGE =
  "I'm back. My prior session ran into platform errors (API auth/rate/load) and didn't make progress — nothing to recap. Ready to continue.";

/**
 * Assemble the Haiku prompt for a Discord-tuned prior-session summary.
 * Enforces the <500-char target through explicit instruction; the embed
 * builder truncates as a belt-and-suspenders safeguard.
 */
export function buildRestartGreetingPrompt(
  turns: readonly ConversationTurn[],
  agentConfig: ResolvedAgentConfig,
  restartKind: RestartKind,
): string {
  const agentVoice = agentConfig.webhook?.displayName ?? agentConfig.name;
  const turnsMarkdown = turns
    .map((t) => `### ${t.role} (turn ${t.turnIndex})\n${t.content}`)
    .join("\n\n");
  const situation =
    restartKind === "crash-suspected"
      ? "an unexpected shutdown"
      : "a clean restart";
  return `You are ${agentVoice}. You just came back online after ${situation}.

Summarize the PRIOR session below into a single first-person paragraph of AT MOST 400 characters (hard limit 500). Speak as "${agentVoice}" — "I was working on…", "We decided…", "I'm still waiting on…". NO bullet points. NO markdown headers. NO meta-commentary about being an AI or being restarted.

Prior session:

${turnsMarkdown}`;
}

// ---------------------------------------------------------------------------
// Embed builders
// ---------------------------------------------------------------------------

function truncateDesc(s: string): string {
  if (s.length <= DESCRIPTION_MAX_CHARS) return s;
  // U+2026 horizontal ellipsis counts as 1 char; slice to (max - 1) and
  // append. Result length === DESCRIPTION_MAX_CHARS.
  return s.slice(0, DESCRIPTION_MAX_CHARS - 1) + "\u2026";
}

export function buildCleanRestartEmbed(
  agentDisplayName: string,
  agentAvatarUrl: string | undefined,
  priorSessionSummary: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: agentDisplayName, iconURL: agentAvatarUrl })
    .setDescription(truncateDesc(priorSessionSummary))
    .setColor(CLEAN_EMBED_COLOR)
    .setFooter({ text: "Back online" })
    .setTimestamp();
}

export function buildCrashRecoveryEmbed(
  agentDisplayName: string,
  agentAvatarUrl: string | undefined,
  priorSessionSummary: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: agentDisplayName, iconURL: agentAvatarUrl })
    .setDescription(truncateDesc(priorSessionSummary))
    .setColor(CRASH_EMBED_COLOR)
    .setFooter({ text: "Recovered after unexpected shutdown" })
    .setTimestamp();
}

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

export async function sendRestartGreeting(
  deps: SendRestartGreetingDeps,
  input: SendRestartGreetingInput,
): Promise<GreetingOutcome> {
  const {
    agentName,
    config,
    restartKind,
    dormancyThresholdMs = DEFAULT_DORMANCY_THRESHOLD_MS,
    summaryTimeoutMs = DEFAULT_SUMMARY_TIMEOUT_MS,
    maxTurnsForSummary = DEFAULT_MAX_TURNS_FOR_SUMMARY,
  } = input;

  // 1. Opt-out gate (D-09 / GREET-07)
  if (config.greetOnRestart === false) {
    return { kind: "skipped-disabled" };
  }

  // 2. Fork / thread skip (D-03 / GREET-02)
  if (isForkAgent(agentName)) return { kind: "skipped-fork" };
  if (isSubagentThread(agentName)) return { kind: "skipped-subagent-thread" };

  // 3. Channel / webhook presence gates. Defensive — forks/threads already
  //    carve themselves out via the name regexes above; these catch any
  //    future headless agent pattern OR a runtime webhook-provisioning miss.
  if (!config.channels || config.channels.length === 0) {
    return { kind: "skipped-no-channel" };
  }
  // Phase 90.1: only skip here if NEITHER webhook nor bot-direct fallback is
  // available. If bot-direct is wired, we fall through and use it at the
  // send step (branch below).
  const hasWebhook = deps.webhookManager.hasWebhook(agentName);
  if (!hasWebhook && !deps.botDirectSender) {
    return { kind: "skipped-no-webhook" };
  }

  // 4. Cool-down gate (D-14 / GREET-10) — BEFORE the expensive summarize call.
  const lastSentAt = deps.coolDownState.get(agentName);
  if (
    lastSentAt !== undefined &&
    deps.now() - lastSentAt < config.greetCoolDownMs
  ) {
    return { kind: "skipped-cool-down", lastGreetingAtMs: lastSentAt };
  }

  // 5/6. Dormancy + empty-state (D-10 / D-11 / GREET-05)
  //
  // Phase 90.1 — iterate back through the last few terminated sessions to
  // find one with actual turns. Without this, a restart-immediately-after-
  // restart (common during operator testing or debugging) reads the most-
  // recent session (0 turns) and silently skips the greeting with
  // `skipped-empty-state`. That looks identical to a broken greeting even
  // though the agent has plenty of history.
  //
  // Phase 99-D — bumped lookback from 5 to 25 because translator-imported
  // OpenClaw sessions can stack many turn-empty rows (status='ended' with
  // turns still mid-translate). 5 was too tight on agents with translator
  // backfill; 25 keeps the scan bounded but lets the loop reach a real
  // session. The sibling fast-path (`summaryMemoryId` fallback) below
  // covers sessions where Gap-2 cleanup has pruned raw turns post-summary
  // OR where the translator has not yet replayed turns into a session it
  // already imported as 'ended'.
  const recent = deps.conversationStore.listRecentTerminatedSessions(
    agentName,
    25,
  );
  if (recent.length === 0) return { kind: "skipped-empty-state" };

  // Find the most-recent session that actually has turns to summarize.
  let lastSession: ConversationSession | undefined;
  let turns: readonly ConversationTurn[] = [];
  for (const candidate of recent) {
    const candidateTurns = deps.conversationStore.getTurnsForSession(
      candidate.id,
      maxTurnsForSummary,
    );
    if (candidateTurns.length > 0) {
      lastSession = candidate;
      turns = candidateTurns;
      break;
    }
  }

  // Phase 99-D fallback — none of the candidates had turns, but one may
  // already carry a stored session-summary memory entry (translator-imported
  // session that was later summarized via the 99-C heartbeat, or a session
  // whose raw turns were pruned by Gap-2 cleanup post-summarize). Picking
  // such a session here routes through the existing summaryMemoryId fast-
  // path (~L483) which uses the cached summary verbatim and skips the Haiku
  // call. Without this, agents with summary-only sessions fall through to
  // the "no prior session to recap" minimal embed even though we DO have a
  // recap on hand.
  if (!lastSession && deps.getMemoryById) {
    for (const candidate of recent) {
      if (!candidate.summaryMemoryId) continue;
      const cached = deps.getMemoryById(candidate.summaryMemoryId);
      if (cached && cached.trim().length > 0) {
        lastSession = candidate;
        // turns intentionally stays []. The fast-path at ~L483 keys off
        // `lastSession.summaryMemoryId + getMemoryById` and bypasses the
        // turns-based Haiku prompt entirely; the dormancy + embed-builder
        // steps below only consult `lastSession`.
        break;
      }
    }
  }
  // Phase 90.1 hotfix (D-11 relaxation) — if no session has turns (happens
  // after repeated /clawcode-restart which creates+ends zero-turn sessions,
  // or for freshly-curated agents), skip the summarization but STILL send a
  // minimal "I'm back" embed so the operator gets visual confirmation the
  // restart fired. The original D-11 silent-skip was intended to avoid
  // noise on fleet boots, but operator-triggered restarts deserve feedback.
  if (!lastSession) {
    const displayName = config.webhook?.displayName ?? agentName;
    const avatarUrl = config.webhook?.avatarUrl;
    const minimalEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("I'm back")
      .setDescription(
        "Restart complete — no prior session to recap. Ask me anything to get rolling.",
      );
    const minimalChannelId = config.channels?.[0];
    let sentId: string;
    try {
      if (deps.webhookManager.hasWebhook(agentName)) {
        sentId = await deps.webhookManager.sendAsAgent(
          agentName,
          displayName,
          avatarUrl,
          minimalEmbed,
        );
      } else if (deps.botDirectSender && minimalChannelId) {
        sentId = await deps.botDirectSender.sendEmbed(
          minimalChannelId,
          minimalEmbed,
        );
      } else {
        return { kind: "skipped-empty-state" };
      }
    } catch (err) {
      return {
        kind: "send-failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    deps.coolDownState.set(agentName, deps.now());
    return { kind: "sent", messageId: sentId };
  }

  // Dormancy check applies to the chosen session's activity time.
  const lastActivityIso = lastSession.endedAt ?? lastSession.startedAt;
  const lastActivityMs = new Date(lastActivityIso).getTime();
  // Clock-skew clamp mirrors src/memory/conversation-brief.ts:110.
  const ageMs = Math.max(0, deps.now() - lastActivityMs);
  if (ageMs > dormancyThresholdMs) {
    return { kind: "skipped-dormant", lastActivityMs };
  }

  // Phase 99 D-fix (2026-04-25 evening): fast-path — if the chosen session
  // already has a summary memory entry (summaryMemoryId set), reuse it
  // verbatim and skip the Haiku call entirely. Translated OpenClaw sessions
  // can have 60+ turns; re-summarizing reliably exceeds the 10s Haiku
  // timeout (D-05) and falls through to skipped-empty-state. The existing
  // summary IS the correct artifact — one source of truth for "what
  // happened in this session" matches the design intent of summary_memory_id.
  let summary: string | undefined;
  if (lastSession.summaryMemoryId && deps.getMemoryById) {
    const existing = deps.getMemoryById(lastSession.summaryMemoryId);
    if (existing && existing.trim().length > 0) {
      // 2026-05-01 fix (260501-nxm) — guard against legacy bad summaries
      // cached BEFORE the L496 isApiErrorDominatedSession guard landed
      // (2026-04-30). Without this, a stale "Credit balance is too low"
      // summary written by Haiku during a platform-incident session keeps
      // reappearing on every subsequent restart until the cached value is
      // overwritten or expired. Read-time filter only — no scrub of stored
      // memory; the next session that writes a fresh summary will overwrite
      // the bad cached value organically.
      if (API_ERROR_FINGERPRINTS.some((re) => re.test(existing))) {
        deps.log.info(
          { agent: agentName, summaryMemoryId: lastSession.summaryMemoryId },
          "[greeting] cached summary contains API-error fingerprint; using verbatim platform-error recovery message",
        );
        summary = PLATFORM_ERROR_RECOVERY_MESSAGE;
      } else {
        summary = existing;
      }
    }
  }

  if (summary === undefined) {
    // 2026-04-30 fix — bypass Haiku summarization when the prior session is
    // dominated by API errors (auth/rate-limit/platform 5xx). Without this,
    // Haiku gets a transcript full of error strings and produces misleading
    // summaries like "Credit balance is too low" — confusing on OAuth/Max
    // where the operator doesn't even have a literal credit balance.
    if (isApiErrorDominatedSession(turns)) {
      deps.log.info(
        { agent: agentName, turnCount: turns.length },
        "[greeting] prior session was API-error-dominated; using verbatim platform-error recovery message",
      );
      summary = PLATFORM_ERROR_RECOVERY_MESSAGE;
    } else {
      // 7. Haiku summarization with timeout (D-05 / D-06 / GREET-04).
      //    Timeout is OWNED BY THIS CALLER (summarizeWithHaiku's docstring
      //    explicitly delegates the timer to the caller). On timeout / SDK
      //    error / abort / empty-string we stay silent — D-11 forbids a
      //    fallback greeting.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), summaryTimeoutMs);
      try {
        summary = await deps.summarize(
          buildRestartGreetingPrompt(turns, config, restartKind),
          { signal: controller.signal },
        );
      } catch {
        return { kind: "skipped-empty-state" };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  if (summary.trim().length === 0) {
    return { kind: "skipped-empty-state" };
  }

  // 8. Build embed (D-04 / D-13 / GREET-03)
  const displayName = config.webhook?.displayName ?? agentName;
  const avatarUrl = config.webhook?.avatarUrl;
  const embed =
    restartKind === "crash-suspected"
      ? buildCrashRecoveryEmbed(displayName, avatarUrl, summary)
      : buildCleanRestartEmbed(displayName, avatarUrl, summary);

  // 9. Send via webhook (D-08 / D-13 / D-15 / GREET-06), OR fall back to
  //    bot-direct (Phase 90.1) when no webhook is provisioned / webhook send
  //    fails. Bot-direct targets the first bound channel directly under the
  //    bot's own identity — less pretty (no per-agent avatar) but functional
  //    when MANAGE_WEBHOOKS is missing. A failure here is still non-fatal at
  //    the session-manager layer — our caller wraps the whole invocation in
  //    `.catch(log-and-swallow)`.
  let messageId: string;
  const channelId = config.channels?.[0];
  if (hasWebhook) {
    try {
      messageId = await deps.webhookManager.sendAsAgent(
        agentName,
        displayName,
        avatarUrl,
        embed,
      );
    } catch (err) {
      // Webhook send failed — try bot-direct fallback if available.
      if (deps.botDirectSender && channelId) {
        try {
          messageId = await deps.botDirectSender.sendEmbed(channelId, embed);
        } catch (err2) {
          return {
            kind: "send-failed",
            error: err2 instanceof Error ? err2.message : String(err2),
          };
        }
      } else {
        return {
          kind: "send-failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  } else {
    // No webhook — use bot-direct. (hasWebhook=false here implies
    // deps.botDirectSender is truthy per the guard at step 3.)
    if (!deps.botDirectSender || !channelId) {
      return { kind: "skipped-no-webhook" };
    }
    try {
      messageId = await deps.botDirectSender.sendEmbed(channelId, embed);
    } catch (err) {
      return {
        kind: "send-failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 10. Cool-down write-back (D-14). MUST run AFTER the successful send —
  //     failed sends should not block the next retry.
  deps.coolDownState.set(agentName, deps.now());
  return { kind: "sent", messageId };
}
