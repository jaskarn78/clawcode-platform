/**
 * Phase 145 WS3 (Plan 04) — the `ask-user-question` IPC handler, extracted as a
 * pure-ish dispatcher (mirroring `browser/daemon-handler.ts` etc.) so the
 * branch selection (Discord-native vs text-fallback), the fail-closed
 * operator-allowlist gate (T-145-10), and the daemon-owned bounded timeout
 * (T-145-11) are unit-testable WITHOUT a live daemon, Discord client, or Slack
 * socket. The daemon block (daemon.ts) is a thin call that wires the real
 * bridge interactions as callbacks.
 *
 * The handler ALWAYS settles (answer or clean timeout / clean failure reason)
 * — sendIpcRequest has no client timeout, so the worker only unblocks when this
 * resolves. Operator attribution is fail-closed on the daemon side: an empty
 * allowlist returns `no-operator` BEFORE any prompt is posted (never
 * trust-first-replier); the per-path filters (Discord component filter,
 * text-fallback inbound parse) enforce the same allowlist downstream.
 */

import type { Logger } from "pino";
import type {
  IpcAskUserQuestionParams,
  IpcAskUserQuestionResult,
} from "../ipc/types.js";
import type { NeutralQuestion, NeutralAnswers } from "../messaging/types.js";
import { decideRenderMode } from "../messaging/pending-prompt-registry.js";
import type { PendingPromptRegistry } from "../messaging/pending-prompt-registry.js";

/** The minimal agent-binding shape the handler needs (a slice of ResolvedAgentConfig). */
export interface AskAgentBinding {
  readonly name: string;
  readonly channels?: readonly string[];
  readonly slack?: { readonly channels?: readonly string[] };
}

/** Injected dependencies — real bridges in the daemon, fakes in tests. */
export interface AskUserQuestionDeps {
  /** All bound agents (for agent→channel→platform resolution). */
  readonly agents: readonly AskAgentBinding[];
  /** The shared pending-prompt registry (text-fallback resolution channel). */
  readonly registry: Pick<PendingPromptRegistry, "register" | "cancel">;
  /**
   * The fail-closed operator allowlist (already split from env). EMPTY → no one
   * can answer → the handler returns `no-operator` without posting.
   */
  readonly allowlistIds: readonly string[];
  /** Generate a correlation id (nanoid in the daemon). */
  readonly newPromptId: () => string;
  /** Default bound when the caller supplies no timeoutMs. */
  readonly defaultTimeoutMs: number;
  /** Hard ceiling on any caller-supplied timeoutMs. */
  readonly maxTimeoutMs: number;
  /**
   * Render the prompt natively (Discord buttons today). Resolves with the
   * operator's answer, or `null` on timeout / unavailable. Self-contained — it
   * owns its own collector + does NOT register a pending prompt.
   */
  readonly renderNative: (
    channelId: string,
    questions: readonly NeutralQuestion[],
    allowlistIds: readonly string[],
    timeoutMs: number,
    promptId: string,
  ) => Promise<NeutralAnswers | null>;
  /**
   * Post the numbered text-fallback question to a non-native platform (Slack
   * today). The reply is resolved separately via the registry. Throws if no
   * bridge is bound for the platform. (Discord always renders natively, so the
   * text branch never passes "discord" — but the type stays the platform union
   * for forward-compatibility.)
   */
  readonly postText: (
    platform: "discord" | "slack",
    channelId: string,
    agent: string,
    text: string,
  ) => Promise<void>;
  readonly log: Pick<Logger, "error" | "info">;
}

/** A failure result with a typed reason. */
function fail(reason: string): IpcAskUserQuestionResult {
  return { ok: false, reason };
}

/** Render the numbered text fallback for a question batch. PURE. */
export function renderNumberedText(
  questions: readonly NeutralQuestion[],
): string {
  const numbered = questions
    .map((q, qi) => {
      const head = `**${qi + 1}. ${q.header}**${
        q.multiSelect ? " (reply with one or more numbers, comma-separated)" : ""
      }`;
      const opts = q.options
        .map(
          (o, oi) =>
            `   ${oi + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`,
        )
        .join("\n");
      return `${head}\n${opts}`;
    })
    .join("\n\n");
  const replyHint =
    questions.length === 1
      ? "\n\nReply with the option number."
      : "\n\nReply with one line per question (the option number(s)).";
  return `${numbered}${replyHint}`;
}

/** Validate the inbound batch. Returns null when valid, else a failure result. */
function validateBatch(
  agent: string,
  questions: readonly NeutralQuestion[],
): IpcAskUserQuestionResult | null {
  if (agent.length === 0 || questions.length === 0 || questions.length > 4) {
    return fail("invalid-request");
  }
  for (const q of questions) {
    if (
      typeof q.id !== "string" ||
      typeof q.header !== "string" ||
      !Array.isArray(q.options) ||
      q.options.length === 0 ||
      q.options.some(
        (o) => typeof o.id !== "string" || typeof o.label !== "string",
      )
    ) {
      return fail("invalid-request");
    }
  }
  return null;
}

/**
 * Handle one `ask-user-question` IPC request. ALWAYS resolves.
 *
 * Resolution order:
 *  1. validate the batch                 → invalid-request
 *  2. resolve agent                      → unknown-agent
 *  3. fail-closed allowlist (empty)      → no-operator   (BEFORE any post)
 *  4. resolve channel + platform         → no-channel
 *  5. branch on render mode:
 *       native (Discord)  → renderNative (self-contained collector)
 *       text   (Slack...) → postText + registry.register
 *  6. daemon-owned Promise.race timeout  → timeout       (clean unblock)
 */
export async function handleAskUserQuestion(
  deps: AskUserQuestionDeps,
  params: IpcAskUserQuestionParams,
): Promise<IpcAskUserQuestionResult> {
  const agent = typeof params.agent === "string" ? params.agent : "";
  const questions = Array.isArray(params.questions)
    ? (params.questions as readonly NeutralQuestion[])
    : [];

  const invalid = validateBatch(agent, questions);
  if (invalid) return invalid;

  const cfg = deps.agents.find((a) => a.name === agent);
  if (!cfg) return fail("unknown-agent");

  // Fail-closed: no allowlist → no one can answer. Surfaced BEFORE posting.
  if (deps.allowlistIds.length === 0) return fail("no-operator");

  const discordChannel = cfg.channels?.[0];
  const slackChannel = cfg.slack?.channels?.[0];
  const platform: "discord" | "slack" | null = discordChannel
    ? "discord"
    : slackChannel
      ? "slack"
      : null;
  const channelId = discordChannel ?? slackChannel;
  if (!platform || !channelId) return fail("no-channel");

  const promptId = deps.newPromptId();
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0
      ? Math.min(params.timeoutMs, deps.maxTimeoutMs)
      : deps.defaultTimeoutMs;

  // Capability-gated render mode — Discord native, everything else text.
  const renderMode = decideRenderMode({
    editMessages: true,
    reactions: true,
    typingIndicator: true,
    threads: true,
    perMessageIdentity: true,
    fileDownload: true,
    interactivePrompt: platform === "discord",
    maxMessageLength: 2000,
  });

  let settled = false;
  const answerPromise = new Promise<NeutralAnswers | null>((resolve) => {
    const settle = (answers: NeutralAnswers | null) => {
      if (settled) return;
      settled = true;
      resolve(answers);
    };

    if (renderMode === "native" && platform === "discord") {
      // Discord-native: self-contained collector (NO registry entry, so the
      // handleMessage intercept stays a pure no-op safety net for Discord).
      void deps
        .renderNative(channelId, questions, deps.allowlistIds, timeoutMs, promptId)
        .then((answers) => settle(answers))
        .catch((err: unknown) => {
          deps.log.error(
            { err: err instanceof Error ? err.message : String(err), agent, promptId },
            "ask-user-question: native render failed",
          );
          settle(null);
        });
      return;
    }

    // Text fallback (Slack today / any non-Discord). Register FIRST so a fast
    // reply cannot race the post (the registry is the resolution channel; the
    // post is just the prompt surface). For Slack the reply intercept lands in
    // Plan 07 — until then the Slack text path resolves only via the timeout.
    deps.registry.register({
      promptId,
      platform,
      channelId,
      questions,
      allowlistIds: deps.allowlistIds,
      timeoutMs,
      resolve: (answers) => settle(answers),
      onTimeout: () => settle(null),
    });

    void deps.postText(platform, channelId, agent, renderNumberedText(questions)).catch(
      (err: unknown) => {
        deps.log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            agent,
            promptId,
            platform,
          },
          "ask-user-question: text-fallback post failed",
        );
        deps.registry.cancel(promptId);
        settle(null);
      },
    );
  });

  // Daemon-owned bounded timeout — ALWAYS settles the worker (answer or clean
  // timeout). Wraps BOTH branches so the worker can never hang (T-145-11).
  const timeoutPromise = new Promise<NeutralAnswers | null>((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    if (typeof t === "object" && t !== null && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
  });

  const answers = await Promise.race([answerPromise, timeoutPromise]);
  settled = true;
  deps.registry.cancel(promptId);
  if (answers === null) return fail("timeout");
  return { ok: true, answers };
}
